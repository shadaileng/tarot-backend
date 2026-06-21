import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import express, { type Request, type Response, type NextFunction } from 'express'
import { config, configMeta, updateConfig, maskSensitiveValue, getConfigDefaults } from './config.js'
import { corsMiddleware } from './middleware/cors.js'
import { authMiddleware } from './middleware/auth.js'
import { loggingMiddleware } from './gateway/logging.js'
import { buildPosterHTML } from './poster/template.js'
import { renderPoster } from './poster/render.js'
import { getPoolStats, getPoolInstance } from './poster/browser-pool.js'
import { posterCache } from './cache/index.js'
import { getTemplate } from './poster/templates/index.js'
import { metrics } from './monitor/index.js'
import { getLogger } from './logger.js'
import { readingHandler } from './reading/handler.js'
import { getCachedGeminiHealth, getGeminiHealthDirectly, quotaExhaustedCache } from './reading/models.js'
import { queryLogs, getLogById } from './db/reading-log.js'
import { getAllConfig, upsertConfig, initDefaultConfig, loadUserConfig } from './db/config.js'
import { getDb } from './db/index.js'
import type { PosterData } from './poster/types.js'

const log = getLogger('API')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app: express.Express = express()

app.use(express.json({ limit: '1mb' }))
app.use(corsMiddleware)

app.use('/cards', express.static(path.join(__dirname, '../assets/cards')))

app.use(loggingMiddleware)

app.get('/', (_req, res) => {
  res.json({
    service: 'tarot-backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      reading: 'POST /reading',
      poster: 'POST /poster',
      health: 'GET /health',
      metrics: 'GET /metrics',
      logs: 'GET /logs',
    },
  })
})

app.get('/health', async (req, res) => {
  const poolStats = await getPoolStats()
  const snap = metrics.getSnapshot()
  const noCache = req.query.noCache === '1'

  // 默认状态：Worker 正常运行
  let geminiStatus: 'up' | 'down' | 'unconfigured' | 'quota_exhausted' = 'unconfigured'
  let geminiDetail: string | undefined
  let geminiModel: string | null = null
  let httpStatus = 200

  if (!config.geminiApiKey) {
    geminiStatus = 'unconfigured'
    geminiDetail = 'GEMINI_API_KEY not configured'
    httpStatus = 500
  } else {
    const geminiHealth = noCache
      ? await getGeminiHealthDirectly(config.geminiApiKey)
      : await getCachedGeminiHealth(config.geminiApiKey)

    if (geminiHealth.allExhausted) {
      geminiStatus = 'quota_exhausted'
      geminiDetail = geminiHealth.detail
    } else if (geminiHealth.up) {
      geminiStatus = 'up'
      geminiModel = geminiHealth.model
    } else {
      geminiStatus = 'down'
      geminiDetail = geminiHealth.detail
    }
  }

  const responseBody: any = {
    status: geminiStatus === 'up' ? 'ok' : 'degraded',
    worker: 'up',
    gemini: geminiStatus,
    model: geminiModel,
    _noCache: noCache || undefined,
    cache: {
      size: posterCache.size,
      maxSize: posterCache.maxSize,
      hitRate: snap.cacheHitRate,
    },
    pool: poolStats ?? { available: 0, active: 0, waiting: 0, maxPages: config.pool.maxPages },
    metrics: {
      totalRequests: snap.totalRequests,
      errors: snap.errorCount,
      avgTotalMs: Math.round(snap.avgTotalMs),
    },
  }

  // 添加可选字段
  if (geminiDetail) responseBody.detail = geminiDetail
  if (geminiStatus === 'quota_exhausted') {
    responseBody.exhaustedModels = [...quotaExhaustedCache.models]
  }

  res.status(httpStatus).json(responseBody)
})

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(metrics.toPrometheus())
})

app.post('/reading', readingHandler)

