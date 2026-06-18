import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { insertLog } from '../db/reading-log.js'

const SKIP_PATHS = ['/', '/health', '/metrics', '/logs']

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.includes(req.path) || req.path.startsWith('/logs/')) {
    next()
    return
  }

  const start = Date.now()
  const logId = crypto.randomUUID()
  const requestBody = req.body || {}

  const originalSend = res.send.bind(res)
  const originalJson = res.json.bind(res)
  let responseBody: any = null

  res.json = function (body: any) {
    responseBody = body
    return originalJson(body)
  }

  res.send = function (body: any) {
    if (responseBody === null) {
      responseBody = body
    }
    return originalSend(body)
  }

  let responseLogged = false

  res.on('finish', () => {
    if (responseLogged) return
    responseLogged = true
    const duration = Date.now() - start
    const target = req.path === '/reading' ? 'reading' : req.path === '/poster' ? 'poster' : 'other'

    if (target === 'other') return

    const isError = res.statusCode >= 400
    const respObj = responseBody && typeof responseBody === 'object' && !Buffer.isBuffer(responseBody)
      ? responseBody as Record<string, any>
      : null

    const errorMsg = isError && respObj
      ? (respObj.error || respObj.detail || null)
      : null

    insertLog({
      id: logId,
      method: req.method,
      path: req.path,
      target,
      status_code: res.statusCode,
      duration_ms: duration,
      ip_address: req.ip || req.socket.remoteAddress || '',
      question: requestBody.question || null,
      cards_json: requestBody.cards ? JSON.stringify(requestBody.cards) : null,
      reading: target === 'reading' && respObj ? (respObj.reading || null) : null,
      model: target === 'reading' && respObj ? (respObj.model || null) : null,
      incomplete: target === 'reading' && respObj ? !!(respObj.incomplete) : false,
      is_error: isError,
      error_msg: errorMsg,
    }).catch(() => {})
  })

  req.on('close', () => {
    if (responseLogged) return
    responseLogged = true
    const duration = Date.now() - start
    const target = req.path === '/reading' ? 'reading' : req.path === '/poster' ? 'poster' : 'other'
    if (target === 'other') return
    insertLog({
      id: logId,
      method: req.method,
      path: req.path,
      target,
      status_code: 499,
      duration_ms: duration,
      ip_address: req.ip || req.socket.remoteAddress || '',
      question: requestBody.question || null,
      cards_json: requestBody.cards ? JSON.stringify(requestBody.cards) : null,
      reading: null,
      model: null,
      incomplete: false,
      is_error: true,
      error_msg: 'Client disconnected before response completed',
    }).catch(() => {})
  })

  next()
}
