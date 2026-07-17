# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.31.0] - 2026-07-18

### Added

- 统一日志清理调度器（`src/db/cleanup.ts`），替代分散的 setInterval
- `request_logs` 自动清理（`cleanupRequestLogs()`），默认保留 30 天
- `poster_tasks` 旧数据清理（`cleanupPosterTasks()`），已完成/失败/取消的任务自动清理
- `reading_logs` 遗留表清理（`deleteOldLogs()`）
- 持久化指标 API（`GET /api/admin/persistence/stats`），展示数据库大小、各表行数、文件占用
- 持久化历史 API（`GET /api/admin/persistence/history`），记录 DB 大小和各表行数趋势
- 手动清理 API（`POST /api/admin/persistence/clean`），一键清理所有日志表
- DB 大小快照表（`db_size_history`），每小时自动快照
- Prometheus 持久化指标（`db_size_bytes`、`db_table_rows`、`cleanup_rows_deleted_total` 等）

### Fixed

- 修复 `AUDIT_LOG_RETENTION_DAYS` 默认值不一致（configMeta 为 '0'，config 为 90），统一为 90
- 修复 `reading_logs.deleteOldLogs()` 硬编码 `return 0` 的 bug，改为返回实际删除行数

### Changed

- 移除 `index.ts` 中分散的审计日志和客户端事件日志清理 setInterval，改用统一调度器
- `readings` 表不纳入自动清理，永久保留用户解读数据

## [2.30.0] - 2026-07-17

### Added

- 新增登录失败审计日志（`admin_login_failed`、`user_login_failed`）
- 新增越权操作审计日志（`access_denied`）
- 新增JWT鉴权失败审计日志（`auth_failed`）
- 新增admin登出/token刷新审计日志（`admin_logout`、`admin_token_refresh`）
- 新增审计日志CSV导出功能（`GET /api/admin/audit-logs/export`）
- 新增异常行为检测API（`GET /api/admin/audit-logs/anomalies`）
- 新增关键词/IP搜索功能（`keyword`、`ipAddress`查询参数）

### Changed

- saveDb()写合并性能优化，减少高频写入时的I/O竞争
- 添加复合索引优化多条件查询性能
- old_value/new_value大小限制（10KB），防止大型对象撑爆存储
- 审计日志默认保留天数从0改为90天

## [2.29.1] - 2026-07-07

### Fixed

- 修复 admin 解读日志页面无法查看7月1日后记录的问题：`/api/reading-logs` 改为查询 `readings` 新表
- 修复 Dashboard 每日解读量统计7月1日后显示为0的问题：改为查询 `readings` 表
- 修复用户管理列表请求次数/最后请求时间统计不准确的问题：JOIN 表从 `reading_logs` 改为 `request_logs`

## [2.29.0] - 2026-07-07

### Added

- 新增海报异步生成接口（`POST /api/poster/start`、`GET /api/poster/result/:taskId`、`POST /api/poster/cancel/:taskId`）
- 新增 `poster_tasks` 表（异步任务状态持久化）
- 新增 `src/db/poster-task.ts`（海报任务 CRUD 操作）
- 新增 `src/poster/async-handler.ts`（异步任务处理器，支持后台渲染、取消、重启恢复）
- 新增用户删除脚本（`scripts/soft-delete-user.js`、`scripts/hard-delete-user.js`）

## [2.28.0] - 2026-07-06

### Added

- 新增 `POST /api/upload/avatar` 头像上传接口（JWT 鉴权，multer，2MB 限制）
- 更新用户资料时自动清理旧头像文件（仅清理 `/uploads/avatar/` 下的本地文件）

## [2.27.0] - 2026-07-05

### Added

- `client_event_logs` 表新增 `trace_id` 列 + 索引，支持操作链路追踪
- `POST /api/client-events` 接收客户端 `traceId` 字段，写入 `trace_id` 列
- `GET /api/admin/client-events` 新增 `traceId` 查询参数，支持按链路 ID 筛选

## [2.26.0] - 2026-07-05

### Added

