import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import express, { type Request, type Response, type NextFunction } from 'express'
import { config, configMeta, updateConfig, maskSensitiveValue, getConfigDefaults } from './config.js'
import { corsMiddleware } from './middleware/cors.js'
import { adminAuthMiddleware, type AdminJwtPayload } from './middleware/admin-auth.js'
import { jwtAuthMiddleware } from './middleware/jwt-auth.js'
import { rateLimitMiddleware } from './middleware/rate-limit.js'
import { quotaMiddleware } from './middleware/quota.js'
import { loggingMiddleware } from './gateway/logging.js'
import { buildPosterHTML } from './poster/template.js'
import { renderPoster } from './poster/render.js'
import { getPoolStats, getPoolInstance } from './poster/browser-pool.js'
import { posterCache } from './cache/index.js'
import { getTemplate } from './poster/templates/index.js'
import { metrics } from './monitor/index.js'
import { getLogger } from './logger.js'
import { readingHandler } from './reading/handler.js'
import { startReadingHandler, getReadingResultHandler, cancelReadingHandler, recoverPendingTasks, adminCancelTaskHandler } from './reading/async-handler.js'
import { getCachedGeminiHealth, getGeminiHealthDirectly, quotaExhaustedCache } from './reading/models.js'
import { queryRequestLogs, getRequestLogById, getRequestStats } from './db/request-log.js'
import { queryReadingLogs, getReadingLogById } from './db/reading-log.js'
import { listReadingTasks, getReadingTaskById, getAsyncTaskStats } from './db/reading-task.js'
import { queryUsers, unbindEmail, softDeleteUser, restoreUser } from './db/user.js'
import { getAllConfig, upsertConfig, initDefaultConfig, loadUserConfig } from './db/config.js'
import { getAllPageSections, updatePageSectionVisibility } from './db/page-sections.js'
import { getMyMenus } from './db/menus.js'
import { getDb, saveDb } from './db/index.js'
import { wechatLoginHandler } from './auth/wechat-login.js'
import { emailRegisterHandler } from './auth/email-register.js'
import { emailLoginHandler } from './auth/email-login.js'
import { bindEmailHandler } from './auth/bind-email.js'
import { bindPhoneHandler } from './auth/bind-phone.js'
import { updateProfileHandler } from './auth/update-profile.js'
import { getProfileHandler } from './auth/get-profile.js'
import { checkinHandler, checkinStatusHandler } from './auth/checkin.js'
import { getTasksHandler, claimTaskHandler } from './auth/tasks.js'
import { getInviteCodeHandler, getInviteRecordsHandler, bindReferralHandler } from './auth/invite.js'
import { getUserStatsHandler, getLevelsHandler } from './auth/stats.js'
import { initMissingUserStats } from './db/user-stats.js'
import { getUserRecords, getRecordById, saveRecord, deleteRecord, updateRecordInterpretation } from './db/reading-record.js'
import { insertAuditLog, queryAuditLogs, cleanExpiredAuditLogs } from './db/audit.js'
import {
  findAdminByUsername, updateLastLogin, initAdminIfNeeded, findAdminById, changePassword,
  createAdmin, listAdmins, updateAdmin, deleteAdmin, resetAdminPassword, validatePasswordStrength,
  type AdminRow, type UpdateAdminInput,
} from './db/admin.js'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'
import multer from 'multer'
import type { PosterData } from './poster/types.js'
import {
  handleCreateFeedback,
  handleGetMyFeedback,
  handleGetFeedbackDetail,
  handleAdminListFeedback,
  handleAdminGetDetail,
  handleAdminReply,
  handleAdminUpdateStatus,
} from './feedback/handler.js'

const log = getLogger('API')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app: express.Express = express()

app.use(express.json({ limit: '1mb' }))
app.use(corsMiddleware)

app.use('/api/cards', express.static(path.join(__dirname, '../assets/cards')))
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

app.use(loggingMiddleware)

app.get('/', (_req, res) => {
  res.json({
    service: 'tarot-backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      reading: 'POST /api/reading',
      poster: 'POST /api/poster',
      health: 'GET /api/health',
      metrics: 'GET /api/metrics',
      logs: 'GET /api/logs',
      auth: {
        wechatLogin: 'POST /api/auth/wechat-login',
        emailRegister: 'POST /api/auth/email-register',
        emailLogin: 'POST /api/auth/email-login',
        bindEmail: 'POST /api/auth/bind-email',
        bindPhone: 'POST /api/auth/bind-phone',
      },
      user: {
        profile: 'PUT /api/user/profile',
        records: 'GET /api/user/records',
        recordById: 'GET /api/user/records/:id',
        deleteRecord: 'DELETE /api/user/records/:id',
      },
      admin: {
        login: 'POST /admin/auth/login',
        logout: 'POST /admin/auth/logout',
        me: 'GET /admin/auth/me',
        changePassword: 'POST /admin/auth/change-password',
        logs: 'GET /api/logs',
        logById: 'GET /api/logs/:id',
        users: 'GET /api/admin/users',
        config: 'GET /api/config',
        updateConfig: 'PUT /api/config/:key',
      },
    },
  })
})

app.get('/api/health', async (req, res) => {
  const poolStats = await getPoolStats()
  const stats = await getRequestStats()
  const noCache = req.query.noCache === '1'

  // 默认状态：Worker 正常运行
  let geminiStatus: 'up' | 'down' | 'unconfigured' | 'quota_exhausted' = 'unconfigured'
  let geminiDetail: string | undefined
  let geminiModel: string | null = null
  let httpStatus = 200

  if (!config.geminiApiKey) {
    geminiStatus = 'unconfigured'
    geminiDetail = 'GEMINI_API_KEY not configured'
    httpStatus = 500
  } else {
    const geminiHealth = noCache
      ? await getGeminiHealthDirectly(config.geminiApiKey)
      : await getCachedGeminiHealth(config.geminiApiKey)

    if (geminiHealth.allExhausted) {
      geminiStatus = 'quota_exhausted'
      geminiDetail = geminiHealth.detail
    } else if (geminiHealth.up) {
      geminiStatus = 'up'
      geminiModel = geminiHealth.model
    } else {
      geminiStatus = 'down'
      geminiDetail = geminiHealth.detail
    }
  }

  const responseBody: any = {
    status: geminiStatus === 'up' ? 'ok' : 'degraded',
    worker: 'up',
    gemini: geminiStatus,
    model: geminiModel,
    _noCache: noCache || undefined,
    cache: {
      size: posterCache.size,
      maxSize: posterCache.maxSize,
      hitRate: stats.cacheHitRate,
    },
    pool: poolStats ?? { available: 0, active: 0, waiting: 0, maxPages: config.pool.maxPages },
    metrics: {
      totalRequests: stats.totalRequests,
      errors: stats.errors,
      avgTotalMs: Math.round(stats.avgTotalMs),
    },
  }

  // 添加可选字段
  if (geminiDetail) responseBody.detail = geminiDetail
  if (geminiStatus === 'quota_exhausted') {
    responseBody.exhaustedModels = [...quotaExhaustedCache.models]
  }

  res.status(httpStatus).json(responseBody)
})

