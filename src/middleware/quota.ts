import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import { consumeQuota, getAvailableQuota, incrementReadings, addPoints, resetDailyQuotaIfNeeded } from '../db/user-stats.js'
import { advanceTaskProgress } from '../db/tasks.js'
import { completeInvite } from '../db/invite.js'
import { insertAuditLog } from '../db/audit.js'
import type { JwtPayload } from '../types/auth.js'

const log = getLogger('Middleware:Quota')

const GUEST_DAILY_LIMIT = 2

const guestStore = new Map<string, { count: number; date: string }>()

function getTodayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

setInterval(() => {
  const today = getTodayDate()
  for (const [ip, entry] of guestStore) {
    if (entry.date !== today) guestStore.delete(ip)
  }
}, 30 * 60 * 1000).unref()

/**
 * 额度检查中间件
 * - 可选解析 JWT（不强制登录）
 * - 登录用户：读取 DB 额度
 * - 游客：基于 IP 的内存计数（每天 2 次）
 * - 占用响应成功时自动消耗额度并更新统计
 */
export async function quotaMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'
      const decoded = jwt.verify(authHeader.slice(7), secret) as JwtPayload
      req.userId = decoded.sub
      req.openid = decoded.openid
    } catch {
      // 无效 token，按游客处理
    }
  }

  let isGuest = false
  if (req.userId) {
    await resetDailyQuotaIfNeeded(req.userId)
    const available = await getAvailableQuota(req.userId)
    if (available.remaining <= 0) {
      res.status(429).json({
        error: 'DAILY_QUOTA_EXCEEDED',
        message: '今日解读额度已用完，完成签到或任务可获得额外额度',
      })
      return
    }
  } else {
    isGuest = true
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const today = getTodayDate()
    const entry = guestStore.get(ip)
    if (entry && entry.date === today && entry.count >= GUEST_DAILY_LIMIT) {
      res.status(429).json({
        error: 'GUEST_DAILY_LIMIT',
        message: `游客每天可免费使用 ${GUEST_DAILY_LIMIT} 次，登录后可获得更多额度`,
      })
      return
    }
  }

  const isAsyncRoute = req.path === '/api/reading/start'

  const userId = req.userId
  if (userId) {
    if (isAsyncRoute) {
      // 异步解读路由：立即消费额度，不等待 finish 回调
      consumeQuota(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to consume quota'))
      incrementReadings(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to increment readings'))
      addPoints(userId, 2).catch((e: Error) => log.warn({ err: e }, 'Failed to add points'))
      advanceTaskProgress(userId, 'read_count').catch((e: Error) => log.warn({ err: e }, 'Failed to advance task'))
      completeInvite(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to process invite'))
      insertAuditLog({
        actorType: 'user',
        actorId: userId,
        action: 'quota_consume',
        targetType: 'reading',
        ipAddress: req.ip,
      }).catch((e: Error) => log.warn({ err: e }, 'Failed to insert audit log'))
      insertAuditLog({
        actorType: 'system',
        actorId: null,
        action: 'points_earn',
        targetType: 'user',
        targetId: userId,
        newValue: { points: 2, reason: 'reading_reward' },
        ipAddress: req.ip,
      }).catch((e: Error) => log.warn({ err: e }, 'Failed to insert audit log'))
    } else {
      const finishHandler = () => {
        if (res.statusCode === 200) {
          consumeQuota(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to consume quota'))
          incrementReadings(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to increment readings'))
          addPoints(userId, 2).catch((e: Error) => log.warn({ err: e }, 'Failed to add points'))
          advanceTaskProgress(userId, 'read_count').catch((e: Error) => log.warn({ err: e }, 'Failed to advance task'))
          completeInvite(userId).catch((e: Error) => log.warn({ err: e }, 'Failed to process invite'))
          insertAuditLog({
            actorType: 'user',
            actorId: userId,
            action: 'quota_consume',
            targetType: 'reading',
            ipAddress: req.ip,
          }).catch((e: Error) => log.warn({ err: e }, 'Failed to insert audit log'))
          insertAuditLog({
            actorType: 'system',
            actorId: null,
            action: 'points_earn',
            targetType: 'user',
            targetId: userId,
            newValue: { points: 2, reason: 'reading_reward' },
            ipAddress: req.ip,
          }).catch((e: Error) => log.warn({ err: e }, 'Failed to insert audit log'))
        }
      }
      res.on('finish', finishHandler)
    }
  } else if (isGuest) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const today = getTodayDate()
    const finishHandler = () => {
      if (res.statusCode === 200) {
        const entry = guestStore.get(ip)
        if (entry && entry.date === today) {
          entry.count++
        } else {
          guestStore.set(ip, { count: 1, date: today })
        }
      }
    }
    res.on('finish', finishHandler)
  }

  next()
}

/** 获取游客额度统计（调试用）*/
export function getGuestQuotaStats() {
  return { trackedIPs: guestStore.size, dailyLimit: GUEST_DAILY_LIMIT }
}
