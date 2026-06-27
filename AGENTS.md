# AGENTS.md — AI 协作指南

> 本文档帮助 AI 编程助手快速理解 `tarot-backend` 项目。
> 修改代码前请先阅读本文档。

## 项目概述

塔罗牌后台统一服务，整合了 AI 解读生成和海报 PNG 生成两个核心功能，并提供统一的请求日志记录。

- **AI 解读**：接收问题 + 牌面 → 调用 Google Gemini API → 返回个性化解读文本
- **海报生成**：接收牌面数据 → 拼装 HTML/CSS → Puppeteer 截图 → 返回 PNG
- **请求日志**：所有请求/响应通过网关中间件写入 SQLite

### 来源项目

| 功能 | 来源 | 原始平台 |
|------|------|---------|
| AI 解读 | `tarot-reading-api` | Cloudflare Worker |
| 海报生成 | `tarot-poster-service` | Node.js Express |

两个原始项目保持**完全不变**，本项目复制并整合了其核心逻辑。

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 语言 | TypeScript（strict: true） |
| 框架 | Express |
| AI | Google Gemini API（REST，非 SDK） |
| 截图 | Puppeteer（Chromium headless） |
| 缓存 | LRU 内存缓存（自实现，Map-based） |
| 数据库 | SQLite（sql.js WASM，零原生编译） |
| 日志 | pino 结构化日志 |
| 指标 | Prometheus 文本格式（自实现） |
| 包管理 | pnpm |
| 部署 | Docker / HuggingFace Spaces |

## 项目结构

```
tarot-backend/
├── src/
│   ├── index.ts                 # Express 入口，注册所有路由和中间件
│   ├── config.ts                # 统一环境变量管理
│   ├── logger.ts                # pino 结构化日志
│   │
│   ├── reading/                 # ★ AI 解读模块（移植自 tarot-reading-api）
│   │   ├── types.ts             # CardInput, ReadingRequestBody, ModelCache
│   │   ├── prompt.ts            # systemPrompt + buildUserPrompt()
│   │   ├── models.ts            # 模型选择、配额追踪、API 调用 + 重试降级
│   │   └── handler.ts           # Express 路由处理器
│   │
│   ├── poster/                  # ◆ 海报模块（复制自 tarot-poster-service，不变）
│   │   ├── types.ts             # PosterData, PosterCardInput, TemplateName
│   │   ├── template.ts          # buildPosterHTML() 模板编排
│   │   ├── render.ts            # Puppeteer 渲染 + 多阶段截图
│   │   ├── engine.ts            # 正则模板引擎（零依赖）
│   │   ├── theme.ts             # 设计令牌：dark / light 双主题
│   │   ├── browser-pool.ts      # Page 连接池（max 4）
│   │   └── templates/           # default / minimal / wechat 三套模板
│   │
│   ├── db/                      # ★ 新增：SQLite 数据库
│   │   ├── index.ts             # 初始化 + 建表
│   │   └── reading-log.ts       # insertLog / queryLogs / getLogById
│   │
│   ├── gateway/                 # ★ 新增：网关中间件
│   │   └── logging.ts           # 请求/响应拦截 → SQLite
│   │
│   ├── middleware/              # ◆ 复制自 poster-service
│   │   ├── cors.ts              # CORS 中间件
│   │   ├── jwt-auth.ts           # JWT 鉴权（用户端）
│   │   ├── admin-auth.ts         # Admin JWT 鉴权（管理端）
│   │   └── rate-limit.ts         # 频率限制
│   │
│   ├── cache/                   # ◆ 复制自 poster-service
│   │   └── index.ts             # LRU 内存缓存（SHA256 键 + TTL）
│   │
│   └── monitor/                 # ◆ 复制自 poster-service
│       ├── index.ts             # 统一导出
│       └── metrics.ts           # Prometheus 指标收集器
│
├── assets/cards/                # ◆ 78 张塔罗牌 SVG 文件
├── Dockerfile                   # ★ 新建
├── Dockerfile.hf                # ★ 新建（HF Spaces 专用）
└── package.json                 # ★ 新建
```

> ★ = 新建  ◆ = 复制（内容不变）

## 核心流程

### /reading — AI 解读

```
POST /reading  { question, cards[] }
  │
  ├── 校验：question 和 cards 不能为空
  ├── 格式化卡片信息 → cardsInfo 字符串
  ├── 组装 systemPrompt + userPrompt
  ├── 获取缓存模型列表（5 分钟 TTL）
  ├── 按优先级遍历模型（跳过今日配额耗尽的）
  │   ├── 调用 Gemini API → generateContent
  │   ├── 成功 → 解析响应，检查 incomplete
  │   └── 失败 → 可重试错误则标记配额耗尽，尝试下一模型
  ├── 写入 SQLite（gateway/logging.ts 中间件自动完成）
  └── 返回 { reading, model, incomplete }
```

