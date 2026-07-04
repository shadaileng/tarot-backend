// CORS 中间件

import type { Request, Response, NextFunction } from 'express'
import { config } from '../config.js'

export function corsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Key, X-Cache, X-Render-Template-Ms, X-Render-Resource-Ms, X-Render-Screenshot-Ms, X-Render-Total-Ms')
  res.setHeader('Access-Control-Max-Age', '86400')

  if (_req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  next()
}
