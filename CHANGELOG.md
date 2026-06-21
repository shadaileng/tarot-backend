# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
