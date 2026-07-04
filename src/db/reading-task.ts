import { getDb, saveDb } from './index.js'
import { v4 as uuidv4 } from 'uuid'

export interface ReadingTaskRow {
  id: string
  user_id: string
  created_at: string
  updated_at: string | null
  spread_type: string
  question: string | null
  cards_json: string
  reading: string | null
  model: string | null
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  is_local: number
  incomplete: number
  warning: string | null
  error_msg: string | null
  interpretation: string | null
  request_log_id: string | null
}

/** 创建待处理解读任务 */
export async function createReadingTask(params: {
  userId: string
  question: string
  cardsJson: string
  spreadType?: string
  requestLogId?: string
}): Promise<string> {
  const db = await getDb()
  const id = uuidv4()
  const now = new Date().toISOString()

  db.run(
    `INSERT INTO readings (id, user_id, created_at, spread_type, question, cards_json, status, request_log_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, params.userId, now, params.spreadType || '', params.question, params.cardsJson,
     params.requestLogId || null],
  )
  saveDb()
  return id
}

/** 查询任务状态 */
export async function getReadingTask(
  taskId: string,
  userId: string,
): Promise<ReadingTaskRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM readings WHERE id = ? AND user_id = ?')
  stmt.bind([taskId, userId])
  let row: ReadingTaskRow | null = null
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as ReadingTaskRow
  }
  stmt.free()
  return row
}

/** 标记任务完成 */
export async function completeReadingTask(params: {
  taskId: string
  reading: string
  model: string
  incomplete: boolean
  warning?: string
}): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  db.run(
    `UPDATE readings
     SET status = 'completed', reading = ?, model = ?, incomplete = ?,
         warning = ?, updated_at = ?
     WHERE id = ?`,
    [params.reading, params.model, params.incomplete ? 1 : 0,
     params.warning || null, now, params.taskId],
  )
  saveDb()
}

/** 标记任务失败（可指定 status 为 'failed' 或 'cancelled'） */
export async function failReadingTask(
  taskId: string,
  error: string,
  status: 'failed' | 'cancelled' = 'failed',
): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  db.run(
    `UPDATE readings
     SET status = ?, error_msg = ?, updated_at = ?
     WHERE id = ?`,
    [status, error, now, taskId],
  )
  saveDb()
}

/**
 * 取消解读任务（原子化）
 * 仅当任务状态为 'pending' 时才更新为 'cancelled'
 * @returns { ok: 是否成功取消, alreadyFinished: 任务是否已结束 }
 */
export async function cancelReadingTask(
  taskId: string,
  userId: string,
): Promise<{ ok: boolean; alreadyFinished: boolean }> {
  const db = await getDb()

  // 原子化：只有 pending 才更新
  db.run(
    `UPDATE readings
     SET status = 'cancelled', error_msg = 'Cancelled by user', updated_at = ?
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [new Date().toISOString(), taskId, userId],
  )

  const changes = (db as any).getRowsModified?.() ?? 0
  if (changes === 0) {
    // 任务已结束（completed/failed/cancelled）
    return { ok: false, alreadyFinished: true }
  }

  saveDb()
  return { ok: true, alreadyFinished: false }
}

/** 获取任务统计 */
export async function getAsyncTaskStats(): Promise<{
  total: number; pending: number; completed: number; failed: number; cancelled: number
}> {
  const db = await getDb()
  const stmt = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
     FROM readings`,
  )
  stmt.step()
  const stats = stmt.getAsObject() as any
  stmt.free()
  return {
    total: stats.total || 0,
    pending: stats.pending || 0,
    completed: stats.completed || 0,
    failed: stats.failed || 0,
    cancelled: stats.cancelled || 0,
  }
}
