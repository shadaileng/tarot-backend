# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
