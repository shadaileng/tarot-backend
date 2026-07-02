import { getDb, closeDb, saveDb } from './index.js'

// ========== 精简版：解读日志 ==========

export interface ReadingLogEntry {
  id: string
  created_at: string
  user_id: string | null
  question: string | null
  cards_json: string | null
  reading: string | null
  model: string | null
  incomplete: number | null
  // JOIN 字段
  user_nickname: string | null
  user_email: string | null
  user_avatar: string | null
}

export interface ReadingLogQueryResult {
  total: number
  page: number
  limit: number
  data: ReadingLogEntry[]
}

export interface InsertReadingLogParams {
  id: string
  method: string
  path: string
  target: string
  user_id?: string | null
  question?: string | null
  cards_json?: string | null
  reading?: string | null
  model?: string | null
  incomplete?: boolean
}

export async function insertReadingLog(params: InsertReadingLogParams): Promise<void> {
  const db = await getDb()
  const created_at = new Date().toISOString()
  db.run(
    `INSERT INTO reading_logs (id, created_at, method, path, target, user_id, question, cards_json, reading, model, incomplete)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      created_at,
      params.method,
      params.path,
      params.target,
      params.user_id ?? null,
      params.question ?? null,
      params.cards_json ?? null,
      params.reading ?? null,
      params.model ?? null,
      params.incomplete ? 1 : 0,
    ],
  )
  saveDb()
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [local, domain] = email.split('@')
  if (!domain) return email
  const visible = local.length > 1 ? local[0] + '***' : '***'
  return visible + '@' + domain
}

export async function queryReadingLogs(page: number = 1, limit: number = 50): Promise<ReadingLogQueryResult> {
  const db = await getDb()

  const countSql = 'SELECT COUNT(*) as cnt FROM reading_logs'
  const querySql = `SELECT l.id, l.created_at, l.user_id, l.question, l.cards_json, l.reading, l.model, l.incomplete,
    u.nickname   AS user_nickname,
    u.email      AS user_email,
    u.avatar_url AS user_avatar
  FROM reading_logs l
  LEFT JOIN users u ON l.user_id = u.id`

  const countResult = db.exec(countSql)
  const total = countResult.length > 0 && countResult[0].values.length > 0
    ? Number(countResult[0].values[0][0])
    : 0

  const offset = (page - 1) * limit
  const finalSql = querySql + ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?'

  const stmt = db.prepare(finalSql)
  stmt.bind([limit, offset])
  const rows: ReadingLogEntry[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as ReadingLogEntry
    row.user_email = maskEmail(row.user_email)
    rows.push(row)
  }
  stmt.free()

  return { total, page, limit, data: rows }
}

export async function getReadingLogById(id: string): Promise<ReadingLogEntry | undefined> {
  const db = await getDb()
  const stmt = db.prepare(`SELECT l.id, l.created_at, l.user_id, l.question, l.cards_json, l.reading, l.model, l.incomplete,
    u.nickname   AS user_nickname,
    u.email      AS user_email,
    u.avatar_url AS user_avatar
  FROM reading_logs l
  LEFT JOIN users u ON l.user_id = u.id
  WHERE l.id = ?`)
  stmt.bind([id])
  let row: ReadingLogEntry | undefined
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as ReadingLogEntry
    row.user_email = maskEmail(row.user_email)
  }
  stmt.free()
  return row
}

// ========== 旧版：完整日志（向后兼容） ==========

export interface LogEntry {
  id: string
  created_at: string
  method: string
  path: string
  target: string
  status_code: number | null
  duration_ms: number | null
  ip_address: string | null
  question: string | null
  cards_json: string | null
  reading: string | null
  model: string | null
  incomplete: number | null
  is_error: number | null
  error_msg: string | null
  user_id: string | null
  // 来自 users 表的 JOIN 字段
  user_nickname: string | null
  user_email: string | null
  user_avatar: string | null
  login_type: string | null // 'wechat' | 'email' | 'wechat+email' | 'anonymous'
}

export interface LogQueryResult {
  total: number
  page: number
  limit: number
  data: LogEntry[]
}

export interface InsertLogParams {
  id: string
  method: string
  path: string
  target: string
  status_code: number
  duration_ms: number
  ip_address: string
  question?: string | null
  cards_json?: string | null
  reading?: string | null
  model?: string | null
  incomplete?: boolean
  is_error?: boolean
  error_msg?: string | null
  user_id?: string | null
}

export async function insertLog(params: InsertLogParams): Promise<void> {
  const db = await getDb()
  const created_at = new Date().toISOString()
  db.run(
    `INSERT INTO reading_logs (id, created_at, method, path, target, status_code, duration_ms, ip_address, question, cards_json, reading, model, incomplete, is_error, error_msg, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      created_at,
      params.method,
      params.path,
      params.target,
      params.status_code,
      params.duration_ms,
      params.ip_address,
      params.question ?? null,
      params.cards_json ?? null,
      params.reading ?? null,
      params.model ?? null,
      params.incomplete ? 1 : 0,
      params.is_error ? 1 : 0,
      params.error_msg ?? null,
      params.user_id ?? null,
    ],
  )
  saveDb()
}

