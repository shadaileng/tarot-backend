import crypto from 'crypto'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'

const log = getLogger('DB:UserStats')

export interface UserStatsRow {
  user_id: string
  points: number
  level: number
  extra_quota: number
  total_readings: number
  daily_quota_used: number
  quota_reset_date: string | null
  referral_code: string
  invited_by: string | null
  consecutive_checkins: number
  last_checkin_date: string | null
}

export interface LevelDefinitionRow {
  level: number
  title: string
  points_required: number
  daily_quota: number
  max_extra_quota: number
}

function generateReferralCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}

function getTodayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 获取用户统计数据 */
export async function getUserStats(userId: string): Promise<UserStatsRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM user_stats WHERE user_id = ?')
  stmt.bind([userId])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserStatsRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 为新用户创建默认统计行 */
export async function createUserStats(userId: string, invitedBy?: string): Promise<UserStatsRow> {
  const db = await getDb()
  let code = generateReferralCode()
  // 确保邀请码唯一
  while (true) {
    const existing = db.prepare('SELECT 1 FROM user_stats WHERE referral_code = ?')
    existing.bind([code])
    if (!existing.step()) {
      existing.free()
      break
    }
    existing.free()
    code = generateReferralCode()
  }
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO user_stats (user_id, points, level, extra_quota, referral_code, invited_by, created_at)
     VALUES (?, 0, 1, 0, ?, ?, ?)`,
    [userId, code, invitedBy || null, now],
  )
  saveDb()
  log.info({ userId, referralCode: code, invitedBy }, 'User stats created')
  return (await getUserStats(userId))!
}

/** 根据邀请码查找用户 */
export async function findByReferralCode(code: string): Promise<UserStatsRow | null> {
  if (!code) return null
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM user_stats WHERE referral_code = ?')
  stmt.bind([code])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as UserStatsRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 获取所有等级定义 */
export async function getLevelDefinitions(): Promise<LevelDefinitionRow[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM level_definitions ORDER BY level ASC')
  const rows: LevelDefinitionRow[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as LevelDefinitionRow)
  }
  stmt.free()
  return rows
}

/** 根据等级获取定义 */
export async function getLevelDefinition(level: number): Promise<LevelDefinitionRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM level_definitions WHERE level = ?')
  stmt.bind([level])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as LevelDefinitionRow
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

/** 计算用户在指定积分下应处的等级 */
export async function calculateLevel(points: number): Promise<LevelDefinitionRow> {
  const levels = await getLevelDefinitions()
  let bestLevel = levels[0]
  for (const lv of levels) {
    if (points >= lv.points_required) {
      bestLevel = lv
    }
  }
  return bestLevel
}

/** 增加积分，自动检测升级 */
export async function addPoints(userId: string, delta: number): Promise<{ newPoints: number; newLevel: number; leveledUp: boolean }> {
  const stats = await getUserStats(userId)
  if (!stats) return { newPoints: 0, newLevel: 1, leveledUp: false }

  const db = await getDb()
  const newPoints = stats.points + delta
  const newLevelDef = await calculateLevel(Math.max(0, newPoints))
  const leveledUp = newLevelDef.level > stats.level

  db.run('UPDATE user_stats SET points = ?, level = ? WHERE user_id = ?',
    [Math.max(0, newPoints), newLevelDef.level, userId])
  saveDb()

  if (leveledUp) {
    log.info({ userId, oldLevel: stats.level, newLevel: newLevelDef.level, points: newPoints }, 'User leveled up')
  }

  return { newPoints: Math.max(0, newPoints), newLevel: newLevelDef.level, leveledUp }
}

/** 增加占卜计数 */
export async function incrementReadings(userId: string): Promise<void> {
  const db = await getDb()
  db.run('UPDATE user_stats SET total_readings = total_readings + 1 WHERE user_id = ?', [userId])
  saveDb()
}

/** 重置每日配额（如果日期变了）*/
export async function resetDailyQuotaIfNeeded(userId: string): Promise<void> {
  const stats = await getUserStats(userId)
  if (!stats) return

  const today = getTodayDate()
  if (stats.quota_reset_date !== today) {
    const db = await getDb()
    db.run('UPDATE user_stats SET daily_quota_used = 0, quota_reset_date = ? WHERE user_id = ?',
      [today, userId])
    saveDb()
  }
}

/** 获取用户可用额度（基础 + 额外），并检查是否已用完 */
export async function getAvailableQuota(userId: string): Promise<{ total: number; used: number; remaining: number }> {
  const stats = await getUserStats(userId)
  if (!stats) return { total: 0, used: 0, remaining: 0 }

  const levelDef = await getLevelDefinition(stats.level)
  const baseQuota = levelDef?.daily_quota ?? 3
  const total = baseQuota + stats.extra_quota
  const used = stats.daily_quota_used

  return { total, used, remaining: Math.max(0, total - used) }
}

/** 消耗一次配额 */
export async function consumeQuota(userId: string): Promise<boolean> {
  await resetDailyQuotaIfNeeded(userId)
  const available = await getAvailableQuota(userId)

  if (available.remaining <= 0) return false

  const db = await getDb()
  db.run('UPDATE user_stats SET daily_quota_used = daily_quota_used + 1 WHERE user_id = ?', [userId])
  saveDb()
  return true
}

/** 获取用户等级信息和进度（前端展示用）*/
export async function getUserLevelInfo(userId: string): Promise<{
  level: number
  title: string
  points: number
  nextLevelPoints: number | null
  nextLevelTitle: string | null
  progress: number
  totalQuota: number
  usedQuota: number
  remainingQuota: number
  extraQuota: number
  totalReadings: number
} | null> {
  const stats = await getUserStats(userId)
  if (!stats) return null

  const levels = await getLevelDefinitions()
  const currentLv = levels.find(l => l.level === stats.level)
  const nextLv = levels.find(l => l.level === stats.level + 1)

  const baseQuota = currentLv?.daily_quota ?? 3
  const totalQuota = baseQuota + stats.extra_quota

  let progress = 0
  if (nextLv) {
    const range = nextLv.points_required - (currentLv?.points_required ?? 0)
    const earned = stats.points - (currentLv?.points_required ?? 0)
    progress = range > 0 ? Math.min(100, Math.round((earned / range) * 100)) : 100
  } else {
    progress = 100
  }

  return {
    level: stats.level,
    title: currentLv?.title ?? '',
    points: stats.points,
    nextLevelPoints: nextLv?.points_required ?? null,
    nextLevelTitle: nextLv?.title ?? null,
    progress,
    totalQuota,
    usedQuota: stats.daily_quota_used,
    remainingQuota: Math.max(0, totalQuota - stats.daily_quota_used),
    extraQuota: stats.extra_quota,
    totalReadings: stats.total_readings,
  }
}

/** 为缺少 user_stats 的老用户补充数据 */
export async function initMissingUserStats(): Promise<void> {
  const db = await getDb()

  const users = db.prepare(`
    SELECT u.id FROM users u
    LEFT JOIN user_stats s ON u.id = s.user_id
    WHERE s.user_id IS NULL AND u.deleted_at IS NULL
  `)
  const missingIds: string[] = []
  while (users.step()) {
    const row = users.getAsObject() as { id: string }
    missingIds.push(row.id)
  }
  users.free()

  if (missingIds.length === 0) return

  const now = new Date().toISOString()
  for (const userId of missingIds) {
    let code = generateReferralCode()
    while (true) {
      const existing = db.prepare('SELECT 1 FROM user_stats WHERE referral_code = ?')
      existing.bind([code])
      if (!existing.step()) {
        existing.free()
        break
      }
      existing.free()
      code = generateReferralCode()
    }
    db.run(
      `INSERT INTO user_stats (user_id, points, level, extra_quota, referral_code, invited_by, created_at)
       VALUES (?, 0, 1, 0, ?, NULL, ?)`,
      [userId, code, now],
    )
  }
  saveDb()
  log.info({ count: missingIds.length }, 'Migrated existing users with default stats')
}
