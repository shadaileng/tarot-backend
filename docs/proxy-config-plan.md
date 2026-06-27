# tarot-backend Gemini API 代理配置执行计划

## 问题概述

Gemini API（`generativelanguage.googleapis.com`）在中国大陆网络环境下不可直接访问，导致：

- 服务启动时 `fetchAvailableModels()` 连接超时，Gemini 标记为 `down`
- `/reading` 解读请求全部失败（502）
- 影响 `/health` 检查结果，整体状态变为 `degraded`

当前代码已正确捕获超时异常（`models.ts:163-165`），但缺乏代理出口配置支持。

---

## 总体时间估算：2-3 小时

---

## 阶段 1：核心实现（约 1.5 小时）

**目标**：通过 admin 面板热配置 `HTTPS_PROXY`，使 Gemini API 调用走代理

### 方案设计

#### 技术选型

使用 `undici.ProxyAgent`（undici 是 Node.js 内置 fetch 的底层 HTTP 引擎），在 fetch 调用时通过 `dispatcher` 参数注入代理。`ProxyAgent` 自动识别 `http://`、`https://`、`socks5://` 等协议。

#### 核心机制

```
PUT /api/config/HTTPS_PROXY  { value: "http://127.0.0.1:7890" }
        │
        ├── updateConfig() ──▶ config.httpsProxy = value
        │                      process.env.HTTPS_PROXY = value
        │
        └── 下次 fetch 调用时 fetchWithProxy() 自动读取最新值
```

#### fetchWithProxy 包装器

```
fetch(url, options)
         │
         ├── config.httpsProxy 为空？──▶ 直接原生 fetch（零开销）
         │
         └── 有代理？──▶ 创建/复用 ProxyAgent 实例 ──▶ fetch(url, { ...options, dispatcher })
                                                              │
                                                        代理地址变更时自动
                                                        销毁旧 agent 创建新 agent
```

### 任务列表

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1.1 | **安装 undici 依赖** | `package.json` | `pnpm add undici`，提供 `ProxyAgent` |
| 1.2 | **创建 fetch 代理包装器** | `src/fetch-proxy.ts` | `fetchWithProxy()` 函数，单例 ProxyAgent 管理 |
| 1.3 | **HTTPS_PROXY 配置注册** | `src/config.ts` | configMeta 新增条目 + config 对象 + updateConfig() |
| 1.4 | **替换 Gemini fetch 调用** | `src/reading/models.ts` | 2 处 `fetch(` → `fetchWithProxy(` |
| 1.5 | **Env 示例更新** | `.env.example` | 添加 `HTTPS_PROXY` 注释 |

### 详细实现要点

#### 1.1 安装 undici

```bash
pnpm add undici
```

undici 是 Node.js 官方 HTTP 客户端，Node.js 18+ fetch 的内核，轻量零依赖。

#### 1.2 fetch 代理包装器（`src/fetch-proxy.ts`）

```typescript
import { ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { config } from './config.js'

let currentProxyUrl = ''
let proxyAgent: ProxyAgent | null = null

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = config.httpsProxy?.trim()
  if (!proxyUrl) {
    if (proxyAgent) {
      proxyAgent.close()
      proxyAgent = null
    }
    currentProxyUrl = ''
    return undefined
  }
  if (proxyUrl !== currentProxyUrl) {
    if (proxyAgent) proxyAgent.close()
    proxyAgent = new ProxyAgent(proxyUrl)
    currentProxyUrl = proxyUrl
  }
  return proxyAgent
}

export async function fetchWithProxy(
  url: string | URL,
  options?: RequestInit,
): Promise<Response> {
  const dispatcher = getProxyDispatcher()
  if (dispatcher) {
    return (fetch as any)(url, { ...options, dispatcher })
  }
  return fetch(url, options)
}
```

**设计要点**：
- **零代理零开销**：`config.httpsProxy` 为空时直接原生 fetch，不创建任何对象
- **代理地址变更自动响应**：admin 热更新后，`ProxyAgent` 实例自动重建，旧实例 `close()` 释放连接
- **类型处理**：`dispatcher` 是 undici 扩展参数，非标准 `RequestInit`，使用 `(fetch as any)` 断言（与 undici 官方推荐用法一致）

#### 1.3 配置注册

`src/config.ts` 中新增：

```typescript
// configMeta 新增（editable: true，支持 admin 热配置）
{ key: 'HTTPS_PROXY', envKey: 'HTTPS_PROXY', group: 'AI 配置',
  editable: true, sensitive: false, type: 'string', defaultValue: '' }

// config 对象新增
httpsProxy: process.env.HTTPS_PROXY || '',

// updateConfig() 新增 case
case 'HTTPS_PROXY':
  config.httpsProxy = value
  break
```

#### 1.4 替换 Gemini fetch 调用

`src/reading/models.ts` 中 2 处替换：

