#!/bin/bash
# tarot-backend 备份脚本
# 用法: ./scripts/backup.sh [备份目录]
#
# 路径通过环境变量配置（与 src/config.ts 保持一致）：
#   DB_PATH      — 数据库文件路径（默认 ./data/tarot.db）
#   UPLOADS_DIR  — 上传文件目录（默认 ./uploads）
#   BACKUP_DIR   — 备份存储目录（默认 ./backups）

set -euo pipefail

# ==================== 配置（从环境变量读取，与 src/config.ts 一致） ====================
DB_PATH="${DB_PATH:-./data/tarot.db}"
DATA_DIR="$(dirname "${DB_PATH}")"
UPLOADS_DIR="${UPLOADS_DIR:-./data/uploads}"
BACKUP_DIR="${1:-${BACKUP_DIR:-./data/backups}}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="tarot-backup-${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
RETENTION_DAYS=30  # 本地保留天数

# ==================== 颜色输出 ====================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ==================== 前置检查 ====================
command -v sqlite3 >/dev/null 2>&1 || warn "sqlite3 CLI 未安装，将跳过 WAL checkpoint（备份可能不一致）"

# ==================== 创建备份目录 ====================
mkdir -p "${BACKUP_PATH}"
info "开始备份 → ${BACKUP_PATH}"

# ==================== 1. 数据库备份 ====================
if [ -f "${DB_PATH}" ]; then
    info "备份数据库 (${DB_PATH})..."

    # WAL checkpoint：将日志写回主数据库文件
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(FULL);" 2>/dev/null || true
        info "  WAL checkpoint 完成"
    fi

    # 复制数据库文件（同时复制 WAL 和 SHM 文件）
    mkdir -p "${BACKUP_PATH}/data"
    cp "${DB_PATH}" "${BACKUP_PATH}/data/tarot.db"
    [ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${BACKUP_PATH}/data/tarot.db-wal"
    [ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${BACKUP_PATH}/data/tarot.db-shm"

    DB_SIZE=$(du -sh "${BACKUP_PATH}/data/tarot.db" | cut -f1)
    info "  数据库备份完成 (${DB_SIZE})"
else
    error "数据库文件不存在: ${DB_PATH}"
fi

# ==================== 2. 上传文件备份 ====================
if [ -d "${UPLOADS_DIR}" ]; then
    info "备份上传文件 (${UPLOADS_DIR})..."
    cp -r "${UPLOADS_DIR}" "${BACKUP_PATH}/uploads"
    UPLOAD_SIZE=$(du -sh "${BACKUP_PATH}/uploads" | cut -f1)
    info "  上传文件备份完成 (${UPLOAD_SIZE})"
else
    warn "上传目录不存在，跳过: ${UPLOADS_DIR}"
fi

# ==================== 3. 生成备份清单 ====================
info "生成备份清单..."
cat > "${BACKUP_PATH}/manifest.json" << EOF
{
  "backup_name": "${BACKUP_NAME}",
  "timestamp": "${TIMESTAMP}",
  "created_at": "$(date -Iseconds)",
  "hostname": "$(hostname 2>/dev/null || echo 'unknown')",
  "config": {
    "db_path": "${DB_PATH}",
    "uploads_dir": "${UPLOADS_DIR}"
  },
  "files": {
    "database": $(ls -la "${BACKUP_PATH}/data/tarot.db" 2>/dev/null | awk '{print $5}' || echo 0),
    "uploads": "$(du -sh "${BACKUP_PATH}/uploads" 2>/dev/null | cut -f1 || echo 'N/A')"
  }
}
EOF

# ==================== 4. 压缩打包 ====================
info "压缩备份包..."
cd "${BACKUP_DIR}"
tar -czf "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}"
TARBALL_SIZE=$(du -sh "${BACKUP_NAME}.tar.gz" | cut -f1)
info "  压缩包: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz (${TARBALL_SIZE})"

# 删除未压缩的临时目录
rm -rf "${BACKUP_NAME}"

# ==================== 5. 清理旧备份 ====================
info "清理 ${RETENTION_DAYS} 天前的旧备份..."
find "${BACKUP_DIR}" -name "tarot-backup-*.tar.gz" -mtime +${RETENTION_DAYS} -delete -print 2>/dev/null | \
    while read f; do
        info "  已删除: $(basename $f)"
    done

# ==================== 6. 备份摘要 ====================
TOTAL_BACKUPS=$(ls "${BACKUP_DIR}"/tarot-backup-*.tar.gz 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)

echo ""
info "========== 备份完成 =========="
info "  备份文件: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
info "  备份大小: ${TARBALL_SIZE}"
info "  备份总数: ${TOTAL_BACKUPS} 个"
info "  占用空间: ${TOTAL_SIZE}"
echo ""
