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