| 行号 | 原始代码 | 替换为 |
|:----:|----------|--------|
| 142 | `const res = await fetch(...)` | `const res = await fetchWithProxy(...)` |
| 270 | `const geminiResponse = await fetch(...)` | `const geminiResponse = await fetchWithProxy(...)` |

另新增 import：`import { fetchWithProxy } from '../fetch-proxy.js'`

#### 1.5 Env 示例

```bash
# Gemini API 代理地址（中国大陆部署时必填，支持 http/https/socks5）
# HTTPS_PROXY=http://127.0.0.1:7890
```

---

## 阶段 2：配置传播增强（约 0.5 小时）

**目标**：`HTTPS_PROXY` 热更新后通知相关子系统

### 任务列表

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 2.1 | **PUT 回调注册** | `src/index.ts` | 配置更新后打印日志，确认新代理地址生效 |
| 2.2 | **启动恢复确认** | `src/index.ts` | 启动时从 DB 恢复后打印已生效的代理地址（脱敏） |

### 详细实现

#### 2.1 PUT 回调

在 `/api/config/:key` handler 中，追加：

```typescript
if (key === 'HTTPS_PROXY') {
  log.info({ proxy: value ? '***configured***' : '(none)' }, 'HTTPS_PROXY config updated')
}
```

#### 2.2 启动横幅

在启动日志中追加代理状态：

```typescript
httpsProxy: config.httpsProxy ? '***configured***' : '(none)',
```

---

## 阶段 3：文档同步（约 0.5 小时）

**目标**：所有相关文档同步更新

### 任务列表

| # | 任务 | 文件 | 变更内容 |
|---|------|------|---------|
| 3.1 | **环境变量表更新** | `README.md` | 环境变量表新增 `HTTPS_PROXY` 行 |
| 3.2 | **环境变量表更新** | `AGENTS.md` | 同上 |
| 3.3 | **CHANGELOG 记录** | `CHANGELOG.md` | 记录 `feat` 新增 |

**`HTTPS_PROXY` 环境变量信息**：

| 变量 | 用途 | 默认值 | 必填 | 可热配置 |
|------|------|--------|:----:|:--------:|
| `HTTPS_PROXY` | Gemini API 代理地址（支持 http/https/socks5） | 空（不代理） | | ✅ |

---

## 阶段 4：验证（约 0.5 小时）

| # | 验证项 | 步骤 | 预期结果 |
|---|--------|------|---------|
| 4.1 | TypeScript 编译 | `pnpm run typecheck` | 无类型错误 |
| 4.2 | 无代理启动 | 启动服务，`GEMINI_API_KEY` 正确但无 HTTPS_PROXY | `/health` 返回 `gemini: "down"`，但服务不崩溃 |
| 4.3 | 热配置代理 | `PUT /api/config/HTTPS_PROXY` 设置有效代理 | 下次 `/health` 探测成功，`gemini: "up"` |
| 4.4 | 代理切换 | 再次 PUT 修改代理地址 | 旧代理连接释放，新代理生效 |
| 4.5 | 清除代理 | `PUT /api/config/HTTPS_PROXY ""` 清空 | 恢复直连模式 |
| 4.6 | 重启恢复 | 重启服务，确认代理配置从 DB 恢复 | 启动横幅显示代理已配置 |
| 4.7 | `/reading` 请求 | 代理配置正确时发起解读请求 | 正常返回解读结果 |

---

## 改动文件清单

| 文件 | 操作 | 改动量（估） |
|------|------|:-----:|
| `package.json` | 修改 | +1 行（dependencies） |
| `src/fetch-proxy.ts` | **新建** | ~40 行 |
| `src/config.ts` | 修改 | +8 行 |
| `src/reading/models.ts` | 修改 | ~5 行（+import，2 处替换） |
| `src/index.ts` | 修改 | +4 行 |
| `.env.example` | 修改 | +2 行 |
| `README.md` | 修改 | +1 行 |
| `AGENTS.md` | 修改 | +1 行 |
| `CHANGELOG.md` | 修改 | +2 行 |
| `docs/proxy-config-plan.md` | **新建** | 本文档 |

---

## 降级与边界情况

| 场景 | 行为 | 日志 |
|------|------|------|
| `HTTPS_PROXY` 未配置 | 原生 fetch 直连 | 无代理相关日志 |
| `HTTPS_PROXY` 为空字符串 | 同未配置 | 同上 |
| 代理地址格式错误 | undici 抛出异常，`fetchWithProxy` 不拦截，由上游 catch 处理 | `log.warn({ err }, 'Fetch failed')` |
| 代理服务器不可用 | fetch 超时/拒绝连接，Gemini 标记为 down | 同现有超时日志 |
| 运行时修改代理 | 旧 `ProxyAgent` 关闭，新 agent 创建，下一次 fetch 生效 | `log.info({ proxy }, 'HTTPS_PROXY config updated')` |
| 代理地址含认证 | undici `ProxyAgent` 原生支持 `http://user:pass@host:port` | 正常使用，URL 脱敏后打印 |
