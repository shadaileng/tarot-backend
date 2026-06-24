import { getDb, saveDb } from './index.js'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { getLogger } from '../logger.js'

const log = getLogger('DB:Admin')

export interface AdminRow {
  id: string
  username: string
  password_hash: string
  display_name: string
  role: string
  created_at: string
  last_login_at: string | null
  is_active: number
  must_change_password: number
}

/** 管理员列表项（脱敏，不含 password_hash） */
export interface AdminListItem {
  id: string
  username: string
  displayName: string
  role: string
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface AdminListResult {
  list: AdminListItem[]
  total: number
  page: number
  pageSize: number
}

export interface UpdateAdminInput {
  displayName?: string
  role?: string
  isActive?: boolean
}

/** 分页列出管理员（支持按 username / displayName 模糊搜索） */
export async function listAdmins(
  page: number,
  pageSize: number,
  search?: string,
): Promise<AdminListResult> {
  const db = await getDb()

  // COUNT
  let countSql = 'SELECT COUNT(*) as cnt FROM admins'
  const countParams: (string | number)[] = []
  if (search) {
    countSql += ' WHERE username LIKE ? OR display_name LIKE ?'
    countParams.push(`%${search}%`, `%${search}%`)
  }
  const countStmt = db.prepare(countSql)
  countStmt.bind(countParams)
  countStmt.step()
  const totalRow = countStmt.getAsObject() as { cnt: number }
  countStmt.free()

  // SELECT with pagination
  const offset = (page - 1) * pageSize
  let sql =
    'SELECT id, username, display_name, role, is_active, created_at, last_login_at FROM admins'
  const params: (string | number)[] = []
  if (search) {
    sql += ' WHERE username LIKE ? OR display_name LIKE ?'
    params.push(`%${search}%`, `%${search}%`)
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(pageSize, offset)

  const stmt = db.prepare(sql)
  stmt.bind(params)
  const list: AdminListItem[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as any
    list.push({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active === 1,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    })
  }
  stmt.free()

  return { list, total: totalRow.cnt, page, pageSize }
}

/** 更新管理员信息（displayName / role / isActive） */
export async function updateAdmin(id: string, data: UpdateAdminInput): Promise<boolean> {
  const db = await getDb()
  const parts: string[] = []
  const params: (string | number)[] = []

  if (data.displayName !== undefined) {
    parts.push('display_name = ?')
    params.push(data.displayName)
  }
  if (data.role !== undefined) {
    parts.push('role = ?')
    params.push(data.role)
  }
  if (data.isActive !== undefined) {
    parts.push('is_active = ?')
    params.push(data.isActive ? 1 : 0)
  }

  if (parts.length === 0) return false

  params.push(id)
  db.run(`UPDATE admins SET ${parts.join(', ')} WHERE id = ?`, params)
  saveDb()
  return true
}

/** 软删除管理员（设置 is_active = 0） */
export async function deleteAdmin(id: string): Promise<boolean> {
  const db = await getDb()
  db.run('UPDATE admins SET is_active = 0 WHERE id = ?', [id])
  saveDb()
  return true
}

/** 重置管理员密码（强制 must_change_password = 1） */
export async function resetAdminPassword(id: string, hashedPassword: string): Promise<boolean> {
  const db = await getDb()
  db.run('UPDATE admins SET password_hash = ?, must_change_password = 1 WHERE id = ?', [
    hashedPassword,
    id,
  ])
  saveDb()
  return true
}

export async function findAdminByUsername(username: string): Promise<AdminRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM admins WHERE username = ?')
  stmt.bind([username])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as AdminRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

export async function updateLastLogin(adminId: string): Promise<void> {
  const db = await getDb()
  db.run("UPDATE admins SET last_login_at = datetime('now') WHERE id = ?", [adminId])
  saveDb()
}

export interface CreateAdminOptions {
  username: string
  passwordHash: string
  displayName: string
  role: string
  mustChangePassword?: number
}

export async function createAdmin(options: CreateAdminOptions): Promise<AdminRow> {
  const { username, passwordHash, displayName, role, mustChangePassword = 0 } = options
  const db = await getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.run(
    'INSERT INTO admins (id, username, password_hash, display_name, role, created_at, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    [id, username, passwordHash, displayName, role, now, mustChangePassword],
  )
  saveDb()
  return {
    id,
    username,
    password_hash: passwordHash,
    display_name: displayName,
    role,
    created_at: now,
    last_login_at: null,
    is_active: 1,
    must_change_password: mustChangePassword,
  }
}

export async function findAdminById(adminId: string): Promise<AdminRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM admins WHERE id = ?')
  stmt.bind([adminId])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as AdminRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

export async function setMustChangePassword(adminId: string, value: number): Promise<void> {
  const db = await getDb()
  db.run('UPDATE admins SET must_change_password = ? WHERE id = ?', [value, adminId])
  saveDb()
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) {
    return '新密码长度不能少于 8 位'
  }
  if (!/[a-zA-Z]/.test(password)) {
    return '新密码必须包含至少一个字母'
  }
  if (!/[0-9]/.test(password)) {
    return '新密码必须包含至少一个数字'
  }
  return null
}

export async function changePassword(
  adminId: string,
  oldPassword: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = await findAdminById(adminId)
  if (!admin || admin.is_active !== 1) {
    return { success: false, error: '账号不存在或已禁用' }
  }

  const passwordMatch = await bcrypt.compare(oldPassword, admin.password_hash)
  if (!passwordMatch) {
    return { success: false, error: '旧密码错误' }
  }

  const strengthError = validatePasswordStrength(newPassword)
  if (strengthError) {
    return { success: false, error: strengthError }
  }

  const newHash = await bcrypt.hash(newPassword, 10)
  const db = await getDb()
  db.run(
    'UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [newHash, adminId],
  )
  saveDb()
  log.info({ adminId, username: admin.username }, 'Admin password changed')

  return { success: true }
}

/** 首次启动时，若 admins 表为空，则使用环境变量默认值自动创建初始管理员（默认账号 admin / admin@123456） */
export async function initAdminIfNeeded(): Promise<void> {
  const username = process.env.ADMIN_INIT_USERNAME || 'admin'
  const password = process.env.ADMIN_INIT_PASSWORD || 'admin@123456'

  if (!username || !password) return

  const db = await getDb()

  // 检查是否已有管理员
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM admins')
  countStmt.step()
  const row = countStmt.getAsObject() as { cnt: number }
  countStmt.free()

  if (row.cnt > 0) return

  // 确保用户名不重复
  const existing = await findAdminByUsername(username)
  if (existing) return

  const passwordHash = await bcrypt.hash(password, 10)
  await createAdmin({
    username,
    passwordHash,
    displayName: username,
    role: 'admin',
    mustChangePassword: 1,
  })
  log.info({ username }, '初始管理员账号已创建（首次登录须修改密码）')
}
