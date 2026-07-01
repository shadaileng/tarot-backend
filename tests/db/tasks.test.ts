import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, insertTestUser, getTodayDate, getYesterdayDate } from '../test-helpers.js'
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

  describe('advanceTaskProgress - 每日任务重置逻辑', () => {
    // 辅助函数：手动设置任务的 reset_date 为昨天
    function setTaskResetDateToYesterday(taskId: string, progress: number = 2) {
      const yesterday = getYesterdayDate()
      currentDb!.run(
        'UPDATE user_tasks SET reset_date = ?, progress = ?, is_completed = 0 WHERE task_id = ?',
        [yesterday, progress, taskId]
      )
    }

    it('应该先重置过期的每日任务，再推进进度', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      // 模拟昨天做了2次占卜，daily_read_3 进度=2，未完成
      setTaskResetDateToYesterday('daily_read_3', 2)

      // 今天直接做1次占卜
      await advanceTaskProgress('user-1', 'read_count')

      // 验证：daily_read_3 应该先重置（进度清零），再推进（进度=1）
      const tasks = await getUserTasks('user-1')
      const dailyRead3 = tasks.find((t: any) => t.task_id === 'daily_read_3')
      expect(dailyRead3.progress).toBe(1)  // 先重置为0，再推进为1
      expect(dailyRead3.reset_date).toBe(getTodayDate())
    })

    it('应该正确处理昨天已完成但未领取奖励的任务', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      // 模拟昨天已完成 daily_read_1（进度=1，已完成，但未领取奖励）
      currentDb!.run(
        'UPDATE user_tasks SET progress = 1, is_completed = 1, reward_claimed = 0 WHERE task_id = ?',
        ['daily_read_1']
      )
      const yesterday = getYesterdayDate()
      currentDb!.run(
        'UPDATE user_tasks SET reset_date = ? WHERE task_id = ?',
        [yesterday, 'daily_read_1']
      )

      // 今天做1次占卜
      await advanceTaskProgress('user-1', 'read_count')

      // 验证：daily_read_1 应该先重置，再推进
      const tasks = await getUserTasks('user-1')
      const dailyRead1 = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(dailyRead1.progress).toBe(1)  // 先重置为0，再推进为1
      expect(dailyRead1.is_completed).toBe(1)
      expect(dailyRead1.reward_claimed).toBe(0)  // 奖励未领取
    })

    it('成就任务不应该被重置', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      // 模拟昨天做了2次占卜，成就任务 achv_read_10 进度=2
      currentDb!.run(
        'UPDATE user_tasks SET progress = 2 WHERE task_id = ?',
        ['achv_read_10']
      )

      // 今天做1次占卜
      await advanceTaskProgress('user-1', 'read_count')

      // 验证：成就任务进度应该累加，不会被重置
      const tasks = await getUserTasks('user-1')
      const achvRead10 = tasks.find((t: any) => t.task_id === 'achv_read_10')
      expect(achvRead10.progress).toBe(3)  // 累加：2 + 1 = 3
    })

    it('如果 reset_date 已经是今天，不应该重复重置', async () => {
      const { initUserTasks, advanceTaskProgress, getUserTasks } = await import('../../src/db/tasks.js')
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await initUserTasks('user-1')

      // 模拟今天已经做了1次占卜，daily_read_1 进度=1
      await advanceTaskProgress('user-1', 'read_count')

      // 再做1次占卜
      await advanceTaskProgress('user-1', 'read_count')

      // 验证：进度应该累加，不会被重置
      const tasks = await getUserTasks('user-1')
      const dailyRead1 = tasks.find((t: any) => t.task_id === 'daily_read_1')
      expect(dailyRead1.progress).toBe(2)  // daily_read_1 进度累加：1 + 1 = 2
      expect(dailyRead1.is_completed).toBe(1)
    })
  })
})