app.get('/api/metrics', async (_req, res) => {
  const stats = await getRequestStats()

  const lines: string[] = [
    '# HELP request_requests_total Total number of API requests',
    '# TYPE request_requests_total counter',
    `request_requests_total ${stats.totalRequests}`,
    '',
    '# HELP request_errors_total Total number of error requests',
    '# TYPE request_errors_total counter',
    `request_errors_total ${stats.errors}`,
    '',
    '# HELP request_cache_hits_total Total number of cache hits',
    '# TYPE request_cache_hits_total counter',
    `request_cache_hits_total ${stats.cacheHits}`,
    '',
    '# HELP request_cache_misses_total Total number of cache misses',
    '# TYPE request_cache_misses_total counter',
    `request_cache_misses_total ${stats.cacheMisses}`,
    '',
    '# HELP request_cache_hit_rate Cache hit rate (0-1)',
    '# TYPE request_cache_hit_rate gauge',
    `request_cache_hit_rate ${stats.cacheHitRate.toFixed(4)}`,
    '',
    '# HELP request_duration_ms Request duration in milliseconds',
    '# TYPE request_duration_ms summary',
    `request_duration_ms{quantile="0.5"} ${stats.p50Ms}`,
    `request_duration_ms{quantile="0.95"} ${stats.p95Ms}`,
    `request_duration_ms{quantile="0.99"} ${stats.p99Ms}`,
    `request_duration_ms_sum ${(stats.avgTotalMs * stats.totalRequests).toFixed(0)}`,
    `request_duration_ms_count ${stats.totalRequests}`,
    '',
    '# HELP request_template_duration_ms Template generation duration (poster only)',
    '# TYPE request_template_duration_ms gauge',
    `request_template_duration_ms ${stats.avgTemplateMs.toFixed(2)}`,
    '',
    '# HELP request_resource_duration_ms Resource loading duration (poster only)',
    '# TYPE request_resource_duration_ms gauge',
    `request_resource_duration_ms ${stats.avgResourceMs.toFixed(2)}`,
    '',
    '# HELP request_screenshot_duration_ms Screenshot duration (poster only)',
    '# TYPE request_screenshot_duration_ms gauge',
    `request_screenshot_duration_ms ${stats.avgScreenshotMs.toFixed(2)}`,
    '',
  ]

  // 按 target 分组统计
  for (const t of stats.byTarget) {
    lines.push(`# HELP request_by_target_total Requests by target (${t.target})`)
    lines.push(`# TYPE request_by_target_total counter`)
    lines.push(`request_by_target_total{target="${t.target}"} ${t.count}`)
    lines.push('')
    lines.push(`# HELP request_by_target_errors Errors by target (${t.target})`)
    lines.push(`# TYPE request_by_target_errors counter`)
    lines.push(`request_by_target_errors{target="${t.target}"} ${t.errors}`)
    lines.push('')
    lines.push(`# HELP request_by_target_avg_duration_ms Avg duration by target (${t.target})`)
    lines.push(`# TYPE request_by_target_avg_duration_ms gauge`)
    lines.push(`request_by_target_avg_duration_ms{target="${t.target}"} ${t.avgDurationMs.toFixed(2)}`)
    lines.push('')
  }

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(lines.join('\n'))
})

// ========== 认证相关路由 ==========

// 登录与注册（无需鉴权）
app.post('/api/auth/wechat-login', wechatLoginHandler)
app.post('/api/auth/email-register', emailRegisterHandler)
app.post('/api/auth/email-login', emailLoginHandler)

// 账号绑定（需要 JWT 鉴权）
app.post('/api/auth/bind-email', jwtAuthMiddleware, bindEmailHandler)
app.post('/api/auth/bind-phone', jwtAuthMiddleware, bindPhoneHandler)

// 用户资料（需要 JWT 鉴权）
app.get('/api/user/profile', jwtAuthMiddleware, getProfileHandler)
app.put('/api/user/profile', jwtAuthMiddleware, updateProfileHandler)

// 签到（需要 JWT 鉴权）
app.post('/api/checkin', jwtAuthMiddleware, checkinHandler)
app.get('/api/checkin/status', jwtAuthMiddleware, checkinStatusHandler)

// 任务（需要 JWT 鉴权）
app.get('/api/tasks', jwtAuthMiddleware, getTasksHandler)
app.post('/api/tasks/:id/claim', jwtAuthMiddleware, claimTaskHandler)

// 邀请（需要 JWT 鉴权）
app.get('/api/invite/code', jwtAuthMiddleware, getInviteCodeHandler)
app.get('/api/invite/records', jwtAuthMiddleware, getInviteRecordsHandler)
app.post('/api/user/bind-referral', jwtAuthMiddleware, bindReferralHandler)

// 统计（需要 JWT 鉴权）
app.get('/api/user/stats', jwtAuthMiddleware, getUserStatsHandler)

// 等级配置（公开）
app.get('/api/levels', getLevelsHandler)

// ========== 页面区域可见性（公开）==========

app.get('/api/page-sections', async (_req, res) => {
  try {
    const sections = await getAllPageSections()
    const result: Record<string, Record<string, boolean>> = {}
    for (const s of sections) {
      if (!result[s.page_key]) result[s.page_key] = {}
      result[s.page_key][s.section_key] = s.visible === 1
    }
    res.json(result)
  } catch (err) {
    log.error({ err }, 'Failed to get page sections')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取页面配置失败' })
  }
})

// ========== Admin 认证路由 ==========

