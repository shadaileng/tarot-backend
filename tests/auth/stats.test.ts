import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Response } from 'express'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

function createMockReq(userId: string) {
  return { userId } as any
}

function createMockRes(): Response & { _status: number; _jsonBody: any } {
  return {
    _status: 200,
    _jsonBody: null as any,
    status(code: number) { this._status = code; return this },
    json(body: any) { this._jsonBody = body; return this },
  } as any
}

describe('stats handlers', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('getUserStatsHandler', () => {
    it('should return level info for user', async () => {
      const { createUserStats, addPoints } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      await createUserStats('user-1')
      await addPoints('user-1', 50)

      const { getUserStatsHandler } = await import('../../src/auth/stats.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getUserStatsHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.level).toBe(1)
      expect(res._jsonBody.points).toBe(50)
      expect(res._jsonBody.progress).toBe(50)
      expect(res._jsonBody.totalQuota).toBe(3)
    })

    it('should return 404 for user without stats', async () => {
      insertTestUser(currentDb!, 'user-1')

      const { getUserStatsHandler } = await import('../../src/auth/stats.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getUserStatsHandler(req, res)

      expect(res._status).toBe(404)
    })
  })

  describe('getLevelsHandler', () => {
    it('should return all level definitions', async () => {
      const { getLevelsHandler } = await import('../../src/auth/stats.js')
      const req = {} as any
      const res = createMockRes()
      await getLevelsHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.levels).toHaveLength(6)
      expect(res._jsonBody.levels[0].title).toBe('见习塔罗师')
      expect(res._jsonBody.levels[5].title).toBe('大师塔罗师')
    })
  })
})
