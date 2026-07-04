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
  cancelReadingTask,
} from '../db/reading-task.js'

const log = getLogger('reading:async')

/**
 * 活跃任务注册表
 * key = taskId, value = AbortController
 * 用于用户/后台主动取消时 abort 正在进行的 Gemini 调用
 */
const activeTasks = new Map<string, AbortController>()

/**
 * 取消指定任务
 * @returns true 表示任务存在且已 abort，false 表示任务不存在或已结束
 */
export function abortTask(taskId: string): boolean {
  const controller = activeTasks.get(taskId)
  if (!controller) return false
  controller.abort()
  activeTasks.delete(taskId)
  log.info({ taskId }, 'Task aborted by external request')
  return true
}

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

  // 注册 AbortController 并异步执行 Gemini 调用（不阻塞响应）
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  processTask(taskId, userId, question || '', cards, controller.signal)
    .finally(() => activeTasks.delete(taskId))

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
 * POST /api/reading/cancel/:taskId
 * 取消进行中的解读任务（用户/后台手动调用）
 */
export async function cancelReadingHandler(req: Request, res: Response): Promise<void> {
  const { taskId } = req.params
  const userId = (req as any).userId as string

  // 1. 原子化更新数据库状态
  const { ok, alreadyFinished } = await cancelReadingTask(taskId, userId)

  if (alreadyFinished) {
    // 任务已结束，返回当前状态
    const row = await getReadingTask(taskId, userId)
    res.json({
      taskId,
      status: row?.status || 'unknown',
      quotaRefunded: false,
      message: 'Task already finished',
    })
    return
  }

  if (!ok) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  // 2. Abort 正在进行的 Gemini 调用
  abortTask(taskId)

  // 3. 退还额度
  await refundQuota(userId).catch((e) =>
    log.warn({ taskId, err: e }, 'Failed to refund quota on cancel'),
  )

  log.info({ taskId, userId }, 'Reading task cancelled by user — quota refunded')

  res.json({ taskId, status: 'cancelled', quotaRefunded: true })
}

/**
 * 后台异步处理任务（无超时限制）
 * @param signal - AbortSignal，用于接收外部取消信号
 */
async function processTask(
  taskId: string,
  userId: string,
  question: string,
  cards: any[],
  signal: AbortSignal,
): Promise<void> {
  const startTime = Date.now()

  try {
    const result = await callGeminiReading(config.geminiApiKey!, question, cards, signal)

    // 检查是否在 Gemini 调用期间被取消
    if (signal.aborted) {
      log.info({ taskId }, 'Task was cancelled during Gemini call, skipping completion')
      return
    }

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
    // AbortError：任务已被 cancelReadingHandler 处理（cancelReadingTask + refundQuota 已执行）
    // 这里只需跳过，不做重复操作
    if (err.name === 'AbortError') {
      log.info({ taskId }, 'Task aborted via AbortController (cancellation already handled)')
      return
    }

    // 其他未预期的异常
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
  const stmt = db.prepare("SELECT * FROM readings WHERE status = 'pending'")
  const rows: any[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()

  if (rows.length === 0) return

  log.info({ count: rows.length }, 'Recovering pending reading tasks after restart')

  // 使用 import 避免循环依赖
  for (const row of rows) {
    const cards = JSON.parse(row.cards_json)
    const signal = new AbortController().signal  // 恢复的任务不用外部取消
    processTask(row.id, row.user_id, row.question || '', cards, signal).catch((err) => {
      log.error({ taskId: row.id, err }, 'Recovered task processing crashed')
    })
  }
}
