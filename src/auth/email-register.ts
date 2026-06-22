import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { findByEmail, createUser, toUserInfo } from '../db/user.js'
import { signJwt } from './wechat-login.js'
import { getLogger } from '../logger.js'
import type { EmailRegisterRequest } from '../types/auth.js'

const log = getLogger('Auth:EmailRegister')

/**
 * POST /auth/email-register
 * H5 邮箱注册：email + password → bcrypt 哈希 → 创建用户 → 签发 JWT
 */
export async function emailRegisterHandler(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as EmailRegisterRequest

    // 校验
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

    // 检查邮箱是否已注册
    const existing = await findByEmail(email)
    if (existing) {
      res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS', message: '该邮箱已被注册' })
      return
    }

    // bcrypt 哈希密码
    const passwordHash = await bcrypt.hash(password, 10)

    // 创建用户
    const user = await createUser({
      email,
      passwordHash,
      nickname: email.split('@')[0],
    })

    log.info({ userId: user.id, email }, 'Email registered')

    // 签发 JWT
    const token = signJwt(user.id, user.openid || '')

    res.status(201).json({
      token,
      user: toUserInfo(user),
    })
  } catch (err) {
    log.error({ err }, 'Email registration failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