// Admin 登录（公开，但有限流）
const adminLoginRateLimit = new Map<string, { count: number; resetAt: number }>()
function checkAdminLoginRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = adminLoginRateLimit.get(ip)
  if (!entry || now > entry.resetAt) {
    adminLoginRateLimit.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

app.post('/admin/auth/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || ''

  if (!checkAdminLoginRateLimit(ip)) {
    res.status(429).json({ error: 'RATE_LIMITED', message: '登录频率过高，请 1 分钟后重试' })
    return
  }

  const { username, password } = req.body as { username?: string; password?: string }

  if (!username || !password) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '用户名和密码为必填项' })
    return
  }

  try {
    const admin = await findAdminByUsername(username)

    if (!admin || admin.is_active !== 1) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
      return
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash)
    if (!passwordMatch) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
      return
    }

    await updateLastLogin(admin.id)

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.username,
      action: 'admin_login',
      targetType: 'admin',
      targetId: admin.id,
      ipAddress: ip,
    })

    const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'
    const accessToken = jwt.sign(
      { sub: admin.id, username: admin.username, role: admin.role, type: 'admin', tokenType: 'access' },
      secret,
      { expiresIn: (config.adminAccessExpiresIn || '2h') as import('ms').StringValue },
    )
    const refreshToken = jwt.sign(
      { sub: admin.id, type: 'admin', tokenType: 'refresh' },
      secret,
      { expiresIn: (config.adminRefreshExpiresIn || '30d') as import('ms').StringValue },
    )

    res.json({
      accessToken,
      refreshToken,
      admin: {
        id: admin.id,
        username: admin.username,
        displayName: admin.display_name,
        role: admin.role,
      },
      mustChangePassword: admin.must_change_password === 1,
    })
  } catch (err) {
    log.error({ err }, 'Admin login failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// Admin 登出（纯前端清除 token，后端无状态）
app.post('/admin/auth/logout', adminAuthMiddleware, (_req, res) => {
  res.json({ message: '已退出登录' })
})

// Admin 刷新 Token（用 refreshToken 换取新 token 对）
app.post('/admin/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string }

  if (!refreshToken) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '缺少 refreshToken' })
    return
  }

  const secret = config.jwtSecret || 'dev-secret-do-not-use-in-production'

  try {
    const decoded = jwt.verify(refreshToken, secret) as AdminJwtPayload

    if (decoded.type !== 'admin' || decoded.tokenType !== 'refresh') {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }

    const admin = await findAdminById(decoded.sub)
    if (!admin || admin.is_active !== 1) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '账号不存在或已禁用' })
      return
    }

    const newAccessToken = jwt.sign(
      { sub: admin.id, username: admin.username, role: admin.role, type: 'admin', tokenType: 'access' },
      secret,
      { expiresIn: (config.adminAccessExpiresIn || '2h') as import('ms').StringValue },
    )
    const newRefreshToken = jwt.sign(
      { sub: admin.id, type: 'admin', tokenType: 'refresh' },
      secret,
      { expiresIn: (config.adminRefreshExpiresIn || '30d') as import('ms').StringValue },
    )

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken })
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'REFRESH_EXPIRED', message: '登录已过期，请重新登录' })
      return
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '无效的 token' })
      return
    }
    log.error({ err }, 'Admin token refresh failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 获取当前 Admin 信息（查 DB，返回完整字段）
app.get('/admin/auth/me', adminAuthMiddleware, async (req, res) => {
  try {
    const adminId = (req as any).adminId as string
    const admin = await findAdminById(adminId)
    if (!admin || admin.is_active !== 1) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: '账号不存在或已禁用' })
      return
    }
    res.json({
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      role: admin.role,
      mustChangePassword: admin.must_change_password === 1,
    })
  } catch (err) {
    log.error({ err }, 'Failed to get admin info')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 修改密码
app.post('/admin/auth/change-password', adminAuthMiddleware, async (req, res) => {
  const adminId = (req as any).adminId as string
  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string }

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: 'INVALID_INPUT', message: '旧密码和新密码为必填项' })
    return
  }

  try {
    const result = await changePassword(adminId, oldPassword, newPassword)
    if (!result.success) {
      res.status(400).json({ error: 'CHANGE_PASSWORD_FAILED', message: result.error })
      return
    }
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_change_password',
      targetType: 'admin',
      targetId: adminId,
      ipAddress: req.ip,
    })
    res.json({ message: '密码修改成功，请使用新密码重新登录' })
  } catch (err) {
    log.error({ err }, 'Change password failed')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// ========== 超管专用：管理员 CRUD（role=admin 才可操作）==========

/** 校验请求是否为 role=admin 的超管 */
function requireAdminRole(req: Request, res: Response): boolean {
  const role = (req as any).adminRole as string | undefined
  if (role !== 'admin') {
    res.status(403).json({ error: 'FORBIDDEN', message: '仅超级管理员可执行此操作' })
    return false
  }
  return true
}

// 管理员列表
app.get('/api/admin/admins', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100)
    const search = req.query.search as string | undefined
    const result = await listAdmins(page, pageSize, search)
    res.json({ success: true, data: result })
  } catch (err) {
    log.error({ err }, 'Failed to list admins')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 创建管理员
app.post('/api/admin/admins', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const { username, displayName, password, role: newRole } = req.body as {
      username?: string
      displayName?: string
      password?: string
      role?: string
    }

    if (!username || !displayName || !password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '用户名、显示名和密码为必填项' })
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: strengthError })
      return
    }

    const existing = await findAdminByUsername(username)
    if (existing) {
      res.status(409).json({ error: 'CONFLICT', message: '该用户名已存在' })
      return
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const admin = await createAdmin({
      username,
      passwordHash,
      displayName,
      role: newRole === 'readonly' ? 'readonly' : 'admin',
    })
    log.info({ adminId: admin.id, username, operator: (req as any).adminUsername }, 'Admin created')

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_create_admin',
      targetType: 'admin',
      targetId: admin.id,
      targetName: username,
      newValue: { username, displayName, role: newRole === 'readonly' ? 'readonly' : 'admin' },
      ipAddress: req.ip,
    })

    res.status(201).json({
      success: true,
      data: {
        id: admin.id,
        username: admin.username,
        displayName: admin.display_name,
        role: admin.role,
        isActive: true,
        createdAt: admin.created_at,
      },
    })
  } catch (err) {
    log.error({ err }, 'Failed to create admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 编辑管理员
app.put('/api/admin/admins/:id', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const operatorId = (req as any).adminId as string
    const { displayName, role: newRole, isActive } = req.body as UpdateAdminInput

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    // 禁止禁用自己
    if (targetId === operatorId && isActive === false) {
      res.status(400).json({ error: 'NOT_ALLOWED', message: '不能禁用自己的账号' })
      return
    }

    const updateData: UpdateAdminInput = {}
    if (displayName !== undefined) updateData.displayName = displayName
    if (newRole !== undefined) updateData.role = newRole
    if (isActive !== undefined) updateData.isActive = isActive

    await updateAdmin(targetId, updateData)
    log.info({ targetId, operator: (req as any).adminUsername, changes: updateData }, 'Admin updated')

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_update_admin',
      targetType: 'admin',
      targetId: targetId,
      targetName: target.username,
      newValue: updateData as Record<string, any>,
      ipAddress: req.ip,
    })

    res.json({ success: true, message: '管理员信息已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 删除管理员（软删除）
app.delete('/api/admin/admins/:id', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const operatorId = (req as any).adminId as string

    // 禁止删除自己
    if (targetId === operatorId) {
      res.status(400).json({ error: 'NOT_ALLOWED', message: '不能删除自己的账号' })
      return
    }

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    await deleteAdmin(targetId)
    log.info({ targetId, operator: (req as any).adminUsername, targetUsername: target.username }, 'Admin deleted')

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_delete_admin',
      targetType: 'admin',
      targetId: targetId,
      targetName: target.username,
      ipAddress: req.ip,
    })

    res.json({ success: true, message: '管理员已删除' })
  } catch (err) {
    log.error({ err }, 'Failed to delete admin')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// 重置管理员密码
app.post('/api/admin/admins/:id/reset-password', adminAuthMiddleware, async (req, res) => {
  if (!requireAdminRole(req, res)) return
  try {
    const targetId = req.params.id
    const { password } = req.body as { password?: string }

    if (!password) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '新密码为必填项' })
      return
    }

    const strengthError = validatePasswordStrength(password)
    if (strengthError) {
      res.status(400).json({ error: 'WEAK_PASSWORD', message: strengthError })
      return
    }

    const target = await findAdminById(targetId)
    if (!target) {
      res.status(404).json({ error: 'NOT_FOUND', message: '管理员不存在' })
      return
    }

    const passwordHash = await bcrypt.hash(password, 10)
    await resetAdminPassword(targetId, passwordHash)
    log.info({ targetId, operator: (req as any).adminUsername, targetUsername: target.username }, 'Admin password reset')

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_reset_password',
      targetType: 'admin',
      targetId: targetId,
      targetName: target.username,
      ipAddress: req.ip,
    })

    res.json({ success: true, message: '密码已重置，该管理员下次登录时需修改密码' })
  } catch (err) {
    log.error({ err }, 'Failed to reset admin password')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
  }
})

// ========== 业务接口（JWT 鉴权 + 频率限制）==========

// 异步解读（新版，推荐）
app.post('/api/reading/start', jwtAuthMiddleware, quotaMiddleware, startReadingHandler)
app.get('/api/reading/result/:taskId', jwtAuthMiddleware, getReadingResultHandler)
app.post('/api/reading/cancel/:taskId', jwtAuthMiddleware, cancelReadingHandler)

// 同步解读（旧版，保留兼容）
app.post('/api/reading', quotaMiddleware, rateLimitMiddleware, readingHandler)

