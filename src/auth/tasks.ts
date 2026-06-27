import type { Request, Response } from 'express'
import { getLogger } from '../logger.js'
import { getUserTasks, claimTaskReward } from '../db/tasks.js'

const log = getLogger('Auth:Tasks')

/**
 * GET /api/tasks
 * 获取用户任务列表
 */
export async function getTasksHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const tasks = await getUserTasks(userId)
    res.json({ tasks })
  } catch (err) {
    log.error({ err, userId: req.userId }, 'Get tasks failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取任务列表失败' })
  }
}

/**
 * POST /api/tasks/:id/claim
 * 领取任务奖励
 */
export async function claimTaskHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!
    const taskId = req.params.id

    const result = await claimTaskReward(userId, taskId)

    if (!result.success) {
      const statusMap: Record<string, number> = {
        TASK_NOT_FOUND: 404,
        TASK_NOT_COMPLETED: 400,
        REWARD_ALREADY_CLAIMED: 409,
      }
      res.status(statusMap[result.error!] || 400).json({
        error: result.error,
        message: result.error === 'TASK_NOT_FOUND' ? '任务不存在' :
                 result.error === 'TASK_NOT_COMPLETED' ? '任务还未完成' :
                 result.error === 'REWARD_ALREADY_CLAIMED' ? '奖励已领取' :
                 '领取失败',
      })
      return
    }

    log.info({ userId, taskId, ...result }, 'Task reward claimed')
    res.json({ success: true, pointsReward: result.pointsReward, extraQuotaReward: result.extraQuotaReward })
  } catch (err) {
    log.error({ err, userId: req.userId, taskId: req.params.id }, 'Claim task failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '领取奖励失败' })
  }
}
