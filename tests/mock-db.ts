import type { Database } from 'sql.js'

export let currentDb: Database | null = null

export function setDb(db: Database): void {
  currentDb = db
}

export function clearDb(): void {
  currentDb = null
}

export function getDb(): Database {
  if (!currentDb) throw new Error('Test DB not set — call setDb() first')
  return currentDb
}

export function saveDb(): void {
}
