import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { findByEmail, updateLastLogin, toUserInfo } from '../db/user.js'
import { signJwt } from './wechat-login.js'
import { getLogger } from '../logger.js'
import type { EmailLoginRequest } from '../types/auth.js'

const log = getLogger('Auth:EmailLogin')

/**
 * POST /auth/email-login
 * H5 邮箱登录：email + password → 验证 bcrypt → 签发 JWT
 */
export async function emailLoginHandler(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as EmailLoginRequest

    if (!email || !password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '邮箱和密码不能为空' })
      return
    }

    // 查找用户
    const user = await findByEmail(email)
    if (!user || !user.password_hash) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' })
      return
    }

    // 验证密码
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' })
      return
    }

    // 更新最后登录时间
    await updateLastLogin(user.id)

    log.info({ userId: user.id, email }, 'Email login')

    // 签发 JWT
    const token = signJwt(user.id, user.openid || '')

    res.json({
      token,
      isNewUser: false,
      user: toUserInfo(user),
    })
  } catch (err) {
    log.error({ err }, 'Email login failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
