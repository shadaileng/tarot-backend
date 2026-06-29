import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'

const log = getLogger('DB:Feedback')

export interface FeedbackCreateParams {
  userId: string
  category: string
  content: string
  images?: string[]
}

export interface FeedbackRow {
  id: string
  user_id: string
  category: string
  content: string
  images: string | null
  status: string
  admin_reply: string | null
  replied_at: string | null
  replied_by: string | null
  created_at: string
  updated_at: string
}

export interface FeedbackListResult {
  total: number
  page: number
  limit: number
  data: FeedbackRow[]
}

export async function createFeedback(params: FeedbackCreateParams): Promise<FeedbackRow> {
  const db = await getDb()
  const now = new Date().toISOString()
  const id = uuidv4()

  db.run(
    `INSERT INTO feedback (id, user_id, category, content, images, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      params.userId,
      params.category,
      params.content,
      params.images ? JSON.stringify(params.images) : null,
      now,
      now,
    ]
  )
  saveDb()
  log.debug({ id, userId: params.userId, category: params.category }, 'Feedback created')
  return (await getFeedbackById(id))!
}

export async function getFeedbackById(id: string): Promise<FeedbackRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM feedback WHERE id = ?')
  stmt.bind([id])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as FeedbackRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

export async function getFeedbackListByUser(
  userId: string,
  page: number = 1,
  limit: number = 20
): Promise<FeedbackListResult> {
  const db = await getDb()
  const offset = (page - 1) * limit

  const countStmt = db.prepare('SELECT COUNT(*) as total FROM feedback WHERE user_id = ?')
  countStmt.bind([userId])
  countStmt.step()
  const total = (countStmt.getAsObject() as { total: number }).total
  countStmt.free()

  const data: FeedbackRow[] = []
  const stmt = db.prepare(
    'SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
  stmt.bind([userId, limit, offset])
  while (stmt.step()) {
    data.push(stmt.getAsObject() as unknown as FeedbackRow)
  }
  stmt.free()

  return { total, page, limit, data }
}

export async function queryAllFeedback(params: {
  page?: number
  limit?: number
  keyword?: string
  status?: string
}): Promise<FeedbackListResult> {
  const db = await getDb()
  const page = params.page || 1
  const limit = Math.min(params.limit || 20, 100)
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const bindValues: any[] = []

  if (params.status) {
    conditions.push('f.status = ?')
    bindValues.push(params.status)
  }
  if (params.keyword) {
    conditions.push('f.content LIKE ?')
    bindValues.push(`%${params.keyword}%`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM feedback f ${where}`)
  countStmt.bind(bindValues)
  countStmt.step()
  const total = (countStmt.getAsObject() as { total: number }).total
  countStmt.free()

  const data: any[] = []
  const stmt = db.prepare(`
    SELECT f.*, u.nickname as user_nickname, u.avatar_url as user_avatar
    FROM feedback f
    LEFT JOIN users u ON f.user_id = u.id
    ${where}
    ORDER BY f.created_at DESC LIMIT ? OFFSET ?
  `)
  stmt.bind([...bindValues, limit, offset])
  while (stmt.step()) {
    data.push(stmt.getAsObject())
  }
  stmt.free()

  return { total, page, limit, data }
}

export async function replyFeedback(
  id: string,
  adminId: string,
  reply: string
): Promise<FeedbackRow | null> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(
    "UPDATE feedback SET admin_reply = ?, replied_at = ?, replied_by = ?, status = 'replied', updated_at = ? WHERE id = ?",
    [reply, now, adminId, now, id]
  )
  saveDb()
  log.debug({ id, adminId }, 'Feedback replied')
  return getFeedbackById(id)
}

export async function updateFeedbackStatus(
  id: string,
  status: string
): Promise<FeedbackRow | null> {
  const db = await getDb()
  const now = new Date().toISOString()

  db.run(
    'UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?',
    [status, now, id]
  )
  saveDb()
  log.debug({ id, status }, 'Feedback status updated')
  return getFeedbackById(id)
}
