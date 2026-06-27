import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import type { SqlJsStatic, Database } from 'sql.js'

const log = getLogger('DB')

let db: Database | null = null
let SQL: SqlJsStatic | null = null

async function initSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs()
  }
  return SQL
}

export function saveDb(): void {
  const data = db!.export()
  const dir = path.dirname(config.db.path)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(config.db.path, Buffer.from(data))
}

export async function getDb(): Promise<Database> {
  if (!db) {
    const sql = await initSql()
    const existed = fs.existsSync(config.db.path)
    if (existed) {
      const buffer = fs.readFileSync(config.db.path)
      db = new sql.Database(buffer)
    } else {
      db = new sql.Database()
    }
    db.run('PRAGMA journal_mode=WAL')
    initSchema(db)
    saveDb()
    log.info({ path: config.db.path, new: !existed }, 'Database initialized')
  }
  return db
}

function initSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS reading_logs (
      id             TEXT PRIMARY KEY,
      created_at     TEXT NOT NULL,
      method         TEXT NOT NULL,
      path           TEXT NOT NULL,
      target         TEXT NOT NULL,
      status_code    INTEGER,
      duration_ms    INTEGER,
      ip_address     TEXT,
      question       TEXT,
      cards_json     TEXT,
      reading        TEXT,
      model          TEXT,
      incomplete     INTEGER DEFAULT 0,
      is_error       INTEGER DEFAULT 0,
      error_msg      TEXT,
      openid         TEXT,
      user_id        TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_logs_created_at ON reading_logs(created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_logs_target ON reading_logs(target)')

  database.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'env',
      updated_at  TEXT NOT NULL
    )
  `)

  // ========== 用户系统表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      openid        TEXT NOT NULL DEFAULT '',
      unionid       TEXT,
      email         TEXT,
      password_hash TEXT,
      phone         TEXT,
      nickname      TEXT DEFAULT '匿名用户',
      avatar_url    TEXT,
      gender        INTEGER DEFAULT 0,
      birthday      TEXT,
      created_at    TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid)')
  database.run('CREATE INDEX IF NOT EXISTS idx_users_unionid ON users(unionid)')
  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != \'\'')

  database.run(`
    CREATE TABLE IF NOT EXISTS reading_records (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      spread_type TEXT NOT NULL,
      question    TEXT,
      cards_json  TEXT NOT NULL,
      reading     TEXT NOT NULL,
      model       TEXT,
      is_local    INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_records_user_id ON reading_records(user_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_records_created_at ON reading_records(created_at DESC)')

  // ========== 管理员表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id                  TEXT PRIMARY KEY,
      username            TEXT NOT NULL UNIQUE,
      password_hash       TEXT NOT NULL,
      display_name        TEXT NOT NULL DEFAULT '',
      role                TEXT NOT NULL DEFAULT 'admin',
      created_at          TEXT NOT NULL,
      last_login_at       TEXT,
      is_active           INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0
    )
  `)
  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username ON admins(username)')

  // 兼容已有数据库：为 admins 表新增 must_change_password 列
  try {
    database.run('ALTER TABLE admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')
  } catch {
    // 列已存在时静默忽略（SQLite 不支持 IF NOT EXISTS for ALTER TABLE）
  }

  // 兼容已有数据库：为 reading_logs 新增 user_id 列
  try {
    database.run('ALTER TABLE reading_logs ADD COLUMN user_id TEXT')
  } catch {
    // 列已存在时静默忽略（SQLite 不支持 IF NOT EXISTS for ALTER TABLE）
  }

  // 兼容已有数据库：为 users 表新增 gender / birthday 列
  try {
    database.run('ALTER TABLE users ADD COLUMN gender INTEGER DEFAULT 0')
  } catch {}
  try {
    database.run('ALTER TABLE users ADD COLUMN birthday TEXT')
  } catch {}

  // 兼容已有数据库：软删除支持
  try {
    database.run('ALTER TABLE users ADD COLUMN deleted_at TEXT')
  } catch {}

  // 更新邮箱唯一索引以支持软删除（排除已删除用户）
  try {
    database.run('DROP INDEX IF EXISTS idx_users_email')
  } catch {}
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL`)
}

export function closeDb(): void {
  if (db) {
    saveDb()
    db.close()
    db = null
  }
}
