import type { Request, Response } from 'express'
import { getLogger } from '../logger.js'
import { getDb } from '../db/index.js'
import { insertAuditLog } from '../db/audit.js'
import {
  createFeedback,
  getFeedbackById,
  getFeedbackListByUser,
  queryAllFeedback,
  replyFeedback,
  updateFeedbackStatus,
} from '../db/feedback.js'
import type { FeedbackCreateRequest, FeedbackReplyRequest, FeedbackStatusUpdate } from './types.js'

const log = getLogger('feedback')

export async function handleCreateFeedback(req: Request, res: Response): Promise<void> {
  const { category, content, images } = req.body as FeedbackCreateRequest

  if (!content || !content.trim()) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '反馈内容不能为空' })
    return
  }

  if (!category || !['bug', 'suggestion', 'other'].includes(category)) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '请选择有效的反馈分类' })
    return
  }

  try {
    const feedback = await createFeedback({
      userId: req.userId!,
      category,
      content: content.trim(),
      images,
    })

    // 记录审计日志
    insertAuditLog({
      actorType: 'user',
      actorId: req.userId!,
      action: 'user_create_feedback',
      targetType: 'feedback',
      targetId: feedback.id,
      newValue: { category, content: content.trim(), imageCount: images?.length || 0 },
      ipAddress: req.ip,
    })

    res.status(201).json({
      id: feedback.id,
      category: feedback.category,
      content: feedback.content,
      images: feedback.images ? JSON.parse(feedback.images) : [],
      status: feedback.status,
      adminReply: feedback.admin_reply,
      repliedAt: feedback.replied_at,
      createdAt: feedback.created_at,
    })
  } catch (err) {
    log.error({ err }, 'Failed to create feedback')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '提交反馈失败' })
  }
}

export async function handleGetMyFeedback(req: Request, res: Response): Promise<void> {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)

  try {
    const result = await getFeedbackListByUser(req.userId!, page, limit)
    const data = result.data.map((f) => ({
      id: f.id,
      category: f.category,
      content: f.content,
      images: f.images ? JSON.parse(f.images) : [],
      status: f.status,
      adminReply: f.admin_reply,
      repliedAt: f.replied_at,
      createdAt: f.created_at,
    }))
    res.json({ total: result.total, page: result.page, limit: result.limit, data })
  } catch (err) {
    log.error({ err }, 'Failed to get my feedback')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取反馈列表失败' })
  }
}

export async function handleGetFeedbackDetail(req: Request, res: Response): Promise<void> {
  try {
    const feedback = await getFeedbackById(req.params.id)
    if (!feedback) {
      res.status(404).json({ error: 'NOT_FOUND', message: '反馈不存在' })
      return
    }

    if (feedback.user_id !== req.userId) {
      res.status(403).json({ error: 'FORBIDDEN', message: '无权查看此反馈' })
      return
    }

    res.json({
      id: feedback.id,
      category: feedback.category,
      content: feedback.content,
      images: feedback.images ? JSON.parse(feedback.images) : [],
      status: feedback.status,
      adminReply: feedback.admin_reply,
      repliedAt: feedback.replied_at,
      createdAt: feedback.created_at,
    })
  } catch (err) {
    log.error({ err }, 'Failed to get feedback detail')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取反馈详情失败' })
  }
}

export async function handleAdminListFeedback(req: Request, res: Response): Promise<void> {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const keyword = req.query.keyword as string | undefined
  const status = req.query.status as string | undefined

  try {
    const result = await queryAllFeedback({ page, limit, keyword, status })
    const data = result.data.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      userNickname: r.user_nickname || '匿名用户',
      userAvatar: r.user_avatar || null,
      category: r.category,
      content: r.content,
      images: r.images ? JSON.parse(r.images) : [],
      status: r.status,
      adminReply: r.admin_reply,
      repliedAt: r.replied_at,
      repliedBy: r.replied_by,
      createdAt: r.created_at,
    }))
    res.json({ total: result.total, page: result.page, limit: result.limit, data })
  } catch (err) {
    log.error({ err }, 'Failed to list feedback')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取反馈列表失败' })
  }
}

export async function handleAdminGetDetail(req: Request, res: Response): Promise<void> {
  try {
    const feedback = await getFeedbackById(req.params.id)
    if (!feedback) {
      res.status(404).json({ error: 'NOT_FOUND', message: '反馈不存在' })
      return
    }

    const db = await getDb()
    const userStmt = db.prepare('SELECT id, nickname, avatar_url, email FROM users WHERE id = ?')
    userStmt.bind([feedback.user_id])
    const user: any = userStmt.step() ? userStmt.getAsObject() : null
    userStmt.free()

    res.json({
      id: feedback.id,
      userId: feedback.user_id,
      user: user ? { nickname: user.nickname, avatarUrl: user.avatar_url, email: user.email } : null,
      category: feedback.category,
      content: feedback.content,
      images: feedback.images ? JSON.parse(feedback.images) : [],
      status: feedback.status,
      adminReply: feedback.admin_reply,
      repliedAt: feedback.replied_at,
      repliedBy: feedback.replied_by,
      createdAt: feedback.created_at,
    })
  } catch (err) {
    log.error({ err }, 'Failed to get feedback detail')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取反馈详情失败' })
  }
}

export async function handleAdminReply(req: Request, res: Response): Promise<void> {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能回复' })
    return
  }

  const { reply } = req.body as FeedbackReplyRequest

  if (!reply || !reply.trim()) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '回复内容不能为空' })
    return
  }

  try {
    const feedback = await replyFeedback(req.params.id, (req as any).adminId, reply.trim())
    if (!feedback) {
      res.status(404).json({ error: 'NOT_FOUND', message: '反馈不存在' })
      return
    }
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_reply_feedback',
      targetType: 'feedback',
      targetId: req.params.id,
      targetName: feedback.user_id || null,
      newValue: { reply: reply.trim() },
      ipAddress: req.ip,
    })
    res.json({ message: '回复成功' })
  } catch (err) {
    log.error({ err }, 'Failed to reply feedback')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '回复失败' })
  }
}

export async function handleAdminUpdateStatus(req: Request, res: Response): Promise<void> {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改' })
    return
  }

  const { status } = req.body as FeedbackStatusUpdate

  if (!status || !['pending', 'replied', 'closed'].includes(status)) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '无效的状态值' })
    return
  }

  try {
    const prevStatus = (await getFeedbackById(req.params.id))?.status
    const feedback = await updateFeedbackStatus(req.params.id, status)
    if (!feedback) {
      res.status(404).json({ error: 'NOT_FOUND', message: '反馈不存在' })
      return
    }
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_update_feedback_status',
      targetType: 'feedback',
      targetId: req.params.id,
      oldValue: prevStatus ? { status: prevStatus } : null,
      newValue: { status },
      ipAddress: req.ip,
    })
    res.json({ message: '状态已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update feedback status')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '状态更新失败' })
  }
}
