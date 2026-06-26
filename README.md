# tarot-backend

塔罗牌后台统一服务 — AI 解读生成 + 海报 PNG 生成 + SQLite 请求日志记录

整合自两个独立服务：
- `tarot-reading-api`（Cloudflare Worker → AI 解读）
- `tarot-poster-service`（Node.js Express + Puppeteer → 海报截图）

## 快速开始

### 本地开发

```bash
# 安装依赖
pnpm install

# 复制环境变量
cp .env.example .env
# 编辑 .env，填入 GEMINI_API_KEY

# 启动开发服务器（tsx watch 热重载）
pnpm run dev
```

服务默认监听 `http://localhost:3000`。

### 生产构建

```bash
pnpm run build     # tsc 编译 + 复制模板文件
pnpm start         # node dist/index.js
```

## API 端点

| 方法 | 路径 | 说明 | 鉴权 | 日志 |
|------|------|------|:---:|:---:|
| `GET` | `/` | 服务信息 | ❌ | ❌ |
| `GET` | `/health` | 健康检查（Gemini + Chromium） | ❌ | ❌ |
| `GET` | `/metrics` | Prometheus 格式指标 | ❌ | ❌ |
| `POST` | `/reading` | **AI 塔罗解读** | ❌ | ✅ 全文 |
| `POST` | `/poster` | **海报生成 PNG** | ✅ 可选 | ✅ 请求元数据 |
| `GET` | `/logs` | 查询解读日志（分页） | ❌ | ❌ |
| `GET` | `/logs/:id` | 单条日志详情 | ❌ | ❌ |

---

### POST /reading — AI 塔罗解读

请求体：

```typescript
{
  "question": string,     // 用户问题（必填）
  "cards": [{             // 牌数组（必填，至少1张）
    "position": string,         // 牌阵位置，如"过去""现在""未来"
    "name": string,             // 牌名，如"愚者""女皇"
    "isUpright": boolean,       // true=正位, false=逆位
    "uprightMeaning": string,   // 正位含义
    "reversedMeaning": string,  // 逆位含义
    "keywords": string[]        // 关键词
  }]
}
```

请求示例：

```bash
curl -X POST http://localhost:3000/reading \
  -H "Content-Type: application/json" \
  -d '{
    "question": "我最近的工作发展如何？",
    "cards": [
      {
        "position": "过去",
        "name": "愚者",
        "isUpright": true,
        "uprightMeaning": "新的开始、冒险、天真",
        "reversedMeaning": "鲁莽、轻率、停滞",
        "keywords": ["开始", "冒险", "天真"]
      },
      {
        "position": "现在",
        "name": "女皇",
        "isUpright": true,
        "uprightMeaning": "丰收、滋养、创造力",
        "reversedMeaning": "依赖、空虚、创作枯竭",
        "keywords": ["丰收", "滋养", "创造力"]
      },
      {
        "position": "未来",
        "name": "星星",
        "isUpright": false,
        "uprightMeaning": "希望、灵感、平静",
        "reversedMeaning": "绝望、迷茫、失去方向",
        "keywords": ["希望", "灵感", "平静"]
      }
    ]
  }'
```

成功响应（200）：

```json
{
  "reading": "📍 位置：过去 - 愚者...\n\n📍 位置：现在 - 女皇...\n\n📍 位置：未来 - 星星...\n\n✨ 综合解读...",
  "model": "gemini-2.5-flash-lite",
  "incomplete": false
}
```

错误响应：

| 状态码 | 说明 |
|:------:|------|
| 400 | 缺少必要字段 question 或 cards |
| 429 | 所有 Gemini 模型今日配额已耗尽 |
| 500 | GEMINI_API_KEY 未配置 |
| 502 | Gemini API 不可用或所有模型调用失败 |

---

### POST /poster — 海报生成

请求体：