### /poster — 海报生成

```
POST /poster  { cards[], question, spreadName, ... }
  │
  ├── authMiddleware（可选）
  ├── 参数校验
  ├── LRU 缓存查询（SHA256 键）
  │   ├── HIT → 返回缓存 PNG
  │   └── MISS → 继续
  ├── buildPosterHTML()
  │   ├── generateCardHTML() × N
  │   ├── extractComprehensivePart()
  │   ├── renderTemplate() → engine.ts 变量注入
  │   └── themeToCSSVars() → CSS 自定义属性
  ├── renderPoster(html, width)
  │   ├── BrowserPool.acquire() → Page
  │   ├── 5 步资源就绪检查
  │   ├── 2x 高清截图
  │   └── 返回 { buffer, timings }
  ├── LRUCache.set(key, buffer)
  └── 返回 PNG + 缓存/耗时响应头
```

### 日志记录

```
请求到达 → loggingMiddleware（gateway/logging.ts）
  ├── 跳过 /health, /metrics, /logs
  ├── 劫持 res.json / res.send 以捕获响应体
  ├── 记录请求信息到 SQLite（异步，不阻塞）
  └── next()
```

## API 契约

### 端点一览

| 方法 | 路径 | 说明 | 鉴权 | 日志 |
|------|------|------|:---:|:---:|
| GET | `/` | 服务信息 | ❌ | ❌ |
| GET | `/health` | 健康检查 | ❌ | ❌ |
| GET | `/metrics` | Prometheus 指标 | ❌ | ❌ |
| POST | `/reading` | AI 塔罗解读 | ❌ | ✅ |
| POST | `/poster` | 海报生成 PNG | ✅ 可选 | ✅ |
| GET | `/logs` | 查询日志 | ❌ | ❌ |
| GET | `/logs/:id` | 日志详情 | ❌ | ❌ |

### POST /reading

请求体：

```typescript
// src/reading/types.ts
interface CardInput {
  position: string
  name: string
  isUpright: boolean
  uprightMeaning: string
  reversedMeaning: string
  keywords: string[]
}

interface ReadingRequestBody {
  question: string
  cards: CardInput[]
}
```

成功响应（200）：

```typescript
{
  reading: string      // AI 生成的解读文本
  model: string        // 实际使用的 Gemini 模型名
  incomplete: boolean  // 是否截断或格式不完整
  warning?: string     // 不完整时的说明
}
```

错误响应：400 / 429 / 500 / 502，统一 JSON 格式 `{ error, detail?, model?, exhaustedModels? }`。

> 解读文本格式要求：每张牌用 `📍 位置：XXX` 开头，最后用 `✨ 综合解读` 做总结。

### POST /poster

请求体详见 `src/poster/types.ts` 中的 `PosterData` 接口。

成功响应：`image/png` 二进制，附加 `X-Cache`、`X-Render-*` 响应头。

错误响应：400 / 401 / 500，JSON `{ error }`。

### GET /logs

查询参数：`page`（默认 1）、`limit`（默认 50，最大 200）、`target`（`reading` / `poster`）。

### GET /health — 健康检查

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `ok` \| `degraded` | 整体健康状态 |
| `worker` | `up` | Worker 进程状态（始终为 up） |
| `gemini` | `up` \| `down` \| `quota_exhausted` \| `unconfigured` | Gemini API 状态 |
| `model` | `string \| null` | 当前选中的 Gemini 模型名（如 `gemini-2.5-flash-lite`），不可用时为 `null` |
| `detail` | `string?` | 错误详情（仅在异常时返回） |
| `exhaustedModels` | `string[]?` | 今日已耗尽配额的模型列表（仅 quota_exhausted 时返回） |
| `cache` | object | 缓存统计（size/maxSize/hitRate） |
| `pool` | object | 浏览器池状态（available/active/waiting/maxPages） |
| `metrics` | object | 请求指标（totalRequests/errors/avgTotalMs） |
| `_noCache` | `true` \| `undefined` | 是否跳过了缓存（仅 `?noCache=1` 时出现） |

**状态说明**：

| gemini 状态 | HTTP 状态码 | 含义 |
|-------------|------------|------|
| `up` | 200 | Gemini API 可用，有可用模型 |
| `quota_exhausted` | 200 | API 可用，但今日所有模型配额已耗尽 |
| `down` | 200 | Gemini API Key 无效、网络不可达或服务不可用 |
| `unconfigured` | 500 | 未配置 `GEMINI_API_KEY` |

**示例响应**（正常）：

```json
{
  "status": "ok",
  "worker": "up",
  "gemini": "up",
  "model": "gemini-2.5-flash-lite",
  "cache": { "size": 5, "maxSize": 100, "hitRate": 0.3 },
  "pool": { "available": 4, "active": 0, "waiting": 0, "maxPages": 4 },
  "metrics": { "totalRequests": 42, "errors": 1, "avgTotalMs": 3120 }
}
```

