import type { Request, Response } from 'express'
import { findById, toUserInfo } from '../db/user.js'
import { getUserLevelInfo } from '../db/user-stats.js'

/**
 * GET /user/profile（需 JWT 鉴权）
 * 获取当前用户资料（含等级信息）
 */
export async function getProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const user = await findById(req.userId!)
    if (!user) {
      res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' })
      return
    }
    const levelInfo = await getUserLevelInfo(req.userId!)
    res.json({
      user: {
        ...toUserInfo(user),
        level: levelInfo?.level ?? 1,
        levelTitle: levelInfo?.title ?? '',
        points: levelInfo?.points ?? 0,
        nextLevelPoints: levelInfo?.nextLevelPoints,
        levelProgress: levelInfo?.progress ?? 0,
        remainingQuota: levelInfo?.remainingQuota ?? 0,
        totalQuota: levelInfo?.totalQuota ?? 0,
      },
    })
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
