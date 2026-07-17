import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import type { SqlJsStatic, Database } from 'sql.js'

const log = getLogger('DB')

let db: Database | null = null
let SQL: SqlJsStatic | null = null

// 写合并机制
let saveDbTimeout: NodeJS.Timeout | null = null
let pendingSave = false

async function initSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs()
  }
  return SQL
}

function doSaveDb(): void {
  try {
    const data = db!.export()
    const dir = path.dirname(config.db.path)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(config.db.path, Buffer.from(data))
  } catch (err) {
    log.error({ err }, 'saveDb failed')
  }
}

export function saveDb(debounce = false): void {
  if (!debounce) {
    // 立即执行（用于关键操作如初始化）
    doSaveDb()
    return
  }

  // 写合并：50ms内的多次调用合并为一次
  pendingSave = true
  if (saveDbTimeout) {
    clearTimeout(saveDbTimeout)
  }
  saveDbTimeout = setTimeout(() => {
    if (pendingSave) {
      doSaveDb()
      pendingSave = false
    }
  }, 50)
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
    initDefaultPageSections()
    initDefaultMenus()
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

  // ========== 请求日志表（所有请求） ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id             TEXT PRIMARY KEY,
      created_at     TEXT NOT NULL,
      method         TEXT NOT NULL,
      path           TEXT NOT NULL,
      target         TEXT NOT NULL,
      status_code    INTEGER,
      duration_ms    INTEGER,
      template_ms    INTEGER,
      resource_ms    INTEGER,
      screenshot_ms  INTEGER,
      cache_hit      INTEGER DEFAULT 0,
      ip_address     TEXT,
      is_error       INTEGER DEFAULT 0,
      error_msg      TEXT,
      user_id        TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_request_logs_target ON request_logs(target)')
  database.run('CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs(path)')

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

  // ========== 合并后的 readings 表（异步任务 + 历史记录） ==========

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

  // ========== 海报异步任务表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS poster_tasks (
      id              TEXT PRIMARY KEY,
      user_id         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT,
      cards_json      TEXT NOT NULL,
      question        TEXT,
      spread_name     TEXT,
      interpretation  TEXT,
      comprehensive_interpretation TEXT,
      theme           TEXT DEFAULT 'dark',
      template        TEXT DEFAULT 'default',
      status          TEXT NOT NULL DEFAULT 'pending',
      poster_url      TEXT,
      cache_key       TEXT,
      error_msg       TEXT,
      request_log_id  TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_poster_tasks_user_id ON poster_tasks(user_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_poster_tasks_status ON poster_tasks(status)')
  database.run('CREATE INDEX IF NOT EXISTS idx_poster_tasks_created_at ON poster_tasks(created_at DESC)')

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

  // 兼容已有数据库：为 client_event_logs 新增 trace_id 列
  try {
    database.run('ALTER TABLE client_event_logs ADD COLUMN trace_id TEXT')
  } catch {}

  // 兼容已有数据库：为 audit_logs 新增 hash 列（完整性链）
  try {
    database.run('ALTER TABLE audit_logs ADD COLUMN hash TEXT')
  } catch {}

  // 更新邮箱唯一索引以支持软删除（排除已删除用户）
  try {
    database.run('DROP INDEX IF EXISTS idx_users_email')
  } catch {}
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL`)

  // 兼容已有数据库：menus.route_name 去掉 NOT NULL 约束
  try {
    const tableInfo = database.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='menus'")
    const createSql = tableInfo[0]?.values[0]?.[0] as string || ''
    if (/\broute_name\s+TEXT\s+NOT\s+NULL\b/.test(createSql)) {
      database.run('CREATE TABLE menus_backup AS SELECT * FROM menus')
      database.run('DROP TABLE menus')
      database.run(`
        CREATE TABLE menus (
          id            TEXT PRIMARY KEY,
          parent_id     TEXT,
          route_name    TEXT,
          label         TEXT NOT NULL,
          icon          TEXT,
          sort_order    INTEGER NOT NULL DEFAULT 0,
          is_visible    INTEGER NOT NULL DEFAULT 1,
          require_role  TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES menus(id) ON DELETE CASCADE
        )
      `)
      database.run('INSERT INTO menus SELECT * FROM menus_backup')
      database.run('DROP TABLE menus_backup')
    }
  } catch {}

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

  // ========== 页面区域可见性 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS page_section_visibility (
      id          TEXT PRIMARY KEY,
      page_key    TEXT NOT NULL,
      section_key TEXT NOT NULL,
      label       TEXT NOT NULL,
      visible     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL,
      UNIQUE(page_key, section_key)
    )
  `)

  // ========== 动态菜单 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS menus (
      id          TEXT PRIMARY KEY,
      parent_id   TEXT,
      route_name  TEXT,
      label       TEXT NOT NULL,
      icon        TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_visible  INTEGER NOT NULL DEFAULT 1,
      require_role TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES menus(id) ON DELETE CASCADE
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS role_menus (
      id      TEXT PRIMARY KEY,
      role    TEXT NOT NULL,
      menu_id TEXT NOT NULL,
      FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE,
      UNIQUE(role, menu_id)
    )
  `)

  // ========== 审计日志表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      actor_type    TEXT NOT NULL,
      actor_id      TEXT,
      actor_name    TEXT,
      action        TEXT NOT NULL,
      target_type   TEXT,
      target_id     TEXT,
      target_name   TEXT,
      old_value     TEXT,
      new_value     TEXT,
      ip_address    TEXT,
      hash          TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)')
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id)')
  // 复合索引：优化多条件组合查询
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_logs(action, created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs(actor_type, actor_id, created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_audit_target_created ON audit_logs(target_type, target_id, created_at DESC)')

  // ========== 客户端事件日志表 ==========

  database.run(`
    CREATE TABLE IF NOT EXISTS client_event_logs (
      id             TEXT PRIMARY KEY,
      user_id        TEXT,
      created_at     TEXT NOT NULL,
      event          TEXT NOT NULL,
      category       TEXT NOT NULL,
      level          TEXT NOT NULL DEFAULT 'info',
      result         TEXT,
      action         TEXT,
      data_json      TEXT,
      platform       TEXT,
      device_model   TEXT,
      system_version TEXT,
      sdk_version    TEXT,
      app_version    TEXT,
      trace_id       TEXT
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_client_event_user ON client_event_logs(user_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_client_event_created ON client_event_logs(created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_client_event_category ON client_event_logs(category)')
  database.run('CREATE INDEX IF NOT EXISTS idx_client_event_trace ON client_event_logs(trace_id)')
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

/** 初始化 page_section_visibility 默认数据 */
export function initDefaultPageSections(): void {
  if (!db) return
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO page_section_visibility (id, page_key, section_key, label, visible, updated_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `)
  const now = new Date().toISOString()
  const sections: [string, string, string, string][] = [
    ['ps-index-particle', 'index', 'particle_background', '星空粒子背景'],
    ['ps-index-hero',     'index', 'hero_section',        '顶部标题区域'],
    ['ps-index-status',   'index', 'backend_status',      '后台服务状态'],
    ['ps-index-spread',   'index', 'spread_selection',    '牌型选择'],
    ['ps-index-question', 'index', 'question_input',      '问题输入'],
    ['ps-index-draw',     'index', 'draw_button',         '抽牌按钮'],
    ['ps-draw-spread',    'draw',  'spread_selection',    '牌型选择'],
    ['ps-draw-question',  'draw',  'question_input',      '问题输入'],
    ['ps-draw-preview',   'draw',  'spread_preview',      '牌型预览'],
    ['ps-draw-draw',      'draw',  'draw_action',         '抽牌按钮'],
  ]
  for (const s of sections) {
    stmt.bind([s[0], s[1], s[2], s[3], now])
    stmt.step()
    stmt.reset()
  }
  stmt.free()
}

/** 初始化 menus 默认数据 */
export function initDefaultMenus(): void {
  if (!db) return

  const now = new Date().toISOString()

  // 顶级菜单（分组）
  const groups: [string, string, string | null, number][] = [
    ['menu-system',    '系统监控', null, 1],
    ['menu-user',      '用户管理', null, 2],
    ['menu-operation', '运营管理', null, 3],
  ]
  const grpStmt = db.prepare(`
    INSERT OR IGNORE INTO menus (id, parent_id, route_name, label, icon, sort_order, is_visible, require_role, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, ?, ?, 1, NULL, ?, ?)
  `)
  const grpIcons: Record<string, string> = {
    'menu-system':    'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2',
    'menu-user':      'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    'menu-operation': 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  }
  for (const g of groups) {
    grpStmt.bind([g[0], g[1], grpIcons[g[0]] || null, g[2] || 0, now, now])
    grpStmt.step()
    grpStmt.reset()
  }
  grpStmt.free()

  // 子菜单
  const items: [string, string, string, string, string, number, string | null][] = [
    // 系统监控
    ['menu-dashboard',   'menu-system',    'dashboard',       '仪表盘',   'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6', 1, null],
    ['menu-logs',        'menu-system',    'logs',            '请求日志',  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', 2, null],
    ['menu-reading-logs','menu-system',    'reading-logs',    '解读日志',  'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253', 3, null],
    ['menu-health',      'menu-system',    'health',          '健康监控',  'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z', 4, null],
    ['menu-metrics',     'menu-system',    'metrics',         '指标',     'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z', 5, null],
    ['menu-config',      'menu-system',    'config',          '配置',     'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z', 6, null],
    ['menu-audit-logs',  'menu-system',    'audit-logs',      '操作日志',  'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', 7, null],
    ['menu-client-events','menu-system',  'client-events',   '客户端事件', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z', 8, null],
    ['menu-persistence',  'menu-system',  'persistence',     '持久化监控', 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4', 9, null],
    // 用户管理
    ['menu-users',       'menu-user',      'users',           '用户管理',  'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', 1, null],
    ['menu-user-stats',  'menu-user',      'user-stats',      '用户统计',  'M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z', 2, null],
    ['menu-checkin-stats','menu-user',     'checkin-stats',   '签到统计',  'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', 3, null],
    ['menu-invite-records','menu-user',    'invite-records',  '邀请记录',  'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1', 4, null],
    // 运营管理
    ['menu-menus',           'menu-operation', 'menus',           '菜单管理', 'M4 6h16M4 12h16M4 18h16', 0, 'admin'],
    ['menu-admins',           'menu-operation', 'admins',           '管理员管理', 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', 1, 'admin'],
    ['menu-levels',           'menu-operation', 'levels',           '等级管理', 'M13 10V3L4 14h7v7l9-11h-7z', 2, null],
    ['menu-task-definitions', 'menu-operation', 'task-definitions', '任务管理', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', 3, null],
    ['menu-stats-trends',     'menu-operation', 'stats-trends',     '趋势统计', 'M18 20V10M12 20V4M6 20v-6', 4, null],
    ['menu-feedback',         'menu-operation', 'feedback',         '意见反馈', 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z', 5, null],
    ['menu-page-sections',    'menu-operation', 'page-sections',    '页面管理', 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z', 6, null],
    ['menu-reading-tasks',    'menu-operation', 'reading-tasks',   '解读任务', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', 7, null],
  ]
  const itemStmt = db.prepare(`
    INSERT OR IGNORE INTO menus (id, parent_id, route_name, label, icon, sort_order, is_visible, require_role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
  for (const item of items) {
    itemStmt.bind([item[0], item[1], item[2], item[3], item[4], item[5], item[6], now, now])
    itemStmt.step()
    itemStmt.reset()
  }
  itemStmt.free()

  // 默认角色菜单关联（admin 看所有菜单）
  const allMenuIds = groups.map(g => g[0]).concat(items.map(i => i[0]))
  const roleStmt = db.prepare(`
    INSERT OR IGNORE INTO role_menus (id, role, menu_id) VALUES (?, 'admin', ?)
  `)
  for (const menuId of allMenuIds) {
    roleStmt.bind([`rm-admin-${menuId}`, menuId])
    roleStmt.step()
    roleStmt.reset()
  }
  roleStmt.free()
}

export function closeDb(): void {
  // 清除定时器并立即保存
  if (saveDbTimeout) {
    clearTimeout(saveDbTimeout)
    saveDbTimeout = null
  }
  if (pendingSave) {
    doSaveDb()
    pendingSave = false
  }
  if (db) {
    doSaveDb()
    db.close()
    db = null
  }
}

// ========== 快照相关 ==========

const LOG_TABLES = [
  'request_logs', 'client_event_logs', 'audit_logs', 'reading_logs',
  'readings', 'poster_tasks',
]

interface FileInfo {
  path: string
  sizeBytes: number
  count: number
}

const MONITORED_FILES = [
  'uploads/avatar',
  'uploads/feedback',
]

function getDirSize(dirPath: string): { sizeBytes: number; count: number } {
  let totalSize = 0
  let count = 0
  try {
    if (!fs.existsSync(dirPath)) return { sizeBytes: 0, count: 0 }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isFile()) {
        totalSize += fs.statSync(fullPath).size
        count++
      }
    }
  } catch {}
  return { sizeBytes: totalSize, count }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export interface TableStats {
  name: string
  rows: number
  retentionDays: number
}

export interface FileStats {
  path: string
  sizeBytes: number
  sizeHuman: string
  count: number
}

export interface PersistenceStats {
  database: {
    path: string
    sizeBytes: number
    sizeHuman: string
    pageSize: number
    totalPages: number
    freePages: number
  }
  tables: TableStats[]
  files: {
    database: FileStats
    uploads: {
      avatar: FileStats
      feedback: FileStats
    }
  }
  totalSizeBytes: number
  totalSizeHuman: string
  retention: {
    logRetentionDays: number
    auditLogRetentionDays: number
  }
}

const TABLE_RETENTION: Record<string, string> = {
  request_logs: 'db.retentionDays',
  client_event_logs: 'db.retentionDays',
  reading_logs: 'db.retentionDays',
  audit_logs: 'auditLog.retentionDays',
  readings: 'db.retentionDays',
  poster_tasks: 'db.retentionDays',
}

function getRetentionDays(key: string): number {
  switch (key) {
    case 'db.retentionDays': return config.db.retentionDays
    case 'auditLog.retentionDays': return config.auditLog.retentionDays
    default: return 0
  }
}

export function getDbStats(): PersistenceStats {
  const database = db!

  // 数据库文件信息
  let dbSizeBytes = 0
  try { dbSizeBytes = fs.statSync(config.db.path).size } catch {}
  const pageSize = database.exec('PRAGMA page_size')[0]?.values[0]?.[0] as number || 4096
  const pageCount = database.exec('PRAGMA page_count')[0]?.values[0]?.[0] as number || 0
  const freePages = database.exec('PRAGMA freelist_count')[0]?.values[0]?.[0] as number || 0

  // 各表行数
  const tables: TableStats[] = ALL_TABLES.map(name => {
    const countResult = database.exec(`SELECT COUNT(*) as cnt FROM ${name}`)
    const rows = countResult.length > 0 && countResult[0].values.length > 0
      ? Number(countResult[0].values[0][0])
      : 0
    const retentionKey = TABLE_RETENTION[name]
    const retentionDays = retentionKey ? getRetentionDays(retentionKey) : 0

    return { name, rows, retentionDays }
  })

  // 上传文件
  const dbDir = path.dirname(config.db.path)
  const projectRoot = path.resolve(dbDir, '..')
  const avatarDir = path.join(projectRoot, 'uploads/avatar')
  const feedbackDir = path.join(projectRoot, 'uploads/feedback')
  const avatarStats = getDirSize(avatarDir)
  const feedbackStats = getDirSize(feedbackDir)

  const totalSizeBytes = dbSizeBytes + avatarStats.sizeBytes + feedbackStats.sizeBytes

  return {
    database: {
      path: config.db.path,
      sizeBytes: dbSizeBytes,
      sizeHuman: formatBytes(dbSizeBytes),
      pageSize,
      totalPages: pageCount,
      freePages,
    },
    tables,
    files: {
      database: { path: config.db.path, sizeBytes: dbSizeBytes, sizeHuman: formatBytes(dbSizeBytes), count: 1 },
      uploads: {
        avatar: { path: 'uploads/avatar', sizeBytes: avatarStats.sizeBytes, sizeHuman: formatBytes(avatarStats.sizeBytes), count: avatarStats.count },
        feedback: { path: 'uploads/feedback', sizeBytes: feedbackStats.sizeBytes, sizeHuman: formatBytes(feedbackStats.sizeBytes), count: feedbackStats.count },
      },
    },
    totalSizeBytes,
    totalSizeHuman: formatBytes(totalSizeBytes),
    retention: {
      logRetentionDays: config.db.retentionDays,
      auditLogRetentionDays: config.auditLog.retentionDays,
    },
  }
}

const ALL_TABLES = [
  'request_logs', 'client_event_logs', 'audit_logs', 'reading_logs',
  'readings', 'poster_tasks', 'checkin_records', 'reading_records',
  'feedback', 'users', 'user_stats', 'admins', 'system_config',
  'level_definitions', 'task_definitions', 'user_tasks', 'invite_records',
  'menus', 'role_menus', 'page_section_visibility',
]

export async function snapshotDbSize(): Promise<void> {
  const database = db!
  if (!database) return

  const dbPath = config.db.path

  // DB 文件大小
  let dbSizeBytes = 0
  try { dbSizeBytes = fs.statSync(dbPath).size } catch {}

  // DB 页面信息
  const pageSize = database.exec('PRAGMA page_size')[0]?.values[0]?.[0] as number || 4096
  const pageCount = database.exec('PRAGMA page_count')[0]?.values[0]?.[0] as number || 0
  const freePages = database.exec('PRAGMA freelist_count')[0]?.values[0]?.[0] as number || 0

  // 各表行数
  const tableRows: Record<string, number> = {}
  for (const name of LOG_TABLES) {
    const result = database.exec(`SELECT COUNT(*) as cnt FROM ${name}`)
    tableRows[name] = result.length > 0 && result[0].values.length > 0
      ? Number(result[0].values[0][0])
      : 0
  }

  // 持久化文件
  const dbDir = path.dirname(dbPath)
  const projectRoot = path.resolve(dbDir, '..')
  const files: FileInfo[] = MONITORED_FILES.map(relPath => {
    const fullPath = path.join(projectRoot, relPath)
    const { sizeBytes, count } = getDirSize(fullPath)
    return { path: relPath, sizeBytes, count }
  })

  // 写入快照表
  try {
    database.run(`
      CREATE TABLE IF NOT EXISTS db_size_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_at   TEXT NOT NULL,
        db_size_bytes INTEGER NOT NULL,
        total_pages   INTEGER NOT NULL,
        free_pages    INTEGER NOT NULL,
        table_rows    TEXT NOT NULL,
        files         TEXT NOT NULL
      )
    `)
    database.run('CREATE INDEX IF NOT EXISTS idx_db_size_history_snapshot ON db_size_history(snapshot_at DESC)')

    database.run(
      'INSERT INTO db_size_history (snapshot_at, db_size_bytes, total_pages, free_pages, table_rows, files) VALUES (?, ?, ?, ?, ?, ?)',
      [
        new Date().toISOString(),
        dbSizeBytes,
        pageCount,
        freePages,
        JSON.stringify(tableRows),
        JSON.stringify(files),
      ]
    )
    saveDb(true)
  } catch {}
}
