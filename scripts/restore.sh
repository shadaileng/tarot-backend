#!/bin/bash
# tarot-backend 恢复脚本
# 用法: ./scripts/restore.sh <备份包路径> [--no-confirm]
#
# 路径通过环境变量配置（与 src/config.ts 保持一致）：
#   DB_PATH      — 数据库文件路径（默认 ./data/tarot.db）
#   UPLOADS_DIR  — 上传文件目录（默认 ./uploads）

set -euo pipefail

# ==================== 配置（从环境变量读取，与 src/config.ts 一致） ====================
BACKUP_FILE="${1:-}"
SKIP_CONFIRM="${2:-}"
DB_PATH="${DB_PATH:-./data/tarot.db}"
DATA_DIR="$(dirname "${DB_PATH}")"
UPLOADS_DIR="${UPLOADS_DIR:-${DATA_DIR}/uploads}"
BACKUP_DIR="${BACKUP_DIR:-${DATA_DIR}/backups}"

# ==================== 颜色输出 ====================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ==================== 参数检查 ====================
if [ -z "${BACKUP_FILE}" ]; then
    echo "用法: $0 <备份包路径> [--no-confirm]"
    echo ""
    echo "示例:"
    echo "  $0 ./backups/tarot-backup-20260718-120000.tar.gz"
    echo "  $0 ./backups/tarot-backup-20260718-120000.tar.gz --no-confirm"
    echo ""
    echo "环境变量:"
    echo "  DB_PATH      — 数据库目标路径 (默认: ./data/tarot.db)"
    echo "  UPLOADS_DIR  — 上传文件目标目录 (默认: ./uploads)"
    echo ""
    echo "可用的备份文件:"
    ls -lh ./backups/tarot-backup-*.tar.gz 2>/dev/null || echo "  （无）"
    exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
    error "备份文件不存在: ${BACKUP_FILE}"
fi

# ==================== 解压备份 ====================
TEMP_DIR=$(mktemp -d)
info "解压备份包..."
tar -xzf "${BACKUP_FILE}" -C "${TEMP_DIR}"

# 找到解压后的目录
BACKUP_DIR=$(find "${TEMP_DIR}" -maxdepth 1 -type d -name "tarot-backup-*" | head -1)
if [ -z "${BACKUP_DIR}" ]; then
    error "备份包格式异常，未找到 tarot-backup-* 目录"
fi

# 读取清单
if [ -f "${BACKUP_DIR}/manifest.json" ]; then
    info "备份信息:"
    cat "${BACKUP_DIR}/manifest.json"
    echo ""
fi

# ==================== 确认恢复 ====================
if [ "${SKIP_CONFIRM}" != "--no-confirm" ]; then
    warn "⚠️  即将恢复以下数据（现有数据将被覆盖）:"
    [ -d "${BACKUP_DIR}/data" ] && echo "  - 数据库: ${BACKUP_DIR}/data/tarot.db → ${DB_PATH}"
    [ -d "${BACKUP_DIR}/uploads" ] && echo "  - 上传文件: ${BACKUP_DIR}/uploads/ → ${UPLOADS_DIR}/"
    echo ""
    read -p "确认恢复? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        info "已取消恢复"
        rm -rf "${TEMP_DIR}"
        exit 0
    fi
fi

# ==================== 停止服务（提示） ====================
warn "请确保在恢复前已停止 tarot-backend 服务！"
echo "  如果正在运行，按 Ctrl+C 取消，先停止服务再恢复"
sleep 3

# ==================== 恢复数据库 ====================
if [ -d "${BACKUP_DIR}/data" ]; then
    info "恢复数据库..."
    mkdir -p "${DATA_DIR}"
    cp "${BACKUP_DIR}/data/tarot.db" "${DB_PATH}"
    [ -f "${BACKUP_DIR}/data/tarot.db-wal" ] && cp "${BACKUP_DIR}/data/tarot.db-wal" "${DB_PATH}-wal"
    [ -f "${BACKUP_DIR}/data/tarot.db-shm" ] && cp "${BACKUP_DIR}/data/tarot.db-shm" "${DB_PATH}-shm"
    info "  数据库恢复完成"
fi

# ==================== 恢复上传文件 ====================
if [ -d "${BACKUP_DIR}/uploads" ]; then
    info "恢复上传文件..."
    mkdir -p "${UPLOADS_DIR}"
    cp -r "${BACKUP_DIR}/uploads/"* "${UPLOADS_DIR}/" 2>/dev/null || true
    info "  上传文件恢复完成"
fi

# ==================== 清理 ====================
rm -rf "${TEMP_DIR}"

# ==================== 恢复后验证 ====================
info "恢复后验证..."

# 检查数据库完整性
if command -v sqlite3 >/dev/null 2>&1; then
    INTEGRITY=$(sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" 2>/dev/null)
    if [ "${INTEGRITY}" = "ok" ]; then
        info "  数据库完整性检查: ✅ 通过"
    else
        error "  数据库完整性检查: ❌ 失败 (${INTEGRITY})"
    fi
fi

# 检查文件
[ -f "${DB_PATH}" ] && info "  数据库文件: ✅ 存在" || error "  数据库文件: ❌ 缺失"
[ -d "${UPLOADS_DIR}/avatar" ] && info "  头像目录: ✅ 存在" || warn "  头像目录: ⚠️ 不存在"
[ -d "${UPLOADS_DIR}/feedback" ] && info "  反馈目录: ✅ 存在" || warn "  反馈目录: ⚠️ 不存在"

echo ""
info "========== 恢复完成 =========="
info "请重启 tarot-backend 服务以加载恢复的数据"
echo ""