app.post('/api/poster', async (req, res) => {
  const requestStart = Date.now()
  const posterData = req.body as PosterData
  const template = getTemplate(posterData.template)
  const requestLogger = log.child({ logId: (req as any).logId || 'unknown', userId: (req as any).userId || null })

  try {
    if (!posterData.cards || !Array.isArray(posterData.cards) || posterData.cards.length === 0) {
      res.status(400).json({ error: 'Invalid request: cards array is required' })
      return
    }

    const cacheKey = posterCache.generateKey(posterData)
    const cached = posterCache.get(cacheKey)
    if (cached) {
      const totalMs = Date.now() - requestStart
      requestLogger.debug({ cacheKey, template: template.name, totalMs }, 'Poster cache HIT')

      res.set('Content-Type', 'image/png')
      res.set('X-Cache', 'HIT')
      res.set('X-Cache-Key', cacheKey)
      res.set('Cache-Control', 'public, max-age=3600')
      res.send(cached)

      metrics.recordRender({
        templateMs: 0,
        resourceMs: 0,
        screenshotMs: 0,
        totalMs,
        timestamp: requestStart,
        template: template.name,
        cacheHit: true,
      })
      return
    }

    const templateStart = Date.now()
    const html = buildPosterHTML(posterData)
    const templateMs = Date.now() - templateStart

    const { buffer: imageBuffer, timings } = await renderPoster(html, template.width)

    posterCache.set(cacheKey, imageBuffer)

    const totalMs = Date.now() - requestStart

    requestLogger.info({
      cacheKey,
      template: template.name,
      templateMs,
      resourceMs: timings.resourceMs,
      screenshotMs: timings.screenshotMs,
      totalMs,
    }, `Poster cache MISS — rendered in ${totalMs}ms`)

    metrics.recordRender({
      templateMs,
      resourceMs: timings.resourceMs,
      screenshotMs: timings.screenshotMs,
      totalMs,
      timestamp: requestStart,
      template: template.name,
      cacheHit: false,
    })

    res.set('Content-Type', 'image/png')
    res.set('X-Cache', 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.set('X-Render-Template-Ms', String(templateMs))
    res.set('X-Render-Resource-Ms', String(timings.resourceMs))
    res.set('X-Render-Screenshot-Ms', String(timings.screenshotMs))
    res.set('X-Render-Total-Ms', String(totalMs))
    res.set('Cache-Control', 'public, max-age=3600')
    res.send(imageBuffer)
  } catch (error) {
    metrics.recordError()
    requestLogger.error({ err: error }, 'Poster generation failed')
    res.status(500).json({ error: 'Poster generation failed' })
  }
})

app.post('/api/poster/key', async (req, res) => {
  const posterData = req.body as PosterData

  try {
    if (!posterData.cards || !Array.isArray(posterData.cards) || posterData.cards.length === 0) {
      res.status(400).json({ error: 'Invalid request: cards array is required' })
      return
    }

    const cacheKey = posterCache.generateKey(posterData)

    // 缓存未命中时先渲染海报并缓存
    const cached = posterCache.get(cacheKey)
    if (!cached) {
      const html = buildPosterHTML(posterData)
      const template = getTemplate(posterData.template)
      const { buffer } = await renderPoster(html, template.width)
      posterCache.set(cacheKey, buffer)
    }

    res.json({ cacheKey })
  } catch (error) {
    log.error({ err: error }, 'Poster key generation failed')
    res.status(500).json({ error: 'Poster generation failed' })
  }
})

app.get('/api/poster/:cacheKey', async (req, res) => {
  const { cacheKey } = req.params
  const cached = posterCache.get(cacheKey)
  if (!cached) {
    res.status(404).json({ error: 'Poster not found or expired' })
    return
  }
  res.set('Content-Type', 'image/png')
  res.set('X-Cache', 'HIT')
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(cached)
})

app.get('/api/logs', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const target = req.query.target as string | undefined
  const status = req.query.status as string | undefined
  const result = await queryRequestLogs(page, limit, target, status)
  res.json(result)
})

app.get('/api/logs/:id', adminAuthMiddleware, async (req, res) => {
  const log = await getRequestLogById(req.params.id)
  if (!log) {
    res.status(404).json({ error: 'Log not found' })
    return
  }
  res.json(log)
})

// 解读日志（仅 reading 请求）
app.get('/api/reading-logs', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const result = await queryReadingLogs(page, limit)
  res.json(result)
})

app.get('/api/reading-logs/:id', adminAuthMiddleware, async (req, res) => {
  const log = await getReadingLogById(req.params.id)
  if (!log) {
    res.status(404).json({ error: 'Reading log not found' })
    return
  }
  res.json(log)
})

// ========== 解读任务管理（Admin JWT）==========

app.get('/api/admin/reading-tasks', adminAuthMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const status = req.query.status as string | undefined
    const userId = req.query.userId as string | undefined
    const keyword = req.query.keyword as string | undefined
    const dateFrom = req.query.dateFrom as string | undefined
    const dateTo = req.query.dateTo as string | undefined

    const [result, stats] = await Promise.all([
      listReadingTasks({ page, limit, status, userId, keyword, dateFrom, dateTo }),
      getAsyncTaskStats(),
    ])

    res.json({
      total: result.total,
      page,
      limit,
      data: result.data,
      stats,
    })
  } catch (err) {
    log.error({ err }, 'Failed to list reading tasks')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取解读任务列表失败' })
  }
})

app.get('/api/admin/reading-tasks/:taskId', adminAuthMiddleware, async (req, res) => {
  try {
    const task = await getReadingTaskById(req.params.taskId)
    if (!task) {
      res.status(404).json({ error: 'Task not found' })
      return
    }
    res.json(task)
  } catch (err) {
    log.error({ err }, 'Failed to get reading task detail')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取任务详情失败' })
  }
})

app.post('/api/admin/reading-tasks/:taskId/cancel', adminAuthMiddleware, adminCancelTaskHandler)

app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const keyword = req.query.keyword as string | undefined
  const deleted = req.query.deleted === 'true'
  const result = await queryUsers(page, limit, keyword, deleted)
  res.json(result)
})

// 解除邮箱绑定（自动恢复被合并的原邮箱用户）
app.put('/api/admin/users/:id/unbind-email', adminAuthMiddleware, async (req, res) => {
  try {
    await unbindEmail(req.params.id)
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_unbind_email',
      targetType: 'user',
      targetId: req.params.id,
      ipAddress: req.ip,
    })
    res.json({ message: '邮箱已解除绑定' })
  } catch (err: any) {
    if (err.message === '纯邮箱用户无法解除邮箱绑定') {
      res.status(400).json({ error: 'CANNOT_UNBIND', message: err.message })
      return
    }
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

// 逻辑删除用户
app.delete('/api/admin/users/:id', adminAuthMiddleware, async (req, res) => {
  try {
    await softDeleteUser(req.params.id)

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_delete_user',
      targetType: 'user',
      targetId: req.params.id,
      newValue: { deleted_at: new Date().toISOString() },
      ipAddress: req.ip,
    })

    res.json({ message: '用户已删除（可恢复）' })
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

// 恢复已删除用户
app.put('/api/admin/users/:id/restore', adminAuthMiddleware, async (req, res) => {
  try {
    await restoreUser(req.params.id)

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_restore_user',
      targetType: 'user',
      targetId: req.params.id,
      newValue: { deleted_at: null },
      ipAddress: req.ip,
    })

    res.json({ message: '用户已恢复' })
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

// ========== 积分等级体系管理后台 API（Admin JWT）==========

app.get('/api/admin/level-definitions', adminAuthMiddleware, async (_req, res) => {
  try {
    const db = await getDb()
    const stmt = db.prepare('SELECT * FROM level_definitions ORDER BY level ASC')
    const levels: any[] = []
    while (stmt.step()) levels.push(stmt.getAsObject())
    stmt.free()
    res.json({ levels })
  } catch (err) {
    log.error({ err }, 'Failed to get level definitions')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取等级配置失败' })
  }
})

app.put('/api/admin/level-definitions/:level', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }
  try {
    const db = await getDb()
    const { title, points_required, daily_quota, max_extra_quota } = req.body as any
    const level = parseInt(req.params.level)

    if (!title || points_required === undefined || daily_quota === undefined) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'title, points_required, daily_quota 为必填项' })
      return
    }

    db.run(
      'UPDATE level_definitions SET title = ?, points_required = ?, daily_quota = ?, max_extra_quota = ? WHERE level = ?',
      [title, points_required, daily_quota, max_extra_quota ?? 100, level],
    )
    saveDb()

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_update_level',
      targetType: 'level_definition',
      targetId: String(level),
      newValue: { title, points_required, daily_quota, max_extra_quota },
      ipAddress: req.ip,
    })

    res.json({ message: '等级配置已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update level definition')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '更新等级配置失败' })
  }
})

