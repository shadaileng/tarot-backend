import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Response } from 'express'
import { setupTestDb, insertTestUser, getTodayDate, getYesterdayDate } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

function createMockReq(userId: string) {
  const req = {
    userId,
    body: {},
    params: {} as Record<string, string>,
  } as any
  return req
}

function createMockRes(): Response & { _status: number; _jsonBody: any } {
  const res = {
    _status: 200,
    _jsonBody: null as any,
    status(code: number) { this._status = code; return this },
    json(body: any) { this._jsonBody = body; return this },
  } as any
  return res
}

describe('checkinHandler', () => {
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

  it('should successfully check in', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    expect(res._status).toBe(200)
    expect(res._jsonBody.success).toBe(true)
    expect(res._jsonBody.streak).toBe(1)
    expect(res._jsonBody.basePoints).toBe(5)
    expect(res._jsonBody.streakBonus).toBe(0)
    expect(res._jsonBody.totalPoints).toBe(5)
  })

  it('should reject duplicate check-in same day', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    const req1 = createMockReq('user-1')
    const res1 = createMockRes()
    await checkinHandler(req1, res1)

    const req2 = createMockReq('user-1')
    const res2 = createMockRes()
    await checkinHandler(req2, res2)

    expect(res2._status).toBe(409)
    expect(res2._jsonBody.error).toBe('ALREADY_CHECKED_IN')
  })

  it('should return consecutive streak for next-day checkin', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    // Set last_checkin_date to yesterday
    const yesterday = getYesterdayDate()
    currentDb!.run(
      'UPDATE user_stats SET consecutive_checkins = 2, last_checkin_date = ? WHERE user_id = ?',
      [yesterday, 'user-1'],
    )

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    expect(res._jsonBody.streak).toBe(3)
    expect(res._jsonBody.streakBonus).toBe(4)
    expect(res._jsonBody.totalPoints).toBe(9)
  })

  it('should reset streak if not consecutive', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    // Set last_checkin_date to 3 days ago
    const d = new Date()
    d.setDate(d.getDate() - 3)
    const oldDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    currentDb!.run(
      'UPDATE user_stats SET consecutive_checkins = 5, last_checkin_date = ? WHERE user_id = ?',
      [oldDate, 'user-1'],
    )

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    expect(res._jsonBody.streak).toBe(1)
    expect(res._jsonBody.streakBonus).toBe(0)
  })

  it('should cap streak bonus at 20', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    const yesterday = getYesterdayDate()
    currentDb!.run(
      'UPDATE user_stats SET consecutive_checkins = 99, last_checkin_date = ? WHERE user_id = ?',
      [yesterday, 'user-1'],
    )

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    expect(res._jsonBody.streak).toBe(100)
    expect(res._jsonBody.streakBonus).toBe(20)
    expect(res._jsonBody.totalPoints).toBe(25)
  })

  it('should advance checkin_streak task progress', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    await setupUser('user-1')

    const yesterday = getYesterdayDate()
    currentDb!.run(
      'UPDATE user_stats SET consecutive_checkins = 2, last_checkin_date = ? WHERE user_id = ?',
      [yesterday, 'user-1'],
    )

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    const { getUserTasks } = await import('../../src/db/tasks.js')
    const tasks = await getUserTasks('user-1')
    const checkinTask = tasks.find((t: any) => t.task_id === 'achv_checkin_3')
    expect(checkinTask.progress).toBe(3)
    expect(checkinTask.is_completed).toBe(1)
  })

  it('should handle non-existent user stats', async () => {
    const { checkinHandler } = await import('../../src/auth/checkin.js')
    insertTestUser(currentDb!, 'user-1')

    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinHandler(req, res)

    expect(res._status).toBe(404)
    expect(res._jsonBody.error).toBe('USER_STATS_NOT_FOUND')
  })
})

describe('checkinStatusHandler', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  it('should return not checked in for new user', async () => {
    const { createUserStats } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, 'user-1')
    await createUserStats('user-1')

    const { checkinStatusHandler } = await import('../../src/auth/checkin.js')
    const req = createMockReq('user-1')
    const res = createMockRes()
    await checkinStatusHandler(req, res)

    expect(res._jsonBody.isCheckedIn).toBe(false)
    expect(res._jsonBody.streak).toBe(0)
  })

  it('should return checked in after checkin', async () => {
    const { createUserStats } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, 'user-1')
    await createUserStats('user-1')

    const { checkinHandler, checkinStatusHandler } = await import('../../src/auth/checkin.js')
    await checkinHandler(createMockReq('user-1'), createMockRes())

    const res = createMockRes()
    await checkinStatusHandler(createMockReq('user-1'), res)

    expect(res._jsonBody.isCheckedIn).toBe(true)
    expect(res._jsonBody.streak).toBe(1)
  })
})
