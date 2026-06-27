import type { Request, Response } from 'express'
import { findById, toUserInfo } from '../db/user.js'

/**
 * GET /user/profile（需 JWT 鉴权）
 * 获取当前用户资料
 */
export async function getProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const user = await findById(req.userId!)
    if (!user) {
      res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' })
      return
    }
    res.json({ user: toUserInfo(user) })
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
