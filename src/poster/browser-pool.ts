// 浏览器 Page 池化
// 池的核心价值：控制并发 Page 数量，避免同时打开过多页面耗尽资源
// Page 对象用完即关，不复用（newPage() 开销极低，但复用会引入僵尸 Page 风险）

import { type Browser, type Page } from 'puppeteer'
import { config } from '../config.js'
import { getLogger } from '../logger.js'

const log = getLogger('Pool')

export interface PoolStats {
  available: number // 始终为 0（Page 不复用）
  active: number
  waiting: number
  maxPages: number
}

interface QueueEntry {
  resolve: (page: Page) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class BrowserPool {
  private browser: Browser
  private maxPages: number
  private acquireTimeoutMs: number

  private activePages: Set<Page> = new Set()
  private waitQueue: QueueEntry[] = []

  private isShuttingDown = false

  constructor(browser: Browser, maxPages: number, acquireTimeoutMs: number) {
    this.browser = browser
    this.maxPages = maxPages
    this.acquireTimeoutMs = acquireTimeoutMs
  }

  /** 获取一个可用的 Page，池满时排队等待 */
  async acquire(): Promise<Page> {
    if (this.isShuttingDown) {
      throw new Error('BrowserPool is shutting down')
    }

    // 还有配额，创建新 Page（不复用旧 Page）
    if (this.activePages.size < this.maxPages) {
      const page = await this.browser.newPage()
      this.activePages.add(page)
      return page
    }

    // 池满，排队等待
    return new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时：从队列中移除
        const idx = this.waitQueue.findIndex((e) => e.timer === timer)
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1)
        }
        reject(
          new Error(
            `BrowserPool: acquire timeout after ${this.acquireTimeoutMs}ms (waiting: ${this.waitQueue.length})`
          )
        )
      }, this.acquireTimeoutMs)

      this.waitQueue.push({ resolve, reject, timer })
    })
  }

  /** 归还 Page — 直接关闭，不复用，避免僵尸 Page 风险 */
  async release(page: Page): Promise<void> {
    this.activePages.delete(page)

    // 直接关闭 Page，不复用
    try {
      await page.close()
    } catch {
      // 静默忽略关闭失败（Page 可能已断开）
    }

    // 通知等待队列
    this.processQueue()
  }

  /** 关闭所有 Page */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true

    // 拒绝所有等待者
    for (const entry of this.waitQueue) {
      clearTimeout(entry.timer)
      entry.reject(new Error('BrowserPool is shutting down'))
    }
    this.waitQueue = []

    // 关闭所有活跃 Page
    const allPages = [...this.activePages]
    this.activePages.clear()

    await Promise.allSettled(
      allPages.map((page) =>
        page.close().catch((e) => {
          log.warn({ err: e }, 'Error closing page during shutdown')
        })
      )
    )

    log.info({ pagesClosed: allPages.length }, 'Shutdown complete')
  }

  /** 获取池状态 */
  get stats(): PoolStats {
    return {
      available: 0,
      active: this.activePages.size,
      waiting: this.waitQueue.length,
      maxPages: this.maxPages,
    }
  }

  /** 处理等待队列：有空闲配额时创建新 Page 分发给等待者 */
  private processQueue(): void {
    while (this.waitQueue.length > 0 && this.activePages.size < this.maxPages) {
      const entry = this.waitQueue.shift()!
      clearTimeout(entry.timer)

      this.browser
        .newPage()
        .then((page) => {
          this.activePages.add(page)
          entry.resolve(page)
        })
        .catch((e) => {
          entry.reject(e)
        })
    }
  }
}

// ========== 全局单例 ==========
let poolPromise: Promise<BrowserPool> | null = null

export async function getBrowserPool(browser: Browser): Promise<BrowserPool> {
  if (poolPromise) {
    try {
      const pool = await poolPromise
      // 检查旧池引用的 browser 是否仍然连接
      if (pool.stats.maxPages > 0 && browser.isConnected()) {
        return pool
      }
      // 旧 browser 已断开，关闭旧池重建
      log.warn('Browser disconnected, recreating pool...')
      await pool.shutdown()
    } catch {
      // poolPromise 异常，重建
    }
    poolPromise = null
  }

  poolPromise = Promise.resolve(
    new BrowserPool(browser, config.pool.maxPages, config.pool.acquireTimeoutMs)
  )
  return poolPromise
}

export async function closeBrowserPool(): Promise<void> {
  if (poolPromise) {
    try {
      const pool = await poolPromise
      await pool.shutdown()
    } catch (e) {
      log.error({ err: e }, 'Error shutting down pool')
    }
    poolPromise = null
  }
}

/** 获取当前池状态（无需 browser 实例，未初始化时返回 null） */
export async function getPoolStats(): Promise<PoolStats | null> {
  if (!poolPromise) return null
  try {
    const pool = await poolPromise
    return pool.stats
  } catch {
    return null
  }
}
