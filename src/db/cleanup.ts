import { config } from '../config.js'
import { cleanupRequestLogs } from './request-log.js'
import { cleanupClientEventLogs } from './client-event-log.js'
import { cleanExpiredAuditLogs } from './audit.js'
import { cleanupPosterTasks } from './poster-task.js'
import { deleteOldLogs } from './reading-log.js'
import { snapshotDbSize } from './index.js'
import { getLogger } from '../logger.js'

const log = getLogger('Cleanup')

export interface CleanupResult {
  table: string
  deleted: number
}

export interface CleanupHistoryEntry {
  timestamp: string
  results: CleanupResult[]
}

const cleanupMetrics: Record<string, number> = {}
const cleanupHistory: CleanupHistoryEntry[] = []
const MAX_HISTORY = 30

export function getCleanupMetrics(): Record<string, number> {
  return { ...cleanupMetrics }
}

export function getCleanupHistory(): CleanupHistoryEntry[] {
  return [...cleanupHistory]
}

export async function runAllCleanups(): Promise<CleanupResult[]> {
  const results: CleanupResult[] = []

  // request_logs
  const requestLogsDeleted = await cleanupRequestLogs(config.db.retentionDays)
  results.push({ table: 'request_logs', deleted: requestLogsDeleted })

  // client_event_logs
  const clientEventsDeleted = await cleanupClientEventLogs(config.db.retentionDays)
  results.push({ table: 'client_event_logs', deleted: clientEventsDeleted })

  // audit_logs
  const auditLogsDeleted = await cleanExpiredAuditLogs(config.auditLog.retentionDays)
  results.push({ table: 'audit_logs', deleted: auditLogsDeleted })

  // reading_logs（遗留日志表）
  const readingLogsDeleted = await deleteOldLogs(config.db.retentionDays)
  results.push({ table: 'reading_logs', deleted: readingLogsDeleted })

  // poster_tasks（已完成任务）
  const posterTasksDeleted = await cleanupPosterTasks(config.db.retentionDays)
  results.push({ table: 'poster_tasks', deleted: posterTasksDeleted })

  // 汇总 metrics
  for (const r of results) {
    cleanupMetrics[r.table] = (cleanupMetrics[r.table] || 0) + r.deleted
  }

  // 记录历史
  cleanupHistory.unshift({
    timestamp: new Date().toISOString(),
    results,
  })
  if (cleanupHistory.length > MAX_HISTORY) {
    cleanupHistory.pop()
  }

  const total = results.reduce((sum, r) => sum + r.deleted, 0)
  if (total > 0) {
    log.info({ results, total }, '日志清理完成')
  } else {
    log.debug('日志清理完成，无需删除')
  }

  return results
}

export function scheduleCleanup(): void {
  // 启动时立即执行一次清理
  runAllCleanups().catch((e: unknown) => log.warn({ err: e }, '启动清理失败'))

  // 启动时立即快照一次
  snapshotDbSize().catch((e: unknown) => log.warn({ err: e }, '启动快照失败'))

  // 每小时快照一次（记录趋势）
  setInterval(() => {
    snapshotDbSize().catch((e: unknown) => log.warn({ err: e }, '快照失败'))
  }, 60 * 60 * 1000).unref()

  // 每 24 小时：清理 + 快照
  setInterval(() => {
    runAllCleanups().catch((e: unknown) => log.warn({ err: e }, '定时清理失败'))
    snapshotDbSize().catch((e: unknown) => log.warn({ err: e }, '定时快照失败'))
  }, 24 * 60 * 60 * 1000).unref()

  log.info({
    logRetentionDays: config.db.retentionDays,
    auditLogRetentionDays: config.auditLog.retentionDays,
  }, '清理调度器已启动')
}
