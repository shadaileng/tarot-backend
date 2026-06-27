import type { Request, Response } from 'express'
import { getLogger } from '../logger.js'
import { getUserLevelInfo, getLevelDefinitions } from '../db/user-stats.js'

const log = getLogger('Auth:Stats')

/**
 * GET /api/user/stats
 * 获取用户积分/等级/额度信息
 */
export async function getUserStatsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const info = await getUserLevelInfo(userId)
    if (!info) {
      res.status(404).json({ error: 'NOT_FOUND', message: '用户统计数据不存在' })
      return
    }
    res.json(info)
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Get user stats failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取统计数据失败' })
  }
}

/**
 * GET /api/levels
 * 获取等级配置表（公开）
 */
export async function getLevelsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const levels = await getLevelDefinitions()
    res.json({ levels })
  } catch (err) {
    log.error({ err }, 'Get level definitions failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取等级配置失败' })
  }
}
