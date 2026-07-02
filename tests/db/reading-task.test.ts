import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, insertTestUser } from '../test-helpers.js'
import { currentDb, setDb, clearDb } from '../mock-db.js'

vi.mock('../../src/db/index.js', () => ({
  getDb: () => currentDb,
  saveDb: () => {},
}))

function getRow(table: string, id: string): any {
  const stmt = currentDb!.prepare(`SELECT * FROM ${table} WHERE id = ?`)
  stmt.bind([id])
  let row: any = null
  if (stmt.step()) {
    row = stmt.getAsObject()
  }
  stmt.free()
  return row
}

function getColumn(table: string, column: string, id: string): any {
  const stmt = currentDb!.prepare(`SELECT ${column} FROM ${table} WHERE id = ?`)
  stmt.bind([id])
  let val: any = null
  if (stmt.step()) {
    val = stmt.getAsObject()
  }
  stmt.free()
  return val ? val[column] : null
}

function getStatus(table: string, id: string): string | null {
  return getColumn(table, 'status', id)
}

describe('reading-task DB layer', () => {
  beforeEach(async () => {
    const db = await setupTestDb()
    setDb(db)
  })

  afterEach(() => {
    currentDb?.close()
    clearDb()
  })

  describe('createReadingTask', () => {
    it('should create a pending task with all required fields', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1', 'test@test.com')

      const taskId = await createReadingTask({
        userId: 'user-1',
        question: '我的事业运势如何？',
        cardsJson: JSON.stringify([{ position: 1, name: '愚者', isUpright: true }]),
      })

      expect(taskId).toBeTruthy()
      expect(typeof taskId).toBe('string')

      const row = getRow('readings', taskId)
      expect(row.user_id).toBe('user-1')
      expect(row.spread_type).toBe('')
      expect(row.question).toBe('我的事业运势如何？')
      expect(row.status).toBe('pending')
      expect(row.reading).toBeNull()
      expect(row.request_log_id).toBeNull()
      expect(row.created_at).toBeTruthy()
    })

    it('should store spread_type when provided', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1',
        question: 'test',
        cardsJson: '[]',
        spreadType: 'celtic-cross',
      })

      expect(getColumn('readings', 'spread_type', taskId)).toBe('celtic-cross')
    })

    it('should store request_log_id when provided', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1',
        question: 'test',
        cardsJson: '[]',
        requestLogId: 'log-abc-123',
      })

      expect(getColumn('readings', 'request_log_id', taskId)).toBe('log-abc-123')
    })

    it('should set request_log_id to NULL when not provided', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1',
        question: 'test',
        cardsJson: '[]',
      })

      expect(getColumn('readings', 'request_log_id', taskId)).toBeNull()
    })

    it('should generate unique task IDs for concurrent tasks', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const id1 = await createReadingTask({
        userId: 'user-1', question: 'Q1', cardsJson: '[]',
      })
      const id2 = await createReadingTask({
        userId: 'user-1', question: 'Q2', cardsJson: '[]',
      })

      expect(id1).not.toBe(id2)
    })
  })

  describe('getReadingTask', () => {
    it('should return task for correct taskId and userId', async () => {
      const { createReadingTask, getReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      const task = await getReadingTask(taskId, 'user-1')
      expect(task).not.toBeNull()
      expect(task!.id).toBe(taskId)
      expect(task!.status).toBe('pending')
    })

    it('should return null for non-existent taskId', async () => {
      const { getReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const task = await getReadingTask('non-existent-id', 'user-1')
      expect(task).toBeNull()
    })

    it('should return null when userId does not match (authorization)', async () => {
      const { createReadingTask, getReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')
      insertTestUser(currentDb!, 'user-2')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      const task = await getReadingTask(taskId, 'user-2')
      expect(task).toBeNull()
    })
  })

  describe('completeReadingTask', () => {
    it('should update status to completed with reading data', async () => {
      const { createReadingTask, completeReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      await completeReadingTask({
        taskId,
        reading: '这是 AI 生成的解读内容...',
        model: 'gemini-2.5-flash',
        incomplete: false,
      })

      const row = getRow('readings', taskId)
      expect(row.status).toBe('completed')
      expect(row.reading).toBe('这是 AI 生成的解读内容...')
      expect(row.model).toBe('gemini-2.5-flash')
      expect(row.incomplete).toBe(0)
      expect(row.warning).toBeNull()
      expect(row.updated_at).toBeTruthy()
    })

    it('should record incomplete flag and warning', async () => {
      const { createReadingTask, completeReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      await completeReadingTask({
        taskId,
        reading: '部分解读...',
        model: 'gemini-2.5-flash',
        incomplete: true,
        warning: '部分卡牌解读未完成',
      })

      const cols = getColumn('readings', 'incomplete', taskId)
      expect(cols).toBe(1)
      expect(getColumn('readings', 'warning', taskId)).toBe('部分卡牌解读未完成')
    })

    it('should not affect other tasks', async () => {
      const { createReadingTask, completeReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId1 = await createReadingTask({
        userId: 'user-1', question: 'Q1', cardsJson: '[]',
      })
      const taskId2 = await createReadingTask({
        userId: 'user-1', question: 'Q2', cardsJson: '[]',
      })

      await completeReadingTask({
        taskId: taskId1,
        reading: '解读1',
        model: 'gemini-2.5-flash',
        incomplete: false,
      })

      expect(getStatus('readings', taskId2)).toBe('pending')
    })
  })

  describe('failReadingTask', () => {
    it('should update status to failed with error message', async () => {
      const { createReadingTask, failReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      await failReadingTask(taskId, 'Gemini API 返回 500 错误')

      const row = getRow('readings', taskId)
      expect(row.status).toBe('failed')
      expect(row.error_msg).toBe('Gemini API 返回 500 错误')
      expect(row.reading).toBeNull()
      expect(row.updated_at).toBeTruthy()
    })

    it('should handle special characters in error message', async () => {
      const { createReadingTask, failReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      const taskId = await createReadingTask({
        userId: 'user-1', question: 'test', cardsJson: '[]',
      })

      await failReadingTask(taskId, "Error: 'timeout' after 30s\nRetry failed")

      const msg = getColumn('readings', 'error_msg', taskId) as string
      expect(msg).toContain('timeout')
      expect(msg).toContain('Retry failed')
    })
  })

  describe('getAsyncTaskStats', () => {
    it('should return all zero for empty table', async () => {
      const { getAsyncTaskStats } = await import('../../src/db/reading-task.js')

      const stats = await getAsyncTaskStats()
      expect(stats).toEqual({ total: 0, pending: 0, completed: 0, failed: 0 })
    })

    it('should correctly count tasks by status', async () => {
      const {
        createReadingTask,
        completeReadingTask,
        failReadingTask,
        getAsyncTaskStats,
      } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      // 2 pending
      const t1 = await createReadingTask({
        userId: 'user-1', question: 'Q1', cardsJson: '[]',
      })
      const t2 = await createReadingTask({
        userId: 'user-1', question: 'Q2', cardsJson: '[]',
      })

      // 1 completed
      await completeReadingTask({
        taskId: t1, reading: 'done', model: 'gemini', incomplete: false,
      })

      // 1 failed
      const t3 = await createReadingTask({
        userId: 'user-1', question: 'Q3', cardsJson: '[]',
      })
      await failReadingTask(t3, 'error')

      const stats = await getAsyncTaskStats()
      expect(stats.total).toBe(3)
      expect(stats.pending).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(1)
    })
  })

  describe('request_log_id 关联查询', () => {
    it('should JOIN readings with request_logs to trace HTTP info', async () => {
      const { createReadingTask } = await import('../../src/db/reading-task.js')
      insertTestUser(currentDb!, 'user-1')

      // 写入一条 request_log
      currentDb!.run(
        `INSERT INTO request_logs (id, method, path, status_code, duration_ms, created_at, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['log-001', 'POST', '/api/reading/start', 200, 45,
         new Date().toISOString(), '192.168.1.1'],
      )

      // 创建关联的阅读任务
      await createReadingTask({
        userId: 'user-1',
        question: 'test',
        cardsJson: '[]',
        requestLogId: 'log-001',
      })

      // JOIN 查询验证
      const stmt = currentDb!.prepare(
        `SELECT r.id, r.status, rl.method, rl.path, rl.status_code, rl.duration_ms
         FROM readings r
         LEFT JOIN request_logs rl ON r.request_log_id = rl.id
         WHERE r.status = 'pending'`,
      )
      stmt.step()
      const row = stmt.getAsObject() as any
      stmt.free()
      expect(row.method).toBe('POST')
      expect(row.path).toBe('/api/reading/start')
      expect(row.status_code).toBe(200)
      expect(row.duration_ms).toBe(45)
    })
  })
})
