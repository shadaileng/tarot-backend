import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { config } from '../config.js'
import { getLogger } from '../logger.js'
import type { SqlJsStatic, Database } from 'sql.js'

const log = getLogger('DB')

let db: Database | null = null
let SQL: SqlJsStatic | null = null

async function initSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs()
  }
  return SQL
}

export function saveDb(): void {
  const data = db!.export()
  const dir = path.dirname(config.db.path)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(config.db.path, Buffer.from(data))
}

export async function getDb(): Promise<Database> {
  if (!db) {
    const sql = await initSql()
    const existed = fs.existsSync(config.db.path)
    if (existed) {
      const buffer = fs.readFileSync(config.db.path)
      db = new sql.Database(buffer)
    } else {
      db = new sql.Database()
    }
    db.run('PRAGMA journal_mode=WAL')
    initSchema(db)
    saveDb()
    log.info({ path: config.db.path, new: !existed }, 'Database initialized')
  }
  return db
}

function initSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS reading_logs (
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
    )
  `)
  database.run('CREATE INDEX IF NOT EXISTS idx_logs_created_at ON reading_logs(created_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_logs_target ON reading_logs(target)')

  database.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'env',
      updated_at  TEXT NOT NULL
    )
  `)
}

export function closeDb(): void {
  if (db) {
    saveDb()
    db.close()
    db = null
  }
}
