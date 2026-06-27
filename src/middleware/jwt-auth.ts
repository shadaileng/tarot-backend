import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import { findById } from '../db/user.js'
import type { JwtPayload } from '../types/auth.js'

const log = getLogger('Middleware:JWT')

/**
 * JWT 鉴权中间件
 * 从 Authorization: Bearer <token> 提取并验证 JWT
 * 验证通过后将 userId 和 openid 注入 req 对象
 * 检查用户是否已被逻辑删除，若已删除则拒绝访问
 */
export async function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: '缺少认证 token' })
    return
  }

  const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'

  try {
    const decoded = jwt.verify(token, secret) as JwtPayload

    if (!decoded.sub) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }

    // 检查用户是否已被逻辑删除
    const user = await findById(decoded.sub)
    if (!user || user.deleted_at) {
      res.status(401).json({ error: 'ACCOUNT_DELETED', message: '账号已被注销' })
      return
    }

    req.userId = decoded.sub
    req.openid = decoded.openid || ''

    next()
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'token 已过期，请重新登录' })
      return
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }
    log.error({ err }, 'JWT verification failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
