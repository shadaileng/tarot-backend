import initSqlJs from 'sql.js'
import type { Database, SqlJsStatic } from 'sql.js'

let SQL: SqlJsStatic | null = null
let testDb: Database | null = null

export async function setupTestDb(): Promise<Database> {
  if (!SQL) {
    SQL = await initSqlJs()
  }
  testDb = new SQL.Database()
  testDb.run('PRAGMA journal_mode=WAL')
  initTestSchema(testDb)
  initTestLevelDefinitions(testDb)
  initTestTaskDefinitions(testDb)
  return testDb
}

export function getTestDb(): Database {
  if (!testDb) throw new Error('Test DB not initialized — call setupTestDb() first')
  return testDb
}

export function teardownTestDb(): void {
  if (testDb) {
    testDb.close()
    testDb = null
  }
}

export function initTestSchema(database: Database): void {
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
      last_login_at TEXT NOT NULL,
      deleted_at    TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid)')
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL`)

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

  database.run(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id              TEXT PRIMARY KEY,
      method          TEXT,
      path            TEXT,
      status_code     INTEGER,
      duration_ms     INTEGER,
      created_at      TEXT,
      ip_address      TEXT
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS readings (
      id              TEXT PRIMARY KEY,
      user_id         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT,
      spread_type     TEXT NOT NULL DEFAULT '',
      question        TEXT,
      cards_json      TEXT NOT NULL,
      reading         TEXT,
      model           TEXT,
      status          TEXT NOT NULL DEFAULT 'completed',
      is_local        INTEGER DEFAULT 0,
      incomplete      INTEGER DEFAULT 0,
      warning         TEXT,
      error_msg       TEXT,
      interpretation  TEXT,
      request_log_id  TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_readings_user_id ON readings(user_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings(created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_readings_status ON readings(status)')
  database.run('CREATE INDEX IF NOT EXISTS idx_readings_request_log_id ON readings(request_log_id)')
}

function initTestLevelDefinitions(database: Database): void {
  const stmt = database.prepare(`
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
  ] as any[]
  for (const lv of levels) {
    stmt.bind(lv)
    stmt.step()
    stmt.reset()
  }
  stmt.free()
}

function initTestTaskDefinitions(database: Database): void {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO task_definitions (id, title, description, type, requirement_type, requirement_count, points_reward, extra_quota_reward, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tasks: any[] = [
    ['daily_read_1',  '每日占卜1次', '今日完成1次占卜', 'daily', 'read_count', 1, 5, 1, 1],
    ['daily_read_3',  '每日占卜3次', '今日完成3次占卜', 'daily', 'read_count', 3, 10, 3, 2],
    ['daily_share',   '分享1次', '今日分享1次占卜结果', 'daily', 'share_count', 1, 5, 1, 3],
    ['achv_checkin_3','连续签到3天', '连续签到达到3天', 'achievement', 'checkin_streak', 3, 20, 5, 4],
    ['achv_read_10',  '累计10次占卜', '累计占卜达到10次', 'achievement', 'read_count', 10, 50, 10, 5],
    ['achv_read_50',  '累计50次占卜', '累计占卜达到50次', 'achievement', 'read_count', 50, 200, 30, 6],
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

export function insertTestUser(database: Database, id: string, email?: string): void {
  const now = new Date().toISOString()
  database.run(
    `INSERT OR IGNORE INTO users (id, openid, email, nickname, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, 'test-openid', email || null, 'TestUser', now, now],
  )
}

export function getTodayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function getYesterdayDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
