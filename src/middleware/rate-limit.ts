import type { Request, Response, NextFunction } from 'express'
import { getLogger } from '../logger.js'

const log = getLogger('Middleware:RateLimit')

// ========== 配置 ==========

/** 时间窗口：1 分钟（毫秒） */
const WINDOW_MS = 60_000
/** 每分钟最大请求数 */
const MAX_PER_MINUTE = 3

// ========== 内存存储 ==========

interface RateLimitEntry {
  count: number
  windowStart: number
}

const store = new Map<string, RateLimitEntry>()

/** 定期清理过期条目（每 5 分钟） */
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now - entry.windowStart > WINDOW_MS) {
      store.delete(key)
    }
  }
}, 5 * 60_000).unref()

// ========== 中间件 ==========

/**
 * 频率限制中间件
 * 策略：每用户每分钟最多 3 次（日额度由 quotaMiddleware 管理）
 * 需在 jwtAuthMiddleware 之后使用（依赖 req.userId）
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) return next()

  const now = Date.now()
  const entry = store.get(req.userId) || { count: 0, windowStart: now }

  // 分钟窗口检查
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0
    entry.windowStart = now
  }

  if (entry.count >= MAX_PER_MINUTE) {
    const resetIn = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)
    res.set('Retry-After', String(resetIn))
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `请求过于频繁，请在 ${resetIn} 秒后重试（每分钟最多 ${MAX_PER_MINUTE} 次）`,
    })
    return
  }

  // 计数
  entry.count++
  store.set(req.userId, entry)

  // 响应头
  res.set('X-RateLimit-Minute-Remaining', String(MAX_PER_MINUTE - entry.count))

  next()
}

/** 获取当前限流状态（用于调试/监控） */
export function getRateLimitStats() {
  return { totalTracked: store.size }
}
