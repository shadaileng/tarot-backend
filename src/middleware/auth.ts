// API Key 鉴权中间件
// 未配置 API Key 时自动跳过

import type { Request, Response, NextFunction } from 'express'
import { config } from '../config.js'

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 未配置 API Key 时跳过鉴权
  if (!config.apiKey) {
    return next()
  }

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (token !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}