- 新增客户端事件日志系统（`client_event_logs` 表 + `src/db/client-event-log.ts`）
- 新增 `POST /api/client-events` 批量接收客户端事件接口（JWT 鉴权，含 body size 64KB 校验）
- 新增 `GET /api/admin/client-events` 管理端查询接口（分页/多维筛选，不暴露 PII）
- 新增客户端事件日志自动清理定时器（与 `request_logs` 共用 `retentionDays`）
- 新增 `menu-client-events` 菜单项（系统监控分组下）

## [2.23.2] - 2026-07-04

### Fixed

- 修复审计日志分类筛选仅前端过滤、未传递到后端的问题：选分类未选操作时后端实际查全量
- `queryAuditLogs` 的 `action` 参数支持 `string | string[]`，数组时使用 SQL `IN (...)` 精确匹配
- `/api/admin/audit-logs` 接口支持 `?action=a,b,c` 逗号分隔或 `?action=a&action=b` 多值形式

## [2.23.1] - 2026-07-04

### Fixed

- 补充缺失的审计日志埋点：解读积分奖励（`points_earn`）、用户升级（`level_up`）、每日额度重置（`quota_daily_reset`）
- 签到审计日志补充 `actorName` 字段（连续签到天数）

## [2.23.0] - 2026-07-04

### Added

- 重建审计日志系统后端模块（`src/db/audit.ts`）：支持插入、分页查询、过期清理
- 新增 `audit_logs` 数据库表及 4 个索引（created_at / actor / action / target）
- 新增 `AUDIT_LOG_RETENTION_DAYS` 环境变量配置（默认 0 = 不自动清理）
- 新增 `GET /api/admin/audit-logs` 审计日志查询接口（adminAuthMiddleware）
- 新增 `POST /api/admin/audit-logs/clean` 审计日志手动清理接口
- 新增自动清理定时器（每日执行，仅在 retentionDays > 0 时启动）
- 用户操作审计埋点：签到、任务领取、额度消耗、登录/注册、邮箱/手机绑定、邀请码绑定
- 管理员操作审计埋点：调整积分、重置额度、清除邀请、删除/恢复用户、配置变更、等级/任务定义更新、管理员 CRUD、重置密码、登录

## [2.22.1] - 2026-07-04

### Fixed

- 修复 CORS 预检响应 `Access-Control-Allow-Methods` 未包含 `PATCH` 方法，导致 H5 端 `PATCH /api/user/records/:id` 请求被浏览器拦截

## [2.21.0] - 2026-07-03

### Added

- 新增 `src/reading/async-handler.ts`：异步解读接口实现
  - `startReadingHandler`：提交任务立即返回 taskId，后台异步生成解读
  - `getReadingResultHandler`：轮询任务结果（pending/completed/failed）
  - `processTask`：异步处理 Gemini 调用，成功标记完成，失败退还额度
  - `recoverPendingTasks`：服务重启时扫描并恢复 pending 任务
- 新增 `src/db/user-stats.ts` 中 `refundQuota` 函数（异常时退还已扣额度）
- 新增 `POST /api/reading/start` 和 `GET /api/reading/result/:taskId` 异步路由
- 新增 `tests/reading/async-handler.test.ts`：8 条处理器单元测试
- 追加 `tests/db/user-stats.test.ts`：4 条 refundQuota 测试

### Changed

- `quotaMiddleware`：异步路由 `/api/reading/start` 立即消费额度，不等待 finish 回调

## [2.20.0] - 2026-07-03

### Added

- 新增 `src/db/reading-task.ts`：`readings` 表专用 CRUD（createReadingTask / getReadingTask / completeReadingTask / failReadingTask / getAsyncTaskStats）
- 新增 `readings` 表建表语句及索引，合并 `reading_logs` + `reading_records` 为单一业务表
- 新增 `src/db/migrations/001-merge-readings.sql`：数据迁移脚本
- 新增 `tests/db/reading-task.test.ts`：16 条 CRUD 单元测试

### Changed

- `gateway/logging.ts`：移除 `insertReadingLog` 分支，解读日志不再写入 `reading_logs` 表（业务字段由 `readings` 承载，监控字段由 `request_logs` 覆盖）
- `tests/test-helpers.ts`：`initTestSchema` 新增 `request_logs` / `readings` 建表语句

