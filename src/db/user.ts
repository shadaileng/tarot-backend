import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'
import type { UserRow, UserInfo } from '../types/auth.js'

const log = getLogger('DB:User')

/** 将数据库行转为前端安全 UserInfo */
function toUserInfo(row: UserRow): UserInfo {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    email: row.email,
    phone: row.phone ? maskPhone(row.phone) : null,
    gender: row.gender,
    birthday: row.birthday,
    createdAt: row.created_at,
  }
}

/** 手机号脱敏 */
function maskPhone(phone: string): string {
  if (phone.length < 7) return phone
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

/** 邮箱脱敏 */
function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [local, domain] = email.split('@')
  if (!domain) return email
  const visible = local.length > 1 ? local[0] + '***' : '***'
  return visible + '@' + domain
}

// ==================== 用户查询（Admin 端） ====================

export interface AdminUserRow {
  id: string
  openid: string
  nickname: string
  avatar_url: string | null
  email: string | null
  phone: string | null
  created_at: string
  last_login_at: string | null
  request_count: number
  last_request_at: string | null
  deleted_at: string | null
}

export interface UserQueryResult {
  total: number
  page: number
  limit: number
  data: AdminUserRow[]
}

/** 查询用户列表（Admin 管理页面），支持按昵称/邮箱模糊搜索，含请求统计 */
export async function queryUsers(
  page: number = 1,
  limit: number = 20,
  keyword?: string,
  deleted?: boolean,
): Promise<UserQueryResult> {
  const db = await getDb()
  const where: string[] = []
  const params: any[] = []

  if (deleted) {
    where.push('u.deleted_at IS NOT NULL')
  } else {
    where.push('u.deleted_at IS NULL')
  }

  if (keyword) {
    where.push('(u.nickname LIKE ? OR u.email LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }

  const whereClause = 'WHERE ' + where.join(' AND ')

  // count
  const countResult = db.exec(
    `SELECT COUNT(*) as cnt FROM users u ${whereClause}`,
    params,
  )
  const total =
    countResult.length > 0 && countResult[0].values.length > 0
      ? Number(countResult[0].values[0][0])
      : 0

  // data — 带请求统计
  const offset = (page - 1) * limit
  const orderBy = deleted
    ? 'u.deleted_at DESC'
    : 'COALESCE(last_request_at, u.last_login_at, u.created_at) DESC'
  const querySql = `
    SELECT
      u.id, u.openid, u.nickname, u.avatar_url, u.email, u.phone,
      u.created_at, u.last_login_at, u.deleted_at,
      COUNT(l.id)   AS request_count,
      MAX(l.created_at) AS last_request_at
    FROM users u
    LEFT JOIN reading_logs l ON u.id = l.user_id
    ${whereClause}
    GROUP BY u.id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `
  const stmt = db.prepare(querySql)
  stmt.bind([...params, limit, offset])
  const rows: AdminUserRow[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as AdminUserRow
    row.email = maskEmail(row.email)
    rows.push(row)
  }
  stmt.free()

  return { total, page, limit, data: rows }
}

// ==================== 查询 ====================

/** 按 openid 查找用户 */
export async function findByOpenid(openid: string): Promise<UserRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE openid = ?')
  stmt.bind([openid])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 按 unionid 查找用户（非空） */
export async function findByUnionid(unionid: string): Promise<UserRow | null> {
  if (!unionid) return null
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE unionid = ?')
  stmt.bind([unionid])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 按 email 查找用户（非空） */
export async function findByEmail(email: string): Promise<UserRow | null> {
  if (!email) return null
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?')
  stmt.bind([email])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 按 userId 查找用户 */
export async function findById(userId: string): Promise<UserRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
  stmt.bind([userId])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

// ==================== 写入 ====================

interface CreateUserParams {
  openid?: string
  unionid?: string
  email?: string
  passwordHash?: string
  phone?: string
  nickname?: string
  avatarUrl?: string
  gender?: number
  birthday?: string
}

/** 创建新用户 */
export async function createUser(params: CreateUserParams): Promise<UserRow> {
  const db = await getDb()
  const now = new Date().toISOString()
  const id = uuidv4()

  db.run(
    `INSERT INTO users (id, openid, unionid, email, password_hash, phone, nickname, avatar_url, gender, birthday, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.openid || '',
      params.unionid || null,
      params.email || null,
      params.passwordHash || null,
      params.phone || null,
      params.nickname || '匿名用户',
      params.avatarUrl || null,
      params.gender ?? 0,
      params.birthday || null,
      now,
      now,
    ]
  )
  saveDb()
  log.info({ userId: id, openid: params.openid, email: params.email }, 'User created')
  return (await findById(id))!
}

// ==================== 更新 ====================

/** 更新最后登录时间 */
export async function updateLastLogin(userId: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, userId])
  saveDb()
}

/** 更新 unionid（已有 openid 用户补充 unionid） */
export async function updateUnionid(userId: string, unionid: string): Promise<void> {
  if (!unionid) return
  const db = await getDb()
  db.run('UPDATE users SET unionid = ? WHERE id = ?', [unionid, userId])
  saveDb()
}

/** 绑定邮箱 */
export async function bindEmail(userId: string, email: string, passwordHash: string): Promise<void> {
  const db = await getDb()
  db.run('UPDATE users SET email = ?, password_hash = ? WHERE id = ?', [email, passwordHash, userId])
  saveDb()
  log.info({ userId, email }, 'Email bound')
}

/** 绑定手机号 */
export async function bindPhone(userId: string, phone: string): Promise<void> {
  const db = await getDb()
  db.run('UPDATE users SET phone = ? WHERE id = ?', [phone, userId])
  saveDb()
  log.info({ userId }, 'Phone bound')
}

/** 合并账号：将源用户的数据迁移到目标用户，然后逻辑删除源用户（可恢复） */
export async function mergeAccount(targetId: string, sourceId: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()

  // 获取源用户数据
  const source = await findById(sourceId)
  if (!source) return

  // 迁移占卜记录
  db.run('UPDATE reading_records SET user_id = ? WHERE user_id = ?', [targetId, sourceId])

  // 先软删源用户（deleted_at 非 NULL 后，部分唯一索引不再覆盖它）
  db.run('UPDATE users SET deleted_at = ? WHERE id = ?', [now, sourceId])

  // 再将邮箱和密码转移到目标用户（此时索引中无冲突行）
  if (source.email) {
    db.run('UPDATE users SET email = ?, password_hash = ? WHERE id = ?',
      [source.email, source.password_hash, targetId])
  }

  saveDb()
  log.info({ targetId, sourceId, email: source.email }, 'Account merged (soft delete)')
}

/** 解除邮箱绑定（Admin 端）— 自动恢复被软删除的原邮箱用户 */
export async function unbindEmail(userId: string): Promise<void> {
  const db = await getDb()
  const user = await findById(userId)
  if (!user || !user.email) return
  if (!user.openid) {
    throw new Error('纯邮箱用户无法解除邮箱绑定')
  }

  const email = user.email

  // 清空当前用户的邮箱和密码
  db.run('UPDATE users SET email = NULL, password_hash = NULL WHERE id = ?', [userId])

  // 查找被软删除的原邮箱用户并恢复
  const stmt = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NOT NULL LIMIT 1')
  stmt.bind([email])
  if (stmt.step()) {
    const row = stmt.getAsObject() as { id: string }
    db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', [row.id])
    log.info({ userId, email, restoredUserId: row.id }, 'Email unbound, source user restored')
  } else {
    log.info({ userId, email }, 'Email unbound (no source user to restore)')
  }
  stmt.free()

  saveDb()
}

/** 逻辑删除用户（Admin 端） */
export async function softDeleteUser(userId: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  db.run('UPDATE users SET deleted_at = ? WHERE id = ?', [now, userId])
  saveDb()
  log.info({ userId }, 'User soft deleted')
}

/** 恢复已删除用户（Admin 端） */
export async function restoreUser(userId: string): Promise<void> {
  const db = await getDb()
  db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', [userId])
  saveDb()
  log.info({ userId }, 'User restored')
}

/** 更新用户资料（昵称/头像/性别/生日） */
export async function updateProfile(userId: string, updates: { nickname?: string; avatarUrl?: string; gender?: number; birthday?: string }): Promise<UserRow | null> {
  const db = await getDb()
  const sets: string[] = []
  const params: any[] = []

  if (updates.nickname !== undefined) {
    sets.push('nickname = ?')
    params.push(updates.nickname)
  }
  if (updates.avatarUrl !== undefined) {
    sets.push('avatar_url = ?')
    params.push(updates.avatarUrl)
  }
  if (updates.gender !== undefined) {
    sets.push('gender = ?')
    params.push(updates.gender)
  }
  if (updates.birthday !== undefined) {
    sets.push('birthday = ?')
    params.push(updates.birthday || null)
  }

  if (sets.length === 0) return findById(userId)

  params.push(userId)
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params)
  saveDb()
  log.info({ userId, ...updates }, 'Profile updated')
  return findById(userId)
}

// ==================== 导出前端信息 ====================

export { toUserInfo }
