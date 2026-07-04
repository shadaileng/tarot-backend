import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { findById, findByEmail, bindEmail, mergeAccount } from '../db/user.js'
import { insertAuditLog } from '../db/audit.js'
import { getLogger } from '../logger.js'
import type { BindEmailRequest } from '../types/auth.js'

const log = getLogger('Auth:BindEmail')

/**
 * POST /auth/bind-email（需 JWT 鉴权）
 * 小程序端绑定邮箱：当前用户 + email + password → bcrypt → 绑定
 * 如果邮箱已被其他账号注册，验证密码后自动合并两账号
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
      // 邮箱已注册 → 验证密码，合并账号
      if (!existing.password_hash) {
        res.status(400).json({ error: 'EMAIL_NO_PASSWORD', message: '该邮箱账号未设置密码，无法绑定' })
        return
      }
      const valid = await bcrypt.compare(password, existing.password_hash)
      if (!valid) {
        res.status(403).json({ error: 'EMAIL_OR_PASSWORD_MISMATCH', message: '邮箱或密码错误' })
        return
      }
      // 密码正确 → 合并账号（迁移占卜记录，删除旧账号）
      await mergeAccount(userId, existing.id)
      log.info({ userId, mergedFrom: existing.id, email }, 'Account merged on email bind')
      res.json({
        message: '邮箱绑定成功，已与已有账号合并',
        email,
      })
      return
    }

    // bcrypt 哈希
    const passwordHash = await bcrypt.hash(password, 10)

    // 绑定
    await bindEmail(userId, email, passwordHash)

    log.info({ userId, email }, 'Email bound to account')

    // 记录审计日志
    insertAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'bind_email',
      targetType: 'user',
      targetId: userId,
      oldValue: { email: currentUser.email || null },
      newValue: { email },
      ipAddress: req.ip,
    })

    res.json({
      message: '邮箱绑定成功',
      email,
    })
  } catch (err) {
    log.error({ err }, 'Bind email failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}
