import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { config, getUploadsDir, getBackupDir } from '../config.js'
import { getDb, saveDb, resetDb } from '../db/index.js'
import { getLogger } from '../logger.js'

const log = getLogger('Admin:Backup')

const BACKUP_FILENAME_RE = /^tarot-backup-[\dT-]+\.tar\.gz$/
const RETENTION_DAYS = 30

// ==================== 备份核心逻辑 ====================

export interface BackupManifest {
  backup_name: string
  timestamp: string
  created_at: string
  hostname: string
  config: {
    db_path: string
    uploads_dir: string
  }
  files: {
    database: number
    uploads: string
  }
}

export interface BackupInfo {
  name: string
  filename: string
  size: number
  createdAt: string
  manifest?: BackupManifest
}

/**
 * 执行 WAL checkpoint，确保数据库一致性
 */
async function walCheckpoint(): Promise<void> {
  try {
    const db = await getDb()
    db.exec('PRAGMA wal_checkpoint(FULL)')
    log.info('WAL checkpoint completed')
  } catch (err) {
    log.warn({ err }, 'WAL checkpoint failed, proceeding anyway')
  }
}

/**
 * 创建备份
 */
export async function createBackup(): Promise<{
  success: boolean
  backup?: BackupInfo
  error?: string
}> {
  const backupDir = getBackupDir()
  const dbPath = config.db.path
  const uploadsDir = getUploadsDir()

  // 确保备份目录存在
  fs.mkdirSync(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupName = `tarot-backup-${timestamp}`
  const stagingPath = path.join(backupDir, '_staging', backupName)
  const tarballPath = path.join(backupDir, `${backupName}.tar.gz`)

  try {
    // 1. WAL checkpoint
    await walCheckpoint()

    // 2. 创建暂存目录
    fs.mkdirSync(path.join(stagingPath, 'data'), { recursive: true })

    // 3. 复制数据库文件
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: '数据库文件不存在' }
    }
    fs.copyFileSync(dbPath, path.join(stagingPath, 'data', 'tarot.db'))
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, path.join(stagingPath, 'data', 'tarot.db-wal'))
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, path.join(stagingPath, 'data', 'tarot.db-shm'))
    }

    // 4. 复制上传目录
    if (fs.existsSync(uploadsDir)) {
      fs.mkdirSync(path.join(stagingPath, 'uploads'), { recursive: true })
      copyDirRecursive(uploadsDir, path.join(stagingPath, 'uploads'))
    }

    // 5. 生成 manifest.json
    const dbStats = fs.statSync(path.join(stagingPath, 'data', 'tarot.db'))
    let uploadsSize = 'N/A'
    try {
      uploadsSize = getDirSizeHuman(path.join(stagingPath, 'uploads'))
    } catch {}

    const manifest: BackupManifest = {
      backup_name: backupName,
      timestamp,
      created_at: new Date().toISOString(),
      hostname: process.env.HOSTNAME || 'unknown',
      config: {
        db_path: dbPath,
        uploads_dir: uploadsDir,
      },
      files: {
        database: dbStats.size,
        uploads: uploadsSize,
      },
    }
    fs.writeFileSync(
      path.join(stagingPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    )

    // 6. tar -czf 压缩打包
    execSync(`tar -czf "${tarballPath}" -C "${path.join(backupDir, '_staging')}" "${backupName}"`, {
      timeout: 60_000,
    })

    // 7. 清理暂存目录
    fs.rmSync(path.join(backupDir, '_staging'), { recursive: true, force: true })

    // 8. 清理旧备份
    cleanOldBackups(backupDir)

    const tarballStats = fs.statSync(tarballPath)
    const backupInfo: BackupInfo = {
      name: backupName,
      filename: `${backupName}.tar.gz`,
      size: tarballStats.size,
      createdAt: manifest.created_at,
      manifest,
    }

    log.info({ backupName, size: tarballStats.size }, 'Backup created')
    return { success: true, backup: backupInfo }
  } catch (err) {
    // 清理暂存目录
    try { fs.rmSync(path.join(backupDir, '_staging'), { recursive: true, force: true }) } catch {}
    log.error({ err }, 'Backup creation failed')
    return { success: false, error: (err as Error).message }
  }
}

/**
 * 列出所有备份文件
 */
export async function listBackups(): Promise<{
  backups: BackupInfo[]
  total: number
  totalSize: number
}> {
  const backupDir = getBackupDir()
  const backups: BackupInfo[] = []

  if (!fs.existsSync(backupDir)) {
    return { backups: [], total: 0, totalSize: 0 }
  }

  const files = fs.readdirSync(backupDir).filter(f => BACKUP_FILENAME_RE.test(f))

  for (const file of files) {
    const filePath = path.join(backupDir, file)
    const stats = fs.statSync(filePath)
    const name = file.replace('.tar.gz', '')

    // 尝试读取 manifest
    let manifest: BackupManifest | undefined
    try {
      const content = execSync(
        `tar -xzf "${filePath}" -O "${name}/manifest.json" 2>/dev/null`,
        { timeout: 10_000 },
      ).toString()
      manifest = JSON.parse(content)
    } catch {}

    backups.push({
      name,
      filename: file,
      size: stats.size,
      createdAt: manifest?.created_at || stats.mtime.toISOString(),
      manifest,
    })
  }

  // 按创建时间倒序
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const totalSize = backups.reduce((sum, b) => sum + b.size, 0)
  return { backups, total: backups.length, totalSize }
}

