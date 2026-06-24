import type { Request, Response, NextFunction } from 'express'
import { authMiddleware } from './auth.js'
import { adminAuthMiddleware } from './admin-auth.js'
import { config } from '../config.js'

/**
 * Admin 认证兼容中间件
 *
 * 根据 ADMIN_AUTH_MODE 环境变量决定认证策略：
 * - 'api_key' → 仅 API Key 认证
 * - 'jwt'     → 仅 Admin JWT 认证
 * - 'dual'    → 两者任一通过即可（默认 / 过渡期）
 */
export function adminCompatMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mode = config.adminAuthMode || 'dual'

  if (mode === 'api_key') {
    return authMiddleware(req, res, next)
  }

  if (mode === 'jwt') {
    return adminAuthMiddleware(req, res, next)
  }

  // === dual mode ===
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  // 先尝试 API Key 匹配
  if (config.apiKey && token === config.apiKey) {
    return next()
  }

  // 否则尝试 Admin JWT
  return adminAuthMiddleware(req, res, next)
}
