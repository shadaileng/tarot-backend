import type { Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from '../db/index.js'
import { getLogger } from '../logger.js'
import { getUserStats, addPoints } from '../db/user-stats.js'
import { advanceTaskProgress } from '../db/tasks.js'

const log = getLogger('Auth:Checkin')

function getTodayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getYesterdayDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * POST /api/checkin
 * 每日签到
 */
export async function checkinHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const today = getTodayDate()
    const db = await getDb()

    const already = db.prepare('SELECT 1 FROM checkin_records WHERE user_id = ? AND checkin_date = ?')
    already.bind([userId, today])
    if (already.step()) {
      already.free()
      res.status(409).json({ error: 'ALREADY_CHECKED_IN', message: '今天已经签到过了' })
      return
    }
    already.free()

    const stats = await getUserStats(userId)
    if (!stats) {
      res.status(404).json({ error: 'USER_STATS_NOT_FOUND', message: '用户数据异常' })
      return
    }

    let streak = 1
    let streakBonus = 0

    if (stats.last_checkin_date === getYesterdayDate()) {
      streak = stats.consecutive_checkins + 1
    } else if (stats.last_checkin_date === today) {
      res.status(409).json({ error: 'ALREADY_CHECKED_IN', message: '今天已经签到过了' })
      return
    } else {
      streak = 1
    }

    streakBonus = Math.min((streak - 1) * 2, 20)

    const basePoints = 5
    const totalPoints = basePoints + streakBonus

    const id = uuidv4()
    const now = new Date().toISOString()
    db.run(
      'INSERT INTO checkin_records (id, user_id, checkin_date, points_earned, streak_bonus, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, userId, today, totalPoints, streakBonus, now],
    )

    db.run(
      'UPDATE user_stats SET consecutive_checkins = ?, last_checkin_date = ? WHERE user_id = ?',
      [streak, today, userId],
    )

    saveDb()

    await addPoints(userId, totalPoints)

    // 推进连续签到任务进度
    const checkinStmt = db.prepare(`
      UPDATE user_tasks SET
        progress = ?,
        is_completed = CASE WHEN ? >= (SELECT requirement_count FROM task_definitions WHERE id = task_id) THEN 1 ELSE 0 END,
        completed_at = CASE WHEN ? >= (SELECT requirement_count FROM task_definitions WHERE id = task_id) THEN ? ELSE completed_at END
      WHERE user_id = ? AND task_id IN (
        SELECT id FROM task_definitions WHERE requirement_type = 'checkin_streak' AND is_active = 1
      )
    `)
    checkinStmt.bind([streak, streak, streak, new Date().toISOString(), userId])
    checkinStmt.step()
    checkinStmt.free()

    log.info({ userId, streak, points: totalPoints }, 'Check-in completed')

    res.json({
      success: true,
      streak,
      streakBonus,
      basePoints,
      totalPoints,
      today,
    })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Check-in failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '签到失败' })
  }
}

/**
 * GET /api/checkin/status
 * 获取签到状态
 */
export async function checkinStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const today = getTodayDate()
    const db = await getDb()

    const checkedIn = db.prepare('SELECT 1 FROM checkin_records WHERE user_id = ? AND checkin_date = ?')
    checkedIn.bind([userId, today])
    const isCheckedIn = checkedIn.step()
    checkedIn.free()

    const stats = await getUserStats(userId)

    res.json({
      isCheckedIn,
      streak: stats?.consecutive_checkins ?? 0,
      lastCheckinDate: stats?.last_checkin_date ?? null,
    })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Check-in status failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取签到状态失败' })
  }
}
