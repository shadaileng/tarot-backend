import { getDb, closeDb, saveDb } from './index.js'

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
  let querySql = 'SELECT * FROM reading_logs'
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
  querySql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  const queryParams = [...params, limit, offset]

  const stmt = db.prepare(querySql)
  stmt.bind(queryParams)
  const rows: LogEntry[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as LogEntry)
  }
  stmt.free()

  return { total, page, limit, data: rows }
}

export async function getLogById(id: string): Promise<LogEntry | undefined> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM reading_logs WHERE id = ?')
  stmt.bind([id])
  let row: LogEntry | undefined
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as LogEntry
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
