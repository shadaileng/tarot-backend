import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import express, { type Request, type Response, type NextFunction } from 'express'
import { config, configMeta, updateConfig, maskSensitiveValue, getConfigDefaults } from './config.js'
import { corsMiddleware } from './middleware/cors.js'
import { adminAuthMiddleware } from './middleware/admin-auth.js'
import { jwtAuthMiddleware } from './middleware/jwt-auth.js'
import { rateLimitMiddleware } from './middleware/rate-limit.js'
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
import { queryUsers } from './db/user.js'
import { getAllConfig, upsertConfig, initDefaultConfig, loadUserConfig } from './db/config.js'
import { getDb } from './db/index.js'
import { wechatLoginHandler } from './auth/wechat-login.js'
import { emailRegisterHandler } from './auth/email-register.js'
import { emailLoginHandler } from './auth/email-login.js'
import { bindEmailHandler } from './auth/bind-email.js'
import { bindPhoneHandler } from './auth/bind-phone.js'
import { updateProfileHandler } from './auth/update-profile.js'
import { getUserRecords, getRecordById, saveRecord, deleteRecord } from './db/reading-record.js'
import {
  findAdminByUsername, updateLastLogin, initAdminIfNeeded, findAdminById, changePassword,
  createAdmin, listAdmins, updateAdmin, deleteAdmin, resetAdminPassword, validatePasswordStrength,
  type AdminRow, type UpdateAdminInput,
} from './db/admin.js'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'
import type { PosterData } from './poster/types.js'

const log = getLogger('API')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app: express.Express = express()

app.use(express.json({ limit: '1mb' }))
app.use(corsMiddleware)

app.use('/api/cards', express.static(path.join(__dirname, '../assets/cards')))

app.use(loggingMiddleware)

app.get('/', (_req, res) => {
  res.json({
    service: 'tarot-backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      reading: 'POST /api/reading',
      poster: 'POST /api/poster',
      health: 'GET /api/health',
      metrics: 'GET /api/metrics',
      logs: 'GET /api/logs',
      auth: {
        wechatLogin: 'POST /api/auth/wechat-login',
        emailRegister: 'POST /api/auth/email-register',
        emailLogin: 'POST /api/auth/email-login',
        bindEmail: 'POST /api/auth/bind-email',
        bindPhone: 'POST /api/auth/bind-phone',
      },
      user: {
        profile: 'PUT /api/user/profile',
        records: 'GET /api/user/records',
        recordById: 'GET /api/user/records/:id',
        deleteRecord: 'DELETE /api/user/records/:id',
      },
      admin: {
        login: 'POST /admin/auth/login',
        logout: 'POST /admin/auth/logout',
        me: 'GET /admin/auth/me',
        changePassword: 'POST /admin/auth/change-password',
        logs: 'GET /api/logs',
        logById: 'GET /api/logs/:id',
        users: 'GET /api/admin/users',
        config: 'GET /api/config',
        updateConfig: 'PUT /api/config/:key',
      },
    },
  })
})

