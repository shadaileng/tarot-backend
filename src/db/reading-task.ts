import { getDb, saveDb } from './index.js'
import { v4 as uuidv4 } from 'uuid'
import { maskEmail } from './reading-log.js'

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

// ========== Admin 端查询 ==========

export interface ReadingTaskListRow {
  id: string
  created_at: string
  updated_at: string | null
  user_id: string
  user_nickname: string | null
  user_email: string | null
  user_avatar: string | null
  spread_type: string
  question: string | null
  cards_json: string
  reading: string | null
  model: string | null
  status: string
  incomplete: number
  warning: string | null
  error_msg: string | null
  duration_ms: number | null
}

export interface ReadingTaskFilter {
  page?: number
  limit?: number
  status?: string
  userId?: string
  keyword?: string
  dateFrom?: string
  dateTo?: string
}

/** Admin 分页查询解读任务列表 */
export async function listReadingTasks(filter: ReadingTaskFilter): Promise<{ total: number; data: ReadingTaskListRow[] }> {
  const db = await getDb()
  const page = filter.page || 1
  const limit = Math.min(filter.limit || 50, 200)
  const offset = (page - 1) * limit

  const where: string[] = []
  const params: any[] = []

  if (filter.status) {
    where.push('r.status = ?')
    params.push(filter.status)
  }
  if (filter.userId) {
    where.push('r.user_id = ?')
    params.push(filter.userId)
  }
  if (filter.keyword) {
    where.push('r.question LIKE ?')
    params.push(`%${filter.keyword}%`)
  }
  if (filter.dateFrom) {
    where.push('r.created_at >= ?')
    params.push(filter.dateFrom)
  }
  if (filter.dateTo) {
    where.push('r.created_at <= ?')
    params.push(filter.dateTo)
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

  // 总数
  const countSql = `SELECT COUNT(*) as cnt FROM readings r ${whereClause}`
  const countResult = db.exec(countSql, params)
  const total = countResult.length > 0 && countResult[0].values.length > 0
    ? Number(countResult[0].values[0][0])
    : 0

  // 列表（JOIN users，计算耗时）
  const listSql = `SELECT r.*, 
    u.nickname AS user_nickname,
    u.email AS user_email,
    u.avatar_url AS user_avatar,
    CASE WHEN r.status IN ('completed','failed','cancelled') AND r.updated_at IS NOT NULL
      THEN (julianday(r.updated_at) - julianday(r.created_at)) * 86400000
      ELSE NULL END AS duration_ms
  FROM readings r
  LEFT JOIN users u ON r.user_id = u.id
  ${whereClause}
  ORDER BY r.created_at DESC LIMIT ? OFFSET ?`

  const stmt = db.prepare(listSql)
  stmt.bind([...params, limit, offset])
  const rows: ReadingTaskListRow[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as ReadingTaskListRow
    row.user_email = maskEmail(row.user_email)
    rows.push(row)
  }
  stmt.free()

  return { total, data: rows }
}

/** Admin 获取单个任务详情（不限 userId） */
export async function getReadingTaskById(taskId: string): Promise<ReadingTaskListRow | null> {
  const db = await getDb()
  const stmt = db.prepare(`SELECT r.*,
    u.nickname AS user_nickname,
    u.email AS user_email,
    u.avatar_url AS user_avatar,
    CASE WHEN r.status IN ('completed','failed','cancelled') AND r.updated_at IS NOT NULL
      THEN (julianday(r.updated_at) - julianday(r.created_at)) * 86400000
      ELSE NULL END AS duration_ms
  FROM readings r
  LEFT JOIN users u ON r.user_id = u.id
  WHERE r.id = ?`)
  stmt.bind([taskId])
  let row: ReadingTaskListRow | null = null
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as ReadingTaskListRow
    row.user_email = maskEmail(row.user_email)
  }
  stmt.free()
  return row
}

/** Admin 强制取消任务（不校验 userId） */
export async function adminCancelReadingTask(taskId: string): Promise<{ ok: boolean; alreadyFinished: boolean }> {
  const db = await getDb()
  db.run(
    `UPDATE readings
     SET status = 'cancelled', error_msg = 'Cancelled by admin', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [new Date().toISOString(), taskId],
  )
  const changes = (db as any).getRowsModified?.() ?? 0
  if (changes === 0) {
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
