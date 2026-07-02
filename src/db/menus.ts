import { getDb } from './index.js'

export interface MenuRow {
  id: string
  parent_id: string | null
  route_name: string | null
  label: string
  icon: string | null
  sort_order: number
  is_visible: number
  require_role: string | null
  created_at: string
  updated_at: string
}

export interface MenuTreeItem {
  id: string
  routeName: string | null
  label: string
  icon: string | null
  sortOrder: number
  children: MenuTreeItem[]
}

/**
 * 获取当前管理员可见的菜单树
 * 兼容逻辑：如果 role_menus 中无该角色记录，返回所有可见菜单
 */
export async function getMyMenus(role: string): Promise<MenuTreeItem[]> {
  const db = await getDb()

  // 查询该角色关联的菜单 ID 列表
  const roleStmt = db.prepare('SELECT menu_id FROM role_menus WHERE role = ?')
  roleStmt.bind([role])
  const roleMenuIds: string[] = []
  while (roleStmt.step()) {
    const row = roleStmt.getAsObject() as unknown as { menu_id: string }
    roleMenuIds.push(row.menu_id)
  }
  roleStmt.free()

  // 如果有角色菜单关联，按关联过滤；否则返回所有可见菜单
  let allMenus: MenuRow[]
  if (roleMenuIds.length > 0) {
    const placeholders = roleMenuIds.map(() => '?').join(',')
    const stmt = db.prepare(`SELECT * FROM menus WHERE is_visible = 1 AND id IN (${placeholders}) ORDER BY sort_order`)
    stmt.bind(roleMenuIds)
    allMenus = []
    while (stmt.step()) allMenus.push(stmt.getAsObject() as unknown as MenuRow)
    stmt.free()
  } else {
    const stmt = db.prepare('SELECT * FROM menus WHERE is_visible = 1 ORDER BY sort_order')
    allMenus = []
    while (stmt.step()) allMenus.push(stmt.getAsObject() as unknown as MenuRow)
    stmt.free()
  }

  // 构建树形结构
  const menuMap = new Map<string, MenuTreeItem>()
  const roots: MenuTreeItem[] = []

  for (const m of allMenus) {
    menuMap.set(m.id, {
      id: m.id,
      routeName: m.route_name,
      label: m.label,
      icon: m.icon,
      sortOrder: m.sort_order,
      children: [],
    })
  }

  for (const m of allMenus) {
    const node = menuMap.get(m.id)!
    if (m.parent_id && menuMap.has(m.parent_id)) {
      menuMap.get(m.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}