**示例响应**（配额耗尽）：

```json
{
  "status": "degraded",
  "worker": "up",
  "gemini": "quota_exhausted",
  "model": null,
  "detail": "All models quota exhausted for today",
  "exhaustedModels": ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
  "cache": { "size": 5, "maxSize": 100, "hitRate": 0.3 },
  "pool": { "available": 4, "active": 0, "waiting": 0, "maxPages": 4 },
  "metrics": { "totalRequests": 42, "errors": 1, "avgTotalMs": 3120 }
}
```

> **实现说明**：`gemini` 状态通过调用 `GET /v1beta/models` 验证（不消耗 token），结果缓存 5 分钟。`model` 字段由 `selectBestModel()` 从可用模型列表中动态选出，会跳过配额已耗尽的模型。

### GET /health 缓存机制

`/health` 端点的 Gemini 探测结果按 **apiKey 分桶缓存**（TTL 5 分钟），不同 Key 互不干扰。

**`?noCache=1` 查询参数**：绕过缓存强制重新探测 Gemini API，结果写回缓存以续期 TTL。适用于：
- 运行时修改了 `GEMINI_API_KEY`，需要立即验证新 Key
- 排查 Gemini API 连通性问题
- 强制刷新可用模型列表

响应中会附加 `_noCache: true` 标记本次请求跳过了缓存。

```bash
# 强制刷新缓存（即时诊断）
curl "http://localhost:3000/health?noCache=1"
```

## 环境变量

> 所有变量通过 `src/config.ts` 统一访问，禁止直接读取 `process.env`。

| 变量 | 来源 | 用途 | 默认值 | 必填 |
|------|------|------|--------|:----:|
| `PORT` | 基础服务 | 监听端口 | `3000`（HF: `7860`） | |
| `NODE_ENV` | 基础服务 | 运行环境 | `development` | |
| `TZ` | 基础服务 | 时区 | `Asia/Shanghai` | |
| `LOG_LEVEL` | 基础服务 | 日志级别（trace/debug/info/warn/error/fatal） | `info` | |
| `GEMINI_API_KEY` | AI 解读 | Gemini API 密钥 | — | **✅** |
| `HTTPS_PROXY` | AI 解读 | Gemini API 代理地址（支持 http/https/socks5） | 空（不代理） | |
| `CORS_ORIGIN` | 安全鉴权 | CORS 来源 | `*` | |
| `DB_PATH` | 数据存储 | SQLite 路径 | `./data/tarot.db` | |
| `LOG_RETENTION_DAYS` | 数据存储 | 日志保留天数 | `30` | |
| `PUPPETEER_EXECUTABLE_PATH` | 海报截图 | Chromium 路径 | 自动查找 | |
| `PUPPETEER_ARGS` | 海报截图 | Chromium 启动参数 | `--no-sandbox,...` | |
| `CACHE_MAX_SIZE` | 缓存性能 | 缓存条目上限 | `100` | |
| `CACHE_TTL_SECONDS` | 缓存性能 | 缓存 TTL | `3600` | |
| `POOL_MAX_PAGES` | 海报截图 | Page 池大小 | `4` | |
| `POOL_ACQUIRE_TIMEOUT_MS` | 海报截图 | Page 获取超时 | `30000` | |
| `WECHAT_APPID` | 微信认证 | 微信小程序 AppID | — | ⚠️ ¹ |
| `WECHAT_SECRET` | 微信认证 | 微信小程序 AppSecret（敏感） | — | ⚠️ ¹ |
| `JWT_SECRET` | 管理认证 | JWT 签名密钥（敏感） | — | ⚠️ ¹ |
| `ADMIN_ACCESS_EXPIRES_IN` | 管理认证 | 管理员 Access Token 过期时间 | `2h` | |
| `ADMIN_REFRESH_EXPIRES_IN` | 管理认证 | 管理员 Refresh Token 过期时间 | `30d` | |
| `ADMIN_INIT_USERNAME` | 管理认证 | 初始管理员账号 | `admin` | |
| `ADMIN_INIT_PASSWORD` | 管理认证 | 初始管理员密码（首次登录须修改） | `admin@123456` | |

> ¹ 启用微信小程序登录 / 管理后台时必填，纯 API 调用模式可跳过。
> 过期时间格式（`ms` 库）：`30m`（30分钟）、`2h`（2小时）、`7d`（7天）、`30d`（30天）。

### 生产/开发关键差异

