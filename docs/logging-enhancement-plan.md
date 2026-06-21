# tarot-backend 日志增强执行计划

## 问题概述

当前后端运行日志基本只有启动日志，业务运行时几乎静默。核心盲区：

- **所有请求访问无日志** — 看不到谁在调用、调用什么、返回什么
- **业务失败完全静默** — `/reading` 返回 500 时控制台无 trace
- **Gemini 模型回退无感知** — 配额耗尽、模型切换全程沉默
- **缓存命中/未命中无日志** — 无法判断缓存是否生效
- **启动配置信息不足** — 不知道哪些配置来自 env、哪些是默认值

---

## 总体时间估算：1 天（约 6-8 小时）

---

## 阶段 1：P0 — 必做（约 3 小时）

**目标**：让所有请求可观测、所有业务失败可追溯、所有缓存行为可验证

### 任务列表

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 1.1 | **访问日志** — 每个 HTTP 请求结束时输出 `log.info`，含 method/path/status/duration/ip/logId | `src/gateway/logging.ts` | ✅ 已完成 |
| 1.2 | **业务失败日志** — `/reading` handler 中 Gemini 失败时输出 `log.warn`/`log.error`，含 model/status/error/detail | `src/reading/handler.ts` | ✅ 已完成 |
| 1.3 | **Gemini 模型切换日志** — `callGeminiReading` 中每个模型重试时输出 `log.warn`，含 model/status/原因 | `src/reading/models.ts` | ✅ 已完成 |
| 1.4 | **缓存命中日志** — `X-Cache: HIT` 时输出 `log.debug`，`MISS` 时输出 `log.info`（含渲染耗时） | `src/index.ts`（poster handler） | ✅ 已完成 |
| 1.5 | **启动横幅增强** — 列出当前生效的关键配置（敏感信息脱敏），让运维一眼看清运行状态 | `src/index.ts` `start()` | ✅ 已完成 |

### 详细实现要点

#### 1.1 访问日志

```ts
// 在 loggingMiddleware 中，请求结束时统一输出：
log.info({
  method: req.method,
  path: req.path,
  status: res.statusCode,
  duration: duration,
  ip: req.ip,
  logId,
  target,
}, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
```

**注意**：跳过 `/health` `/metrics` 等高频路径（已在 SKIP_PATHS 中），避免日志噪音。

#### 1.2 业务失败日志

```ts
// 在 readingHandler 中：
// 1. Gemini API 未配置时 → log.warn
// 2. 参数校验失败 → log.warn
// 3. callGeminiReading 返回 success=false → log.warn，含 model/status/error
// 4. catch 块 → log.error，含完整 error stack
```

#### 1.3 Gemini 模型切换日志

```ts
// 在 callGeminiReading 的 for 循环中：
// 1. 每次模型返回 4xx/5xx 时 → log.warn({ model, status, retryable })
// 2. 标记 quota exhausted 时 → log.warn({ model }, 'Marked quota exhausted')
// 3. 所有模型耗尽时 → log.error({ exhaustedModels })
// 4. 首次调用成功 → log.info({ model, finishReason })
```

#### 1.4 缓存命中日志

```ts
// 在 poster handler 中：
if (cached) {
  log.debug({ cacheKey, template }, 'Poster cache HIT')
  // ...
}
// MISS 时：
log.info({ cacheKey, template, templateMs, resourceMs, screenshotMs, totalMs }, 'Poster cache MISS')
```

#### 1.5 启动横幅增强

在 `start()` 的 listen 回调中，追加：

```ts
log.info({
  port: config.port,
  nodeEnv: config.nodeEnv,
  timezone: config.timezone,
  geminiKey: config.geminiApiKey ? '***configured***' : 'NOT SET',
  apiKey: config.apiKey ? '***configured***' : 'NOT SET',
  corsOrigin: config.corsOrigin,
  dbPath: config.db.path,
  cacheMaxSize: config.cache.maxSize,
  cacheTtlSeconds: config.cache.ttlSeconds,
  poolMaxPages: config.pool.maxPages,
  puppeteerPath: config.puppeteer.executablePath || 'default',
  logRetentionDays: config.db.retentionDays,
}, 'Startup configuration summary')
```

---

## 阶段 2：P1 — 推荐（约 2 小时）

**目标**：补全关键路径的上下文日志，让运维诊断有据可查

### 任务列表

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 2.1 | **优雅关闭日志** — SIGTERM/SIGINT 监听时输出 `log.info` | `src/index.ts` | ✅ 已完成 |
| 2.2 | **DB 模块日志** — `getDb` 成功后输出 `log.info`，含路径、是否新建、schema 初始化 | `src/db/index.ts` | ✅ 已完成 |
| 2.3 | **配置加载来源日志** — 启动时区分 "from env" vs "default value" vs "from DB user" | `src/index.ts` `start()` | ✅ 已完成 |
| 2.4 | **Puppeteer 启动详情** — 启动后输出 `log.info` 含 executablePath、args、耗时 | `src/poster/render.ts` `getBrowser()` | ✅ 已完成 |
| 2.5 | **Gemini 健康探测日志** — `fetchAvailableModels` 失败/成功时输出 `log.warn`/`log.info` | `src/reading/models.ts` | ✅ 已完成 |

### 详细实现要点

#### 2.1 优雅关闭日志

```ts
// 在 src/index.ts 末尾添加：
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...')
  // 后续可扩展 closeDb() 等清理逻辑
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...')
  process.exit(0)
})
```

#### 2.2 DB 模块日志