## [2.19.2] - 2026-07-02

### Fixed

- 修复 `insertReadingLog` 缺少 NOT NULL 列 `method`/`path`/`target` 导致 SQLite 约束冲突，解读日志无法写入

## [2.19.1] - 2026-07-02

### Fixed

- 修复 `queryRequestLogs` 中 `countSql` 缺少表别名 `l` 导致 `no such column` 错误

## [2.19.0] - 2026-07-02

### Added

- 请求日志查询 API 支持 `status` 参数，按 2xx/4xx/5xx 范围筛选

## [2.18.1] - 2026-07-02

### Changed

- `gateway/logging.ts` 新增 `resolveTarget()` 函数，按路径匹配细化 target 字段
- target 值从 `reading`/`poster`/`other` 细化为：`reading`/`poster`/`auth`/`user`/`admin`/`other`

## [2.18.0] - 2026-07-02

### Added

- 新建 `request_logs` 表，记录所有请求的访问日志（含分阶段耗时、缓存命中等）
- 新建 `src/db/request-log.ts`，提供请求日志 CRUD 和统计函数
- 新增 `GET /api/reading-logs` 和 `GET /api/reading-logs/:id` 端点，查询解读日志

### Changed

- `GET /api/logs` 改为查询 `request_logs` 表（原 `reading_logs`）
- `gateway/logging.ts` 重构：所有请求写入 `request_logs`，仅 `reading` 请求同时写入 `reading_logs`

## [2.16.3] - 2026-07-01

### Fixed

- 修复每日任务进度推进逻辑，`advanceTaskProgress` 现在会先重置过期任务再推进进度，解决用户登录后未查看任务列表直接做任务时进度被清零的问题

## [2.16.2] - 2026-07-01

### Added

- 新增 `POST /api/poster/key` 端点，返回 JSON 格式 cacheKey，解决小程序正式版 arraybuffer 响应头不可用问题

### Fixed

- CORS 中间件补上 `Access-Control-Expose-Headers`，暴露海报生成相关自定义 header

## [2.16.1] - 2026-06-30

### Added

- 启用 `WECHAT_APPID`、`WECHAT_SECRET`、`JWT_SECRET` 的动态配置，支持通过管理后台运行时更新

### Fixed

- 修复每日任务重置时未重置 `reward_claimed` 字段导致次日仍显示"已领取"的问题

## [2.15.1] - 2026-06-29

### Fixed

- 修复旧用户访问任务中心无任务的问题（任务系统上线前注册的用户不会自动初始化任务）

## [2.15.0] - 2026-06-29

### Added

- 新增 `PATCH /api/user/records/:id` 接口，支持更新占卜记录的解读文本
- 新增 `updateRecordInterpretation` 数据库函数

## [2.14.0] - 2026-06-29

### Added

- 占卜记录数据库表 `reading_records` 新增 `interpretation` 字段，支持保存解读文本
- `POST /api/user/records` 接口支持传入 `interpretation` 参数

## [2.13.1] - 2026-06-28

### Fixed

- 修复 Docker 构建时 Corepack 下载 pnpm 因 Node.js undici bug 失败的问题（预装 pnpm 绕过下载）

## [2.13.0] - 2026-06-27

### Added

- 新增用户统计 API：`GET /api/user/stats`（等级/积分/额度信息）
- 新增等级配置公开 API：`GET /api/levels`
- `GET /api/user/profile` 集成等级、积分、额度信息

### Changed

- 精简 `rate-limit.ts`：移除日额度逻辑（由 `quotaMiddleware` 统一管理）

### Docs

- 新增 Vitest 测试框架（76 个单元测试），覆盖 DB 层、中间件、Auth handler 三大层面
- 测试文件：`tests/db/`, `tests/middleware/`, `tests/auth/`
- 运行方式：`pnpm test`（~1.4s 单次运行，零外部依赖）

## [2.12.0] - 2026-06-27

### Added

