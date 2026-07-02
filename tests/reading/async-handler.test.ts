import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

vi.mock('../../src/config.js', () => ({
  config: {
    geminiApiKey: 'test-api-key',
  },
}))

vi.mock('../../src/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

function createMockReqRes(overrides: Partial<{
  userId: string
  logId: string
  body: any
  params: Record<string, string>
}> = {}) {
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
  } as unknown as Response & {
    _status: number; _jsonBody: any; _headers: Record<string, string>;
    emit: (e: string) => void
  }

  const req = {
    userId: overrides.userId || 'user-test',
    logId: overrides.logId || 'log-test-001',
    body: overrides.body || {},
    params: overrides.params || {},
  } as unknown as Request

  return { req, res }
}

describe('async-handler', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('startReadingHandler', () => {
    it('should create task and return taskId with pending status', async () => {
      const { startReadingHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        logId: 'log-001',
        body: {
          question: '我的运势如何？',
          cards: [{ position: 1, name: '魔法师', isUpright: true }],
        },
      })

      await startReadingHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody).toHaveProperty('taskId')
      expect(res._jsonBody.status).toBe('pending')
      expect(typeof res._jsonBody.taskId).toBe('string')

      // 校验数据库记录
      const stmt = currentDb!.prepare('SELECT * FROM readings WHERE id = ?')
      stmt.bind([res._jsonBody.taskId])
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row).not.toBeNull()
      expect(row.status).toBe('pending')
      expect(row.request_log_id).toBe('log-001')
      expect(row.user_id).toBe('user-test')
    })

    it('should return 400 when cards array is empty', async () => {
      const { startReadingHandler } = await import('../../src/reading/async-handler.js')

      const { req, res } = createMockReqRes({
        body: { question: 'test', cards: [] },
      })

      await startReadingHandler(req, res)

      expect(res._status).toBe(400)
      expect(res._jsonBody).toHaveProperty('error', 'Missing cards')
    })

    it('should pass logId from req to createReadingTask as request_log_id', async () => {
      const { startReadingHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        logId: 'custom-log-id-xyz',
        body: {
          question: 'test',
          cards: [{ position: 1, name: '星星', isUpright: false }],
        },
      })

      await startReadingHandler(req, res)

      const stmt = currentDb!.prepare('SELECT request_log_id FROM readings WHERE id = ?')
      stmt.bind([res._jsonBody.taskId])
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row.request_log_id).toBe('custom-log-id-xyz')
    })
  })

  describe('getReadingResultHandler', () => {
    it('should return completed task with full reading data', async () => {
      const { createReadingTask, completeReadingTask } = await import('../../src/db/reading-task.js')
      const { getReadingResultHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const taskId = await createReadingTask({
        userId: 'user-test', question: 'test', cardsJson: '[]',
      })
      await completeReadingTask({
        taskId, reading: '解读结果', model: 'gemini-2.5-flash', incomplete: false,
      })

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        params: { taskId },
      })

      await getReadingResultHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody).toEqual({
        taskId,
        status: 'completed',
        reading: '解读结果',
        model: 'gemini-2.5-flash',
        incomplete: false,
        warning: null,
        error: null,
      })
    })

    it('should return pending task with null reading', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      const { getReadingResultHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const taskId = await createReadingTask({
        userId: 'user-test', question: 'test', cardsJson: '[]',
      })

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        params: { taskId },
      })

      await getReadingResultHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.status).toBe('pending')
      expect(res._jsonBody.reading).toBeNull()
    })

    it('should return failed task with error_msg', async () => {
      const { createReadingTask, failReadingTask } = await import('../../src/db/reading-task.js')
      const { getReadingResultHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const taskId = await createReadingTask({
        userId: 'user-test', question: 'test', cardsJson: '[]',
      })
      await failReadingTask(taskId, 'AI service unavailable')

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        params: { taskId },
      })

      await getReadingResultHandler(req, res)

      expect(res._status).toBe(200)
      expect(res._jsonBody.status).toBe('failed')
      expect(res._jsonBody.error).toBe('AI service unavailable')
    })

    it('should return 404 for non-existent task', async () => {
      const { getReadingResultHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-test')

      const { req, res } = createMockReqRes({
        userId: 'user-test',
        params: { taskId: 'nonexistent-task-id' },
      })

      await getReadingResultHandler(req, res)

      expect(res._status).toBe(404)
      expect(res._jsonBody).toHaveProperty('error', 'Task not found')
    })

    it('should return 404 when userId does not match (security)', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      const { getReadingResultHandler } = await import('../../src/reading/async-handler.js')
      insertTestUser(currentDb!, 'user-a')
      insertTestUser(currentDb!, 'user-b')

      const taskId = await createReadingTask({
        userId: 'user-a', question: 'test', cardsJson: '[]',
      })

      // user-b 尝试访问 user-a 的任务
      const { req, res } = createMockReqRes({
        userId: 'user-b',
        params: { taskId },
      })

      await getReadingResultHandler(req, res)

      expect(res._status).toBe(404)
      expect(res._jsonBody).toHaveProperty('error', 'Task not found')
    })
  })
})
