import type { Request, Response } from 'express'
import { getLogger } from '../logger.js'
import { getReferralCode, getInviteRecords } from '../db/invite.js'

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
    const records = await getInviteRecords(userId)
    res.json({ records })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Get invite records failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取邀请记录失败' })
  }
}