app.get('/api/health', async (req, res) => {
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

app.get('/api/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(metrics.toPrometheus())
})

// ========== 认证相关路由 ==========

// 登录与注册（无需鉴权）
app.post('/api/auth/wechat-login', wechatLoginHandler)
app.post('/api/auth/email-register', emailRegisterHandler)
app.post('/api/auth/email-login', emailLoginHandler)

// 账号绑定（需要 JWT 鉴权）
app.post('/api/auth/bind-email', jwtAuthMiddleware, bindEmailHandler)
app.post('/api/auth/bind-phone', jwtAuthMiddleware, bindPhoneHandler)

// 用户资料（需要 JWT 鉴权）
app.put('/api/user/profile', jwtAuthMiddleware, updateProfileHandler)

// ========== Admin 认证路由 ==========

// Admin 登录（公开，但有限流）
const adminLoginRateLimit = new Map<string, { count: number; resetAt: number }>()
function checkAdminLoginRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = adminLoginRateLimit.get(ip)
  if (!entry || now > entry.resetAt) {
    adminLoginRateLimit.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

app.post('/admin/auth/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || ''

  if (!checkAdminLoginRateLimit(ip)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '登录频率过高，请 1 分钟后重试' })
    return
  }

  const { username, password } = req.body as { username?: string; password?: string }

  if (!username || !password) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '用户名和密码为必填项' })
    return
  }

  try {
    const admin = await findAdminByUsername(username)

    if (!admin || admin.is_active !== 1) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
      return
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash)
    if (!passwordMatch) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
      return
    }

    await updateLastLogin(admin.id)

    const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'
    const token = jwt.sign(
      { sub: admin.id, username: admin.username, role: admin.role, type: 'admin' },
      secret,
      { expiresIn: config.adminJwtExpiresIn || '24h' },
    )

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        displayName: admin.display_name,
        role: admin.role,
      },
      mustChangePassword: admin.must_change_password === 1,
    })
  } catch (err) {
    log.error({ err }, 'Admin login failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// Admin 登出（纯前端清除 token，后端无状态）
app.post('/admin/auth/logout', adminAuthMiddleware, (_req, res) => {
  res.json({ message: '已退出登录' })
})

// 获取当前 Admin 信息（查 DB，返回完整字段）
app.get('/admin/auth/me', adminAuthMiddleware, async (req, res) => {
  try {
    const adminId = (req as any).adminId as string
    const admin = await findAdminById(adminId)
    if (!admin || admin.is_active !== 1) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '账号不存在或已禁用' })
      return
    }
    res.json({
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      role: admin.role,
      mustChangePassword: admin.must_change_password === 1,
    })
  } catch (err) {
    log.error({ err }, 'Failed to get admin info')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 修改密码
app.post('/admin/auth/change-password', adminAuthMiddleware, async (req, res) => {
  const adminId = (req as any).adminId as string
  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string }

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '旧密码和新密码为必填项' })
    return
  }

  try {
    const result = await changePassword(adminId, oldPassword, newPassword)
    if (!result.success) {
      res.status(400).json({ error: 'CHANGE_PASSWORD_FAILED', message: result.error })
      return
    }
    res.json({ message: '密码修改成功，请使用新密码重新登录' })
  } catch (err) {
    log.error({ err }, 'Change password failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// ========== 超管专用：管理员 CRUD（role=admin 才可操作）==========

/** 校验请求是否为 role=admin 的超管 */
function requireAdminRole(req: Request, res: Response): boolean {
  const role = (req as any).adminRole as string | undefined
  if (role !== 'admin') {
    res.status(403).json({ error: 'FORBIDDEN', message: '仅超级管理员可执行此操作' })
    return false
  }
  return true
}

// 管理员列表
app.get('/api/admin/admins', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100)
    const search = req.query.search as string | undefined
    const result = await listAdmins(page, pageSize, search)
    res.json({ success: true, data: result })
  } catch (err) {
    log.error({ err }, 'Failed to list admins')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 创建管理员
app.post('/api/admin/admins', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const { username, displayName, password, role: newRole } = req.body as {
      username?: string
      displayName?: string
      password?: string
      role?: string
    }

    if (!username || !displayName || !password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '用户名、显示名和密码为必填项' })
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: strengthError })
      return
    }

    const existing = await findAdminByUsername(username)
    if (existing) {
      res.status(409).json({ error: 'CONFLICT', message: '该用户名已存在' })
      return
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const admin = await createAdmin({
      username,
      passwordHash,
      displayName,
      role: newRole === 'readonly' ? 'readonly' : 'admin',
    })
    log.info({ adminId: admin.id, username, operator: (req as any).adminUsername }, 'Admin created')

    res.status(201).json({
      success: true,
      data: {
        id: admin.id,
        username: admin.username,
        displayName: admin.display_name,
        role: admin.role,
        isActive: true,
        createdAt: admin.created_at,
      },
    })
  } catch (err) {
    log.error({ err }, 'Failed to create admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 编辑管理员
app.put('/api/admin/admins/:id', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const operatorId = (req as any).adminId as string
    const { displayName, role: newRole, isActive } = req.body as UpdateAdminInput

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    // 禁止禁用自己
    if (targetId === operatorId && isActive === false) {
      res.status(400).json({ error: 'NOT_ALLOWED', message: '不能禁用自己的账号' })
      return
    }

    const updateData: UpdateAdminInput = {}
    if (displayName !== undefined) updateData.displayName = displayName
    if (newRole !== undefined) updateData.role = newRole
    if (isActive !== undefined) updateData.isActive = isActive

    await updateAdmin(targetId, updateData)
    log.info({ targetId, operator: (req as any).adminUsername, changes: updateData }, 'Admin updated')

    res.json({ success: true, message: '管理员信息已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 删除管理员（软删除）
app.delete('/api/admin/admins/:id', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const operatorId = (req as any).adminId as string

    // 禁止删除自己
    if (targetId === operatorId) {
      res.status(400).json({ error: 'NOT_ALLOWED', message: '不能删除自己的账号' })
      return
    }

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    await deleteAdmin(targetId)
    log.info({ targetId, operator: (req as any).adminUsername, targetUsername: target.username }, 'Admin deleted')

    res.json({ success: true, message: '管理员已删除' })
  } catch (err) {
    log.error({ err }, 'Failed to delete admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 重置管理员密码
app.post('/api/admin/admins/:id/reset-password', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const { password } = req.body as { password?: string }

    if (!password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '新密码为必填项' })
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: strengthError })
      return
    }

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    const passwordHash = await bcrypt.hash(password, 10)
    await resetAdminPassword(targetId, passwordHash)
    log.info({ targetId, operator: (req as any).adminUsername, targetUsername: target.username }, 'Admin password reset')

    res.json({ success: true, message: '密码已重置，该管理员下次登录时需修改密码' })
  } catch (err) {
    log.error({ err }, 'Failed to reset admin password')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// ========== 业务接口（JWT 鉴权 + 频率限制）==========

app.post('/api/reading', jwtAuthMiddleware, rateLimitMiddleware, readingHandler)

app.post('/api/poster', jwtAuthMiddleware, async (req, res) => {
  const requestStart = Date.now()
  const posterData = req.body as PosterData
  const template = getTemplate(posterData.template)
  const requestLogger = log.child({ logId: (req as any).logId || 'unknown', userId: (req as any).userId || null })

  try {
    if (!posterData.cards || !Array.isArray(posterData.cards) || posterData.cards.length === 0) {
      res.status(400).json({ error: 'Invalid request: cards array is required' })
      return
    }

    const cacheKey = posterCache.generateKey(posterData)
    const cached = posterCache.get(cacheKey)
    if (cached) {
      const totalMs = Date.now() - requestStart
      requestLogger.debug({ cacheKey, template: template.name, totalMs }, 'Poster cache HIT')

      res.set('Content-Type', 'image/png')
      res.set('X-Cache', 'HIT')
      res.set('Cache-Control', 'public, max-age=3600')
      res.send(cached)

      metrics.recordRender({
        templateMs: 0,
        resourceMs: 0,
        screenshotMs: 0,
        totalMs,
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

    requestLogger.info({
      cacheKey,
      template: template.name,
      templateMs,
      resourceMs: timings.resourceMs,
      screenshotMs: timings.screenshotMs,
      totalMs,
    }, `Poster cache MISS — rendered in ${totalMs}ms`)

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
    requestLogger.error({ err: error }, 'Poster generation failed')
    res.status(500).json({ error: 'Poster generation failed' })
  }
})

app.get('/api/logs', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const target = req.query.target as string | undefined
  const result = await queryLogs(page, limit, target)
  res.json(result)
})

app.get('/api/logs/:id', adminAuthMiddleware, async (req, res) => {
  const log = await getLogById(req.params.id)
  if (!log) {
    res.status(404).json({ error: 'Log not found' })
    return
  }
  res.json(log)
})

app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const keyword = req.query.keyword as string | undefined
  const result = await queryUsers(page, limit, keyword)
  res.json(result)
})

// ========== 用户级占卜记录（JWT 鉴权）==========

app.post('/api/user/records', jwtAuthMiddleware, async (req, res) => {
  const { spreadType, question, cardsJson, reading, model, isLocal } = req.body as {
    spreadType: string
    question?: string
    cardsJson: string
    reading: string
    model?: string
    isLocal?: boolean
  }

  if (!spreadType || !cardsJson) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'spreadType 和 cardsJson 为必填项' })
    return
  }

  try {
    const record = await saveRecord({
      userId: req.userId!,
      spreadType,
      question: question || null,
      cardsJson,
      reading: reading || '',
      model: model || null,
      isLocal,
    })
    res.status(201).json(record)
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '保存记录失败' })
  }
})

