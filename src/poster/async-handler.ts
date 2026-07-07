import type { Request, Response } from 'express'
import { buildPosterHTML } from './template.js'
import { renderPoster } from './render.js'
import { posterCache } from '../cache/index.js'
import { getTemplate } from './templates/index.js'
import { getLogger } from '../logger.js'
import {
  createPosterTask,
  getPosterTask,
  completePosterTask,
  failPosterTask,
  cancelPosterTask,
  updatePosterTaskStatus,
} from '../db/poster-task.js'
import type { PosterData } from './types.js'

const log = getLogger('Poster:Async')

// 内存中的活跃任务注册表（用于取消）
const activeTasks = new Map<string, AbortController>()

/** 提交异步海报任务 */
export async function startPosterHandler(req: Request, res: Response): Promise<void> {
  try {
    const posterData = req.body as PosterData

    // 参数校验
    if (!posterData.cards || !Array.isArray(posterData.cards) || posterData.cards.length === 0) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'cards 数组不能为空' })
      return
    }

    // 创建任务
    const cardsJson = JSON.stringify(posterData.cards)
    const taskId = await createPosterTask({
      userId: (req as any).userId,
      cardsJson,
      question: posterData.question,
      spreadName: posterData.spreadName,
      interpretation: posterData.interpretation,
      comprehensiveInterpretation: posterData.comprehensiveInterpretation,
      theme: posterData.theme,
      template: posterData.template,
    })

    // 注册 AbortController 并异步执行（不阻塞响应）
    const controller = new AbortController()
    activeTasks.set(taskId, controller)

    processPosterTask(taskId, posterData, controller.signal)
      .finally(() => activeTasks.delete(taskId))

    // 立即返回 taskId
    res.json({ taskId, status: 'pending' })
  } catch (err) {
    log.error({ err }, 'Failed to start poster task')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}

/** 轮询海报任务结果 */
export async function getPosterResultHandler(req: Request, res: Response): Promise<void> {
  try {
    const { taskId } = req.params

    const row = await getPosterTask(taskId, (req as any).userId)
    if (!row) {
      res.status(404).json({ error: 'TASK_NOT_FOUND', message: '任务不存在' })
      return
    }

    res.json({
      taskId: row.id,
      status: row.status,
      url: row.poster_url,
      cacheKey: row.cache_key,
      error: row.error_msg,
    })
  } catch (err) {
    log.error({ err }, 'Failed to get poster result')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}

/** 取消海报任务 */
export async function cancelPosterHandler(req: Request, res: Response): Promise<void> {
  try {
    const { taskId } = req.params

    // 1. 原子更新数据库状态
    const cancelled = await cancelPosterTask(taskId)
    if (!cancelled) {
      res.status(400).json({ error: 'TASK_NOT_CANCELLABLE', message: '任务无法取消' })
      return
    }

    // 2. Abort 正在进行的渲染
    const controller = activeTasks.get(taskId)
    if (controller) {
      controller.abort()
      activeTasks.delete(taskId)
    }

    res.json({ message: '任务已取消' })
  } catch (err) {
    log.error({ err }, 'Failed to cancel poster task')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
}

/** 后台处理海报任务 */
async function processPosterTask(taskId: string, posterData: PosterData, signal: AbortSignal): Promise<void> {
  try {
    // 1. 更新状态为 rendering
    await updatePosterTaskStatus(taskId, 'rendering')

    // 2. 生成海报（复用现有逻辑）
    const template = getTemplate(posterData.template)
    const html = buildPosterHTML(posterData)
    const { buffer } = await renderPoster(html, template.width)

    // 3. 检查是否已取消
    if (signal.aborted) return

    // 4. 写入缓存
    const cacheKey = posterCache.generateKey(posterData)
    posterCache.set(cacheKey, buffer)

    // 5. 标记完成
    await completePosterTask({
      taskId,
      cacheKey,
      posterUrl: `/api/poster/${cacheKey}`,
    })

    log.info({ taskId, cacheKey }, 'Poster task completed')
  } catch (err: any) {
    if (err.name === 'AbortError') return  // 取消已处理

    log.error({ taskId, err }, 'Poster task failed')
    await failPosterTask(taskId, err.message)
  }
}

/** 服务重启恢复（可选实现） */
export async function recoverPendingPosterTasks(): Promise<void> {
  // 扫描 pending/rendering 状态的任务，重新投递 processPosterTask()
  // 参考 src/reading/async-handler.ts 的 recoverPendingTasks()
  log.info('Recovering pending poster tasks...')
  // TODO: v1.1 实现
}
