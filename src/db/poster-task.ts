import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'

const log = getLogger('DB:PosterTask')

export interface PosterTaskRow {
  id: string
  user_id: string | null
  created_at: string
  updated_at: string | null
  cards_json: string
  question: string | null
  spread_name: string | null
  interpretation: string | null
  comprehensive_interpretation: string | null
  theme: string
  template: string
  status: 'pending' | 'rendering' | 'completed' | 'failed' | 'cancelled'
  poster_url: string | null
  cache_key: string | null
  error_msg: string | null
  request_log_id: string | null
}

/** 创建海报任务 */
export async function createPosterTask(data: {
  userId?: string
  cardsJson: string
  question?: string
  spreadName?: string
  interpretation?: string
  comprehensiveInterpretation?: string
  theme?: string
  template?: string
  requestLogId?: string
}): Promise<string> {
  const db = await getDb()
  const id = uuidv4()
  const now = new Date().toISOString()

  db.run(`
    INSERT INTO poster_tasks (id, user_id, created_at, cards_json, question, spread_name,
      interpretation, comprehensive_interpretation, theme, template, status, request_log_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `, [id, data.userId || null, now, data.cardsJson, data.question || null,
      data.spreadName || null, data.interpretation || null,
      data.comprehensiveInterpretation || null, data.theme || 'dark',
      data.template || 'default', data.requestLogId || null])

  saveDb()
  log.info({ taskId: id, userId: data.userId }, 'Created poster task')
  return id
}

/** 获取海报任务 */
export async function getPosterTask(taskId: string, userId?: string): Promise<PosterTaskRow | null> {
  const db = await getDb()
  let sql = 'SELECT * FROM poster_tasks WHERE id = ?'
  const params: any[] = [taskId]

  if (userId) {
    sql += ' AND user_id = ?'
    params.push(userId)
  }

  const stmt = db.prepare(sql)
  stmt.bind(params)

  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as PosterTaskRow
    stmt.free()
    return row
  }

  stmt.free()
  return null
}

/** 标记任务完成 */
export async function completePosterTask(data: {
  taskId: string
  posterUrl: string
  cacheKey: string
}): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(`
    UPDATE poster_tasks
    SET status = 'completed', poster_url = ?, cache_key = ?, updated_at = ?
    WHERE id = ?
  `, [data.posterUrl, data.cacheKey, now, data.taskId])

  saveDb()
  log.info({ taskId: data.taskId }, 'Completed poster task')
}

/** 标记任务失败 */
export async function failPosterTask(taskId: string, error: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(`
    UPDATE poster_tasks
    SET status = 'failed', error_msg = ?, updated_at = ?
    WHERE id = ?
  `, [error, now, taskId])

  saveDb()
  log.info({ taskId, error }, 'Failed poster task')
}

/** 取消任务（原子操作：只有 pending 才能改 cancelled） */
export async function cancelPosterTask(taskId: string): Promise<boolean> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(`
    UPDATE poster_tasks
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `, [now, taskId])

  const changes = (db as any).getRowsModified?.() ?? 0
  saveDb()
  return changes > 0
}

/** 更新任务状态 */
export async function updatePosterTaskStatus(taskId: string, status: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(`
    UPDATE poster_tasks SET status = ?, updated_at = ? WHERE id = ?
  `, [status, now, taskId])

  saveDb()
}

/** 清理已完成/失败的旧海报任务 */
export async function cleanupPosterTasks(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0
  const db = await getDb()
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()

  const countStmt = db.prepare(
    "SELECT COUNT(*) as cnt FROM poster_tasks WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')"
  )
  countStmt.bind([cutoff])
  countStmt.step()
  const count = (countStmt.getAsObject() as { cnt: number }).cnt
  countStmt.free()

  if (count > 0) {
    db.run("DELETE FROM poster_tasks WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')", [cutoff])
    saveDb(true)
    log.info({ deleted: count, retentionDays }, 'Old poster tasks cleaned')
  }
  return count
}