app.get('/api/admin/task-definitions', adminAuthMiddleware, async (_req, res) => {
  try {
    const db = await getDb()
    const stmt = db.prepare('SELECT * FROM task_definitions ORDER BY sort_order ASC')
    const tasks: any[] = []
    while (stmt.step()) tasks.push(stmt.getAsObject())
    stmt.free()
    res.json({ tasks })
  } catch (err) {
    log.error({ err }, 'Failed to get task definitions')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取任务定义失败' })
  }
})

app.post('/api/admin/task-definitions', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }
  try {
    const db = await getDb()
    const { id, title, description, type, requirement_type, requirement_count, points_reward, extra_quota_reward, icon, sort_order } = req.body as any

    if (!id || !title || !type || !requirement_type || requirement_count === undefined) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'id, title, type, requirement_type, requirement_count 为必填项' })
      return
    }

    db.run(
      `INSERT INTO task_definitions (id, title, description, type, requirement_type, requirement_count, points_reward, extra_quota_reward, icon, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, title, description || null, type, requirement_type, requirement_count, points_reward || 0, extra_quota_reward || 0, icon || null, sort_order || 0],
    )
    saveDb()

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_create_task',
      targetType: 'task_definition',
      targetId: id,
      targetName: title,
      newValue: { title, type, points_reward, extra_quota_reward },
      ipAddress: req.ip,
    })

    res.status(201).json({ message: '任务定义已创建' })
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'CONFLICT', message: '任务 ID 已存在' })
      return
    }
    log.error({ err }, 'Failed to create task definition')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '创建任务定义失败' })
  }
})

app.put('/api/admin/task-definitions/:id', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }
  try {
    const db = await getDb()
    const fields = ['title', 'description', 'type', 'requirement_type', 'requirement_count', 'points_reward', 'extra_quota_reward', 'icon', 'sort_order', 'is_active'] as const
    const updates: string[] = []
    const values: any[] = []
    const body = req.body as any

    for (const field of fields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`)
        values.push(body[field])
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '没有需要更新的字段' })
      return
    }

    values.push(req.params.id)
    db.run(`UPDATE task_definitions SET ${updates.join(', ')} WHERE id = ?`, values)
    saveDb()

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_update_task',
      targetType: 'task_definition',
      targetId: req.params.id,
      newValue: body as Record<string, any>,
      ipAddress: req.ip,
    })

    res.json({ message: '任务定义已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update task definition')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '更新任务定义失败' })
  }
})

app.get('/api/admin/user-stats', adminAuthMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const keyword = (req.query.keyword as string) || ''
    const offset = (page - 1) * limit

    let whereClause = 'WHERE s.user_id IS NOT NULL'
    const params: any[] = []
    if (keyword) {
      whereClause += ' AND (u.nickname LIKE ? OR u.email LIKE ? OR u.id LIKE ?)'
      const like = `%${keyword}%`
      params.push(like, like, like)
    }

    const countStmt = db.prepare(`
      SELECT COUNT(*) as total FROM user_stats s
      LEFT JOIN users u ON s.user_id = u.id
      ${whereClause}
    `)
    countStmt.bind(params)
    countStmt.step()
    const total = (countStmt.getAsObject() as any).total
    countStmt.free()

    const stmt = db.prepare(`
      SELECT s.*, u.nickname, u.email,
        (SELECT title FROM level_definitions WHERE level = s.level) as level_title
      FROM user_stats s
      LEFT JOIN users u ON s.user_id = u.id
      ${whereClause}
      ORDER BY s.points DESC
      LIMIT ? OFFSET ?
    `)
    stmt.bind([...params, limit, offset])
    const data: any[] = []
    while (stmt.step()) data.push(stmt.getAsObject())
    stmt.free()

    res.json({ total, page, limit, data })
  } catch (err) {
    log.error({ err }, 'Failed to get user stats')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取用户统计失败' })
  }
})

app.put('/api/admin/users/:id/points', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }
  try {
    const { addPoints, getUserStats } = await import('./db/user-stats.js')
    const { delta } = req.body as { delta: number }
    if (typeof delta !== 'number') {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'delta 必须为数字' })
      return
    }
    const oldStats = await getUserStats(req.params.id)
    const result = await addPoints(req.params.id, delta)

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_adjust_points',
      targetType: 'user',
      targetId: req.params.id,
      oldValue: { points: oldStats?.points ?? 0 },
      newValue: { points: result.newPoints, delta },
      ipAddress: req.ip,
    })

    res.json({ newPoints: result.newPoints, newLevel: result.newLevel, leveledUp: result.leveledUp })
  } catch (err) {
    log.error({ err }, 'Failed to adjust points')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '调整积分失败' })
  }
})

// ========== 数据维护 API（Admin JWT）==========

