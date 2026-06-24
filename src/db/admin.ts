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

export async function createAdmin(
  username: string,
  passwordHash: string,
  displayName: string,
  role: string,
): Promise<AdminRow> {
  const db = await getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.run(
    'INSERT INTO admins (id, username, password_hash, display_name, role, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [id, username, passwordHash, displayName, role],
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
  }
}

/** 首次启动时，若 admins 表为空且环境变量已设置，则自动创建初始管理员 */
export async function initAdminIfNeeded(): Promise<void> {
  const username = process.env.ADMIN_INIT_USERNAME
  const password = process.env.ADMIN_INIT_PASSWORD

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
  await createAdmin(username, passwordHash, username, 'admin')
  log.info({ username }, 'Initial admin account created from environment variables')
}