- 新增邀请系统：注册时可传入 `referralCode`，首次占卜后自动标记邀请完成
- 新增邀请 API：`GET /api/invite/code`、`GET /api/invite/records`
- 邀请完成后自动推进 `invite_count` 类型任务进度

## [2.11.0] - 2026-06-27

### Added

- 新增任务系统：8 个内置任务（3 个每日任务 + 5 个成就任务）
- 任务进度自动推进：占卜后更新 `read_count`，签到后更新 `checkin_streak`
- 新增任务 API：`GET /api/tasks`（任务列表+进度）、`POST /api/tasks/:id/claim`（领取奖励）
- 新用户注册时自动初始化所有活跃任务

## [2.10.0] - 2026-06-27

### Added

- 新增签到 API：`POST /api/checkin`（每日打卡，连续签到奖励 +2/天，上限 +20）
- 新增签到状态 API：`GET /api/checkin/status`

## [2.9.0] - 2026-06-27

### Added

- 新增 `quotaMiddleware`：统一额度控制，可选解析 JWT，登录用户读 DB 额度，游客基于 IP 每天 2 次
- 占卜成功后自动消耗额度、递增占卜计数、增加 2 积分
- `POST /api/poster` 和 `GET /api/poster/:cacheKey` 移除 JWT 鉴权，海报分享公开访问

## [2.8.0] - 2026-06-27

### Added

- 新增积分等级体系相关数据库表：user_stats, level_definitions, checkin_records, invite_records, task_definitions, user_tasks
- 新增 `createUserStats`：注册时自动创建用户统计行并生成邀请码
- 新增注册时可选传入 `referralCode` 参数支持邀请关系绑定

## [2.7.2] - 2026-06-27

### Fixed

- 修复 mergeAccount 邮箱合并时 UNIQUE 约束冲突（先软删再转移 email）

## [2.7.1] - 2026-06-27

### Fixed

- 修复 queryUsers 排序 COALESCE 中 last_request_at 别名误加 `u.` 前缀导致 SQL 错误

## [2.7.0] - 2026-06-27

### Added

- mergeAccount 改为软删除，源用户保留 email 供日后恢复
- 新增 unbindEmail: 解除邮箱绑定并自动恢复被合并的原邮箱用户
- 新增 softDeleteUser / restoreUser: 逻辑删除与恢复用户
- queryUsers 增加 deleted 参数，支持查询已删除用户
- 邮箱唯一索引增加 deleted_at IS NULL 条件，允许已删除用户保留邮箱

### Fixed

- 修复排序: COALESCE(last_request_at, last_login_at, created_at) DESC，微信用户不再沉底

## [2.6.0] - 2026-06-27

### Added

- 用户资料支持性别（gender）和生日（birthday）字段，可在小程序个人资料页编辑
- 数据库 `users` 表新增 `gender` 和 `birthday` 列，含自动迁移兼容

## [2.4.1] - 2026-06-26

### Fixed

- POST `/api/poster` 响应添加 `X-Cache-Key` header，新增 `GET /api/poster/:cacheKey` 缓存下载路由，供小程序通过 `uni.downloadFile` 获取真实文件系统路径

## [2.5.0] - 2026-06-26

### Added

- 新增 `HTTPS_PROXY` 配置项，支持通过 admin 面板热配置 Gemini API 代理地址（`undici.ProxyAgent`），解决中国大陆网络环境下 Google API 不可达问题；未配置时直连无额外开销
- 新增 `src/fetch-proxy.ts` 代理感知 fetch 包装器，支持运行时动态切换代理地址，旧代理连接自动释放

## [2.4.0] - 2026-06-26

### Added

- 管理员双 Token 自动刷新认证：登录返回 accessToken（默认 2h）+ refreshToken（默认 30d），Access Token 过期后前端自动用 Refresh Token 刷新，用户无感知
- 新增 POST /admin/auth/refresh 刷新端点，支持 refresh token rotation（每次刷新同时更换 refresh token）
- 新增 ADMIN_ACCESS_EXPIRES_IN（默认 2h）和 ADMIN_REFRESH_EXPIRES_IN（默认 30d）可配置项，支持通过管理面板动态修改
- 前端 401 拦截器：自动检测 TOKEN_EXPIRED 响应，触发 token 刷新并重试原请求，支持并发安全

