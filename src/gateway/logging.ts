import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { insertRequestLog } from '../db/request-log.js'
import { getLogger } from '../logger.js'

const log = getLogger('gateway')

const SKIP_PATHS = ['/', '/api/health', '/api/metrics', '/api/logs']

// 精确匹配表（O(1) 查找）
const EXACT_TARGETS = new Map<string, string>([
  ['/api/reading', 'reading'],
  ['/api/checkin', 'user'],
  ['/api/tasks', 'user'],
])

// 前缀匹配表（按长度降序排列，避免短前缀误匹配）
const PREFIX_TARGETS: [string, string][] = [
  ['/api/admin/menus', 'admin:menu'],
  ['/api/admin/admins', 'admin:admin'],
  ['/api/admin/users', 'admin:user'],
  ['/api/admin/audit-logs', 'admin:audit'],
  ['/api/admin/client-events', 'admin:events'],
  ['/api/admin', 'admin'],
  ['/api/auth', 'auth'],
  ['/admin/auth', 'auth'],
  ['/api/user', 'user'],
  ['/api/poster', 'poster'],
]

function resolveTarget(path: string): string {
  // 1. 精确匹配（O(1)）
  const exact = EXACT_TARGETS.get(path)
  if (exact) return exact

  // 2. 前缀匹配（有序，避免 /api/admin 误匹配 /api/admin/menus）
  for (const [prefix, target] of PREFIX_TARGETS) {
    if (path.startsWith(prefix)) return target
  }

  return 'other'
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.includes(req.path) || req.path.startsWith('/api/logs/')) {
    next()
    return
  }

  const start = Date.now()
  const logId = crypto.randomUUID()
  const requestBody = req.body || {}
  const target = resolveTarget(req.path)
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
