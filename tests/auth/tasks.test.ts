import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Response } from 'express'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

function createMockReq(userId: string, params?: Record<string, string>) {
  return { userId, params: params || {} } as any
}

function createMockRes(): Response & { _status: number; _jsonBody: any } {
  return {
    _status: 200,
    _jsonBody: null as any,
    status(code: number) { this._status = code; return this },
    json(body: any) { this._jsonBody = body; return this },
  } as any
}

describe('tasks handlers', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  async function setupUser(userId: string) {
    const { createUserStats } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, userId)
    await createUserStats(userId)
    const { initUserTasks } = await import('../../src/db/tasks.js')
    await initUserTasks(userId)
  }

  describe('getTasksHandler', () => {
    it('should return all tasks for user', async () => {
      await setupUser('user-1')
      const { getTasksHandler } = await import('../../src/auth/tasks.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getTasksHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.tasks).toHaveLength(8)
      expect(res._jsonBody.tasks[0].task_id).toBe('daily_read_1')
    })
  })

  describe('claimTaskHandler', () => {
    it('should claim reward for completed task', async () => {
      await setupUser('user-1')
      const { advanceTaskProgress } = await import('../../src/db/tasks.js')
      await advanceTaskProgress('user-1', 'read_count')

      const { claimTaskHandler } = await import('../../src/auth/tasks.js')
      const req = createMockReq('user-1', { id: 'daily_read_1' })
      const res = createMockRes()
      await claimTaskHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.success).toBe(true)
      expect(res._jsonBody.pointsReward).toBe(5)
    })

    it('should return 400 for uncompleted task', async () => {
      await setupUser('user-1')
      const { claimTaskHandler } = await import('../../src/auth/tasks.js')
      const req = createMockReq('user-1', { id: 'daily_read_1' })
      const res = createMockRes()
      await claimTaskHandler(req, res)

      expect(res._status).toBe(400)
      expect(res._jsonBody.error).toBe('TASK_NOT_COMPLETED')
    })

    it('should return 409 for double claim', async () => {
      await setupUser('user-1')
      const { advanceTaskProgress, claimTaskReward } = await import('../../src/db/tasks.js')
      await advanceTaskProgress('user-1', 'read_count')
      await claimTaskReward('user-1', 'daily_read_1')

      const { claimTaskHandler } = await import('../../src/auth/tasks.js')
      const req = createMockReq('user-1', { id: 'daily_read_1' })
      const res = createMockRes()
      await claimTaskHandler(req, res)

      expect(res._status).toBe(409)
      expect(res._jsonBody.error).toBe('REWARD_ALREADY_CLAIMED')
    })

    it('should return 404 for unknown task', async () => {
      await setupUser('user-1')
      const { claimTaskHandler } = await import('../../src/auth/tasks.js')
      const req = createMockReq('user-1', { id: 'nonexistent' })
      const res = createMockRes()
      await claimTaskHandler(req, res)

      expect(res._status).toBe(404)
      expect(res._jsonBody.error).toBe('TASK_NOT_FOUND')
    })
  })
})