```ts
// 在 getDb() 中：
// - 首次创建 vs 从文件加载 → log.info({ path, new: true/false })
// - initSchema 完成后 → log.debug('Schema initialized')
```

#### 2.3 配置加载来源日志

在 `loadUserConfig` 恢复后，输出每个 key 的来源：

```ts
// 输出一个简洁的配置来源表：
// - from_env: PORT, NODE_ENV, CORS_ORIGIN
// - from_default: DB_PATH
// - from_user: CACHE_MAX_SIZE=200
```

#### 2.4 Puppeteer 启动详情

```ts
// 在 puppeteer.launch 成功后：
log.info({
  executablePath: config.puppeteer.executablePath || 'system default',
  args: config.puppeteer.args,
  headless: true,
}, 'Browser launched')
```

#### 2.5 Gemini 健康探测日志

```ts
// fetchAvailableModels 中：
if (!res.ok) {
  log.warn({ status: res.status }, 'Gemini model list fetch failed')
} else {
  log.info({ modelCount: models.length }, 'Gemini model list refreshed')
}
```

---

## 阶段 3：P2 — 锦上添花（约 2 小时）

**目标**：实现请求追踪串联、周期状态监控

### 任务列表

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 3.1 | **请求 ID 透传** — 在 `loggingMiddleware` 中把 `logId` 注入到 `req` 上，下游 handler 可用 `log.child({ logId })` 串联 | `src/gateway/logging.ts` | ⬜ 待完成 |
| 3.2 | **周期状态日志** — 每 60s 输出一条 `log.info` 含 metrics snapshot（健康自检） | `src/index.ts` | ⬜ 待完成 |
| 3.3 | **配置热更新通知** — 更新 cache/pool 配置时，输出是否已通知到对应模块 | `src/index.ts` `/api/config/:key` | ⬜ 待完成 |

### 详细实现要点

#### 3.1 请求 ID 透传

```ts
// 扩展 Request 类型或使用 (req as any).logId = logId
// 在 loggingMiddleware 中设置
// 下游 handler 使用 log.child({ logId: req.logId }) 串联日志
```

#### 3.2 周期状态日志

```ts
setInterval(() => {
  const snap = metrics.getSnapshot()
  log.info({
    totalRequests: snap.totalRequests,
    errorCount: snap.errorCount,
    errorRate: snap.totalRequests > 0
      ? (snap.errorCount / snap.totalRequests * 100).toFixed(2) + '%'
      : '0%',
    avgTotalMs: Math.round(snap.avgTotalMs),
    cacheHitRate: snap.cacheHitRate,
  }, 'Periodic status report')
}, 60000)
```

#### 3.3 配置热更新通知

```ts
// 在 PUT /api/config/:key 中，更新后追加：
if (key === 'CACHE_MAX_SIZE' || key === 'CACHE_TTL_SECONDS') {
  posterCache.updateConfig(...)
  log.info({ key, value }, 'Cache config updated')
}
if (key === 'POOL_MAX_PAGES' || key === 'POOL_ACQUIRE_TIMEOUT_MS') {
  pool.updateConfig(...)
  log.info({ key, value }, 'Pool config updated')
}
```

---

## 阶段 4：验证与收尾（约 1 小时）

**目标**：确保所有日志正常输出，无遗漏

### 任务列表

| # | 任务 | 状态 |
|---|------|------|
| 4.1 | TypeScript 类型检查通过 (`npm run typecheck` 或 `npx tsc --noEmit`) | ⬜ 待完成 |
| 4.2 | 启动服务，验证启动横幅完整性 | ⬜ 待完成 |
| 4.3 | 发起正常 `/reading` 请求，验证访问日志 + 成功日志 | ⬜ 待完成 |
| 4.4 | 发起错误 `/reading` 请求（无 API Key），验证错误日志 | ⬜ 待完成 |
| 4.5 | 连续请求同一 `/poster`，验证缓存 HIT/MISS 日志 | ⬜ 待完成 |
| 4.6 | 发送 SIGTERM，验证优雅关闭日志 | ⬜ 待完成 |
| 4.7 | 检查日志级别，确保 `log.debug` 在 production 不输出 | ⬜ 待完成 |

---

## 日志级别约定

| 级别 | 使用场景 | 示例 |
|------|---------|------|
| `error` | 服务级故障（无法恢复） | Puppeteer 崩溃、启动失败 |
| `warn` | 业务异常（可恢复） | Gemini 429、字体超时、参数校验失败 |
| `info` | 关键路径节点 | 请求到达/离开、缓存 MISS、配置变更 |
| `debug` | 调试细节 | 缓存 HIT、DB 写入、模型切换 |

---

## 改动文件清单

| 文件 | P0 | P1 | P2 | 合计行数（估） |
|------|:--:|:--:|:--:|:-----:|
| `src/gateway/logging.ts` | ✅ | — | ✅ | +15 |
| `src/reading/handler.ts` | ✅ | — | ✅ | +10 |
| `src/reading/models.ts` | ✅ | ✅ | — | +15 |
| `src/index.ts` | ✅ | ✅ | ✅ | +35 |
| `src/db/index.ts` | — | ✅ | — | +5 |
| `src/poster/render.ts` | — | ✅ | — | +5 |

---

## 当前进度

| 阶段 | 完成度 | 状态 |
|------|--------|------|
| 阶段 1 (P0) | 100% | ✅ 已完成 |
| 阶段 2 (P1) | 100% | ✅ 已完成 |
| 阶段 3 (P2) | 0% | ⬜ 待开始 |
| 阶段 4 (验证) | 0% | ⬜ 待开始 |
| **总计** | **50%** | |