export async function queryLogs(page: number = 1, limit: number = 50, target?: string): Promise<LogQueryResult> {
  const db = await getDb()

  let countSql = 'SELECT COUNT(*) as cnt FROM reading_logs'
  let querySql = `SELECT l.*,
    u.nickname   AS user_nickname,
    u.email      AS user_email,
    u.avatar_url AS user_avatar,
    CASE
      WHEN u.openid != '' AND u.email IS NOT NULL THEN 'wechat+email'
      WHEN u.openid != '' THEN 'wechat'
      WHEN u.email IS NOT NULL THEN 'email'
      ELSE 'anonymous'
    END AS login_type
  FROM reading_logs l
  LEFT JOIN users u ON l.user_id = u.id`
  const where: string[] = []
  const params: any[] = []

  if (target) {
    where.push('target = ?')
    params.push(target)
  }

  if (where.length > 0) {
    const clause = ' WHERE ' + where.join(' AND ')
    countSql += clause
    querySql += clause
  }

  const countResult = db.exec(countSql, params)
  const total = countResult.length > 0 && countResult[0].values.length > 0
    ? Number(countResult[0].values[0][0])
    : 0

  const offset = (page - 1) * limit
  querySql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?'
  const queryParams = [...params, limit, offset]

  const stmt = db.prepare(querySql)
  stmt.bind(queryParams)
  const rows: LogEntry[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as LogEntry
    row.user_email = maskEmail(row.user_email)
    rows.push(row)
  }
  stmt.free()

  return { total, page, limit, data: rows }
}

export async function getLogById(id: string): Promise<LogEntry | undefined> {
  const db = await getDb()
  const stmt = db.prepare(`SELECT l.*,
    u.nickname   AS user_nickname,
    u.email      AS user_email,
    u.avatar_url AS user_avatar,
    CASE
      WHEN u.openid != '' AND u.email IS NOT NULL THEN 'wechat+email'
      WHEN u.openid != '' THEN 'wechat'
      WHEN u.email IS NOT NULL THEN 'email'
      ELSE 'anonymous'
    END AS login_type
  FROM reading_logs l
  LEFT JOIN users u ON l.user_id = u.id
  WHERE l.id = ?`)
  stmt.bind([id])
  let row: LogEntry | undefined
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as LogEntry
    row.user_email = maskEmail(row.user_email)
  }
  stmt.free()
  return row
}

export async function deleteOldLogs(retentionDays: number): Promise<number> {
  const db = await getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  db.run('DELETE FROM reading_logs WHERE created_at < ?', [cutoff.toISOString()])
  return 0
}