app.get('/api/admin/stats/trends', adminAuthMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const days = Math.min(parseInt(req.query.days as string) || 30, 365)
    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceStr = since.toISOString().slice(0, 10)

    function formatDate(d: Date): string {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    const today = new Date()
    const dateMap = new Map<string, { registration: number; checkin: number; reading: number; invite: number }>()
    for (let d = new Date(since); d <= today; d.setDate(d.getDate() + 1)) {
      const key = formatDate(d)
      dateMap.set(key, { registration: 0, checkin: 0, reading: 0, invite: 0 })
    }

    const regStmt = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= ? GROUP BY DATE(created_at)`)
    regStmt.bind([sinceStr])
    while (regStmt.step()) { const r = regStmt.getAsObject() as any; if (dateMap.has(r.date)) dateMap.get(r.date)!.registration = r.count; else dateMap.set(r.date, { registration: r.count, checkin: 0, reading: 0, invite: 0 }) }
    regStmt.free()

    const ckStmt = db.prepare(`SELECT checkin_date as date, COUNT(*) as count FROM checkin_records WHERE created_at >= ? GROUP BY checkin_date`)
    ckStmt.bind([sinceStr])
    while (ckStmt.step()) { const r = ckStmt.getAsObject() as any; if (dateMap.has(r.date)) dateMap.get(r.date)!.checkin = r.count; else dateMap.set(r.date, { registration: 0, checkin: r.count, reading: 0, invite: 0 }) }
    ckStmt.free()

    const rdStmt = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as count FROM reading_logs WHERE target = 'reading' AND created_at >= ? GROUP BY DATE(created_at)`)
    rdStmt.bind([sinceStr])
    while (rdStmt.step()) { const r = rdStmt.getAsObject() as any; if (dateMap.has(r.date)) dateMap.get(r.date)!.reading = r.count; else dateMap.set(r.date, { registration: 0, checkin: 0, reading: r.count, invite: 0 }) }
    rdStmt.free()

    const invStmt = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as count FROM invite_records WHERE created_at >= ? GROUP BY DATE(created_at)`)
    invStmt.bind([sinceStr])
    while (invStmt.step()) { const r = invStmt.getAsObject() as any; if (dateMap.has(r.date)) dateMap.get(r.date)!.invite = r.count; else dateMap.set(r.date, { registration: 0, checkin: 0, reading: 0, invite: r.count }) }
    invStmt.free()

    const sortedDates = [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b))
    const registration = sortedDates.map(([date, v]) => ({ date, count: v.registration }))
    const checkin = sortedDates.map(([date, v]) => ({ date, count: v.checkin }))
    const reading = sortedDates.map(([date, v]) => ({ date, count: v.reading }))
    const invite = sortedDates.map(([date, v]) => ({ date, count: v.invite }))

    const lvStmt = db.prepare(`
      SELECT s.level, COUNT(*) as count, COALESCE((SELECT title FROM level_definitions WHERE level = s.level), '未知') as title
      FROM user_stats s GROUP BY s.level ORDER BY s.level ASC
    `)
    const levelDistribution: any[] = []
    while (lvStmt.step()) levelDistribution.push(lvStmt.getAsObject())
    lvStmt.free()

    const todayStr = formatDate(today)
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL').getAsObject() as any
    const tcStmt = db.prepare('SELECT COUNT(*) as c FROM checkin_records WHERE checkin_date = ?')
    tcStmt.bind([todayStr]); tcStmt.step(); const tc = (tcStmt.getAsObject() as any).c; tcStmt.free()
    const totalReadings = db.prepare('SELECT COALESCE(SUM(total_readings),0) as c FROM user_stats').getAsObject() as any
    const totalInvites = db.prepare("SELECT COUNT(*) as c FROM invite_records WHERE status = 'completed'").getAsObject() as any

    res.json({
      registration, checkin, reading, invite, levelDistribution,
      summary: {
        totalUsers: (totalUsers as any).c,
        todayCheckins: tc,
        totalReadings: (totalReadings as any).c,
        totalInvites: (totalInvites as any).c,
      },
    })
  } catch (err) {
    log.error({ err }, 'Failed to get stats trends')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取趋势统计失败' })
  }
})

app.get('/api/admin/invite-records', adminAuthMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = (page - 1) * limit
    const status = req.query.status as string
    const keyword = (req.query.keyword as string) || ''

    let where = 'WHERE 1=1'
    const params: any[] = []
    if (status) { where += ' AND ir.status = ?'; params.push(status) }
    if (keyword) {
      where += ' AND (iu.nickname LIKE ? OR eu.nickname LIKE ?)'
      const like = `%${keyword}%`
      params.push(like, like)
    }

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM invite_records ir ${where}`)
    countStmt.bind(params)
    countStmt.step()
    const total = (countStmt.getAsObject() as any).total
    countStmt.free()

    const stmt = db.prepare(`
      SELECT ir.*, iu.nickname as inviter_name, iu.avatar_url as inviter_avatar,
             eu.nickname as invitee_name, eu.avatar_url as invitee_avatar
      FROM invite_records ir
      LEFT JOIN users iu ON ir.inviter_id = iu.id
      LEFT JOIN users eu ON ir.invitee_id = eu.id
      ${where} ORDER BY ir.created_at DESC LIMIT ? OFFSET ?
    `)
    stmt.bind([...params, limit, offset])
    const data: any[] = []
    while (stmt.step()) data.push(stmt.getAsObject())
    stmt.free()
    res.json({ total, page, limit, data })
  } catch (err) {
    log.error({ err }, 'Failed to get invite records')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取邀请记录失败' })
  }
})

app.put('/api/admin/invite-records/:id/complete', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') return res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改' })
  try {
    const db = await getDb()
    const now = new Date().toISOString()
    const stmt = db.prepare("UPDATE invite_records SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'")
    stmt.bind([now, req.params.id])
    stmt.step()
    stmt.free()
    saveDb()
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_complete_invite',
      targetType: 'invite_record',
      targetId: req.params.id,
      ipAddress: req.ip,
    })
    res.json({ message: '邀请已标记为完成' })
  } catch (err) {
    log.error({ err }, 'Failed to complete invite')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

app.delete('/api/admin/invite-records/:id', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') return res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改' })
  try {
    const db = await getDb()
    db.run('DELETE FROM invite_records WHERE id = ?', [req.params.id])
    saveDb()
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_delete_invite',
      targetType: 'invite_record',
      targetId: req.params.id,
      ipAddress: req.ip,
    })
    res.json({ message: '邀请记录已删除' })
  } catch (err) {
    log.error({ err }, 'Failed to delete invite record')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

app.get('/api/admin/checkin-stats', adminAuthMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const todayCount = db.prepare('SELECT COUNT(*) as c FROM checkin_records WHERE checkin_date = ?')
    todayCount.bind([todayStr])
    todayCount.step()
    const todayCheckins = (todayCount.getAsObject() as any).c
    todayCount.free()

    const totalStmt = db.prepare('SELECT COUNT(*) as c FROM checkin_records')
    totalStmt.step()
    const total = (totalStmt.getAsObject() as any).c
    totalStmt.free()

    const avgStmt = db.prepare('SELECT AVG(points_earned) as avg FROM checkin_records')
    avgStmt.step()
    const avgPoints = (avgStmt.getAsObject() as any).avg || 0
    avgStmt.free()

    if (req.query.detail === '1') {
      const page = parseInt(req.query.page as string) || 1
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
      const offset = (page - 1) * limit
      const detailStmt = db.prepare(`
        SELECT cr.*, u.nickname, u.avatar_url
        FROM checkin_records cr
        LEFT JOIN users u ON cr.user_id = u.id
        ORDER BY cr.created_at DESC LIMIT ? OFFSET ?
      `)
      detailStmt.bind([limit, offset])
      const detail: any[] = []
      while (detailStmt.step()) detail.push(detailStmt.getAsObject())
      detailStmt.free()
      res.json({ todayCheckins, total, avgPoints: Math.round(avgPoints * 10) / 10, page, limit, data: detail })
      return
    }

    res.json({ todayCheckins, total, avgPoints: Math.round(avgPoints * 10) / 10 })
  } catch (err) {
    log.error({ err }, 'Failed to get checkin stats')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取签到统计失败' })
  }
})

app.put('/api/admin/users/:id/reset-quota', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') return res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改' })
  try {
    const db = await getDb()
    db.run('UPDATE user_stats SET daily_quota_used = 0 WHERE user_id = ?', [req.params.id])
    saveDb()

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_reset_quota',
      targetType: 'user',
      targetId: req.params.id,
      newValue: { daily_quota_used: 0 },
      ipAddress: req.ip,
    })

    res.json({ message: '额度已重置' })
  } catch (err) {
    log.error({ err }, 'Failed to reset quota')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

app.put('/api/admin/users/:id/clear-invite', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') return res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改' })
  try {
    const db = await getDb()
    db.run("DELETE FROM invite_records WHERE invitee_id = ?", [req.params.id])
    db.run("UPDATE user_stats SET invited_by = NULL WHERE user_id = ?", [req.params.id])
    saveDb()

    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_clear_invite',
      targetType: 'user',
      targetId: req.params.id,
      newValue: { invited_by: null },
      ipAddress: req.ip,
    })

    res.json({ message: '邀请绑定已清除' })
  } catch (err) {
    log.error({ err }, 'Failed to clear invite')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '操作失败' })
  }
})

// ========== 动态菜单 API（Admin JWT）==========

