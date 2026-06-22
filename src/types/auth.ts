// ========== 认证相关类型定义 ==========

/** JWT payload 结构 */
export interface JwtPayload {
  sub: string      // userId (UUID)
  openid: string    // 微信 openid（邮箱用户为空字符串）
  iat?: number
  exp?: number
}

/** 微信 jscode2session 响应 */
export interface WechatSession {
  openid: string
  session_key: string
  unionid?: string
  errcode?: number
  errmsg?: string
}

/** 用户数据库记录 */
export interface UserRow {
  id: string
  openid: string
  unionid: string | null
  email: string | null
  password_hash: string | null
  phone: string | null
  nickname: string
  avatar_url: string | null
  created_at: string
  last_login_at: string
}

/** 返回给前端的用户信息（脱敏） */
export interface UserInfo {
  id: string
  nickname: string
  avatarUrl: string | null
  email?: string | null
  phone?: string | null      // 脱敏后
  createdAt: string
}

/** 占卜记录 */
export interface ReadingRecord {
  id: string
  user_id: string
  created_at: string
  spread_type: string
  question: string | null
  cards_json: string
  reading: string
  model: string | null
  is_local: number
}

/** 登录/注册响应 */
export interface AuthResponse {
  token: string
  isNewUser?: boolean
  user: UserInfo
}

/** 微信登录请求 */
export interface WechatLoginRequest {
  code: string
}

/** 邮箱注册请求 */
export interface EmailRegisterRequest {
  email: string
  password: string
}

/** 邮箱登录请求 */
export interface EmailLoginRequest {
  email: string
  password: string
}

/** 绑定邮箱请求 */
export interface BindEmailRequest {
  email: string
  password: string
}

/** 绑定手机号请求 */
export interface BindPhoneRequest {
  code: string
}

/** 更新资料请求 */
export interface UpdateProfileRequest {
  nickname?: string
  avatarUrl?: string
}

/** Express Request 扩展 */
declare global {
  namespace Express {
    interface Request {
      userId?: string
      openid?: string
    }
  }
}
