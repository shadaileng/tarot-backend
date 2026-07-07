#!/usr/bin/env node

/**
 * 用户软删除脚本
 *
 * 用法：
 *   node scripts/soft-delete-user.js <userId>          # 软删除用户
 *   node scripts/soft-delete-user.js <userId> --info   # 仅查看用户信息
 *
 * 说明：
 *   - 软删除仅设置 deleted_at 字段，用户数据保留，可恢复
 *   - 关联表数据不清理，恢复用户后数据完整
 */

import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/tarot.db')

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('用法: node scripts/soft-delete-user.js <userId> [--info]')
    console.log('  --info  仅查看用户信息，不执行删除')
    process.exit(1)
  }

  const userId = args[0]
  const infoOnly = args.includes('--info')

  if (!fs.existsSync(DB_PATH)) {
    console.error(`数据库文件不存在: ${DB_PATH}`)
    process.exit(1)
  }

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(DB_PATH)
  const db = new SQL.Database(buffer)

  try {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
    stmt.bind([userId])

    if (!stmt.step()) {
      console.error(`用户不存在: ${userId}`)
      stmt.free()
      process.exit(1)
    }

    const user = stmt.getAsObject()
    stmt.free()

    console.log('\n========== 用户信息 ==========')
    console.log(`ID:         ${user.id}`)
    console.log(`昵称:       ${user.nickname}`)
    console.log(`OpenID:     ${user.openid || '(空)'}`)
    console.log(`邮箱:       ${user.email || '(空)'}`)
    console.log(`手机:       ${user.phone || '(空)'}`)
    console.log(`创建时间:   ${user.created_at}`)
    console.log(`最后登录:   ${user.last_login_at}`)
    console.log(`删除时间:   ${user.deleted_at || '(未删除)'}`)
    console.log('================================\n')

    if (infoOnly) {
      process.exit(0)
    }

    if (user.deleted_at) {
      console.log('该用户已被软删除，无需重复操作')
      process.exit(0)
    }

    const adminCheck = db.prepare('SELECT id FROM admins WHERE id = ?')
    adminCheck.bind([userId])
    if (adminCheck.step()) {
      console.error('错误：不能删除管理员账号')
      adminCheck.free()
      process.exit(1)
    }
    adminCheck.free()

    const now = new Date().toISOString()

    if (user.email && user.openid) {
      console.log('检测到微信+邮箱双绑定用户，正在解绑邮箱...')
      db.run('UPDATE users SET email = NULL, password_hash = NULL WHERE id = ?', [userId])

      const findStmt = db.prepare('SELECT id FROM users WHERE email IS NOT NULL AND email != \'\' AND deleted_at IS NOT NULL LIMIT 1')
      if (findStmt.step()) {
        const originalUser = findStmt.getAsObject()
        db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', [originalUser.id])
        console.log(`已恢复被合并的原邮箱用户: ${originalUser.id}`)
      }
      findStmt.free()
    }

    db.run('UPDATE users SET deleted_at = ? WHERE id = ?', [now, userId])

    const data = db.export()
    fs.writeFileSync(DB_PATH, Buffer.from(data))

    console.log(`✓ 用户已软删除: ${userId}`)
    console.log(`  删除时间: ${now}`)
    console.log('  提示：可通过 restoreUser API 恢复该用户')
  } catch (err) {
    console.error('执行失败:', err)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()