| 维度 | 开发 | Docker 生产 | HF Spaces 生产 |
|------|------|-------------|----------------|
| `NODE_ENV` | `development` | `production` | `production` |
| `PORT` | `3000`（可自定义） | `3000` | **`7860`**（平台固定） |
| 启动方式 | `tsx watch`（热重载） | `node dist/index.js` | `node dist/index.js` |
| `PUPPETEER_EXECUTABLE_PATH` | 不设置 | `/usr/bin/chromium` | `/usr/bin/chromium` |
| 日志 | pino-pretty 美化 | JSON 纯文本 | JSON 纯文本 |

## 数据库

使用 `sql.js`（SQLite WASM 实现），**零原生编译依赖**，可在所有平台上直接安装。

- 数据库文件位置由 `DB_PATH` 指定
- 每次写入后自动保存到磁盘
- 日志记录通过 `gateway/logging.ts` 中间件自动完成
- 支持按 `target`（`reading`/`poster`）过滤查询

### reading_logs 表

```sql
CREATE TABLE reading_logs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  target         TEXT NOT NULL,
  status_code    INTEGER,
  duration_ms    INTEGER,
  ip_address     TEXT,
  question       TEXT,
  cards_json     TEXT,
  reading        TEXT,
  model          TEXT,
  incomplete     INTEGER DEFAULT 0,
  is_error       INTEGER DEFAULT 0,
  error_msg      TEXT
);
```

## 配置持久化

`PUT /api/config/:key` 写入的 `source='user'` 配置会持久化到 `system_config` 表。

### 启动时恢复机制

`start()` 流程在 `initDefaultConfig()` 之后、`app.listen()` 之前调用 `loadUserConfig()`：

1. 遍历 `system_config` 表中所有 `source='user'` 的记录
2. 回写到 `process.env` 和内存 `config` 对象
3. 后续请求（`/health`、`/reading`、`/poster` 等）自然读到恢复后的值

### 优先级规则

**DB user 配置 > 环境变量**（DB 优先）

| 场景 | env | DB user | 启动后 config |
|------|:---:|:---:|------|
| 首次启动，env 已设 Key | `AIza...` | — | env 的值 |
| 首次启动，env 未设 Key | 空 | — | 空（unconfigured） |
| 动态配置 Key 后 | 空 | `AIza...` | user 的值 |
| 重启后 | 空 | `AIza...` | user 的值（从 DB 恢复） |
| 动态清空 Key 后 | 空 | `""` | 空（unconfigured） |

### 适用场景

- 部署时未设置 `GEMINI_API_KEY` 环境变量
- 运行时通过 `PUT /api/config/GEMINI_API_KEY` 动态注入 Key
- 服务重启后无需重新配置，Key 自动恢复

## 编码规范

1. **TypeScript strict 模式** — 所有类型需明确声明，禁止隐式 `any`
2. **ESM 导入必须带 `.js` 扩展名** — 如 `import { config } from './config.js'`
3. **环境变量统一访问** — 通过 `src/config.ts`，不直接读取 `process.env`
4. **部署前必做 `pnpm run build`** — `tsc` 编译通过后才可部署（tsx 不做类型检查）
5. **新增环境变量时同步更新**：
   - `src/config.ts` — 添加读取逻辑
   - `.env.example` — 添加示例值
   - `README.md` — 添加到环境变量表格
   - `AGENTS.md` — 添加到环境变量表格
6. **模型选择逻辑** — Gemini 模型动态选择，按优先级尝试，配额耗尽自动降级：
   - `gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-2.0-flash-lite` → `gemini-2.0-flash` → `gemini-1.5-flash` → `gemini-1.5-pro`
   - 配额缓存每天 UTC 0 点自动重置
7. **海报模块** — 保持与 poster-service 同步，尽量不改动 `src/poster/` 下的文件
8. **Puppeteer 浏览器实例** — 通过连接池复用，监听 `SIGTERM/SIGINT` 优雅关闭
9. **HTML 模板内联所有 CSS** — 不依赖外部样式文件
10. **CORS 头** — 每个响应必须包含 `Access-Control-Allow-Origin`

## 部署

```bash
# 本地开发
pnpm install && pnpm run dev

# Docker 生产
docker build -t tarot-backend .
docker run -p 3000:3000 -e GEMINI_API_KEY=xxx tarot-backend

# HF Spaces
docker build -f Dockerfile.hf -t tarot-backend .
docker run -p 7860:7860 -e GEMINI_API_KEY=xxx tarot-backend
```

## 已知限制

- SQLite 数据存储在本地文件，重启清空（HF Spaces 临时磁盘特性）
- Gemini 免费层有请求频率限制（约 15 RPM/项目）和每日配额限制
- 所有 Gemini 模型配额耗尽后需等次日 UTC 0 点重置
- 海报生成依赖 Chromium（Docker 镜像 ~650MB）
- Cloudflare Workers 免费版有 CPU 时间限制（10ms/请求），但 Gemini API 调用属于 I/O 等待不计入
