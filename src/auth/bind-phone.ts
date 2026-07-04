import type { Request, Response } from 'express'
import { config } from '../config.js'
import { findById, bindPhone } from '../db/user.js'
import { insertAuditLog } from '../db/audit.js'
import { getLogger } from '../logger.js'
import type { BindPhoneRequest } from '../types/auth.js'

const log = getLogger('Auth:BindPhone')

/**
 * POST /auth/bind-phone（需 JWT 鉴权）
 * 小程序端绑定手机号：code（getPhoneNumber 返回）→ 微信解密 → 绑定
 */
export async function bindPhoneHandler(req: Request, res: Response): Promise<void> {
  try {
    const { code } = req.body as BindPhoneRequest
    const userId = req.userId!

    if (!code) {
      res.status(400).json({ error: 'INVALID_PHONE_CODE', message: '缺少手机号授权 code' })
      return
    }

    // 检查当前用户
    const currentUser = await findById(userId)
    if (!currentUser) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '用户不存在' })
      return
    }

    if (currentUser.phone) {
      res.status(400).json({ error: 'PHONE_ALREADY_BOUND', message: '该账号已绑定手机号' })
      return
    }

    // 调用微信 getPhoneNumber API 获取真实手机号
    const phone = await exchangePhoneNumber(code)

    if (!phone) {
      res.status(400).json({ error: 'INVALID_PHONE_CODE', message: '获取手机号失败' })
      return
    }

    // 绑定
    await bindPhone(userId, phone)

    // 脱敏返回
    const masked = phone.slice(0, 3) + '****' + phone.slice(-4)

    log.info({ userId }, 'Phone bound')

    // 记录审计日志
    insertAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'bind_phone',
      targetType: 'user',
      targetId: userId,
      oldValue: { phone: currentUser.phone || null },
      newValue: { phone: masked },
      ipAddress: req.ip,
    })

    res.json({
      message: '手机号绑定成功',
      phone: masked,
    })
  } catch (err) {
    log.error({ err }, 'Bind phone failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}

/**
 * 调用微信 getPhoneNumber API
 * 需要先获取 access_token，然后用 code 换取手机号
 * 参考：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html
 */
async function exchangePhoneNumber(code: string): Promise<string | null> {
  if (!config.wechatAppId || !config.wechatSecret) {
    log.warn('WeChat not configured, cannot exchange phone number')
    return null
  }

  try {
    // 1. 获取 access_token
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechatAppId}&secret=${config.wechatSecret}`
    const tokenRes = await fetch(tokenUrl)
    const tokenData = (await tokenRes.json()) as { access_token?: string; errcode?: number; errmsg?: string }

    if (!tokenData.access_token) {
      log.error({ errcode: tokenData.errcode, errmsg: tokenData.errmsg }, 'Failed to get access_token')
      return null
    }

    // 2. 用 code 换取手机号
    const phoneUrl = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${tokenData.access_token}`
    const phoneRes = await fetch(phoneUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const phoneData = (await phoneRes.json()) as {
      errcode: number
      errmsg: string
      phone_info?: { phoneNumber: string; purePhoneNumber: string; countryCode: string }
    }

    if (phoneData.errcode === 0 && phoneData.phone_info) {
      return phoneData.phone_info.purePhoneNumber
    }

    log.error({ errcode: phoneData.errcode, errmsg: phoneData.errmsg }, 'Failed to get phone number')
    return null
  } catch (err) {
    log.error({ err }, 'Phone number exchange failed')
    return null
  }
}