```typescript
{
  "cards": [{           // 牌数组（必填）
    "name": string,               // 牌名
    "image": string,              // 卡牌图片 URL
    "position": string,           // 牌阵位置
    "orientation": "upright" | "reversed",
    "meaning": string,            // 含义文本
    "keywords": string[],         // 关键词
    "type": "major" | "minor" | "court",
    "number": number              // 大牌序号
  }],
  "question": string,                             // 占卜问题
  "spreadName": string,                           // 牌阵名称
  "date": string,                                 // 日期
  "interpretation"?: string,                      // 完整解读文本
  "comprehensiveInterpretation"?: string,          // 综合解读（优先）
  "theme"?: "dark" | "light",                     // 主题，默认按模板
  "template"?: "default" | "minimal" | "wechat"   // 模板，默认 default
}
```

成功响应：`image/png`（二进制图片）

响应头：
- `X-Cache: HIT` | `MISS`
- `Cache-Control: public, max-age=3600`
- `X-Render-Template-Ms`、`X-Render-Resource-Ms`、`X-Render-Screenshot-Ms`、`X-Render-Total-Ms`

---

### GET /logs — 日志查询

```bash
# 查询最近 20 条解读记录
curl "http://localhost:3000/logs?target=reading&limit=20&page=1"

# 查询最近 10 条海报记录
curl "http://localhost:3000/logs?target=poster&limit=10"

# 查看单条详情
curl "http://localhost:3000/logs/<log-id>"
```

响应格式：

```json
{
  "total": 42,
  "page": 1,
  "limit": 20,
  "data": [
    {
      "id": "uuid",
      "created_at": "2026-06-18T12:00:00.000Z",
      "method": "POST",
      "path": "/reading",
      "target": "reading",
      "status_code": 200,
      "duration_ms": 3450,
      "question": "我最近的工作发展如何？",
      "cards_json": "[{\"position\":\"过去\",\"name\":\"愚者\",...}]",
      "reading": "📍 位置：过去 - 愚者...",
      "model": "gemini-2.5-flash-lite",
      "incomplete": 0,
      "is_error": 0,
      "error_msg": null
    }
  ]
}
```

查询参数：

| 参数 | 默认 | 说明 |
|------|:---:|------|
| `page` | 1 | 页码 |
| `limit` | 50 | 每页条数（最大 200） |
| `target` | 全部 | 过滤：`reading` 或 `poster` |

---

### GET /health — 健康检查

返回 Worker、Gemini API、缓存、浏览器池、请求指标的综合健康状态。

支持 `?noCache=1` 查询参数绕过 Gemini 探测缓存（适用于切换 API Key 后即时验证）。

**正常响应**（HTTP 200）：

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

**Gemini 状态说明**：

- `up` — Gemini API 可用，返回当前选中的模型名
- `quota_exhausted` — 所有模型今日配额已耗尽（HTTP 200，`exhaustedModels` 列出已耗尽模型）
- `down` — API Key 无效或网络不可达（HTTP 200，`detail` 说明原因）
- `unconfigured` — 未配置 `GEMINI_API_KEY`（HTTP 500）

**示例**：

```bash
curl http://localhost:3000/health

# 切换 GEMINI_API_KEY 后强制刷新缓存验证
curl "http://localhost:3000/health?noCache=1"
```

## 环境变量

