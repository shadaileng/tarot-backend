import type { Request, Response } from 'express'
import { config } from '../config.js'
import { callGeminiReading } from './models.js'
import { getLogger } from '../logger.js'
import type { ReadingRequestBody } from './types.js'
import { refundQuota } from '../db/user-stats.js'
import {
  createReadingTask,
  getReadingTask,
  completeReadingTask,
  failReadingTask,
} from '../db/reading-task.js'

const log = getLogger('reading:async')

/**
 * POST /api/reading/start
 * 提交解读任务，立即返回 taskId，异步生成解读
 */
export async function startReadingHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as ReadingRequestBody
  const { question, cards } = body
  const userId = (req as any).userId as string
  const logId = (req as any).logId as string

  if (!cards || cards.length === 0) {
    res.status(400).json({ error: 'Missing cards' })
    return
  }

  if (!config.geminiApiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }

  // 立即写入数据库（status='pending'，通过 request_log_id 关联 request_logs）
  const taskId = await createReadingTask({
    userId,
    question: question || '',
    cardsJson: JSON.stringify(cards),
    requestLogId: logId,
  })

  log.info({ taskId, userId, cardCount: cards.length }, 'Reading task created, starting async generation')

  // 异步执行 Gemini 调用（不阻塞响应）
  processTask(taskId, userId, question || '', cards).catch((err) => {
    log.error({ taskId, err }, 'Async task processing crashed')
  })

  res.json({ taskId, status: 'pending' })
}

/**
 * GET /api/reading/result/:taskId
 * 轮询解读任务结果
 */
export async function getReadingResultHandler(req: Request, res: Response): Promise<void> {
  const { taskId } = req.params
  const userId = (req as any).userId as string

  const row = await getReadingTask(taskId, userId)

  if (!row) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  res.json({
    taskId: row.id,
    status: row.status,
    reading: row.reading,
    model: row.model,
    incomplete: row.incomplete === 1,
    warning: row.warning,
    error: row.error_msg,
  })
}

/**
 * 后台异步处理任务
 */
async function processTask(
  taskId: string,
  userId: string,
  question: string,
  cards: any[],
): Promise<void> {
  const startTime = Date.now()

  try {
    const result = await callGeminiReading(config.geminiApiKey!, question, cards)

    if (result.success) {
      await completeReadingTask({
        taskId,
        reading: result.reading!,
        model: result.model!,
        incomplete: result.incomplete || false,
        warning: result.warning,
      })

      log.info({
        taskId,
        model: result.model,
        duration: Date.now() - startTime,
        readingLength: result.reading?.length,
      }, 'Async reading task completed successfully')
    } else {
      // Gemini 调用失败 — 退还额度
      await failReadingTask(taskId, result.error || 'AI service error')
      await refundQuota(userId).catch((e) =>
        log.warn({ taskId, err: e }, 'Failed to refund quota'),
      )

      log.warn({
        taskId,
        error: result.error,
        duration: Date.now() - startTime,
      }, 'Async reading task failed — quota refunded')
    }
  } catch (err: any) {
    await failReadingTask(taskId, err.message || 'Internal error')
    await refundQuota(userId).catch((e) =>
      log.warn({ taskId, err: e }, 'Failed to refund quota on crash'),
    )

    log.error({ taskId, err, duration: Date.now() - startTime },
      'Async reading task crashed — quota refunded')
  }
}

/**
 * 服务启动时恢复 pending 任务
 * 在主入口 index.ts 中调用，扫描数据库中的 pending 任务重新投递
 */
export async function recoverPendingTasks(): Promise<void> {
  const db = await (await import('../db/index.js')).getDb()
  const rows = db
    .prepare("SELECT * FROM readings WHERE status = 'pending'")
    .all() as any[]

  if (rows.length === 0) return

  log.info({ count: rows.length }, 'Recovering pending reading tasks after restart')

  // 使用 import 避免循环依赖
  for (const row of rows) {
    const cards = JSON.parse(row.cards_json)
    processTask(row.id, row.user_id, row.question || '', cards).catch((err) => {
      log.error({ taskId: row.id, err }, 'Recovered task processing crashed')
    })
  }
}
