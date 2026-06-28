import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'
import { v4 as uuidv4 } from 'uuid'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

describe('invite DB layer', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  async function setupUsersWithStats(inviterId: string, inviteeId: string): Promise<{ inviterCode: string }> {
    const { createUserStats } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, inviterId)
    insertTestUser(currentDb!, inviteeId)
    const inviter = await createUserStats(inviterId)
    await createUserStats(inviteeId, inviter.referral_code)
    return { inviterCode: inviter.referral_code }
  }

  describe('completeInvite', () => {
    it('should mark invitation as completed', async () => {
      const { completeInvite, getInviteRecords } = await import('../../src/db/invite.js')
      await setupUsersWithStats('inviter', 'invitee')

      await completeInvite('invitee')

      const records = await getInviteRecords('inviter')
      expect(records).toHaveLength(1)
      expect(records[0].status).toBe('completed')
    })

    it('should be idempotent', async () => {
      const { completeInvite, getInviteRecords } = await import('../../src/db/invite.js')
      await setupUsersWithStats('inviter', 'invitee')

      await completeInvite('invitee')
      await completeInvite('invitee')

      const records = await getInviteRecords('inviter')
      expect(records).toHaveLength(1)
      expect(records[0].status).toBe('completed')
    })

    it('should do nothing for user without inviter', async () => {
      const { completeInvite, getInviteRecords } = await import('../../src/db/invite.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'solo')
      await createUserStats('solo')

      await completeInvite('solo')

      const records = await getInviteRecords('solo')
      expect(records).toHaveLength(0)
    })

    it('should do nothing for self-referral', async () => {
      const { completeInvite, getReferralCode } = await import('../../src/db/invite.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user')
      const stats = await createUserStats('user')

      currentDb!.run('UPDATE user_stats SET invited_by = ? WHERE user_id = ?', [stats.referral_code, 'user'])

      await completeInvite('user')

      const records = currentDb!.prepare(
        'SELECT COUNT(*) as count FROM invite_records WHERE inviter_id = ?',
      )
      records.bind(['user'])
      records.step()
      const row = records.getAsObject() as any
      records.free()
      expect(row.count).toBe(0)
    })

    it('should advance invite_count task progress for inviter', async () => {
      const { completeInvite } = await import('../../src/db/invite.js')
      const { initUserTasks, getUserTasks } = await import('../../src/db/tasks.js')
      await setupUsersWithStats('inviter', 'invitee')
      await initUserTasks('inviter')

      await completeInvite('invitee')

      const tasks = await getUserTasks('inviter')
      const invite1 = tasks.find((t: any) => t.task_id === 'achv_invite_1')
      expect(invite1.progress).toBe(1)
    })
  })

  describe('getReferralCode', () => {
    it('should return referral code for user', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      const { getReferralCode } = await import('../../src/db/invite.js')
      insertTestUser(currentDb!, 'user-1')
      const stats = await createUserStats('user-1')

      const code = await getReferralCode('user-1')
      expect(code).toBe(stats.referral_code)
    })

    it('should return null for non-existent user', async () => {
      const { getReferralCode } = await import('../../src/db/invite.js')
      const code = await getReferralCode('nonexistent')
      expect(code).toBeNull()
    })
  })

  describe('getInviteRecords', () => {
    it('should return empty array for no records', async () => {
      const { getInviteRecords } = await import('../../src/db/invite.js')
      const records = await getInviteRecords('user-1')
      expect(records).toEqual([])
    })
  })
})
