import { getDb, saveDb } from './index.js'

export interface RequestLogEntry {
  id: string
  created_at: string
  method: string
  path: string
  target: string
  status_code: number | null
  duration_ms: number | null
  template_ms: number | null
  resource_ms: number | null
  screenshot_ms: number | null
  cache_hit: number
  ip_address: string | null
  is_error: number | null
  error_msg: string | null
  user_id: string | null
  // JOIN 字段
  user_nickname: string | null
  user_email: string | null
  user_avatar: string | null
  login_type: string | null
}

export interface RequestLogQueryResult {
  total: number
  page: number
  limit: number
  data: RequestLogEntry[]
}

export interface InsertRequestLogParams {
  id: string
  method: string
  path: string
  target: string
  status_code: number
  duration_ms: number
  template_ms?: number | null
  resource_ms?: number | null
  screenshot_ms?: number | null
  cache_hit?: boolean
  ip_address: string
  is_error?: boolean
  error_msg?: string | null
  user_id?: string | null
}

export async function insertRequestLog(params: InsertRequestLogParams): Promise<void> {
  const db = await getDb()
  const created_at = new Date().toISOString()
  db.run(
    `INSERT INTO request_logs (id, created_at, method, path, target, status_code, duration_ms, template_ms, resource_ms, screenshot_ms, cache_hit, ip_address, is_error, error_msg, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      created_at,
      params.method,
      params.path,
      params.target,
      params.status_code,
      params.duration_ms,
      params.template_ms ?? null,
      params.resource_ms ?? null,
      params.screenshot_ms ?? null,
      params.cache_hit ? 1 : 0,
      params.ip_address,
      params.is_error ? 1 : 0,
      params.error_msg ?? null,
      params.user_id ?? null,
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

export async function queryRequestLogs(page: number = 1, limit: number = 50, target?: string, status?: string): Promise<RequestLogQueryResult> {
  const db = await getDb()

  let countSql = 'SELECT COUNT(*) as cnt FROM request_logs'
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
  FROM request_logs l
  LEFT JOIN users u ON l.user_id = u.id`
  const where: string[] = []
  const params: any[] = []

  if (target) {
    where.push('l.target = ?')
    params.push(target)
  }

  if (status === '2xx') {
    where.push('l.status_code >= 200 AND l.status_code < 300')
  } else if (status === '4xx') {
    where.push('l.status_code >= 400 AND l.status_code < 500')
  } else if (status === '5xx') {
    where.push('l.status_code >= 500 AND l.status_code < 600')
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
  const rows: RequestLogEntry[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as RequestLogEntry
    row.user_email = maskEmail(row.user_email)
    rows.push(row)
  }
  stmt.free()

  return { total, page, limit, data: rows }
}

export async function getRequestLogById(id: string): Promise<RequestLogEntry | undefined> {
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
  FROM request_logs l
  LEFT JOIN users u ON l.user_id = u.id
  WHERE l.id = ?`)
  stmt.bind([id])
  let row: RequestLogEntry | undefined
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as RequestLogEntry
    row.user_email = maskEmail(row.user_email)
  }
  stmt.free()
  return row
}

export interface TargetStats {
  target: string
  count: number
  errors: number
  avgDurationMs: number
}

export interface RequestStats {
  totalRequests: number
  errors: number
  avgTotalMs: number
  cacheHits: number
  cacheMisses: number
  cacheHitRate: number
  avgTemplateMs: number
  avgResourceMs: number
  avgScreenshotMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  byTarget: TargetStats[]
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const index = Math.ceil((p / 100) * sortedValues.length) - 1
  return sortedValues[Math.max(0, index)]
}

export async function getRequestStats(): Promise<RequestStats> {
  const db = await getDb()

  // 基础统计
  const result = db.exec(`
    SELECT
      COUNT(*) as totalRequests,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
      AVG(duration_ms) as avgTotalMs,
      SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cacheHits,
      SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END) as cacheMisses,
      AVG(template_ms) as avgTemplateMs,
      AVG(resource_ms) as avgResourceMs,
      AVG(screenshot_ms) as avgScreenshotMs
    FROM request_logs
  `)

  // 分位数统计（需要获取所有 duration_ms 值排序）
  const durationResult = db.exec(`
    SELECT duration_ms FROM request_logs WHERE duration_ms IS NOT NULL ORDER BY duration_ms
  `)

  let p50Ms = 0, p95Ms = 0, p99Ms = 0
  if (durationResult.length > 0 && durationResult[0].values.length > 0) {
    const durations = durationResult[0].values.map((r) => Number(r[0]))
    p50Ms = percentile(durations, 50)
    p95Ms = percentile(durations, 95)
    p99Ms = percentile(durations, 99)
  }

  // 按 target 分组统计
  const targetResult = db.exec(`
    SELECT
      target,
      COUNT(*) as count,
      SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
      AVG(duration_ms) as avgDurationMs
    FROM request_logs
    GROUP BY target
    ORDER BY count DESC
  `)

  const byTarget: TargetStats[] = []
  if (targetResult.length > 0) {
    for (const row of targetResult[0].values) {
      byTarget.push({
        target: String(row[0]),
        count: Number(row[1]) || 0,
        errors: Number(row[2]) || 0,
        avgDurationMs: Number(row[3]) || 0,
      })
    }
  }

  if (result.length === 0 || result[0].values.length === 0) {
    return {
      totalRequests: 0,
      errors: 0,
      avgTotalMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      avgTemplateMs: 0,
      avgResourceMs: 0,
      avgScreenshotMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      byTarget: [],
    }
  }

  const row = result[0].values[0]
  const totalRequests = Number(row[0]) || 0
  const errors = Number(row[1]) || 0
  const avgTotalMs = Number(row[2]) || 0
  const cacheHits = Number(row[3]) || 0
  const cacheMisses = Number(row[4]) || 0
  const avgTemplateMs = Number(row[5]) || 0
  const avgResourceMs = Number(row[6]) || 0
  const avgScreenshotMs = Number(row[7]) || 0

  return {
    totalRequests,
    errors,
    avgTotalMs,
    cacheHits,
    cacheMisses,
    cacheHitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,
    avgTemplateMs,
    avgResourceMs,
    avgScreenshotMs,
    p50Ms,
    p95Ms,
    p99Ms,
    byTarget,
  }
}