| 变量 | 来源 | 用途 | 默认值 | 必填 |
|------|------|------|--------|:----:|
| `PORT` | 基础服务 | 服务端口 | `3000`（HF: `7860`） | |
| `NODE_ENV` | 基础服务 | 运行环境 | `development` | |
| `TZ` | 基础服务 | 时区 | `Asia/Shanghai` | |
| `LOG_LEVEL` | 基础服务 | 日志级别（trace/debug/info/warn/error/fatal） | `info` | |
| `GEMINI_API_KEY` | AI 解读 | Google Gemini API 密钥 | — | **✅** |
| `CORS_ORIGIN` | 安全鉴权 | 跨域允许来源 | `*` | |
| `DB_PATH` | 数据存储 | SQLite 数据库文件路径 | `./data/tarot.db` | |
| `LOG_RETENTION_DAYS` | 数据存储 | 日志保留天数 | `30` | |
| `PUPPETEER_EXECUTABLE_PATH` | 海报截图 | Chromium 可执行文件路径 | 系统自动查找 | |
| `PUPPETEER_ARGS` | 海报截图 | Chromium 启动参数 | `--no-sandbox,...` | |
| `CACHE_MAX_SIZE` | 缓存性能 | LRU 缓存最大条目数 | `100` | |
| `CACHE_TTL_SECONDS` | 缓存性能 | 缓存 TTL（秒） | `3600` | |
| `POOL_MAX_PAGES` | 海报截图 | 浏览器 Page 池大小 | `4` | |
| `POOL_ACQUIRE_TIMEOUT_MS` | 海报截图 | 获取 Page 超时（ms） | `30000` | |
| `WECHAT_APPID` | 微信认证 | 微信小程序 AppID | — | ⚠️ ¹ |
| `WECHAT_SECRET` | 微信认证 | 微信小程序 AppSecret（敏感） | — | ⚠️ ¹ |
| `JWT_SECRET` | 管理认证 | JWT 签名密钥（敏感） | — | ⚠️ ¹ |
| `ADMIN_ACCESS_EXPIRES_IN` | 管理认证 | 管理员 Access Token 过期时间 | `2h` | |
| `ADMIN_REFRESH_EXPIRES_IN` | 管理认证 | 管理员 Refresh Token 过期时间 | `30d` | |
| `ADMIN_INIT_USERNAME` | 管理认证 | 初始管理员账号 | `admin` | |
| `ADMIN_INIT_PASSWORD` | 管理认证 | 初始管理员密码（首次登录须修改） | `admin@123456` | |

> `GEMINI_API_KEY` 是唯一严格必填变量，其余均有合理默认值。
> ¹ 启用微信小程序登录 / 管理后台时必填，纯 API 调用模式可跳过。
> Docker 部署时 `PUPPETEER_EXECUTABLE_PATH` 和 `PUPPETEER_ARGS` 已在 Dockerfile 中硬编码。
> 过期时间格式（`ms` 库）：`30m`（30分钟）、`2h`（2小时）、`7d`（7天）、`30d`（30天）。

### 配置持久化

通过 `PUT /api/config/:key` 动态修改的配置会写入 SQLite `system_config` 表，标记为 `source='user'`。

服务启动时自动从数据库恢复 `source='user'` 的配置项，**DB 中的 user 配置优先级高于环境变量**。

适用场景：
- 部署时未设置 `GEMINI_API_KEY` 环境变量
- 运行时通过 API 动态注入 Key，重启后自动恢复，无需重新配置

## 数据库

使用 SQLite（通过 `sql.js` WASM 实现，零编译依赖）。

数据库文件位置：`DB_PATH` 环境变量指定，默认 `./data/tarot.db`。

### reading_logs 表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `created_at` | TEXT | ISO 8601 时间戳 |
| `method` | TEXT | 请求方法 |
| `path` | TEXT | 请求路径 |
| `target` | TEXT | `reading` / `poster` |
| `status_code` | INTEGER | HTTP 状态码 |
| `duration_ms` | INTEGER | 处理耗时 |
| `ip_address` | TEXT | 客户端 IP |
| `question` | TEXT | 用户问题（仅 /reading） |
| `cards_json` | TEXT | 牌面 JSON（仅 /reading） |
| `reading` | TEXT | AI 回复原文（仅 /reading） |
| `model` | TEXT | 使用的 Gemini 模型 |
| `incomplete` | INTEGER | 是否截断或不完整 |
| `is_error` | INTEGER | 是否错误 |
| `error_msg` | TEXT | 错误详情 |

> `/poster` 请求不存储 PNG 二进制，仅记录请求元数据和响应状态。

## 实现顺序

> 本节汇总 docs/ 目录下开发计划的落地时序。状态：✅ 已完成  🟡 进行中  ⬜ 待实施

### 阶段 0：基础后端服务

