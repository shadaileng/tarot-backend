import { getDb, saveDb } from './index.js'

export interface ClientEventLogEntry {
  id: string
  user_id: string | null
  created_at: string
  event: string
  category: string
  level: string
  result: string | null
  action: string | null
  data_json: string | null
  platform: string | null
  device_model: string | null
  system_version: string | null
  sdk_version: string | null
  app_version: string | null
}

/** 批量写入客户端事件（事务包裹） */
export async function insertClientEventLogs(events: ClientEventLogEntry[]): Promise<{ inserted: number; duplicates: number }> {
  const db = await getDb()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO client_event_logs
    (id, user_id, created_at, event, category, level, result, action, data_json, platform, device_model, system_version, sdk_version, app_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let inserted = 0
  try {
    db.run('BEGIN TRANSACTION')
    for (const e of events) {
      stmt.bind([
        e.id, e.user_id, e.created_at, e.event, e.category, e.level,
        e.result ?? null, e.action ?? null, e.data_json ?? null,
        e.platform ?? null, e.device_model ?? null,
        e.system_version ?? null, e.sdk_version ?? null,
        e.app_version ?? null,
      ])
      stmt.step()
      stmt.reset()
      inserted++
    }
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  } finally {
    stmt.free()
  }
  saveDb()
  return { inserted, duplicates: events.length - inserted }
}

/** 分页查询客户端事件（Admin 用，默认不 JOIN users 暴露 PII） */
export async function queryClientEventLogs(opts: {
  page?: number; limit?: number
  userId?: string; category?: string; level?: string; event?: string
  from?: string; to?: string
}) {
  const db = await getDb()
  const page = opts.page || 1
  const limit = Math.min(opts.limit || 50, 200)
  const offset = (page - 1) * limit

  const where: string[] = []
  const params: any[] = []

  if (opts.userId) { where.push('user_id = ?'); params.push(opts.userId) }
  if (opts.category) { where.push('category = ?'); params.push(opts.category) }
  if (opts.level) { where.push('level = ?'); params.push(opts.level) }
  if (opts.event) { where.push('event = ?'); params.push(opts.event) }
  if (opts.from) { where.push('created_at >= ?'); params.push(opts.from) }
  if (opts.to) { where.push('created_at <= ?'); params.push(opts.to) }

  const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''

  // 总数
  const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM client_event_logs${clause}`)
  countStmt.bind(params)
  countStmt.step()
  const total = Number((countStmt.getAsObject() as any).cnt)
  countStmt.free()

  // 数据（仅返回 user_id，不 JOIN users 避免暴露 PII）
  const querySql = `SELECT * FROM client_event_logs
    ${clause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?`

  const stmt = db.prepare(querySql)
  stmt.bind([...params, limit, offset])
  const data: any[] = []
  while (stmt.step()) data.push(stmt.getAsObject())
  stmt.free()

  return { total, page, limit, data }
}

/** 清理过期日志（事务包裹） */
export async function cleanupClientEventLogs(retentionDays: number): Promise<number> {
  const db = await getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString()

  let deleted = 0
  db.run('BEGIN TRANSACTION')
  try {
    // 先查待删条数
    const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM client_event_logs WHERE created_at < ?')
    countStmt.bind([cutoffStr])
    countStmt.step()
    deleted = Number((countStmt.getAsObject() as any).cnt)
    countStmt.free()

    db.run('DELETE FROM client_event_logs WHERE created_at < ?', [cutoffStr])
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  } finally {
    saveDb()
  }
  return deleted
}
