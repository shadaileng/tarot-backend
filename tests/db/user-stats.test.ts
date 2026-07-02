import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

describe('user-stats DB layer', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('createUserStats', () => {
    it('should create stats with default values', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1', 'test@test.com')
      const stats = await createUserStats('user-1')

      expect(stats).toBeDefined()
      expect(stats.user_id).toBe('user-1')
      expect(stats.points).toBe(0)
      expect(stats.level).toBe(1)
      expect(stats.extra_quota).toBe(0)
      expect(stats.referral_code).toBeTruthy()
      expect(stats.referral_code.length).toBe(6)
    })

    it('should generate unique referral code', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      insertTestUser(currentDb!, 'user-2')

      const stats1 = await createUserStats('user-1')
      const stats2 = await createUserStats('user-2')
      expect(stats1.referral_code).not.toBe(stats2.referral_code)
    })

    it('should store invited_by if provided', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'inviter', 'inviter@test.com')
      insertTestUser(currentDb!, 'invitee', 'invitee@test.com')

      const inviter = await createUserStats('inviter')
      const invitee = await createUserStats('invitee', inviter.referral_code)
      expect(invitee.invited_by).toBe(inviter.referral_code)
    })
  })

  describe('getUserStats', () => {
    it('should return null for non-existent user', async () => {
      const { getUserStats } = await import('../../src/db/user-stats.js')
      const stats = await getUserStats('nonexistent')
      expect(stats).toBeNull()
    })

    it('should return stats for existing user', async () => {
      const { createUserStats, getUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const stats = await getUserStats('user-1')
      expect(stats).toBeDefined()
      expect(stats!.points).toBe(0)
    })
  })

  describe('addPoints', () => {
    it('should add points and detect level up', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const result = await addPoints('user-1', 100)
      expect(result.newPoints).toBe(100)
      expect(result.newLevel).toBe(2)
      expect(result.leveledUp).toBe(true)
    })

    it('should not level up with insufficient points', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const result = await addPoints('user-1', 50)
      expect(result.newPoints).toBe(50)
      expect(result.newLevel).toBe(1)
      expect(result.leveledUp).toBe(false)
    })

    it('should not go below zero', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const result = await addPoints('user-1', -50)
      expect(result.newPoints).toBe(0)
    })

    it('should level up to higher levels', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const result = await addPoints('user-1', 2000)
      expect(result.newLevel).toBe(6)
      expect(result.leveledUp).toBe(true)
    })

    it('should not return leveledUp for same level', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await addPoints('user-1', 100)

      const result = await addPoints('user-1', 50)
      expect(result.leveledUp).toBe(false)
    })
  })

  describe('calculateLevel', () => {
    it('should return level 1 for 0 points', async () => {
      const { calculateLevel } = await import('../../src/db/user-stats.js')
      const level = await calculateLevel(0)
      expect(level.level).toBe(1)
    })

    it('should return level 6 for 2000+ points', async () => {
      const { calculateLevel } = await import('../../src/db/user-stats.js')
      const level = await calculateLevel(5000)
      expect(level.level).toBe(6)
    })

    it('should return correct level for boundary values', async () => {
      const { calculateLevel } = await import('../../src/db/user-stats.js')

      expect((await calculateLevel(99)).level).toBe(1)
      expect((await calculateLevel(100)).level).toBe(2)
      expect((await calculateLevel(299)).level).toBe(2)
      expect((await calculateLevel(300)).level).toBe(3)
      expect((await calculateLevel(599)).level).toBe(3)
      expect((await calculateLevel(600)).level).toBe(4)
    })
  })

  describe('quota management', () => {
    it('should get available quota for level 1', async () => {
      const { createUserStats, getAvailableQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const quota = await getAvailableQuota('user-1')
      expect(quota.total).toBe(3)
      expect(quota.used).toBe(0)
      expect(quota.remaining).toBe(3)
    })

    it('should consume quota correctly', async () => {
      const { createUserStats, consumeQuota, getAvailableQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      const ok = await consumeQuota('user-1')
      expect(ok).toBe(true)

      const quota = await getAvailableQuota('user-1')
      expect(quota.used).toBe(1)
      expect(quota.remaining).toBe(2)
    })

    it('should return false when quota exhausted', async () => {
      const { createUserStats, consumeQuota, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      for (let i = 0; i < 3; i++) {
        expect(await consumeQuota('user-1')).toBe(true)
      }
      expect(await consumeQuota('user-1')).toBe(false)
    })

    it('should include extra quota from tasks', async () => {
      const { createUserStats, getAvailableQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      currentDb!.run('UPDATE user_stats SET extra_quota = 5 WHERE user_id = ?', ['user-1'])
      const quota = await getAvailableQuota('user-1')
      expect(quota.total).toBe(8)
      expect(quota.remaining).toBe(8)
    })
  })

  describe('getUserLevelInfo', () => {
    it('should return level info with progress', async () => {
      const { createUserStats, addPoints, getUserLevelInfo } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await addPoints('user-1', 50)
      const info = await getUserLevelInfo('user-1')

      expect(info).toBeDefined()
      expect(info!.level).toBe(1)
      expect(info!.points).toBe(50)
      expect(info!.nextLevelPoints).toBe(100)
      expect(info!.progress).toBe(50)
      expect(info!.totalQuota).toBe(3)
    })

    it('should return 100% at max level', async () => {
      const { createUserStats, addPoints, getUserLevelInfo } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await addPoints('user-1', 2000)
      const info = await getUserLevelInfo('user-1')

      expect(info!.level).toBe(6)
      expect(info!.nextLevelPoints).toBeNull()
      expect(info!.progress).toBe(100)
    })

    it('should return null for non-existent user', async () => {
      const { getUserLevelInfo } = await import('../../src/db/user-stats.js')
      const info = await getUserLevelInfo('nonexistent')
      expect(info).toBeNull()
    })
  })

  describe('findByReferralCode', () => {
    it('should find user by referral code', async () => {
      const { createUserStats, findByReferralCode } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      const stats = await createUserStats('user-1')

      const found = await findByReferralCode(stats.referral_code)
      expect(found).toBeDefined()
      expect(found!.user_id).toBe('user-1')
    })

    it('should return null for invalid code', async () => {
      const { findByReferralCode } = await import('../../src/db/user-stats.js')
      const found = await findByReferralCode('invalid')
      expect(found).toBeNull()
    })

    it('should return null for empty code', async () => {
      const { findByReferralCode } = await import('../../src/db/user-stats.js')
      expect(await findByReferralCode('')).toBeNull()
    })
  })

  describe('getLevelDefinitions', () => {
    it('should return all 6 levels', async () => {
      const { getLevelDefinitions } = await import('../../src/db/user-stats.js')
      const levels = await getLevelDefinitions()
      expect(levels).toHaveLength(6)
      expect(levels[0].level).toBe(1)
      expect(levels[5].level).toBe(6)
    })
  })

  describe('initMissingUserStats', () => {
    it('should create stats for users without them', async () => {
      const { initMissingUserStats, getUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      insertTestUser(currentDb!, 'user-2')

      await initMissingUserStats()

      expect(await getUserStats('user-1')).not.toBeNull()
      expect(await getUserStats('user-2')).not.toBeNull()
    })

    it('should not duplicate existing stats', async () => {
      const { createUserStats, initMissingUserStats, getUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await initMissingUserStats()
      const stats = await getUserStats('user-1')
      expect(stats!.points).toBe(0)
    })
  })

  describe('refundQuota', () => {
    it('should decrease daily_quota_used and total_readings by 1', async () => {
      const { createUserStats, consumeQuota, refundQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      // 先消费一次额度
      await consumeQuota('user-1')

      // 退款
      await refundQuota('user-1')

      const stmt = currentDb!.prepare('SELECT daily_quota_used, total_readings FROM user_stats WHERE user_id = ?')
      stmt.bind(['user-1'])
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row.daily_quota_used).toBe(0)
      expect(row.total_readings).toBe(0)
    })

    it('should not go below zero', async () => {
      const { createUserStats, refundQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      // 未消费直接退款
      await refundQuota('user-1')

      const stmt = currentDb!.prepare('SELECT daily_quota_used, total_readings FROM user_stats WHERE user_id = ?')
      stmt.bind(['user-1'])
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row.daily_quota_used).toBe(0)
      expect(row.total_readings).toBe(0)
    })

    it('should handle multiple refunds without going negative', async () => {
      const { createUserStats, consumeQuota, refundQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await consumeQuota('user-1')
      await refundQuota('user-1')
      await refundQuota('user-1')  // 再次退款，不应 < 0

      const stmt = currentDb!.prepare('SELECT daily_quota_used FROM user_stats WHERE user_id = ?')
      stmt.bind(['user-1'])
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row.daily_quota_used).toBe(0)
    })

    it('should restore availability after full consumption and refund', async () => {
      const { createUserStats, consumeQuota, refundQuota, getAvailableQuota } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      // 用完全部额度（level 1 = 3）
      for (let i = 0; i < 3; i++) {
        await consumeQuota('user-1')
      }
      let quota = await getAvailableQuota('user-1')
      expect(quota.remaining).toBe(0)

      // 退款一次
      await refundQuota('user-1')

      quota = await getAvailableQuota('user-1')
      expect(quota.used).toBe(2)
      expect(quota.remaining).toBe(1)
    })
  })
})