### Changed

- 管理员 JWT 中间件验证 tokenType: access，业务接口只接受 access token
- 登录接口返回字段从 token 改为 accessToken + refreshToken
- 移除旧 ADMIN_JWT_EXPIRES_IN 配置项，替换为 ADMIN_ACCESS_EXPIRES_IN + ADMIN_REFRESH_EXPIRES_IN

## [2.3.4] - 2026-06-26

### Fixed

- 修复 Puppeteer 海报渲染 `Runtime.callFunctionOn timed out` 超时问题：`protocolTimeout` 从硬编码 30s 改为可配置环境变量 `PUPPETEER_PROTOCOL_TIMEOUT`（默认 60s），支持运行时动态调整
- `img.decode()` 添加 5s 超时保护，避免 headless Chromium 下 SVG data URI 解码永久 hang

### Added

- `page.evaluate()` 内添加 `[timing]` 逐阶段 `console.log` 计时（`img-count`、`img-wait`、`decode`、`fonts`），自动被诊断日志收集，精确定位渲染卡点
- `insertLog` 增加成功/失败诊断日志（`insertLog OK` / `insertLog FAILED`），排查 reading 日志未入库问题
- 新增 `PUPPETEER_PROTOCOL_TIMEOUT` 配置项，可通过环境变量或 `PUT /api/config/PUPPETEER_PROTOCOL_TIMEOUT` 动态调整

## [2.3.3] - 2026-06-25

### Fixed

- 修复 `jwt.sign` 类型错误：`expiresIn` 参数使用 `StringValue` 品牌类型替代裸 `string`，解决 `@types/jsonwebtoken` v9 的 TS2769 编译报错

## [2.3.2] - 2026-06-25

### Fixed

- 修复 Puppeteer 渲染超时（`Runtime.callFunctionOn timed out`）：去掉 CSS 中 `file://` 字体路径，避免 sandbox 策略拦截导致 `document.fonts.ready` 永不 resolve
- Puppeteer 启动参数新增 `--allow-file-access-from-files` 和 `--disable-web-security`，兜底允许本地资源加载
- `protocolTimeout` 显设置为 30s，避免 CDP 调用卡住 180s 才报错
- `renderPoster` 失败日志增加 `isProtocolTimeout` 标记和诊断提示，方便排障

## [2.3.1] - 2026-06-24

### Fixed

- 修复 `PUT /api/config/:key` 只读管理员（`readonly` 角色）可通过 API 直接修改配置的安全漏洞，增加角色校验返回 403

## [2.3.0] - 2026-06-24

### Added

- 管理员 CRUD 接口：`GET /api/admin/admins`（列表）、`POST /api/admin/admins`（创建）、`PUT /api/admin/admins/:id`（编辑）、`DELETE /api/admin/admins/:id`（软删除）、`POST /api/admin/admins/:id/reset-password`（重置密码）
- 所有管理员管理路由均需 `role=admin` 校验，禁止超管删除/禁用自身账号
- `db/admin.ts` 新增 `listAdmins` / `updateAdmin` / `deleteAdmin` / `resetAdminPassword` 函数
- 管理员列表支持分页和按用户名/显示名模糊搜索

## [2.2.1] - 2026-06-24

### Fixed

- 修复 createAdmin SQL 参数绑定数组缺少 `now` 导致 `admins.must_change_password` NOT NULL 约束失败的问题

## [2.2.0] - 2026-06-24

### Added

- 默认管理员账号：首次启动时自动创建 `admin` 账号（默认密码 `admin@123456`），无需手动设置环境变量即可登录
- 强制改密流程：默认管理员账号首次登录必须修改密码，服务端 `must_change_password` 标记 + 密码强度校验（≥8 位 + 字母 + 数字）
- 改密接口：`POST /admin/auth/change-password`（Admin JWT 鉴权），校验旧密码后更新为新密码（bcrypt 哈希），同步清除 `must_change_password` 标记
- `/admin/auth/me` 接口增强：从数据库查询真实管理员信息，新增 `mustChangePassword` 字段
- `/admin/auth/login` 响应新增 `mustChangePassword` 字段，前端可根据该标记决定是否跳转改密页
- 启动日志新增 `adminDefaultAccount` 字段，可见当前默认管理员账号

