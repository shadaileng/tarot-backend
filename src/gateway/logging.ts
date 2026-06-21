import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { insertLog } from '../db/reading-log.js'
import { getLogger } from '../logger.js'

const log = getLogger('gateway')

const SKIP_PATHS = ['/', '/health', '/metrics', '/logs']

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.includes(req.path) || req.path.startsWith('/logs/')) {
    next()
    return
  }

  const start = Date.now()
  const logId = crypto.randomUUID()
  const requestBody = req.body || {}
  const target = req.path === '/reading' ? 'reading' : req.path === '/poster' ? 'poster' : 'other'
  const ip = req.ip || req.socket.remoteAddress || ''

  // 将 logId 注入到 req，供下游 handler 串联日志
  ;(req as any).logId = logId

  let logWritten = false

  function writeLog(body: any): void {
    if (logWritten || target === 'other') return
    logWritten = true
    const duration = Date.now() - start
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

    insertLog({
      id: logId,
      method: req.method,
      path: req.path,
      target,
      status_code: res.statusCode,
      duration_ms: duration,
      ip_address: ip,
      question: requestBody.question || null,
      cards_json: requestBody.cards ? JSON.stringify(requestBody.cards) : null,
      reading: target === 'reading' && respObj ? (respObj.reading || null) : null,
      model: target === 'reading' && respObj ? (respObj.model || null) : null,
      incomplete: target === 'reading' && respObj ? !!(respObj.incomplete) : false,
      is_error: isError,
      error_msg: errorMsg,
    }).catch((err) => {
      log.error({ err, logId }, 'Failed to insert log')
    })
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