| 顺序 | 计划文档 | 范围 | 状态 |
|:---:|---------|------|:---:|
| 0.1 | （仓库初始提交） | Express + Gemini + 海报 + SQLite 日志骨架 | ✅ |

### 阶段 1：可观测性增强

| 顺序 | 计划文档 | 范围 | 状态 |
|:---:|---------|------|:---:|
| 1.1 | `docs/logging-enhancement-plan.md` | 访问日志 / 业务失败 / 模型切换 / 缓存命中 / 启动横幅 | ✅ |

### 阶段 2：Admin 认证体系

| 顺序 | 计划文档 | 范围 | 状态 |
|:---:|---------|------|:---:|
| 2.1 | `tarot-admin/docs/ADMIN_LOGIN_PLAN.md` 后端部分 | admins 表 / bcrypt / JWT / authMiddleware | ✅ |
| 2.2 | `tarot-admin/docs/ADMIN_AUTH_UPGRADE_PLAN.md` §一 | must_change_password + 默认账号 + 移除 API Key 兼容 | ✅ |

### 阶段 3：日志关联用户（多项目联动）

| 顺序 | 计划文档 | 范围 | 状态 |
|:---:|---------|------|:---:|
| 3.1 | `tarot-miniprogram/docs/AUTH_PLAN.md` 后端 | users 表 / 微信登录 / 邮箱登录 / JWT | 🟡 |
| 3.2 | `tarot-admin/docs/ADMIN_LOGS_USER_PLAN.md` 后端 | /logs JOIN users 返回 user_nickname 等字段 | ⬜ |

### 阶段 4：未来规划

- 用户管理 API 接口（`tarot-admin/docs/ADMIN_USERS_PLAN.md` §2）

### 跨项目依赖