### Changed

- Admin 鉴权从兼容模式（api_key / jwt / dual）全面迁移到纯 JWT：所有受保护路由统一使用 `adminAuthMiddleware`
- `/admin/auth/me` 响应不再依赖 token payload，改为查询 `admins` 表获取实时数据

### Removed

- 完全移除 API Key 兼容：删除 `middleware/auth.ts`（API Key 认证）和 `middleware/admin-compat.ts`（兼容中间件）
- 删除 `configMeta` 中 `API_KEY` 和 `ADMIN_AUTH_MODE` 配置项，`updateConfig` 移除对应分支

## [2.1.0] - 2026-06-24

### Added

- Admin JWT 登录体系：新增 `admins` 表（管理员独立账号、bcrypt 密码、支持 admin/readonly 角色）
- 认证接口：`POST /admin/auth/login`（登录，失败限流 5次/min）、`POST /admin/auth/logout`、`GET /admin/auth/me`
- `adminAuthMiddleware`（JWT 鉴权，验证 type=admin）与 `adminCompatMiddleware`（支持 api_key / jwt / dual 三种模式）
- 首次启动时通过 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` 环境变量自动创建初始管理员
- 可配置项：`ADMIN_AUTH_MODE`（api_key | jwt | dual）、`ADMIN_ACCESS_EXPIRES_IN`（默认 2h）、`ADMIN_REFRESH_EXPIRES_IN`（默认 30d）

### Changed

- Admin 受保护路由（`/api/logs`、`/api/admin/users`、`/api/config`）从 `authMiddleware` 迁移到 `adminCompatMiddleware`，过渡期默认 dual 模式兼容旧 API Key

## [2.0.1] - 2026-06-24

### Fixed

- 修复 `loggingMiddleware` 在 `/api` 路由前缀改造后未同步更新路径匹配，导致 `/api/reading`、`/api/poster` 误判为 `target='other'` 而跳过数据库写入（`reading_logs` 表无任何记录）。同步更新 `SKIP_PATHS` 跳过列表。

## [2.0.0] - 2026-06-24

### Changed

- **BREAKING**: 所有 API 路由统一加 `/api` 前缀：
  - `/cards` → `/api/cards`
  - `/health` → `/api/health`
  - `/metrics` → `/api/metrics`
  - `/reading` → `/api/reading`
  - `/poster` → `/api/poster`
  - `/logs` → `/api/logs`, `/logs/:id` → `/api/logs/:id`
  - `/auth/*` → `/api/auth/*`
  - `/user/*` → `/api/user/*`

## [1.12.0] - 2026-06-24

### Added

- Admin 端用户管理接口 `GET /api/admin/users`，支持分页、昵称/邮箱模糊搜索、请求统计

## [1.11.2] - 2026-06-24

### Fixed

- 修复模型降级链选中 `gemini-2.5-flash-preview-tts`（仅支持 AUDIO 模态）导致解读请求返回 400 `INVALID_ARGUMENT` 的问题
- 新增 `isTextGenerationModel` 黑名单过滤，排除 TTS / 图像生成 / 嵌入等非文本生成模型
- `isRetryableError` 增加对 400 + `INVALID_ARGUMENT` / `response_modalities` 错误的识别，避免反复回退到不支持的模型

## [1.11.1] - 2026-06-24

### Fixed

- 修复 `reading-log.ts` 中 `LogQueryResult` 接口重复声明导致 esbuild 编译失败

## [1.11.0] - 2026-06-24

### Added

- reading_logs 表新增 `user_id` 字段，配合已有 `openid` 实现双维度用户关联
- loggingMiddleware 从 `req.userId` 提取用户标识并写入日志数据库
- readingHandler、poster handler 的请求日志附加 `userId`，支持按用户追溯请求

## [1.9.0] - 2026-06-21

### Added

- 海报生成支持无问题模式：`question` 字段改为可选，不传时海报不显示问题区域

## [1.8.0] - 2026-06-21

### Added

- `/reading` 接口 `question` 参数改为可选，支持不传问题直接进行通用卡牌解读
- 提示词根据是否有问题动态调整：有问题时进行个性化解读，无问题时进行通用牌面解读

## [1.7.1] - 2026-06-21

### Fixed

- 消除 `start()` 中冗余的 DB 初始化日志（DB 模块内部已输出 path + new 标记）

## [1.7.0] - 2026-06-21

### Added

- **请求 ID 透传**：`reading` 和 `poster` handler 使用 `log.child({ logId })` 串联下游日志，可通过 logId 追踪完整请求链路
- **周期状态日志**：每 60 秒输出一条 metrics snapshot（请求量、错误率、平均耗时、缓存命中率），实现无额外工具的轻量健康自检
- **配置热更新通知**：通过 API 更新 cache/pool 配置后，输出已生效的详细参数；pool 未初始化时输出 warn 提示

## [1.6.0] - 2026-06-21

### Added

- **优雅关闭日志**：SIGTERM/SIGINT 监听输出 `log.info`，便于运维排查服务生命周期
- **DB 模块日志**：`getDb()` 成功后输出数据库路径和是否新建标记，区分首次初始化与重启加载
- **配置来源分组日志**：启动时按 `from_env` / `from_default` / `from_user` 分组输出所有配置项来源
- **Puppeteer 启动详情日志**：浏览器 launch 成功后输出 `executablePath`、`args`、`launchMs`
- **Gemini 健康探测日志**：`fetchAvailableModels` 成功/失败时分别输出 `log.info`（模型数量）和 `log.warn`

### Changed

- 启动摘要中 `dbPath` 不再重复输出（由 DB 模块日志单独报告），新增 `restoredUserConfig` 字段
- 启动摘要日志消息从 `'Startup configuration summary'` 改为 `'Service started'`

## [1.5.0] - 2026-06-21

### Added

- **访问日志**：每个 HTTP 请求结束时输出结构化日志，含 method/path/status/duration/ip/logId
- **业务失败日志**：`/reading` handler 在 Gemini 调用失败、参数校验失败、未处理异常时输出 warn/error 日志
- **Gemini 模型切换日志**：每次模型重试时输出 model/status/retryable，配额标记和全部耗尽时输出 error 日志
- **缓存命中日志**：poster handler 在缓存 HIT 时输出 debug 日志、MISS 时输出 info 日志（含各阶段渲染耗时）
- **启动横幅增强**：`start()` 输出完整配置摘要（端口、环境、时区、API Key 状态、缓存、连接池、Puppeteer 参数等），运维可一眼看清运行状态

## [1.4.1] - 2026-06-21

### Fixed

- 服务重启后丢失通过 `PUT /api/config/:key` 动态配置的配置项
- 启动流程新增 `loadUserConfig()`，从数据库恢复 `source='user'` 的配置（DB 优先于环境变量）

## [1.4.0] - 2026-06-21

### Added

- `/health` 端点支持 `?noCache=1` 查询参数，绕过 Gemini 探测缓存，立即验证 API Key 连通性
- Gemini 模型缓存按 `apiKey` 分桶存储（`Map<string, ModelCache>`），不同 Key 互不干扰
- 新增 `getGeminiHealthDirectly()` 导出函数，强制重新探测并写回缓存
- `/health` 响应体新增 `_noCache` 标记，仅在绕过缓存时返回 `true`

## [1.3.0] - 2026-06-21

### Changed

- `/health` 端点升级为分层健康检查：实际调用 Gemini API（`GET /v1beta/models`）验证可用性，新增 `model` 字段返回当前选中的 Gemini 模型名
- `gemini` 字段从二值（`up`/`unconfigured`）扩展为四值（`up`/`down`/`quota_exhausted`/`unconfigured`），更准确反映大模型真实状态
- 当 API Key 未配置时返回 HTTP 500，便于负载均衡器识别异常实例

## [1.1.3] - 2026-06-18

### Fixed

- 重构日志中间件：移除 `res.on('finish')` 和 `req.on('close')` 事件监听器，改为在 `res.json()` / `res.send()` 中直接记录日志，彻底解决事件竞态导致 reading/model 为 null 的问题

## [1.1.2] - 2026-06-18

### Fixed

- `pnpm-workspace.yaml` 使用 `onlyBuiltDependencies` 替代占位符 `allowBuilds`，放行 `esbuild` 和 `puppeteer` 的 build scripts，修复 Docker 构建中 `ERR_PNPM_IGNORED_BUILDS` 错误

## [1.1.1] - 2026-06-18

### Fixed

- 升级 Node.js 基础镜像 `node:20-slim` → `node:22-slim`，修复 pnpm v11 对 Node.js ≥ 22.13 的兼容性要求
- CI 中 `node-version` 同步升级至 22

## [1.1.0] - 2026-06-18

### Added

- CI 工作流（`ci.yml`）：自动 typecheck + build 验证
- HF Spaces 部署工作流（`deploy-hf.yml`）：自动推送代码并设置 GEMINI_API_KEY Secret
- 部署脚本三件套：`scripts/deploy-hf.sh`（bash）、`.ps1`（PowerShell）、`.bat`（批处理）
- `scripts/entrypoint.sh`：容器入口脚本，启动时打印服务信息并检查 Gemini/Chromium 状态
- `README.hf.md`：HF Spaces 首页，包含 API 参考和环境变量声明
- `.env.hf.example`：HF 部署配置模板

### Changed

- `Dockerfile.hf`：改用 ENTRYPOINT 模式（`/entrypoint.sh` + `CMD`），与 poster-service 对齐
- `README.hf.md`：front matter 添加 `env` 段声明 GEMINI_API_KEY 和 API_KEY

## [1.0.1] - 2026-06-18

### Fixed

- 修复 `insertLog` 未调用 `saveDb()` 导致日志写入仅存内存、重启丢失的问题
- 替换日志中间件中 `.catch(() => {})` 为 pino 结构化错误日志，避免静默吞掉异常
- 添加 Express 全局错误处理中间件，兜底未捕获异常
- 修复所有模型失败时错误响应体缺少 `status` 字段的问题（与 reading-api 对齐）

## [1.0.0] - 2026-06-18

### Added

#### AI 解读功能（移植自 `tarot-reading-api`）
- 塔罗牌 AI 个性化解读生成，基于 Google Gemini API
- 动态模型选择与自动降级机制（6 级优先级 + 配额追踪）
- 支持多模型重试：429/403 配额耗尽 → 自动切换下一模型
- 解读完整性检测（MAX_TOKENS 截断检查 + 综合解读部分检查）

#### 海报生成功能（移植自 `tarot-poster-service`）
- 三套海报模板：default（暗黑）、minimal（简约）、wechat（朋友圈）
- 双主题系统：dark / light，通过 CSS 变量实现
- Puppeteer 无头 Chromium 截图，2x 高清输出
- 浏览器 Page 连接池（最大 4），自动健康检查和重连
- LRU 内存缓存（SHA256 键 + 可配置 TTL 和容量）
- 渲染耗时统计（P50/P95/P99）和 Prometheus 指标导出
- 78 张塔罗牌 SVG 资源

#### 请求日志记录（新增）
- SQLite 数据库存储，使用 sql.js（零原生编译依赖）
- 网关中间件自动拦截所有请求/响应
- /reading 请求：记录问题、牌面、回复、模型、耗时
- /poster 请求：记录请求元数据和响应状态（不存储 PNG 二进制）
- 分页日志查询接口（GET /logs, GET /logs/:id）

#### 基础设施
- Express + TypeScript 项目骨架
- pino 结构化日志（开发环境美化，生产环境 JSON）
- CORS 中间件（可配置来源）
- Bearer Token 鉴权中间件（可选）
- 多阶段 Dockerfile / HF Spaces Dockerfile
- `GEMINI_API_KEY` 集中配置

### Fixed

- 修复客户端超时断开导致日志丢失的问题：logging 中间件增加 `req.on('close')` 兜底监听，客户端提前断开时写入状态码 499 的错误日志记录
