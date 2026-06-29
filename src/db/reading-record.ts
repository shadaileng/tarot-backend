import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'
import type { ReadingRecord } from '../types/auth.js'

const log = getLogger('DB:ReadingRecord')

// ==================== 保存 ====================

interface SaveRecordParams {
  userId: string
  spreadType: string
  question?: string | null
  cardsJson: string
  reading: string
  model?: string | null
  isLocal?: boolean
  interpretation?: string | null
}

/** 保存一条占卜记录 */
export async function saveRecord(params: SaveRecordParams): Promise<ReadingRecord> {
  const db = await getDb()
  const now = new Date().toISOString()
  const id = uuidv4()

  db.run(
    `INSERT INTO reading_records (id, user_id, created_at, spread_type, question, cards_json, reading, model, is_local, interpretation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.userId,
      now,
      params.spreadType,
      params.question || null,
      params.cardsJson,
      params.reading,
      params.model || null,
      params.isLocal ? 1 : 0,
      params.interpretation || null,
    ]
  )
  saveDb()
  log.debug({ id, userId: params.userId, spreadType: params.spreadType }, 'Record saved')
  return (await getRecordById(params.userId, id))!
}

// ==================== 查询 ====================

/** 分页查询用户记录（按时间倒序） */
export async function getUserRecords(
  userId: string,
  page: number = 1,
  limit: number = 20
): Promise<{ records: ReadingRecord[]; total: number; page: number; limit: number }> {
  const db = await getDb()
  const offset = (page - 1) * limit

  // 总数
  const countStmt = db.prepare('SELECT COUNT(*) as total FROM reading_records WHERE user_id = ?')
  countStmt.bind([userId])
  countStmt.step()
  const total = (countStmt.getAsObject() as { total: number }).total
  countStmt.free()

  // 查询
  const records: ReadingRecord[] = []
  const stmt = db.prepare(
    'SELECT * FROM reading_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
  stmt.bind([userId, limit, offset])
  while (stmt.step()) {
    records.push(stmt.getAsObject() as unknown as ReadingRecord)
  }
  stmt.free()

  return { records, total, page, limit }
}

/** 查询单条记录 */
export async function getRecordById(userId: string, recordId: string): Promise<ReadingRecord | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM reading_records WHERE id = ? AND user_id = ?')
  stmt.bind([recordId, userId])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as ReadingRecord
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

// ==================== 删除 ====================

/** 删除单条记录 */
export async function deleteRecord(userId: string, recordId: string): Promise<boolean> {
  const db = await getDb()
  const existing = await getRecordById(userId, recordId)
  if (!existing) return false

  db.run('DELETE FROM reading_records WHERE id = ? AND user_id = ?', [recordId, userId])
  saveDb()
  log.debug({ id: recordId, userId }, 'Record deleted')
  return true
}
