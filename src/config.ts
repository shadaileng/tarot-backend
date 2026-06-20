export interface ConfigMeta {
  key: string
  envKey: string
  group: string
  editable: boolean
  sensitive?: boolean
  type: 'string' | 'number'
}

export const configMeta: ConfigMeta[] = [
  { key: 'PORT', envKey: 'PORT', group: '系统配置', editable: false, type: 'number' },
  { key: 'NODE_ENV', envKey: 'NODE_ENV', group: '系统配置', editable: false, type: 'string' },

  { key: 'GEMINI_API_KEY', envKey: 'GEMINI_API_KEY', group: 'AI 配置', editable: true, sensitive: true, type: 'string' },

  { key: 'API_KEY', envKey: 'API_KEY', group: '安全配置', editable: false, sensitive: true, type: 'string' },
  { key: 'CORS_ORIGIN', envKey: 'CORS_ORIGIN', group: '安全配置', editable: false, type: 'string' },

  { key: 'DB_PATH', envKey: 'DB_PATH', group: '数据库', editable: false, type: 'string' },

  { key: 'CACHE_MAX_SIZE', envKey: 'CACHE_MAX_SIZE', group: '缓存配置', editable: true, type: 'number' },
  { key: 'CACHE_TTL_SECONDS', envKey: 'CACHE_TTL_SECONDS', group: '缓存配置', editable: true, type: 'number' },

  { key: 'POOL_MAX_PAGES', envKey: 'POOL_MAX_PAGES', group: '性能配置', editable: true, type: 'number' },
  { key: 'POOL_ACQUIRE_TIMEOUT_MS', envKey: 'POOL_ACQUIRE_TIMEOUT_MS', group: '性能配置', editable: true, type: 'number' },

  { key: 'POSTER_WIDTH', envKey: 'POSTER_WIDTH', group: '海报配置', editable: true, type: 'number' },
  { key: 'POSTER_HEIGHT', envKey: 'POSTER_HEIGHT', group: '海报配置', editable: true, type: 'number' },

  { key: 'LOG_RETENTION_DAYS', envKey: 'LOG_RETENTION_DAYS', group: '日志配置', editable: true, type: 'number' },
]

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  timezone: process.env.TZ || 'Asia/Shanghai',

  apiKey: process.env.API_KEY || '',

  corsOrigin: process.env.CORS_ORIGIN || '*',

  geminiApiKey: process.env.GEMINI_API_KEY || '',

  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: (process.env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage').split(','),
  },

  cache: {
    maxSize: parseInt(process.env.CACHE_MAX_SIZE || '100', 10),
    ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10),
  },

  poster: {
    width: parseInt(process.env.POSTER_WIDTH || '750', 10),
    height: parseInt(process.env.POSTER_HEIGHT || '1334', 10),
  },

  pool: {
    maxPages: parseInt(process.env.POOL_MAX_PAGES || '4', 10),
    acquireTimeoutMs: parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || '30000', 10),
  },

  db: {
    path: process.env.DB_PATH || './data/tarot.db',
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  },
}

export function getConfigDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {}
  for (const meta of configMeta) {
    defaults[meta.envKey] = process.env[meta.envKey] || ''
  }
  return defaults
}

export function updateConfig(key: string, value: string): void {
  process.env[key] = value

  switch (key) {
    case 'PORT':
      config.port = parseInt(value, 10)
      break
    case 'NODE_ENV':
      config.nodeEnv = value
      break
    case 'GEMINI_API_KEY':
      config.geminiApiKey = value
      break
    case 'API_KEY':
      config.apiKey = value
      break
    case 'CORS_ORIGIN':
      config.corsOrigin = value
      break
    case 'DB_PATH':
      config.db.path = value
      break
    case 'CACHE_MAX_SIZE':
      config.cache.maxSize = parseInt(value, 10)
      break
    case 'CACHE_TTL_SECONDS':
      config.cache.ttlSeconds = parseInt(value, 10)
      break
    case 'POOL_MAX_PAGES':
      config.pool.maxPages = parseInt(value, 10)
      break
    case 'POOL_ACQUIRE_TIMEOUT_MS':
      config.pool.acquireTimeoutMs = parseInt(value, 10)
      break
    case 'POSTER_WIDTH':
      config.poster.width = parseInt(value, 10)
      break
    case 'POSTER_HEIGHT':
      config.poster.height = parseInt(value, 10)
      break
    case 'LOG_RETENTION_DAYS':
      config.db.retentionDays = parseInt(value, 10)
      break
  }
}

export function maskSensitiveValue(key: string, value: string): string {
  const meta = configMeta.find((m) => m.envKey === key)
  if (meta?.sensitive && value) {
    return value.slice(0, 3) + '...' + value.slice(-4)
  }
  return value
}
