// LRU 内存缓存
// 基于 SHA256 哈希生成缓存键，支持可配置的最大容量和 TTL

import { createHash } from 'node:crypto'
import { config } from '../config.js'
import type { PosterData } from '../poster/types.js'

interface CacheEntry {
  key: string
  data: Buffer
  timestamp: number
}

export class LRUCache {
  private cache: Map<string, CacheEntry>
  readonly maxSize: number
  readonly ttlMs: number

  constructor(maxSize: number = 100, ttlSeconds: number = 3600) {
    this.cache = new Map()
    this.maxSize = maxSize
    this.ttlMs = ttlSeconds * 1000
  }

  get size(): number {
    return this.cache.size
  }

  /** 根据 PosterData 生成缓存键 */
  generateKey(data: PosterData): string {
    const normalized = JSON.stringify({
      cards: data.cards.map((c) => ({
        name: c.name,
        orientation: c.orientation,
        position: c.position,
      })),
      question: data.question,
      spreadName: data.spreadName,
      date: data.date,
      comprehensiveInterpretation: data.comprehensiveInterpretation || '',
      theme: data.theme || 'dark',
      template: data.template || 'default',
    })
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  }

  get(key: string): Buffer | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // 检查 TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }

    // LRU: 移到末尾（最近使用）
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.data
  }

  set(key: string, data: Buffer): void {
    // 淘汰最旧条目
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }

    this.cache.set(key, {
      key,
      data,
      timestamp: Date.now(),
    })
  }
}

export const posterCache = new LRUCache(config.cache.maxSize, config.cache.ttlSeconds)
