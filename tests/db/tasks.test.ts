import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

describe('tasks DB layer', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('initUserTasks', () => {
    it('should create all 8 tasks for new user', async () => {
      const { initUserTasks, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await initUserTasks('user-1')
      const tasks = await getUserTasks('user-1')
      expect(tasks).toHaveLength(8)
    })

    it('should be idempotent', async () => {
      const { initUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')

      await initUserTasks('user-1')
      await initUserTasks('user-1')
      const tasks = currentDb!.prepare('SELECT COUNT(*) as count FROM user_tasks WHERE user_id = ?')
      tasks.bind(['user-1'])
      tasks.step()
      expect(tasks.getAsObject() as any).toEqual({ count: 8 })
      tasks.free()
    })
  })

  describe('advanceTaskProgress', () => {
    it('should advance read_count tasks', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'read_count')

      const tasks = await getUserTasks('user-1')
      const dailyRead1 = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(dailyRead1.progress).toBe(1)
    })

    it('should auto-complete when meeting requirement', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'read_count')

      const tasks = await getUserTasks('user-1')
      const dailyRead1 = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(dailyRead1.is_completed).toBe(1)
      expect(dailyRead1.completed_at).toBeTruthy()
    })

    it('should advance share_count tasks', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'share_count')

      const tasks = await getUserTasks('user-1')
      const dailyShare = tasks.find((t: any) => t.task_id === 'daily_share')
      expect(dailyShare.progress).toBe(1)
      expect(dailyShare.is_completed).toBe(1)
    })

    it('should advance checkin_streak tasks', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'checkin_streak', 3)

      const tasks = await getUserTasks('user-1')
      const checkin3 = tasks.find((t: any) => t.task_id === 'achv_checkin_3')
      expect(checkin3.is_completed).toBe(1)
      expect(checkin3.progress).toBe(3)
    })
  })

  describe('claimTaskReward', () => {
    it('should reject uncompleted task', async () => {
      const { initUserTasks, claimTaskReward } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      const result = await claimTaskReward('user-1', 'daily_read_1')
      expect(result.success).toBe(false)
      expect(result.error).toBe('TASK_NOT_COMPLETED')
    })

    it('should claim reward for completed task', async () => {
      const { initUserTasks, advanceTaskProgress, claimTaskReward } = await import('../../src/db/tasks.js')
      const { createUserStats, getUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'read_count')
      const result = await claimTaskReward('user-1', 'daily_read_1')

      expect(result.success).toBe(true)
      expect(result.pointsReward).toBe(5)
      expect(result.extraQuotaReward).toBe(1)

      const stats = await getUserStats('user-1')
      expect(stats!.points).toBe(5)  // points reward applied
    })

    it('should reject double claim', async () => {
      const { initUserTasks, advanceTaskProgress, claimTaskReward } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      await advanceTaskProgress('user-1', 'read_count')
      await claimTaskReward('user-1', 'daily_read_1')
      const result = await claimTaskReward('user-1', 'daily_read_1')

      expect(result.success).toBe(false)
      expect(result.error).toBe('REWARD_ALREADY_CLAIMED')
    })

    it('should return TASK_NOT_FOUND for invalid task', async () => {
      const { claimTaskReward } = await import('../../src/db/tasks.js')
      const result = await claimTaskReward('user-1', 'nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toBe('TASK_NOT_FOUND')
    })
  })

  describe('getUserTasks', () => {
    it('should compute progressPercent and canClaim', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks, claimTaskReward } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      let tasks = await getUserTasks('user-1')
      const dailyRead1 = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(dailyRead1.progressPercent).toBe(0)
      expect(dailyRead1.canClaim).toBe(0)

      await advanceTaskProgress('user-1', 'read_count')

      tasks = await getUserTasks('user-1')
      const updated = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(updated.progressPercent).toBe(100)
      expect(updated.canClaim).toBe(1)

      await claimTaskReward('user-1', 'daily_read_1')

      tasks = await getUserTasks('user-1')
      const claimed = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(claimed.canClaim).toBe(0)
    })
  })
})
