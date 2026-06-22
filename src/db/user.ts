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
    createdAt: row.created_at,
  }
}

/** 手机号脱敏 */
function maskPhone(phone: string): string {
  if (phone.length < 7) return phone
  return phone.slice(0, 3) + '****' + phone.slice(-4)
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
}

/** 创建新用户 */
export async function createUser(params: CreateUserParams): Promise<UserRow> {
  const db = await getDb()
  const now = new Date().toISOString()
  const id = uuidv4()

  db.run(
    `INSERT INTO users (id, openid, unionid, email, password_hash, phone, nickname, avatar_url, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.openid || '',
      params.unionid || null,
      params.email || null,
      params.passwordHash || null,
      params.phone || null,
      params.nickname || '匿名用户',
      params.avatarUrl || null,
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

/** 更新用户资料（昵称/头像） */
export async function updateProfile(userId: string, updates: { nickname?: string; avatarUrl?: string }): Promise<UserRow | null> {
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

  if (sets.length === 0) return findById(userId)

  params.push(userId)
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params)
  saveDb()
  log.info({ userId, ...updates }, 'Profile updated')
  return findById(userId)
}

// ==================== 导出前端信息 ====================

export { toUserInfo }