app.get('/api/user/records', jwtAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const result = await getUserRecords(req.userId!, page, limit)
  res.json(result)
})

app.get('/api/user/records/:id', jwtAuthMiddleware, async (req, res) => {
  const record = await getRecordById(req.userId!, req.params.id)
  if (!record) {
    res.status(404).json({ error: 'Record not found' })
    return
  }
  res.json(record)
})

app.delete('/api/user/records/:id', jwtAuthMiddleware, async (req, res) => {
  const deleted = await deleteRecord(req.userId!, req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'Record not found' })
    return
  }
  res.json({ message: '删除成功' })
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

app.put('/api/config/:key', adminAuthMiddleware, async (req, res) => {
  const { key } = req.params
  const { value } = req.body as { value: string }

  // 只读管理员不允许修改配置
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }

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
    log.info({ key, cacheMaxSize: config.cache.maxSize, cacheTtlSeconds: config.cache.ttlSeconds }, 'Cache config applied')
  }

  if (key === 'POOL_MAX_PAGES' || key === 'POOL_ACQUIRE_TIMEOUT_MS') {
    const pool = await getPoolInstance()
    if (pool) {
      pool.updateConfig(config.pool.maxPages, config.pool.acquireTimeoutMs)
      log.info({ key, poolMaxPages: config.pool.maxPages, poolAcquireTimeoutMs: config.pool.acquireTimeoutMs }, 'Pool config applied')
    } else {
      log.warn({ key }, 'Pool config updated but pool not yet initialized — will apply on next launch')
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
  // DB 初始化日志由 src/db/index.ts 的 getDb() 内部输出（含 path + new 标记）

  const defaults = getConfigDefaults()
  await initDefaultConfig(defaults)
  log.info('Default config initialized')

  // 启动时从 DB 恢复用户动态配置（DB 优先于 env）
  const restored = await loadUserConfig()
  if (restored.length > 0) {
    log.info({ restored }, 'Restored user config from database')
  }

  // 初始化管理员账号（首次部署时，默认 admin / admin@123456）
  await initAdminIfNeeded()

  // 输出配置来源分组（from_env / from_default / from_user）
  {
    const fromEnv: string[] = []
    const fromDefault: string[] = []
    const fromUser: string[] = []
    const restoredSet = new Set(restored)
    for (const meta of configMeta) {
      if (restoredSet.has(meta.envKey)) {
        fromUser.push(meta.envKey)
      } else if (process.env[meta.envKey] && process.env[meta.envKey] !== meta.defaultValue) {
        fromEnv.push(meta.envKey)
      } else {
        fromDefault.push(meta.envKey)
      }
    }
    if (fromEnv.length > 0 || fromDefault.length > 0 || fromUser.length > 0) {
      log.info({
        fromEnv,
        fromDefault,
        fromUser,
      }, 'Configuration source summary')
    }
  }

  app.listen(config.port, '0.0.0.0', () => {
    log.info({
      port: config.port,
      nodeEnv: config.nodeEnv,
      timezone: config.timezone,
      logLevel: process.env.LOG_LEVEL || (config.nodeEnv === 'development' ? 'debug' : 'info'),
      geminiKey: config.geminiApiKey ? '***configured***' : 'NOT SET',
      wechatAppId: config.wechatAppId ? '***configured***' : 'NOT SET',
      wechatSecret: config.wechatSecret ? '***configured***' : 'NOT SET',
      jwtSecret: config.jwtSecret ? '***configured***' : 'NOT SET',
      adminDefaultAccount: config.adminInitUsername ? `${config.adminInitUsername} / ***` : 'NOT SET',
      corsOrigin: config.corsOrigin,
      restoredUserConfig: restored.length > 0 ? restored : undefined,
      cacheMaxSize: config.cache.maxSize,
      cacheTtlSeconds: config.cache.ttlSeconds,
      poolMaxPages: config.pool.maxPages,
      poolAcquireTimeoutMs: config.pool.acquireTimeoutMs,
      puppeteerPath: config.puppeteer.executablePath || '(system default)',
      puppeteerArgs: config.puppeteer.args,
      logRetentionDays: config.db.retentionDays,
    }, 'Service started')

    // 周期状态日志 — 每 60s 输出一条 metrics snapshot（健康自检）
    const statusInterval = setInterval(() => {
      const snap = metrics.getSnapshot()
      log.info({
        totalRequests: snap.totalRequests,
        errorCount: snap.errorCount,
        errorRate: snap.totalRequests > 0
          ? (snap.errorCount / snap.totalRequests * 100).toFixed(2) + '%'
          : '0%',
        avgTotalMs: Math.round(snap.avgTotalMs),
        cacheHitRate: (snap.cacheHitRate * 100).toFixed(1) + '%',
        sampleCount: snap.sampleCount,
      }, 'Periodic status report')
    }, 60000)
    statusInterval.unref()
  })
}

start().catch((err) => {
  log.error({ err }, 'Failed to start server')
  process.exit(1)
})

// ========== 优雅关闭 ==========
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...')
  process.exit(0)
})

export default app
