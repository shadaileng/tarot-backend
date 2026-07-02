-- Step 1: 创建合并后的 readings 表
CREATE TABLE IF NOT EXISTS readings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  spread_type     TEXT NOT NULL DEFAULT '',
  question        TEXT,
  cards_json      TEXT NOT NULL,
  reading         TEXT,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'completed',
  is_local        INTEGER DEFAULT 0,
  incomplete      INTEGER DEFAULT 0,
  warning         TEXT,
  error_msg       TEXT,
  interpretation  TEXT,
  request_log_id  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Step 2: 从 reading_records 迁移（已有 AI 解读 → status='completed'）
INSERT INTO readings
  (id, user_id, created_at, spread_type, question, cards_json,
   reading, model, status, is_local, incomplete, interpretation, request_log_id)
SELECT
  id, user_id, created_at, spread_type, question, cards_json,
  reading, model, 'completed', is_local, 0, interpretation, NULL
FROM reading_records;

-- Step 3: 从 reading_logs 迁移（有 AI 结果的 → status='completed'；有读取出错的 → status='failed'）
INSERT OR IGNORE INTO readings
  (id, user_id, created_at, spread_type, question, cards_json,
   reading, model, status, is_local, incomplete, error_msg, request_log_id)
SELECT
  id, user_id, created_at, '', question, cards_json,
  reading, model,
  CASE WHEN is_error = 1 THEN 'failed' ELSE 'completed' END,
  0, incomplete, error_msg, NULL
FROM reading_logs
WHERE target = 'reading'
  AND cards_json IS NOT NULL
  AND id NOT IN (SELECT id FROM readings);

-- Step 4: 创建索引
CREATE INDEX IF NOT EXISTS idx_readings_user_id ON readings(user_id);
CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_status ON readings(status);
CREATE INDEX IF NOT EXISTS idx_readings_request_log_id ON readings(request_log_id);

-- Step 5: 删除旧表（确认迁移无误后执行）
-- DROP TABLE IF EXISTS reading_logs;
-- DROP TABLE IF EXISTS reading_records;
