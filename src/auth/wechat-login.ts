import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import { findByOpenid, findByUnionid, createUser, updateLastLogin, updateUnionid, toUserInfo } from '../db/user.js'
import { createUserStats, findByReferralCode } from '../db/user-stats.js'
import { initUserTasks } from '../db/tasks.js'
import type { WechatLoginRequest, WechatSession } from '../types/auth.js'

const log = getLogger('Auth:WechatLogin')

/**
 * POST /auth/wechat-login
 * 小程序微信登录：code → jscode2session → openid → 查/建用户 → 签发 JWT
 */
export async function wechatLoginHandler(req: Request, res: Response): Promise<void> {
  try {
    const { code } = req.body as WechatLoginRequest

    if (!code) {
      res.status(400).json({ error: 'INVALID_CODE', message: '缺少登录凭证 code' })
      return
    }

    // 检查微信配置
    if (!config.wechatAppId || !config.wechatSecret) {
      log.warn('WeChat not configured')
      res.status(400).json({ error: 'WECHAT_NOT_CONFIGURED', message: '微信登录未配置' })
      return
    }

    // 调用微信 jscode2session
    const session = await exchangeCodeForSession(code)
    if (!session.openid) {
      log.error({ errcode: session.errcode, errmsg: session.errmsg }, 'WeChat API error')
      res.status(400).json({ error: 'WECHAT_ERROR', message: session.errmsg || '微信接口调用失败' })
      return
    }

    const { openid, unionid } = session
    log.info({ openid, unionid }, 'WeChat login')

    // 按优先级查找用户
    let user = await findByOpenid(openid)
    let isNewUser = false

    if (user) {
      // 检查是否已注销
      if (user.deleted_at) {
        log.warn({ userId: user.id, openid }, 'Deleted user attempted to log in')
        res.status(403).json({ error: 'ACCOUNT_DELETED', message: '账号已被注销，无法登录' })
        return
      }
      // 已有用户：更新 unionid 和最后登录时间
      if (unionid && !user.unionid) {
        await updateUnionid(user.id, unionid)
        user.unionid = unionid
      }
      await updateLastLogin(user.id)
    } else if (unionid) {
      // 按 unionid 查找（可能已有邮箱注册账号）
      user = await findByUnionid(unionid)
      if (user) {
        // 检查是否已注销
        if (user.deleted_at) {
          log.warn({ userId: user.id, unionid, openid }, 'Deleted user attempted to log in via unionid')
          res.status(403).json({ error: 'ACCOUNT_DELETED', message: '账号已被注销，无法登录' })
          return
        }
        await updateLastLogin(user.id)
        log.info({ userId: user.id, unionid, openid }, 'User linked by unionid')
      }
    }

    if (!user) {
      // 新用户
      const { referralCode } = req.body as WechatLoginRequest & { referralCode?: string }
      let invitedBy: string | undefined
      if (referralCode) {
        const inviter = await findByReferralCode(referralCode)
        if (inviter) invitedBy = referralCode
      }
      user = await createUser({
        openid,
        unionid: unionid || undefined,
      })
      await createUserStats(user.id, invitedBy)
      await initUserTasks(user.id)
      isNewUser = true
    }

    // 签发 JWT
    const token = signJwt(user.id, openid)

    res.json({
      token,
      isNewUser,
      user: toUserInfo(user),
    })
  } catch (err) {
    log.error({ err }, 'WeChat login failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}

/** 调用微信 jscode2session */
async function exchangeCodeForSession(code: string): Promise<WechatSession> {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${config.wechatAppId}&secret=${config.wechatSecret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`

  const response = await fetch(url)
  const data = (await response.json()) as WechatSession
  return data
}

/** 签发 JWT：payload 含 sub(userId) + openid，有效期 30 天 */
export function signJwt(userId: string, openid: string): string {
  const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'
  return jwt.sign({ sub: userId, openid }, secret, { expiresIn: '30d' })
}
