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

describe('invite handlers', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('getInviteCodeHandler', () => {
    it('should return referral code for user', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'user-1')
      const stats = await createUserStats('user-1')

      const { getInviteCodeHandler } = await import('../../src/auth/invite.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getInviteCodeHandler(req, res)

      expect(res._jsonBody.referralCode).toBe(stats.referral_code)
    })

    it('should return 404 for user without stats', async () => {
      insertTestUser(currentDb!, 'user-1')

      const { getInviteCodeHandler } = await import('../../src/auth/invite.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getInviteCodeHandler(req, res)

      expect(res._status).toBe(404)
    })
  })

  describe('getInviteRecordsHandler', () => {
    it('should return invite records', async () => {
      const { createUserStats } = await import('../../src/db/user-stats.js')
      insertTestUser(currentDb!, 'inviter')
      insertTestUser(currentDb!, 'invitee')
      const inviter = await createUserStats('inviter')
      await createUserStats('invitee', inviter.referral_code)

      const { completeInvite } = await import('../../src/db/invite.js')
      await completeInvite('invitee')

      const { getInviteRecordsHandler } = await import('../../src/auth/invite.js')
      const req = createMockReq('inviter')
      const res = createMockRes()
      await getInviteRecordsHandler(req, res)

      expect(res._jsonBody.records).toHaveLength(1)
      expect(res._jsonBody.records[0].status).toBe('completed')
    })

    it('should return empty array for no records', async () => {
      const { getInviteRecordsHandler } = await import('../../src/auth/invite.js')
      const req = createMockReq('user-1')
      const res = createMockRes()
      await getInviteRecordsHandler(req, res)

      expect(res._jsonBody.records).toEqual([])
    })
  })
})
