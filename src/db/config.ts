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
