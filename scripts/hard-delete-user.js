#!/usr/bin/env node

/**
 * 用户硬删除脚本
 *
 * 用法：
 *   node scripts/hard-delete-user.js <userId>          # 硬删除用户（需确认）
 *   node scripts/hard-delete-user.js <userId> --info   # 仅查看用户信息
 *   node scripts/hard-delete-user.js <userId> --force  # 跳过确认直接删除
 *
 * 说明：
 *   - 硬删除会彻底删除用户及所有关联数据
 *   - 删除后不可恢复，请谨慎操作
 *   - 管理员账号无法删除
 */

import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/tarot.db')

// 关联表删除顺序（避免外键约束）
const RELATED_TABLES = [
  { table: 'client_event_logs', column: 'user_id' },
  { table: 'reading_logs', column: 'user_id' },
  { table: 'request_logs', column: 'user_id' },
  { table: 'poster_tasks', column: 'user_id' },
  { table: 'readings', column: 'user_id' },
  { table: 'reading_records', column: 'user_id' },
  { table: 'user_tasks', column: 'user_id' },
  { table: 'checkin_records', column: 'user_id' },
  { table: 'invite_records', column: 'inviter_id' },
  { table: 'invite_records', column: 'invitee_id' },
  { table: 'feedback', column: 'user_id' },
  { table: 'user_stats', column: 'user_id' },
]

function askQuestion(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('用法: node scripts/hard-delete-user.js <userId> [--info] [--force]')
    console.log('  --info   仅查看用户信息，不执行删除')
    console.log('  --force  跳过确认直接删除')
    process.exit(1)
  }

  const userId = args[0]
  const infoOnly = args.includes('--info')
  const forceMode = args.includes('--force')

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
      // 统计关联数据
      console.log('---------- 关联数据统计 ----------')
      for (const { table, column } of RELATED_TABLES) {
        try {
          const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${column} = ?`)
          countStmt.bind([userId])
          if (countStmt.step()) {
            const count = countStmt.getAsObject().cnt
            if (count > 0) {
              console.log(`${table}: ${count} 条`)
            }
          }
          countStmt.free()
        } catch {
          // 表可能不存在，忽略
        }
      }
      console.log('==================================\n')
      process.exit(0)
    }

    if (user.deleted_at) {
      console.log('该用户已被软删除，硬删除前请先软删除')
      process.exit(1)
    }

    const adminCheck = db.prepare('SELECT id FROM admins WHERE id = ?')
    adminCheck.bind([userId])
    if (adminCheck.step()) {
      console.error('错误：不能删除管理员账号')
      adminCheck.free()
      process.exit(1)
    }
    adminCheck.free()

    if (!forceMode) {
      console.log('⚠️  警告：此操作不可逆！')
      console.log('将删除以下数据：')
      console.log('  - 用户基本信息')
      console.log('  - 所有关联的占卜记录')
      console.log('  - 所有关联的签到记录')
      console.log('  - 所有关联的邀请记录')
      console.log('  - 所有关联的任务记录')
      console.log('  - 所有关联的日志记录')
      console.log('')

      const answer = await askQuestion('请输入 "yes" 确认删除：')
      if (answer !== 'yes') {
        console.log('已取消删除操作')
        process.exit(0)
      }
    }

    console.log('\n开始删除关联数据...')

    // 删除关联表数据
    for (const { table, column } of RELATED_TABLES) {
      try {
        const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
        deleteStmt.bind([userId])
        deleteStmt.step()
        const changes = db.getRowsModified()
        deleteStmt.free()
        if (changes > 0) {
          console.log(`  ✓ ${table}: 删除 ${changes} 条`)
        }
      } catch {
        // 表可能不存在，忽略
      }
    }

    // 删除用户记录
    db.run('DELETE FROM users WHERE id = ?', [userId])
    console.log(`  ✓ users: 删除 1 条`)

    // 保存数据库
    const data = db.export()
    fs.writeFileSync(DB_PATH, Buffer.from(data))

    console.log(`\n✓ 用户已彻底删除: ${userId}`)
    console.log('  此操作不可逆，数据无法恢复')
  } catch (err) {
    console.error('执行失败:', err)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()
