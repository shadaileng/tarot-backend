import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { findById, findByEmail, bindEmail } from '../db/user.js'
import { getLogger } from '../logger.js'
import type { BindEmailRequest } from '../types/auth.js'

const log = getLogger('Auth:BindEmail')

/**
 * POST /auth/bind-email（需 JWT 鉴权）
 * 小程序端绑定邮箱：当前用户 + email + password → bcrypt → 绑定
 */
export async function bindEmailHandler(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as BindEmailRequest
    const userId = req.userId!

    if (!email || !password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '邮箱和密码不能为空' })
      return
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      res.status(400).json({ error: 'INVALID_EMAIL', message: '邮箱格式不正确' })
      return
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: '密码至少需要 6 个字符' })
      return
    }

    // 检查当前用户是否已绑定邮箱
    const currentUser = await findById(userId)
    if (!currentUser) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '用户不存在' })
      return
    }

    if (currentUser.email) {
      res.status(400).json({ error: 'EMAIL_ALREADY_BOUND_TO_THIS_ACCOUNT', message: '该账号已绑定邮箱，无法修改' })
      return
    }

    // 检查邮箱是否已被其他用户绑定
    const existing = await findByEmail(email)
    if (existing) {
      res.status(409).json({ error: 'EMAIL_ALREADY_BOUND', message: '该邮箱已被其他账号绑定' })
      return
    }

    // bcrypt 哈希
    const passwordHash = await bcrypt.hash(password, 10)

    // 绑定
    await bindEmail(userId, email, passwordHash)

    log.info({ userId, email }, 'Email bound to account')

    res.json({
      message: '邮箱绑定成功',
      email,
    })
  } catch (err) {
    log.error({ err }, 'Bind email failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