app.get('/api/admin/menus/my', adminAuthMiddleware, async (req, res) => {
  try {
    const role = (req as any).adminRole as string
    const menus = await getMyMenus(role)
    res.json({ menus })
  } catch (err) {
    log.error({ err }, 'Failed to get my menus')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取菜单失败' })
  }
})

// ========== 页面管理 API（Admin JWT）==========

app.get('/api/admin/page-sections', adminAuthMiddleware, async (_req, res) => {
  try {
    const sections = await getAllPageSections()
    res.json({
      sections: sections.map(s => ({
        id: s.id,
        pageKey: s.page_key,
        sectionKey: s.section_key,
        label: s.label,
        visible: s.visible === 1,
        updatedAt: s.updated_at,
      }))
    })
  } catch (err) {
    log.error({ err }, 'Failed to get admin page sections')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '获取页面配置失败' })
  }
})

app.put('/api/admin/page-sections/:id', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }
  try {
    const { visible } = req.body as { visible: number }
    if (visible !== 0 && visible !== 1) {
      res.status(400).json({ error: 'INVALID_INPUT', message: 'visible 必须为 0 或 1' })
      return
    }
    await updatePageSectionVisibility(req.params.id, visible)
    saveDb()
    // 记录审计日志
    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_update_page_section',
      targetType: 'page_section',
      targetId: req.params.id,
      newValue: { visible },
      ipAddress: req.ip,
    })
    res.json({ message: '已更新' })
  } catch (err) {
    log.error({ err }, 'Failed to update page section')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '更新失败' })
  }
})

// ========== 用户级占卜记录（JWT 鉴权）==========

app.post('/api/user/records', jwtAuthMiddleware, async (req, res) => {
  const { spreadType, question, cardsJson, reading, model, isLocal, interpretation } = req.body as {
    spreadType: string
    question?: string
    cardsJson: string
    reading: string
    model?: string
    isLocal?: boolean
    interpretation?: string
  }

  if (!spreadType || !cardsJson) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'spreadType 和 cardsJson 为必填项' })
    return
  }

  try {
    const record = await saveRecord({
      userId: req.userId!,
      spreadType,
      question: question || null,
      cardsJson,
      reading: reading || '',
      model: model || null,
      isLocal,
      interpretation: interpretation || null,
    })
    res.status(201).json(record)
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '保存记录失败' })
  }
})

app.get('/api/user/records', jwtAuthMiddleware, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const result = await getUserRecords(req.userId!, page, limit)
  res.json(result)
})

app.get('/api/user/records/:id', jwtAuthMiddleware, async (req, res) => {
  const record = await getRecordById(req.userId!, req.params.id)
  if (!record) {
    res.status(404).json({ error: 'Record not found' })
    return
  }
  res.json(record)
})

app.patch('/api/user/records/:id', jwtAuthMiddleware, async (req, res) => {
  const { interpretation } = req.body as { interpretation?: string }

  if (interpretation === undefined) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'interpretation 为必填项' })
    return
  }

  const updated = await updateRecordInterpretation(req.userId!, req.params.id, interpretation)
  if (!updated) {
    res.status(404).json({ error: 'Record not found' })
    return
  }
  res.json({ message: '更新成功' })
})

app.delete('/api/user/records/:id', jwtAuthMiddleware, async (req, res) => {
  const deleted = await deleteRecord(req.userId!, req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'Record not found' })
    return
  }
  // 记录审计日志
  insertAuditLog({
    actorType: 'user',
    actorId: req.userId!,
    action: 'user_delete_record',
    targetType: 'reading_record',
    targetId: req.params.id,
    ipAddress: req.ip,
  })
  res.json({ message: '删除成功' })
})

app.get('/api/config', async (_req, res) => {
  const dbConfig = await getAllConfig()
  const groups = new Map<string, any[]>()

  for (const meta of configMeta) {
    const entry = dbConfig.get(meta.envKey)
    const rawValue = entry?.value ?? process.env[meta.envKey] ?? ''
    const value = meta.sensitive ? maskSensitiveValue(meta.envKey, rawValue) : rawValue

    if (!groups.has(meta.group)) {
      groups.set(meta.group, [])
    }
    groups.get(meta.group)!.push({
      key: meta.envKey,
      label: meta.envKey,
      value,
      source: entry?.source ?? 'env',
      editable: meta.editable,
      type: meta.type,
    })
  }

  res.json({ groups: Array.from(groups.entries()).map(([name, items]) => ({ name, items })) })
})

app.put('/api/config/:key', adminAuthMiddleware, async (req, res) => {
  const { key } = req.params
  const { value } = req.body as { value: string }

  // 只读管理员不允许修改配置
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能修改配置' })
    return
  }

  const meta = configMeta.find((m) => m.envKey === key)
  if (!meta) {
    res.status(404).json({ error: `Unknown config key: ${key}` })
    return
  }

  if (!meta.editable) {
    res.status(403).json({ error: `Config key '${key}' is not editable` })
    return
  }

  if (value === undefined || value === null) {
    res.status(400).json({ error: 'Missing value' })
    return
  }

  const stringValue = String(value)
  if (meta.type === 'number' && isNaN(Number(stringValue))) {
    res.status(400).json({ error: `Invalid number value for ${key}` })
    return
  }

  await upsertConfig(key, stringValue, 'user')
  updateConfig(key, stringValue)

  if (key === 'CACHE_MAX_SIZE' || key === 'CACHE_TTL_SECONDS') {
    posterCache.updateConfig(config.cache.maxSize, config.cache.ttlSeconds)
    log.info({ key, cacheMaxSize: config.cache.maxSize, cacheTtlSeconds: config.cache.ttlSeconds }, 'Cache config applied')
  }

  if (key === 'POOL_MAX_PAGES' || key === 'POOL_ACQUIRE_TIMEOUT_MS') {
    const pool = await getPoolInstance()
    if (pool) {
      pool.updateConfig(config.pool.maxPages, config.pool.acquireTimeoutMs)
      log.info({ key, poolMaxPages: config.pool.maxPages, poolAcquireTimeoutMs: config.pool.acquireTimeoutMs }, 'Pool config applied')
    } else {
      log.warn({ key }, 'Pool config updated but pool not yet initialized — will apply on next launch')
    }
  }

  if (key === 'HTTPS_PROXY') {
    log.info({ proxy: value ? '***configured***' : '(none)' }, 'HTTPS_PROXY config updated')
  }

  log.info({ key, value: meta.sensitive ? '***' : stringValue }, 'Config updated')

  // 记录审计日志
  insertAuditLog({
    actorType: 'admin',
    actorId: (req as any).adminId,
    actorName: (req as any).adminUsername,
    action: 'admin_update_config',
    targetType: 'system_config',
    targetId: key,
    targetName: key,
    newValue: { value: meta.sensitive ? '***' : stringValue },
    ipAddress: req.ip,
  })

  res.json({ key, value: meta.sensitive ? maskSensitiveValue(key, stringValue) : stringValue, source: 'user' })
})

// ========== 意见反馈（JWT 鉴权）==========

app.post('/api/feedback', jwtAuthMiddleware, handleCreateFeedback)
app.get('/api/feedback', jwtAuthMiddleware, handleGetMyFeedback)
app.get('/api/feedback/:id', jwtAuthMiddleware, handleGetFeedbackDetail)

// ========== 意见反馈管理（Admin JWT 鉴权）==========

app.get('/api/admin/feedback', adminAuthMiddleware, handleAdminListFeedback)
app.get('/api/admin/feedback/:id', adminAuthMiddleware, handleAdminGetDetail)
app.post('/api/admin/feedback/:id/reply', adminAuthMiddleware, handleAdminReply)
app.put('/api/admin/feedback/:id/status', adminAuthMiddleware, handleAdminUpdateStatus)

