export interface ConfigMeta {
  key: string
  envKey: string
  group: string
  editable: boolean
  sensitive?: boolean
  type: 'string' | 'number'
  defaultValue: string
}

export const configMeta: ConfigMeta[] = [
  { key: 'PORT', envKey: 'PORT', group: '系统配置', editable: false, type: 'number', defaultValue: '3000' },
  { key: 'NODE_ENV', envKey: 'NODE_ENV', group: '系统配置', editable: false, type: 'string', defaultValue: 'development' },

  { key: 'GEMINI_API_KEY', envKey: 'GEMINI_API_KEY', group: 'AI 配置', editable: true, sensitive: true, type: 'string', defaultValue: '' },
  { key: 'HTTPS_PROXY', envKey: 'HTTPS_PROXY', group: 'AI 配置', editable: true, sensitive: false, type: 'string', defaultValue: '' },

  { key: 'CORS_ORIGIN', envKey: 'CORS_ORIGIN', group: '安全配置', editable: false, type: 'string', defaultValue: '*' },

  { key: 'DB_PATH', envKey: 'DB_PATH', group: '数据库', editable: false, type: 'string', defaultValue: './data/tarot.db' },

  { key: 'CACHE_MAX_SIZE', envKey: 'CACHE_MAX_SIZE', group: '缓存配置', editable: true, type: 'number', defaultValue: '100' },
  { key: 'CACHE_TTL_SECONDS', envKey: 'CACHE_TTL_SECONDS', group: '缓存配置', editable: true, type: 'number', defaultValue: '3600' },

  { key: 'POOL_MAX_PAGES', envKey: 'POOL_MAX_PAGES', group: '性能配置', editable: true, type: 'number', defaultValue: '4' },
  { key: 'POOL_ACQUIRE_TIMEOUT_MS', envKey: 'POOL_ACQUIRE_TIMEOUT_MS', group: '性能配置', editable: true, type: 'number', defaultValue: '30000' },
  { key: 'PUPPETEER_PROTOCOL_TIMEOUT', envKey: 'PUPPETEER_PROTOCOL_TIMEOUT', group: '性能配置', editable: true, type: 'number', defaultValue: '60000' },

  { key: 'LOG_RETENTION_DAYS', envKey: 'LOG_RETENTION_DAYS', group: '日志配置', editable: true, type: 'number', defaultValue: '30' },

  { key: 'WECHAT_APPID',  envKey: 'WECHAT_APPID',  group: '微信配置', editable: true, sensitive: false, type: 'string', defaultValue: '' },
  { key: 'WECHAT_SECRET', envKey: 'WECHAT_SECRET', group: '微信配置', editable: true, sensitive: true,  type: 'string', defaultValue: '' },
  { key: 'JWT_SECRET',    envKey: 'JWT_SECRET',    group: '安全配置', editable: true, sensitive: true,  type: 'string', defaultValue: '' },

  { key: 'ADMIN_ACCESS_EXPIRES_IN', envKey: 'ADMIN_ACCESS_EXPIRES_IN', group: '安全配置', editable: true, type: 'string', defaultValue: '2h' },
  { key: 'ADMIN_REFRESH_EXPIRES_IN', envKey: 'ADMIN_REFRESH_EXPIRES_IN', group: '安全配置', editable: true, type: 'string', defaultValue: '30d' },
  { key: 'ADMIN_INIT_USERNAME',  envKey: 'ADMIN_INIT_USERNAME',  group: '安全配置', editable: false, sensitive: false, type: 'string', defaultValue: 'admin' },
  { key: 'ADMIN_INIT_PASSWORD',  envKey: 'ADMIN_INIT_PASSWORD',  group: '安全配置', editable: false, sensitive: true, type: 'string', defaultValue: 'admin@123456' },
]

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  timezone: process.env.TZ || 'Asia/Shanghai',

  wechatAppId: process.env.WECHAT_APPID || '',
  wechatSecret: process.env.WECHAT_SECRET || '',
  jwtSecret: process.env.JWT_SECRET || '',

  corsOrigin: process.env.CORS_ORIGIN || '*',

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  httpsProxy: process.env.HTTPS_PROXY || '',

  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: (process.env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox').split(','),
    protocolTimeout: parseInt(process.env.PUPPETEER_PROTOCOL_TIMEOUT || '60000', 10),
  },

  cache: {
    maxSize: parseInt(process.env.CACHE_MAX_SIZE || '100', 10),
    ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10),
  },

  pool: {
    maxPages: parseInt(process.env.POOL_MAX_PAGES || '4', 10),
    acquireTimeoutMs: parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || '30000', 10),
  },

  db: {
    path: process.env.DB_PATH || './data/tarot.db',
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  },

  adminAccessExpiresIn: process.env.ADMIN_ACCESS_EXPIRES_IN || '2h',
  adminRefreshExpiresIn: process.env.ADMIN_REFRESH_EXPIRES_IN || '30d',
  adminInitUsername: process.env.ADMIN_INIT_USERNAME || 'admin',
  adminInitPassword: process.env.ADMIN_INIT_PASSWORD || 'admin@123456',
}

export function getConfigDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {}
  for (const meta of configMeta) {
    defaults[meta.envKey] = process.env[meta.envKey] || meta.defaultValue
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
    case 'HTTPS_PROXY':
      config.httpsProxy = value
      break
    case 'WECHAT_APPID':
      config.wechatAppId = value
      break
    case 'WECHAT_SECRET':
      config.wechatSecret = value
      break
    case 'JWT_SECRET':
      config.jwtSecret = value
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
    case 'LOG_RETENTION_DAYS':
      config.db.retentionDays = parseInt(value, 10)
      break
    case 'PUPPETEER_PROTOCOL_TIMEOUT':
      config.puppeteer.protocolTimeout = parseInt(value, 10)
      break
    case 'ADMIN_ACCESS_EXPIRES_IN':
      config.adminAccessExpiresIn = value
      break
    case 'ADMIN_REFRESH_EXPIRES_IN':
      config.adminRefreshExpiresIn = value
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
