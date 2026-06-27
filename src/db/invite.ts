import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'
import { advanceTaskProgress } from './tasks.js'

const log = getLogger('DB:Invite')

/** 标记邀请为已完成（被邀请人首次占卜时调用） */
export async function completeInvite(inviteeId: string): Promise<void> {
  const db = await getDb()

  const stats = db.prepare('SELECT invited_by FROM user_stats WHERE user_id = ?')
  stats.bind([inviteeId])
  if (!stats.step()) {
    stats.free()
    return
  }
  const row = stats.getAsObject() as { invited_by: string | null }
  stats.free()

  if (!row.invited_by) return

  const inviter = db.prepare('SELECT user_id FROM user_stats WHERE referral_code = ?')
  inviter.bind([row.invited_by])
  if (!inviter.step()) {
    inviter.free()
    return
  }
  const inviterRow = inviter.getAsObject() as { user_id: string }
  inviter.free()

  const inviterId = inviterRow.user_id
  if (inviterId === inviteeId) return

  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id, status FROM invite_records WHERE inviter_id = ? AND invitee_id = ?')
  existing.bind([inviterId, inviteeId])

  if (existing.step()) {
    const record = existing.getAsObject() as { id: string; status: string }
    existing.free()
    if (record.status === 'pending') {
      db.run('UPDATE invite_records SET status = ? WHERE id = ?', ['completed', record.id])
      saveDb()
    }
  } else {
    existing.free()
    const id = uuidv4()
    db.run(
      'INSERT INTO invite_records (id, inviter_id, invitee_id, status, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, inviterId, inviteeId, 'completed', now, now],
    )
    saveDb()
  }
  saveDb()

  await advanceTaskProgress(inviterId, 'invite_count')

  log.info({ inviterId, inviteeId }, 'Invite completed')
}

/** 获取用户的邀请码 */
export async function getReferralCode(userId: string): Promise<string | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT referral_code FROM user_stats WHERE user_id = ?')
  stmt.bind([userId])
  if (stmt.step()) {
    const row = stmt.getAsObject() as { referral_code: string }
    stmt.free()
    return row.referral_code
  }
  stmt.free()
  return null
}

/** 获取用户的邀请记录 */
export async function getInviteRecords(userId: string): Promise<any[]> {
  const db = await getDb()

  const stmt = db.prepare(`
    SELECT ir.id, ir.invitee_id, ir.status, ir.created_at, ir.completed_at,
           u.nickname, u.avatar_url
    FROM invite_records ir
    LEFT JOIN users u ON ir.invitee_id = u.id
    WHERE ir.inviter_id = ?
    ORDER BY ir.created_at DESC
  `)
  stmt.bind([userId])
  const rows: any[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}
