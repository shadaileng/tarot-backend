import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import { insertAuditLog } from '../db/audit.js'

const log = getLogger('Middleware:AdminAuth')

export interface AdminJwtPayload {
  sub: string        // admin.id
  username?: string  // access token 才有
  role?: string      // access token 才有
  type: 'admin'
  tokenType: 'access' | 'refresh'
}

/** Admin JWT 鉴权中间件（业务接口使用，只接受 access token） */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' })
    return
  }

  const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'

  try {
    const decoded = jwt.verify(token, secret) as AdminJwtPayload

    if (decoded.type !== 'admin') {
      insertAuditLog({
        actorType: 'admin',
        actorId: decoded.sub,
        actorName: decoded.username,
        action: 'access_denied',
        targetType: 'admin',
        targetId: decoded.sub,
        newValue: { reason: 'non_admin_token', endpoint: req.path },
        ipAddress: req.ip,
      })
      res.status(403).json({ error: 'FORBIDDEN', message: '非管理员 token' })
      return
    }

    if (decoded.tokenType !== 'access') {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }

    ;(req as any).adminId = decoded.sub
    ;(req as any).adminUsername = decoded.username
    ;(req as any).adminRole = decoded.role

    next()
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录' })
      return
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }
    log.error({ err }, 'Admin JWT verification failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