app.post('/poster', authMiddleware, async (req, res) => {
  const requestStart = Date.now()
  const posterData = req.body as PosterData
  const template = getTemplate(posterData.template)

  try {
    if (!posterData.cards || !Array.isArray(posterData.cards) || posterData.cards.length === 0) {
      res.status(400).json({ error: 'Invalid request: cards array is required' })
      return
    }

    const cacheKey = posterCache.generateKey(posterData)
    const cached = posterCache.get(cacheKey)
    if (cached) {
      res.set('Content-Type', 'image/png')
      res.set('X-Cache', 'HIT')
      res.set('Cache-Control', 'public, max-age=3600')
      res.send(cached)

      metrics.recordRender({
        templateMs: 0,
        resourceMs: 0,
        screenshotMs: 0,
        totalMs: Date.now() - requestStart,
        timestamp: requestStart,
        template: template.name,
        cacheHit: true,
      })
      return
    }

    const templateStart = Date.now()
    const html = buildPosterHTML(posterData)
    const templateMs = Date.now() - templateStart

    const { buffer: imageBuffer, timings } = await renderPoster(html, template.width)

    posterCache.set(cacheKey, imageBuffer)

    const totalMs = Date.now() - requestStart

    metrics.recordRender({
      templateMs,
      resourceMs: timings.resourceMs,
      screenshotMs: timings.screenshotMs,
      totalMs,
      timestamp: requestStart,
      template: template.name,
      cacheHit: false,
    })

    res.set('Content-Type', 'image/png')
    res.set('X-Cache', 'MISS')
    res.set('X-Render-Template-Ms', String(templateMs))
    res.set('X-Render-Resource-Ms', String(timings.resourceMs))
    res.set('X-Render-Screenshot-Ms', String(timings.screenshotMs))
    res.set('X-Render-Total-Ms', String(totalMs))
    res.set('Cache-Control', 'public, max-age=3600')
    res.send(imageBuffer)
  } catch (error) {
    metrics.recordError()
    log.error({ err: error }, 'Poster generation failed')
    res.status(500).json({ error: 'Poster generation failed' })
  }
})

app.get('/logs', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const target = req.query.target as string | undefined
  const result = await queryLogs(page, limit, target)
  res.json(result)
})

app.get('/logs/:id', async (req, res) => {
  const log = await getLogById(req.params.id)
  if (!log) {
    res.status(404).json({ error: 'Log not found' })
    return
  }
  res.json(log)
})

app.get('/api/config', async (_req, res) => {
  const dbConfig = await getAllConfig()
  const groups = new Map<string, any[]>()

  for (const meta of configMeta) {
    const entry = dbConfig.get(meta.envKey)
    const rawValue = entry?.value ?? process.env[meta.envKey] ?? ''
    const value = meta.sensitive ? maskSensitiveValue(meta.envKey, rawValue) : rawValue

    if (!groups.has(meta.group)) {
      groups.set(meta.group, [])
    }
    groups.get(meta.group)!.push({
      key: meta.envKey,
      label: meta.envKey,
      value,
      source: entry?.source ?? 'env',
      editable: meta.editable,
      type: meta.type,
    })
  }

  res.json({ groups: Array.from(groups.entries()).map(([name, items]) => ({ name, items })) })
})

app.put('/api/config/:key', authMiddleware, async (req, res) => {
  const { key } = req.params
  const { value } = req.body as { value: string }

  const meta = configMeta.find((m) => m.envKey === key)
  if (!meta) {
    res.status(404).json({ error: `Unknown config key: ${key}` })
    return
  }

  if (!meta.editable) {
    res.status(403).json({ error: `Config key '${key}' is not editable` })
    return
  }

  if (value === undefined || value === null) {
    res.status(400).json({ error: 'Missing value' })
    return
  }

  const stringValue = String(value)
  if (meta.type === 'number' && isNaN(Number(stringValue))) {
    res.status(400).json({ error: `Invalid number value for ${key}` })
    return
  }

  await upsertConfig(key, stringValue, 'user')
  updateConfig(key, stringValue)

  if (key === 'CACHE_MAX_SIZE' || key === 'CACHE_TTL_SECONDS') {
    posterCache.updateConfig(config.cache.maxSize, config.cache.ttlSeconds)
  }

  if (key === 'POOL_MAX_PAGES' || key === 'POOL_ACQUIRE_TIMEOUT_MS') {
    const pool = await getPoolInstance()
    if (pool) {
      pool.updateConfig(config.pool.maxPages, config.pool.acquireTimeoutMs)
    }
  }

  log.info({ key, value: meta.sensitive ? '***' : stringValue }, 'Config updated')

  res.json({ key, value: meta.sensitive ? maskSensitiveValue(key, stringValue) : stringValue, source: 'user' })
})

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'Unhandled error')
  res.status(500).json({ error: 'Internal server error' })
})

async function start(): Promise<void> {
  await getDb()
  log.info({ path: config.db.path }, 'Database initialized')

  const defaults = getConfigDefaults()
  await initDefaultConfig(defaults)
  log.info('Default config initialized')

  // 启动时从 DB 恢复用户动态配置（DB 优先于 env）
  const restored = await loadUserConfig()
  if (restored.length > 0) {
    log.info({ restored }, 'Restored user config from database')
  }

  app.listen(config.port, '0.0.0.0', () => {
    log.info({ port: config.port }, 'Tarot Backend Service running')
    log.info({ environment: config.nodeEnv }, 'Environment')
    log.info({ geminiConfigured: !!config.geminiApiKey }, 'Gemini API')
    log.info({ authEnabled: !!config.apiKey }, 'Auth status')
  })
}

start().catch((err) => {
  log.error({ err }, 'Failed to start server')
  process.exit(1)
})

export default app
