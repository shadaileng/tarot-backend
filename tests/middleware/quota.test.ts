import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

function createMockReqRes(authHeader?: string, ip?: string) {
  const clientIp = ip || '127.0.0.1'
  const events: Record<string, Function> = {}
  const res = {
    _status: 200,
    _jsonBody: null as any,
    _headers: {} as Record<string, string>,
    statusCode: 200,
    status(code: number) { this._status = code; this.statusCode = code; return this },
    json(body: any) { this._jsonBody = body; return this },
    set(key: string, value: string) { this._headers[key] = value; return this },
    on(event: string, fn: Function) { events[event] = fn },
    emit(event: string) { if (events[event]) events[event]() },
  } as unknown as Response & { _status: number; _jsonBody: any; _headers: Record<string, string>; emit: (e: string) => void }

  const req = {
    userId: undefined as string | undefined,
    openid: undefined as string | undefined,
    ip: clientIp,
    socket: { remoteAddress: clientIp },
    headers: {
      authorization: authHeader,
    },
  } as unknown as Request

  let nextCalled = false
  const next = (() => { nextCalled = true }) as NextFunction

  return { req, res, next, nextCalled: () => nextCalled }
}

describe('quotaMiddleware', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  it('should allow guest requests within limit', async () => {
    const { quotaMiddleware } = await import('../../src/middleware/quota.js')
    const { req, res, next } = createMockReqRes(undefined)
    await quotaMiddleware(req, res, next)
    expect(res._status).toBe(200)
  })

  it('should block guests after 2 daily requests', async () => {
    const { quotaMiddleware, getGuestQuotaStats } = await import('../../src/middleware/quota.js')

    const { req: r1, res: res1, next: n1 } = createMockReqRes(undefined)
    await quotaMiddleware(r1, res1, n1)
    res1.emit('finish')

    const { req: r2, res: res2, next: n2 } = createMockReqRes(undefined)
    await quotaMiddleware(r2, res2, n2)
    res2.emit('finish')

    const { req: r3, res: res3, next: n3 } = createMockReqRes(undefined)
    await quotaMiddleware(r3, res3, n3)

    expect(res3._status).toBe(429)
    expect(res3._jsonBody).toHaveProperty('error', 'GUEST_DAILY_LIMIT')
  })

  it('should pass authenticated users within quota', async () => {
    const { createUserStats } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, 'user-1', 'test@test.com')
    await createUserStats('user-1')

    const jwt = await createTestJwt('user-1', 'test-openid')
    const { quotaMiddleware } = await import('../../src/middleware/quota.js')
    const { req, res, next } = createMockReqRes(`Bearer ${jwt}`)
    await quotaMiddleware(req, res, next)
    expect(res._status).toBe(200)
    expect((req as any).userId).toBe('user-1')
  })

  it('should block user when quota exhausted', async () => {
    const { createUserStats, consumeQuota } = await import('../../src/db/user-stats.js')
    insertTestUser(currentDb!, 'user-1', 'test@test.com')
    await createUserStats('user-1')

    for (let i = 0; i < 3; i++) {
      await consumeQuota('user-1')
    }

    const jwt = await createTestJwt('user-1', 'test-openid')
    const { quotaMiddleware } = await import('../../src/middleware/quota.js')
    const { req, res, next } = createMockReqRes(`Bearer ${jwt}`)
    await quotaMiddleware(req, res, next)

    expect(res._status).toBe(429)
    expect(res._jsonBody).toHaveProperty('error', 'DAILY_QUOTA_EXCEEDED')
  })

  it('should treat invalid JWT as guest', async () => {
    const { quotaMiddleware } = await import('../../src/middleware/quota.js')
    const { req, res, next } = createMockReqRes('Bearer invalid-jwt-token', '10.0.0.1')
    await quotaMiddleware(req, res, next)
    expect((req as any).userId).toBeUndefined()
    expect(res._status).toBe(200)
  })
})

async function createTestJwt(userId: string, openid: string): Promise<string> {
  const jwt = await import('jsonwebtoken')
  return jwt.sign({ sub: userId, openid }, 'dev-secret-do-not-use-in-production', { expiresIn: '1h' })
}
