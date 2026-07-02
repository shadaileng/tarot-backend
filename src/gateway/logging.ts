import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { insertRequestLog } from '../db/request-log.js'
import { insertReadingLog } from '../db/reading-log.js'
import { getLogger } from '../logger.js'

const log = getLogger('gateway')

const SKIP_PATHS = ['/', '/api/health', '/api/metrics', '/api/logs']

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.includes(req.path) || req.path.startsWith('/api/logs/')) {
    next()
    return
  }

  const start = Date.now()
  const logId = crypto.randomUUID()
  const requestBody = req.body || {}
  const target = req.path === '/api/reading' ? 'reading' : req.path === '/api/poster' ? 'poster' : 'other'
  const ip = req.ip || req.socket.remoteAddress || ''

  // 将 logId 注入到 req，供下游 handler 串联日志
  ;(req as any).logId = logId

  let logWritten = false

  function writeLog(body: any): void {
    if (logWritten) return
    logWritten = true
    const duration = Date.now() - start
    const userId = (req as any).userId || null
    const isError = res.statusCode >= 400
    const respObj = body && typeof body === 'object' && !Buffer.isBuffer(body)
      ? body as Record<string, any>
      : null

    const errorMsg = isError && respObj
      ? (respObj.error || respObj.detail || null)
      : null

    // 访问日志 — 每个请求结束输出一条
    if (isError) {
      log.warn({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        ip,
        logId,
        target,
        error: errorMsg,
      }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms (error)`)
    } else {
      log.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        ip,
        logId,
        target,
      }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
    }

    // 从响应头提取分阶段耗时（poster 请求）
    const templateMs = parseInt(res.getHeader('X-Render-Template-Ms') as string) || null
    const resourceMs = parseInt(res.getHeader('X-Render-Resource-Ms') as string) || null
    const screenshotMs = parseInt(res.getHeader('X-Render-Screenshot-Ms') as string) || null
    const cacheHit = res.getHeader('X-Cache') === 'HIT'

    // 写入 request_logs（所有请求）
    insertRequestLog({
      id: logId,
      method: req.method,
      path: req.path,
      target,
      status_code: res.statusCode,
      duration_ms: duration,
      template_ms: templateMs,
      resource_ms: resourceMs,
      screenshot_ms: screenshotMs,
      cache_hit: cacheHit,
      ip_address: ip,
      is_error: isError,
      error_msg: errorMsg,
      user_id: userId,
    }).then(() => {
      log.info({ logId, target, userId }, 'insertRequestLog OK')
    }).catch((err) => {
      log.error({ err, logId, target, userId, statusCode: res.statusCode }, 'insertRequestLog FAILED')
    })

    // 写入 reading_logs（仅 reading 请求）
    if (target === 'reading') {
      insertReadingLog({
        id: logId,
        user_id: userId,
        question: requestBody.question || null,
        cards_json: requestBody.cards ? JSON.stringify(requestBody.cards) : null,
        reading: respObj ? (respObj.reading || null) : null,
        model: respObj ? (respObj.model || null) : null,
        incomplete: respObj ? !!(respObj.incomplete) : false,
      }).then(() => {
        log.info({ logId, target, userId }, 'insertReadingLog OK')
      }).catch((err) => {
        log.error({ err, logId, target, userId }, 'insertReadingLog FAILED')
      })
    }
  }

  const originalJson = res.json.bind(res)
  const originalSend = res.send.bind(res)

  res.json = function (body: any) {
    writeLog(body)
    return originalJson(body)
  }

  res.send = function (body: any) {
    if (!logWritten) {
      writeLog(body)
    }
    return originalSend(body)
  }

  next()
}