// ========== 审计日志 API（Admin JWT）==========

app.get('/api/admin/audit-logs', adminAuthMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const actorType = req.query.actorType as string | undefined
    const actorId = req.query.actorId as string | undefined
    const action = req.query.action as string | undefined
    const targetType = req.query.targetType as string | undefined
    const startDate = req.query.startDate as string | undefined
    const endDate = req.query.endDate as string | undefined

    const result = await queryAuditLogs({
      page, limit, actorType, actorId, action, targetType, startDate, endDate,
    })
    res.json(result)
  } catch (err) {
    log.error({ err }, 'Failed to query audit logs')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '查询审计日志失败' })
  }
})

app.post('/api/admin/audit-logs/clean', adminAuthMiddleware, async (req, res) => {
  if ((req as any).adminRole === 'readonly') {
    res.status(403).json({ error: 'FORBIDDEN', message: '只读管理员不能执行此操作' })
    return
  }
  try {
    const { retentionDays } = req.body as { retentionDays?: number }
    const days = retentionDays ?? config.auditLog.retentionDays

    if (days <= 0) {
      res.status(400).json({ error: 'INVALID_INPUT', message: '保留天数必须大于 0' })
      return
    }

    const deleted = await cleanExpiredAuditLogs(days)

    insertAuditLog({
      actorType: 'admin',
      actorId: (req as any).adminId,
      actorName: (req as any).adminUsername,
      action: 'admin_clean_audit_logs',
      targetType: 'audit_log',
      newValue: { retentionDays: days, deleted },
      ipAddress: req.ip,
    })

    res.json({ message: `已清理 ${deleted} 条过期日志`, deleted, retentionDays: days })
  } catch (err) {
    log.error({ err }, 'Failed to clean audit logs')
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '清理审计日志失败' })
  }
})

// ========== 图片上传（JWT 鉴权）==========

const uploadStorage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: (err: Error | null, dest: string) => void) => {
    const dir = path.join(__dirname, '../uploads/feedback')
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req: any, file: any, cb: (err: Error | null, name: string) => void) => {
    const ext = path.extname(file.originalname) || '.jpg'
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
})

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: any, _file: any, cb: any) => {
    if (!_file.mimetype.startsWith('image/')) {
      cb(new Error('只能上传图片文件'), false)
      return
    }
    cb(null, true)
  },
})

app.post('/api/upload/feedback', jwtAuthMiddleware, (req: Request, res: Response) => {
  upload.array('images', 3)(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'FILE_TOO_LARGE', message: '图片大小不能超过 5MB' })
          return
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'TOO_MANY_FILES', message: '最多上传 3 张图片' })
          return
        }
      }
      res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message || '上传失败' })
      return
    }

    const files = (req as any).files as any[]
    const urls = files.map((f: any) => `/uploads/feedback/${f.filename}`)
    // 记录审计日志
    insertAuditLog({
      actorType: 'user',
      actorId: req.userId!,
      action: 'user_upload_image',
      targetType: 'feedback_image',
      newValue: { fileCount: files.length },
      ipAddress: req.ip,
    })
    res.json({ urls })
  })
})

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'Unhandled error')
  res.status(500).json({ error: 'Internal server error' })
})

async function start(): Promise<void> {
  await getDb()
  // DB 初始化日志由 src/db/index.ts 的 getDb() 内部输出（含 path + new 标记）

  // 为缺少 user_stats 的老用户补充数据
  await initMissingUserStats()

  const defaults = getConfigDefaults()
  await initDefaultConfig(defaults)
  log.info('Default config initialized')

  // 启动时从 DB 恢复用户动态配置（DB 优先于 env）
  const restored = await loadUserConfig()
  if (restored.length > 0) {
    log.info({ restored }, 'Restored user config from database')
  }

  // 初始化管理员账号（首次部署时，默认 admin / admin@123456）
  await initAdminIfNeeded()

  // 恢复服务重启前的 pending 异步解读任务
  recoverPendingTasks().catch((e) => log.error({ err: e }, 'Failed to recover pending tasks'))

  // 审计日志自动清理（仅在开启时启动）
  if (config.auditLog.retentionDays > 0) {
    cleanExpiredAuditLogs(config.auditLog.retentionDays).catch((e) => log.warn({ err: e }, 'Failed to clean audit logs on startup'))
    setInterval(() => {
      cleanExpiredAuditLogs(config.auditLog.retentionDays).catch((e) => log.warn({ err: e }, 'Failed to clean audit logs'))
    }, 24 * 60 * 60 * 1000).unref()
  }

  // 输出配置来源分组（from_env / from_default / from_user）
  {
    const fromEnv: string[] = []
    const fromDefault: string[] = []
    const fromUser: string[] = []
    const restoredSet = new Set(restored)
    for (const meta of configMeta) {
      if (restoredSet.has(meta.envKey)) {
        fromUser.push(meta.envKey)
      } else if (process.env[meta.envKey] && process.env[meta.envKey] !== meta.defaultValue) {
        fromEnv.push(meta.envKey)
      } else {
        fromDefault.push(meta.envKey)
      }
    }
    if (fromEnv.length > 0 || fromDefault.length > 0 || fromUser.length > 0) {
      log.info({
        fromEnv,
        fromDefault,
        fromUser,
      }, 'Configuration source summary')
    }
  }

  app.listen(config.port, '0.0.0.0', () => {
    log.info({
      port: config.port,
      nodeEnv: config.nodeEnv,
      timezone: config.timezone,
      logLevel: process.env.LOG_LEVEL || (config.nodeEnv === 'development' ? 'debug' : 'info'),
      geminiKey: config.geminiApiKey ? '***configured***' : 'NOT SET',
      wechatAppId: config.wechatAppId ? '***configured***' : 'NOT SET',
      wechatSecret: config.wechatSecret ? '***configured***' : 'NOT SET',
      jwtSecret: config.jwtSecret ? '***configured***' : 'NOT SET',
      adminDefaultAccount: config.adminInitUsername ? `${config.adminInitUsername} / ***` : 'NOT SET',
      corsOrigin: config.corsOrigin,
      httpsProxy: config.httpsProxy ? '***configured***' : '(none)',
      restoredUserConfig: restored.length > 0 ? restored : undefined,
      cacheMaxSize: config.cache.maxSize,
      cacheTtlSeconds: config.cache.ttlSeconds,
      poolMaxPages: config.pool.maxPages,
      poolAcquireTimeoutMs: config.pool.acquireTimeoutMs,
      puppeteerPath: config.puppeteer.executablePath || '(system default)',
      puppeteerArgs: config.puppeteer.args,
      logRetentionDays: config.db.retentionDays,
    }, 'Service started')

    // 周期状态日志 — 每 60s 输出一条 metrics snapshot（健康自检）
    const statusInterval = setInterval(async () => {
      try {
        const stats = await getRequestStats()
        log.info({
          totalRequests: stats.totalRequests,
          errorCount: stats.errors,
          errorRate: stats.totalRequests > 0
            ? (stats.errors / stats.totalRequests * 100).toFixed(2) + '%'
            : '0%',
          avgTotalMs: Math.round(stats.avgTotalMs),
          cacheHitRate: (stats.cacheHitRate * 100).toFixed(1) + '%',
        }, 'Periodic status report')
      } catch (err) {
        log.error({ err }, 'Periodic status report failed')
      }
    }, 60000)
    statusInterval.unref()
  })
}

start().catch((err) => {
  log.error({ err }, 'Failed to start server')
  process.exit(1)
})

// ========== 优雅关闭 ==========
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...')
  process.exit(0)
})

export default app
