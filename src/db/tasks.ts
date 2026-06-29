import { v4 as uuidv4 } from 'uuid'
import { getDb, saveDb } from './index.js'
import { getLogger } from '../logger.js'
import { addPoints } from './user-stats.js'

const log = getLogger('DB:Tasks')

export interface TaskDefinitionRow {
  id: string
  title: string
  description: string | null
  type: string
  requirement_type: string
  requirement_count: number
  points_reward: number
  extra_quota_reward: number
  icon: string | null
  sort_order: number
  is_active: number
}

export interface UserTaskRow {
  id: string
  user_id: string
  task_id: string
  progress: number
  is_completed: number
  reward_claimed: number
  completed_at: string | null
  claimed_at: string | null
  reset_date: string | null
  created_at: string
}

function getTodayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 获取所有活跃任务定义 */
export async function getActiveTasks(): Promise<TaskDefinitionRow[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM task_definitions WHERE is_active = 1 ORDER BY sort_order ASC')
  const rows: TaskDefinitionRow[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as TaskDefinitionRow)
  }
  stmt.free()
  return rows
}

/** 为新用户初始化所有活跃任务 */
export async function initUserTasks(userId: string): Promise<void> {
  const tasks = await getActiveTasks()
  const db = await getDb()
  const now = new Date().toISOString()
  const today = getTodayDate()

  for (const task of tasks) {
    const id = uuidv4()
    db.run(
      `INSERT OR IGNORE INTO user_tasks (id, user_id, task_id, progress, is_completed, reward_claimed, reset_date, created_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
      [id, userId, task.id, task.type === 'daily' ? today : null, now],
    )
  }
  saveDb()
  log.info({ userId, taskCount: tasks.length }, 'User tasks initialized')
}

/** 获取用户任务列表（含定义信息） */
export async function getUserTasks(userId: string): Promise<any[]> {
  const db = await getDb()
  const today = getTodayDate()

  // 检查用户是否有任务记录，没有则自动初始化（兼容旧用户）
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM user_tasks WHERE user_id = ?')
  countStmt.bind([userId])
  countStmt.step()
  const count = (countStmt.getAsObject() as { cnt: number }).cnt
  countStmt.free()

  if (count === 0) {
    await initUserTasks(userId)
  }

  // 每日任务重置
  db.run(
    `UPDATE user_tasks SET progress = 0, is_completed = 0
     WHERE user_id = ? AND reset_date IS NOT NULL AND reset_date != ?`,
    [userId, today],
  )
  db.run(
    `UPDATE user_tasks SET reset_date = ?
     WHERE user_id = ? AND reset_date IS NOT NULL AND reset_date != ?`,
    [today, userId, today],
  )
  saveDb()

  const stmt = db.prepare(`
    SELECT ut.*, td.title, td.description, td.type, td.requirement_type,
           td.requirement_count, td.points_reward, td.extra_quota_reward,
           td.icon, td.sort_order
    FROM user_tasks ut
    JOIN task_definitions td ON ut.task_id = td.id
    WHERE ut.user_id = ? AND td.is_active = 1
    ORDER BY td.sort_order ASC
  `)
  stmt.bind([userId])
  const rows: any[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject()
    const reqCount = row.requirement_count as number
    const progress = row.progress as number
    row.progressPercent = reqCount > 0 ? Math.min(100, Math.round((progress / reqCount) * 100)) : 0
    row.canClaim = row.is_completed === 1 && row.reward_claimed === 0 ? 1 : 0
    rows.push(row)
  }
  stmt.free()
  return rows
}

/** 推进任务进度（自动调用） */
export async function advanceTaskProgress(
  userId: string,
  requirementType: string,
  delta: number = 1,
): Promise<void> {
  const db = await getDb()
  const today = getTodayDate()

  const stmt = db.prepare(`
    SELECT ut.id, ut.task_id, ut.progress, ut.is_completed, td.requirement_count
    FROM user_tasks ut
    JOIN task_definitions td ON ut.task_id = td.id
    WHERE ut.user_id = ? AND td.requirement_type = ? AND td.is_active = 1 AND ut.reward_claimed = 0
  `)
  stmt.bind([userId, requirementType])

  const toUpdate: Array<{ taskId: string; newProgress: number; requirementCount: number }> = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as any
    const newProgress = row.progress + delta
    const isCompleted = newProgress >= row.requirement_count
    toUpdate.push({
      taskId: row.task_id,
      newProgress,
      requirementCount: row.requirement_count,
    })
    if (isCompleted) {
      db.run(
        'UPDATE user_tasks SET progress = ?, is_completed = 1, completed_at = ? WHERE user_id = ? AND task_id = ?',
        [newProgress, new Date().toISOString(), userId, row.task_id],
      )
    } else {
      db.run(
        'UPDATE user_tasks SET progress = ? WHERE user_id = ? AND task_id = ?',
        [newProgress, userId, row.task_id],
      )
    }
  }
  stmt.free()
  saveDb()
}

/** 领取任务奖励 */
export async function claimTaskReward(userId: string, taskId: string): Promise<{
  success: boolean
  error?: string
  pointsReward?: number
  extraQuotaReward?: number
}> {
  const db = await getDb()

  const stmt = db.prepare(`
    SELECT ut.*, td.points_reward, td.extra_quota_reward
    FROM user_tasks ut
    JOIN task_definitions td ON ut.task_id = td.id
    WHERE ut.user_id = ? AND ut.task_id = ?
  `)
  stmt.bind([userId, taskId])

  if (!stmt.step()) {
    stmt.free()
    return { success: false, error: 'TASK_NOT_FOUND' }
  }

  const row = stmt.getAsObject() as any
  stmt.free()

  if (!row.is_completed) {
    return { success: false, error: 'TASK_NOT_COMPLETED' }
  }

  if (row.reward_claimed) {
    return { success: false, error: 'REWARD_ALREADY_CLAIMED' }
  }

  const now = new Date().toISOString()
  db.run(
    'UPDATE user_tasks SET reward_claimed = 1, claimed_at = ? WHERE user_id = ? AND task_id = ?',
    [now, userId, taskId],
  )

  const pointsReward = row.points_reward as number
  const extraQuotaReward = row.extra_quota_reward as number

  if (pointsReward > 0) {
    await addPoints(userId, pointsReward)
  }

  if (extraQuotaReward > 0) {
    db.run(
      'UPDATE user_stats SET extra_quota = extra_quota + ? WHERE user_id = ?',
      [extraQuotaReward, userId],
    )
  }

  saveDb()
  log.info({ userId, taskId, pointsReward, extraQuotaReward }, 'Task reward claimed')

  return { success: true, pointsReward, extraQuotaReward }
}
