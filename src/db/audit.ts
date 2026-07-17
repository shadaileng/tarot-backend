import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'

const log = getLogger('DB:Audit')

const MAX_VALUE_SIZE = 10 * 1024  // 10KB

export interface AuditLogRow {
  id: string
  created_at: string
  actor_type: string        // 'user' | 'admin' | 'system'
  actor_id: string | null
  actor_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_name: string | null
  old_value: string | null  // JSON string
  new_value: string | null  // JSON string
  ip_address: string | null
}

interface InsertAuditLogParams {
  actorType: 'user' | 'admin' | 'system'
  actorId?: string | null
  actorName?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  targetName?: string | null
  oldValue?: Record<string, any> | null
  newValue?: Record<string, any> | null
  ipAddress?: string | null
}

function truncateValue(value: any): string | null {
  if (!value) return null
  const json = JSON.stringify(value)
  if (json.length > MAX_VALUE_SIZE) {
    return json.substring(0, MAX_VALUE_SIZE) + '[TRUNCATED]'
  }
  return json
}

/**
 * 插入审计日志（fire-and-forget，不阻塞主流程）
 */
export async function insertAuditLog(params: InsertAuditLogParams): Promise<void> {
  try {
    const db = await getDb()
    const id = uuidv4()
    const now = new Date().toISOString()

    db.run(
      `INSERT INTO audit_logs (id, created_at, actor_type, actor_id, actor_name, action, target_type, target_id, target_name, old_value, new_value, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        params.actorType,
        params.actorId || null,
        params.actorName || null,
        params.action,
        params.targetType || null,
        params.targetId || null,
        params.targetName || null,
        truncateValue(params.oldValue),
        truncateValue(params.newValue),
        params.ipAddress || null,
      ],
    )
    saveDb(true)  // 使用写合并，避免高频写入时的性能问题
  } catch (err) {
    log.error({ err, action: params.action, actorId: params.actorId }, 'Failed to insert audit log')
  }
}

interface QueryAuditLogsParams {
  page?: number
  limit?: number
  actorType?: string
  actorId?: string
  action?: string | string[]
  targetType?: string
  targetId?: string
  startDate?: string
  endDate?: string
  keyword?: string
  ipAddress?: string
}

/**
 * 查询审计日志（分页 + 多条件筛选）
 */
export async function queryAuditLogs(params: QueryAuditLogsParams): Promise<{
  total: number
  page: number
  limit: number
  data: AuditLogRow[]
}> {
  const db = await getDb()
  const page = params.page || 1
  const limit = Math.min(params.limit || 50, 200)
  const offset = (page - 1) * limit

  const where: string[] = []
  const bindParams: any[] = []

  if (params.actorType) {
    where.push('actor_type = ?')
    bindParams.push(params.actorType)
  }
  if (params.actorId) {
    where.push('actor_id = ?')
    bindParams.push(params.actorId)
  }
  if (params.action) {
    const actions = Array.isArray(params.action) ? params.action : [params.action]
    if (actions.length > 0) {
      const placeholders = actions.map(() => '?').join(', ')
      where.push(`action IN (${placeholders})`)
      bindParams.push(...actions)
    }
  }
  if (params.targetType) {
    where.push('target_type = ?')
    bindParams.push(params.targetType)
  }
  if (params.targetId) {
    where.push('target_id = ?')
    bindParams.push(params.targetId)
  }
  if (params.startDate) {
    where.push('created_at >= ?')
    bindParams.push(params.startDate)
  }
  if (params.endDate) {
    where.push('created_at <= ?')
    bindParams.push(params.endDate + 'T23:59:59.999Z')
  }
  if (params.keyword) {
    where.push('(actor_name LIKE ? OR target_name LIKE ?)')
    bindParams.push(`%${params.keyword}%`, `%${params.keyword}%`)
  }
  if (params.ipAddress) {
    where.push('ip_address LIKE ?')
    bindParams.push(`%${params.ipAddress}%`)
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

  // Count query
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM audit_logs ${whereClause}`)
  countStmt.bind(bindParams)
  countStmt.step()
  const total = (countStmt.getAsObject() as { total: number }).total
  countStmt.free()

  // Data query
  const stmt = db.prepare(
    `SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
  stmt.bind([...bindParams, limit, offset])
  const data: AuditLogRow[] = []
  while (stmt.step()) {
    data.push(stmt.getAsObject() as unknown as AuditLogRow)
  }
  stmt.free()

  return { total, page, limit, data }
}

/**
 * 清理过期审计日志
 * @param retentionDays 保留天数，设为 0 表示不清理
 * @returns 删除的条数
 */
export async function cleanExpiredAuditLogs(retentionDays: number): Promise<number> {
  // 0 或负数表示不自动清理
  if (retentionDays <= 0) return 0

  const db = await getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString()

  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs WHERE created_at < ?')
  countStmt.bind([cutoffStr])
  countStmt.step()
  const count = (countStmt.getAsObject() as { cnt: number }).cnt
  countStmt.free()

  if (count > 0) {
    db.run('DELETE FROM audit_logs WHERE created_at < ?', [cutoffStr])
    saveDb()
    log.info({ deleted: count, retentionDays }, 'Expired audit logs cleaned')
  }

  return count
}
