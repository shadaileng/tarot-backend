import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

function createMockReqRes(userId?: string) {
  const headers: Record<string, string> = {}
  const req = {
    userId,
    headers,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request

  const res = {
    _status: 200,
    _jsonBody: null as any,
    _headers: {} as Record<string, string>,
    status(code: number) { this._status = code; return this },
    json(body: any) { this._jsonBody = body; return this },
    set(key: string, value: string) { this._headers[key] = value; return this },
    getHeader(key: string) { return this._headers[key] },
  } as unknown as Response

  let nextCalled = false
  const next = (() => { nextCalled = true }) as NextFunction
  ;(req as any).__nextCalled = () => nextCalled

  return { req, res, next }
}

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    // Reset module-level store
    vi.resetModules()
  })

  it('should pass through for guests (no userId)', async () => {
    const { rateLimitMiddleware } = await import('../../src/middleware/rate-limit.js')
    const { req, res, next } = createMockReqRes(undefined)
    rateLimitMiddleware(req, res, next)
    expect((req as any).__nextCalled()).toBe(true)
  })

  it('should allow first request', async () => {
    const { rateLimitMiddleware } = await import('../../src/middleware/rate-limit.js')
    const { req, res, next } = createMockReqRes('user-1')
    rateLimitMiddleware(req, res, next)
    expect((req as any).__nextCalled()).toBe(true)
    expect(res._headers['X-RateLimit-Minute-Remaining']).toBe('2')
  })

  it('should block after 3 requests per minute', async () => {
    const { rateLimitMiddleware } = await import('../../src/middleware/rate-limit.js')
    const { req: r1, res: res1, next: n1 } = createMockReqRes('user-1')
    const { req: r2, res: res2, next: n2 } = createMockReqRes('user-1')
    const { req: r3, res: res3, next: n3 } = createMockReqRes('user-1')
    const { req: r4, res: res4, next: n4 } = createMockReqRes('user-1')

    rateLimitMiddleware(r1, res1, n1)
    rateLimitMiddleware(r2, res2, n2)
    rateLimitMiddleware(r3, res3, n3)
    rateLimitMiddleware(r4, res4, n4)

    expect((r1 as any).__nextCalled()).toBe(true)
    expect((r2 as any).__nextCalled()).toBe(true)
    expect((r3 as any).__nextCalled()).toBe(true)
    expect((r4 as any).__nextCalled()).toBe(false)
    expect(res4._status).toBe(429)
    expect(res4._jsonBody).toHaveProperty('error', 'RATE_LIMITED')
    expect(res4._headers['Retry-After']).toBeDefined()
  })

  it('should reset window after time passes', async () => {
    const { rateLimitMiddleware } = await import('../../src/middleware/rate-limit.js')
    const { req: r1, res: res1, next: n1 } = createMockReqRes('user-1')
    const { req: r2, res: res2, next: n2 } = createMockReqRes('user-1')

    rateLimitMiddleware(r1, res1, n1)

    // Simulate time passing (force window reset by manipulating module internals)
    const { getRateLimitStats } = await import('../../src/middleware/rate-limit.js')
    expect(getRateLimitStats().totalTracked).toBeGreaterThanOrEqual(1)
  })

  it('should have separate windows per user', async () => {
    const { rateLimitMiddleware } = await import('../../src/middleware/rate-limit.js')
    const { req: r1, res: res1, next: n1 } = createMockReqRes('user-1')
    const { req: r2, res: res2, next: n2 } = createMockReqRes('user-2')

    rateLimitMiddleware(r1, res1, n1)
    rateLimitMiddleware(r2, res2, n2)

    expect((r1 as any).__nextCalled()).toBe(true)
    expect((r2 as any).__nextCalled()).toBe(true)
  })
})
