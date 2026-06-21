import { getDb, saveDb } from './index.js'

export interface ConfigEntry {
  key: string
  value: string
  source: 'env' | 'user'
  updated_at: string
}

export async function getAllConfig(): Promise<Map<string, ConfigEntry>> {
  const db = await getDb()
  const stmt = db.prepare('SELECT key, value, source, updated_at FROM system_config')
  const map = new Map<string, ConfigEntry>()
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as ConfigEntry
    map.set(row.key, row)
  }
  stmt.free()
  return map
}

export async function getConfigByKey(key: string): Promise<ConfigEntry | undefined> {
  const db = await getDb()
  const stmt = db.prepare('SELECT key, value, source, updated_at FROM system_config WHERE key = ?')
  stmt.bind([key])
  let row: ConfigEntry | undefined
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as ConfigEntry
  }
  stmt.free()
  return row
}

export async function upsertConfig(key: string, value: string, source: 'env' | 'user' = 'user'): Promise<void> {
  const db = await getDb()
  const updated_at = new Date().toISOString()
  db.run(
    `INSERT INTO system_config (key, value, source, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, source = ?, updated_at = ?`,
    [key, value, source, updated_at, value, source, updated_at],
  )
  saveDb()
}

export async function initDefaultConfig(defaults: Record<string, string>): Promise<void> {
  const existing = await getAllConfig()
  for (const [key, value] of Object.entries(defaults)) {
    if (!existing.has(key)) {
      await upsertConfig(key, value, 'env')
    }
  }
}

/**
 * 从数据库加载所有 source='user' 的配置项，回写到 process.env 和内存 config 对象。
 * 用于服务启动时恢复用户通过 PUT /api/config/:key 动态设置的配置。
 *
 * 优先级：DB user 配置 > 环境变量（DB 优先）
 */
export async function loadUserConfig(): Promise<string[]> {
  const { updateConfig } = await import('../config.js')
  const db = await getAllConfig()
  const loadedKeys: string[] = []
  for (const [key, entry] of db) {
    if (entry.source === 'user') {
      process.env[key] = entry.value
      updateConfig(key, entry.value)
      loadedKeys.push(key)
    }
  }
  return loadedKeys
}
