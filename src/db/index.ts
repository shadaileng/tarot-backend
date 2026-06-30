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
    initLevelDefinitions()
    initTaskDefinitions()
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

  // 兼容已有数据库：为 reading_records 新增 interpretation 列
  try {
    database.run('ALTER TABLE reading_records ADD COLUMN interpretation TEXT')
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

  // ========== 积分等级相关表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id             TEXT PRIMARY KEY,
      points              INTEGER NOT NULL DEFAULT 0,
      level               INTEGER NOT NULL DEFAULT 1,
      extra_quota         INTEGER NOT NULL DEFAULT 0,
      total_readings      INTEGER NOT NULL DEFAULT 0,
      daily_quota_used    INTEGER NOT NULL DEFAULT 0,
      quota_reset_date    TEXT,
      referral_code       TEXT UNIQUE,
      invited_by          TEXT,
      consecutive_checkins INTEGER NOT NULL DEFAULT 0,
      last_checkin_date   TEXT,
      created_at          TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_user_stats_referral_code ON user_stats(referral_code)')

  database.run(`
    CREATE TABLE IF NOT EXISTS level_definitions (
      level           INTEGER PRIMARY KEY,
      title           TEXT NOT NULL,
      points_required INTEGER NOT NULL,
      daily_quota     INTEGER NOT NULL,
      max_extra_quota INTEGER NOT NULL DEFAULT 100
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS checkin_records (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      checkin_date  TEXT NOT NULL,
      points_earned INTEGER NOT NULL DEFAULT 0,
      streak_bonus  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, checkin_date)
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS invite_records (
      id            TEXT PRIMARY KEY,
      inviter_id    TEXT NOT NULL,
      invitee_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      completed_at  TEXT,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (inviter_id) REFERENCES users(id),
      FOREIGN KEY (invitee_id) REFERENCES users(id)
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS task_definitions (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT,
      type                TEXT NOT NULL,
      requirement_type    TEXT NOT NULL,
      requirement_count   INTEGER NOT NULL,
      points_reward       INTEGER NOT NULL DEFAULT 0,
      extra_quota_reward  INTEGER NOT NULL DEFAULT 0,
      icon                TEXT,
      sort_order          INTEGER DEFAULT 0,
      is_active           INTEGER NOT NULL DEFAULT 1
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS user_tasks (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      progress        INTEGER NOT NULL DEFAULT 0,
      is_completed    INTEGER NOT NULL DEFAULT 0,
      reward_claimed  INTEGER NOT NULL DEFAULT 0,
      completed_at    TEXT,
      claimed_at      TEXT,
      reset_date      TEXT,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES task_definitions(id),
      UNIQUE(user_id, task_id)
    )
  `)

  // ========== 意见反馈表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'other',
      content       TEXT NOT NULL,
      images        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      admin_reply   TEXT,
      replied_at    TEXT,
      replied_by    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)')
  database.run('CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC)')
}

/** 初始化 level_definitions 默认数据 */
export function initLevelDefinitions(): void {
  if (!db) return

  // 兼容已有数据库：为 user_stats 新增 created_at 列
  try {
    db.run('ALTER TABLE user_stats ADD COLUMN created_at TEXT')
  } catch {}
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO level_definitions (level, title, points_required, daily_quota, max_extra_quota)
    VALUES (?, ?, ?, ?, ?)
  `)
  const levels = [
    [1, '见习塔罗师', 0, 3, 10],
    [2, '初级塔罗师', 100, 5, 20],
    [3, '中级塔罗师', 300, 10, 30],
    [4, '高级塔罗师', 600, 20, 50],
    [5, '资深塔罗师', 1000, 35, 80],
    [6, '大师塔罗师', 2000, 50, 120],
  ]
  for (const lv of levels) {
    stmt.bind(lv)
    stmt.step()
    stmt.reset()
  }
  stmt.free()
}

/** 初始化 task_definitions 默认数据 */
export function initTaskDefinitions(): void {
  if (!db) return
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO task_definitions (id, title, description, type, requirement_type, requirement_count, points_reward, extra_quota_reward, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tasks: any[] = [
    ['daily_read_1',  '每日抽卡1次', '今日完成1次抽卡', 'daily', 'read_count', 1, 5, 1, 1],
    ['daily_read_3',  '每日抽卡3次', '今日完成3次抽卡', 'daily', 'read_count', 3, 10, 3, 2],
    ['daily_share',   '分享1次', '今日分享1次抽卡结果', 'daily', 'share_count', 1, 5, 1, 3],
    ['achv_checkin_3','连续签到3天', '连续签到达到3天', 'achievement', 'checkin_streak', 3, 20, 5, 4],
    ['achv_read_10',  '累计10次抽卡', '累计抽卡达到10次', 'achievement', 'read_count', 10, 50, 10, 5],
    ['achv_read_50',  '累计50次抽卡', '累计抽卡达到50次', 'achievement', 'read_count', 50, 200, 30, 6],
    ['achv_invite_1', '邀请1位好友', '成功邀请1位好友', 'achievement', 'invite_count', 1, 50, 10, 7],
    ['achv_invite_3', '邀请3位好友', '成功邀请3位好友', 'achievement', 'invite_count', 3, 200, 30, 8],
  ]
  for (const t of tasks) {
    stmt.bind(t)
    stmt.step()
    stmt.reset()
  }
  stmt.free()
}

export function closeDb(): void {
  if (db) {
    saveDb()
    db.close()
    db = null
  }
}