- 📦 本项目被 tarot-admin 依赖：tarot-admin 阶段 1.x 需 tarot-backend 启动
- 📦 本项目被 tarot-miniprogram 依赖：tarot-miniprogram 阶段 2.x 需 /auth/* 接口就绪
- 📦 tarot-reading-api 已整合进本项目；tarot-poster-service 的海报逻辑并入本项目 src/poster/

## 部署

### Docker

```bash
docker build -t tarot-backend .
docker run -d -p 3000:3000 \
  -e GEMINI_API_KEY=your-key \
  tarot-backend
```

### HuggingFace Spaces

```bash
docker build -f Dockerfile.hf -t tarot-backend .
docker run -p 7860:7860 \
  -e GEMINI_API_KEY=your-key \
  tarot-backend
```

在 HF Spaces 上部署后，需在 Settings → Repository secrets 中设置环境变量：

| 变量 | 建议 |
|------|------|
| `GEMINI_API_KEY` | 🔴 必填，设为 Secret |

> HF Spaces 平台已自动设置 `PORT=7860`，不要在 Variables 中手动设置。

## 踩坑记录

### Cloudflare Worker 代理层 CORS 问题

**背景：** HF Space 平台自身的响应头存在 CORS 限制（缺少必要的 CORS 头），因此使用 Cloudflare Worker 作为反向代理，在 Worker 层统一添加 CORS 响应头，覆盖 HF Space 的原始响应。

**问题现象：** 前端调用 PUT 接口（如配置更新）时，浏览器报 CORS 错误：`Method PUT is not allowed by Access-Control-Allow-Methods`。

**根本原因：** Cloudflare Worker 会用自己的 CORS 响应头**覆盖** HF Space 后端返回的 CORS 头。如果 Worker 代码中硬编码的 `Access-Control-Allow-Methods` 缺少 PUT 方法，即使后端正确设置了 PUT，浏览器仍会被拦截。

**解决方案：** 在 Worker 代码中添加 PUT 到允许的方法列表：

```javascript
// ❌ 错误：缺少 PUT
corsHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

// ✅ 正确：包含 PUT
corsHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
```

**排查方法：** 使用 curl 测试 OPTIONS 预检请求，检查响应头：

```bash
curl -X OPTIONS \
  -H "Origin: https://your-admin-domain.com" \
  -H "Access-Control-Request-Method: PUT" \
  https://your-backend-domain.com/api/config/ANY_KEY -v
```

检查 `Access-Control-Allow-Methods` 是否包含 PUT。

## 配置验证清单

```bash
# 1. 服务信息
curl http://localhost:3000/
# 期望：{"service":"tarot-backend","version":"1.0.0","status":"running"}

# 2. 健康检查
curl http://localhost:3000/health
# 期望：{"status":"ok","worker":"up","gemini":"up","model":"...",...}

# 3. 参数校验
curl -s -X POST http://localhost:3000/reading \
  -H "Content-Type: application/json" \
  -d '{}'
# 期望：HTTP 400 + {"error":"Missing question or cards"}

# 4. AI 解读（需要有效 GEMINI_API_KEY）
curl -s -X POST http://localhost:3000/reading \
  -H "Content-Type: application/json" \
  -d '{"question":"测试","cards":[{"position":"现状","name":"愚者","isUpright":true,"uprightMeaning":"开始","reversedMeaning":"停滞","keywords":["开始"]}]}'
# 期望：HTTP 200 + {"reading":"...","model":"gemini-2.5-flash-lite","incomplete":false}

# 5. 日志查询
curl http://localhost:3000/logs?limit=5
# 期望：HTTP 200 + {"total":N,"page":1,"limit":5,"data":[...]}

# 6. 海报生成
curl -s -X POST http://localhost:3000/poster \
  -H "Content-Type: application/json" \
  -d '{"cards":[{"name":"愚者","position":"现状","orientation":"upright","meaning":"新的开始","keywords":["开始"],"type":"major","number":0}],"question":"测试","spreadName":"单张","date":"2026-06-18"}' -o test-output.png && file test-output.png
# 期望：PNG image data, 750 x 1334, ...
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20 |
| 语言 | TypeScript（strict mode） |
| 框架 | Express |
| AI | Google Gemini API |
| 截图 | Puppeteer（无头 Chromium） |
| 缓存 | LRU 内存缓存 |
| 数据库 | SQLite（sql.js WASM） |
| 日志 | pino 结构化日志 |
| 包管理 | pnpm |
| 部署 | Docker / HuggingFace Spaces |

## 项目结构

```
tarot-backend/
├── src/
│   ├── index.ts          # Express 入口，路由注册
│   ├── config.ts         # 统一环境变量管理
│   ├── logger.ts         # pino 结构化日志
│   ├── reading/          # AI 解读模块
│   │   ├── types.ts      # 请求/响应类型
│   │   ├── prompt.ts     # 提示词模板
│   │   ├── models.ts     # 模型选择、配额、调用
│   │   └── handler.ts    # Express 路由处理器
│   ├── poster/           # 海报生成模块（复制自 poster-service）
│   │   ├── types.ts      # PosterData 类型
│   │   ├── template.ts   # 海报 HTML 生成
│   │   ├── render.ts     # Puppeteer 截图
│   │   ├── engine.ts     # 模板引擎
│   │   ├── theme.ts      # 设计令牌系统
│   │   ├── browser-pool.ts # Page 连接池
│   │   └── templates/    # HTML/CSS 模板文件
│   ├── db/               # SQLite 数据库
│   │   ├── index.ts      # 初始化 + 建表
│   │   └── reading-log.ts # 日志 CRUD
│   ├── gateway/          # 网关中间件
│   │   └── logging.ts    # 请求/响应拦截 → SQLite
│   ├── middleware/        # 通用中间件
│   │   ├── cors.ts       # CORS
│   │   └── auth.ts       # Bearer Token 鉴权
│   ├── cache/            # LRU 内存缓存
│   │   └── index.ts      # SHA256 缓存键
│   └── monitor/          # 性能监控
│       ├── index.ts      # 统一导出
│       └── metrics.ts    # Prometheus 指标
├── assets/cards/         # 78 张塔罗牌 SVG
├── Dockerfile            # 标准多阶段构建
├── Dockerfile.hf         # HF Spaces 专用
└── package.json
```