/**
 * 下载备份文件（返回文件路径供 stream）
 */
export function getBackupFilePath(filename: string): string | null {
  if (!BACKUP_FILENAME_RE.test(filename)) return null
  const filePath = path.join(getBackupDir(), filename)
  if (!fs.existsSync(filePath)) return null
  return filePath
}

/**
 * 删除指定备份
 */
export function deleteBackup(filename: string): { success: boolean; error?: string } {
  if (!BACKUP_FILENAME_RE.test(filename)) {
    return { success: false, error: '文件名格式不合法' }
  }
  const filePath = path.join(getBackupDir(), filename)
  if (!fs.existsSync(filePath)) {
    return { success: false, error: '备份文件不存在' }
  }
  fs.unlinkSync(filePath)
  log.info({ filename }, 'Backup deleted')
  return { success: true }
}

/**
 * 从上传的 tar.gz 恢复数据
 */
export async function restoreFromBackup(
  uploadedFilePath: string,
): Promise<{
  success: boolean
  message: string
  restored?: { database: boolean; uploads: boolean }
  requireRestart?: boolean
}> {
  const dbPath = config.db.path
  const dataDir = path.dirname(dbPath)
  const uploadsDir = getUploadsDir()

  // 解压到临时目录
  const tmpDir = path.join(getBackupDir(), '_restore_tmp')
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    execSync(`tar -xzf "${uploadedFilePath}" -C "${tmpDir}"`, { timeout: 60_000 })

    // 找到解压后的目录
    const entries = fs.readdirSync(tmpDir).filter(e => e.startsWith('tarot-backup-'))
    if (entries.length === 0) {
      return { success: false, message: '备份包格式异常，未找到 tarot-backup-* 目录' }
    }
    const backupDir = path.join(tmpDir, entries[0])

    // 读取 manifest
    let manifest: BackupManifest | undefined
    const manifestPath = path.join(backupDir, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      log.info({ manifest }, 'Restoring from backup')
    }

    let dbRestored = false
    let uploadsRestored = false

    // 恢复数据库
    const backupDbDir = path.join(backupDir, 'data')
    if (fs.existsSync(path.join(backupDbDir, 'tarot.db'))) {
      // WAL checkpoint + 关闭当前数据库
      try {
        await walCheckpoint()
      } catch {}

      // 复制新的数据库文件
      fs.mkdirSync(dataDir, { recursive: true })
      fs.copyFileSync(path.join(backupDbDir, 'tarot.db'), dbPath)
      const walFile = path.join(backupDbDir, 'tarot.db-wal')
      const shmFile = path.join(backupDbDir, 'tarot.db-shm')
      if (fs.existsSync(walFile)) {
        fs.copyFileSync(walFile, `${dbPath}-wal`)
      }
      if (fs.existsSync(shmFile)) {
        fs.copyFileSync(shmFile, `${dbPath}-shm`)
      }
      // 重置内存数据库实例（不保存当前状态），下次 getDb() 从新文件重新加载
      resetDb()
      dbRestored = true
      log.info('Database restored')
    }

    // 恢复上传目录
    const backupUploadsDir = path.join(backupDir, 'uploads')
    if (fs.existsSync(backupUploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true })
      copyDirRecursive(backupUploadsDir, uploadsDir)
      uploadsRestored = true
      log.info('Uploads restored')
    }

    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true })

    return {
      success: true,
      message: '恢复完成，数据库已热替换',
      restored: { database: dbRestored, uploads: uploadsRestored },
      requireRestart: false,
    }
  } catch (err) {
    // 清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    log.error({ err }, 'Restore failed')
    return { success: false, message: `恢复失败: ${(err as Error).message}` }
  }
}

// ==================== 工具函数 ====================

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function getDirSizeHuman(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return '0 B'
  let total = 0
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const p = path.join(dirPath, entry.name)
    if (entry.isFile()) {
      total += fs.statSync(p).size
    }
  }
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(2)} KB`
  return `${(total / (1024 * 1024)).toFixed(2)} MB`
}

function cleanOldBackups(backupDir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = fs.readdirSync(backupDir).filter(f => BACKUP_FILENAME_RE.test(f))
    for (const file of files) {
      const filePath = path.join(backupDir, file)
      const stats = fs.statSync(filePath)
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
        log.info({ filename: file }, 'Old backup cleaned')
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to clean old backups')
  }
}
