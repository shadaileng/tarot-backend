import type { Request, Response } from 'express'
import { getLogger } from '../logger.js'
import { updateInvitedBy } from '../db/user-stats.js'
import { getReferralCode, getInviteRecords, getMyInviter, createPendingInvite } from '../db/invite.js'
import { insertAuditLog } from '../db/audit.js'

const log = getLogger('Auth:Invite')

/**
 * GET /api/invite/code
 * 获取我的邀请码
 */
export async function getInviteCodeHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const code = await getReferralCode(userId)
    if (!code) {
      res.status(404).json({ error: 'NOT_FOUND', message: '邀请码不存在' })
      return
    }
    res.json({ referralCode: code })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Get invite code failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取邀请码失败' })
  }
}

/**
 * GET /api/invite/records
 * 获取邀请记录
 */
export async function getInviteRecordsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const [records, inviter] = await Promise.all([
      getInviteRecords(userId),
      getMyInviter(userId),
    ])
    res.json({ records, inviter })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Get invite records failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取邀请记录失败' })
  }
}

/**
 * POST /api/user/bind-referral
 * 绑定邀请码
 */
export async function bindReferralHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const { referralCode } = req.body as { referralCode?: string }

    if (!referralCode) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '邀请码不能为空' })
      return
    }

    const result = await updateInvitedBy(userId, referralCode)
    if (!result.success) {
      const statusMap: Record<string, number> = {
        INVITE_CODE_NOT_FOUND: 404,
        CANNOT_INVITE_SELF: 400,
        USER_STATS_NOT_FOUND: 404,
        ALREADY_INVITED: 409,
      }
      res.status(statusMap[result.error!] || 400).json({
        error: result.error,
        message: result.error === 'INVITE_CODE_NOT_FOUND' ? '邀请码不存在' :
                 result.error === 'CANNOT_INVITE_SELF' ? '不能填写自己的邀请码' :
                 result.error === 'ALREADY_INVITED' ? '已绑定过邀请码' :
                 '操作失败',
      })
      return
    }

    await createPendingInvite(userId)

    // 记录审计日志
    insertAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'invite_bind',
      targetType: 'user',
      targetId: userId,
      newValue: { referral_code: referralCode },
      ipAddress: req.ip,
    })

    log.info({ userId, referralCode }, 'Referral code bound')
    res.json({ success: true, message: '邀请码绑定成功' })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Bind referral code failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '绑定邀请码失败' })
  }
}
