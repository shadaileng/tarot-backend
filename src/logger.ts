// 结构化日志模块 — 基于 pino
// - 开发环境使用 pino-pretty 美化输出
// - 生产环境输出纯 JSON，可直接接入 ELK / Loki 等日志平台
// - 通过 LOG_LEVEL 环境变量控制级别 (debug/info/warn/error，默认 info)

import pino from 'pino'
import { config } from './config.js'

const isDev = config.nodeEnv === 'development'

const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '({module}) {msg}',
          },
        },
      }
    : {}),
})

/** 按模块获取 logger，自动注入 module 字段 */
export function getLogger(module: string): pino.Logger {
  return rootLogger.child({ module })
}
