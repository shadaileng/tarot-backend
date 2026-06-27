import type { Request, Response } from 'express'
import { updateProfile as updateUserProfile, toUserInfo } from '../db/user.js'
import { getLogger } from '../logger.js'
import type { UpdateProfileRequest } from '../types/auth.js'

const log = getLogger('Auth:UpdateProfile')

/**
 * PUT /user/profile（需 JWT 鉴权）
 * 更新用户资料：昵称 / 头像 / 性别 / 生日
 */
export async function updateProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { nickname, avatarUrl, gender, birthday } = req.body as UpdateProfileRequest
    const userId = req.userId!

    // 至少需要一个字段
    if (nickname === undefined && avatarUrl === undefined && gender === undefined && birthday === undefined) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '至少需要提供一个更新字段' })
      return
    }

    // 校验昵称
    if (nickname !== undefined) {
      if (typeof nickname !== 'string' || nickname.trim().length === 0) {
        res.status(400).json({ error: 'INVALID_NICKNAME', message: '昵称不能为空' })
        return
      }
      if (nickname.length > 30) {
        res.status(400).json({ error: 'INVALID_NICKNAME', message: '昵称不能超过 30 个字符' })
        return
      }
    }

    // 校验性别
    let parsedGender = gender
    if (gender !== undefined) {
      parsedGender = Number(gender)
      if (![0, 1, 2].includes(parsedGender)) {
        res.status(400).json({ error: 'INVALID_GENDER', message: '性别值无效（0=保密, 1=男, 2=女）' })
        return
      }
    }

    // 校验生日
    if (birthday !== undefined && birthday !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        res.status(400).json({ error: 'INVALID_BIRTHDAY', message: '生日格式无效（须为 YYYY-MM-DD）' })
        return
      }
    }

    // 更新
    const updated = await updateUserProfile(userId, {
      nickname: nickname?.trim(),
      avatarUrl: avatarUrl || undefined,
      gender: parsedGender !== undefined ? parsedGender : undefined,
      birthday: birthday !== undefined ? birthday : undefined,
    })

    if (!updated) {
      res.status(404).json({ error: 'USER_NOT_FOUND', message: '用户不存在' })
      return
    }

    log.info({ userId, nickname, avatarUrl, gender: parsedGender, birthday }, 'Profile updated')

    res.json({ user: toUserInfo(updated) })
  } catch (err) {
    log.error({ err }, 'Update profile failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
