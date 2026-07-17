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

export interface CreateMenuParams {
  parentId?: string | null
  routeName?: string | null
  label: string
  icon?: string | null
  sortOrder?: number
  isVisible?: number
  requireRole?: string | null
}

export interface UpdateMenuParams {
  parentId?: string | null
  routeName?: string | null
  label?: string
  icon?: string | null
  sortOrder?: number
  isVisible?: number
  requireRole?: string | null
}

/**
 * 获取所有菜单（管理端，含隐藏菜单）
 */
export async function getAllMenus(): Promise<MenuRow[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM menus ORDER BY sort_order')
  const menus: MenuRow[] = []
  while (stmt.step()) {
    menus.push(stmt.getAsObject() as unknown as MenuRow)
  }
  stmt.free()
  return menus
}

/**
 * 获取单个菜单
 */
export async function getMenuById(id: string): Promise<MenuRow | null> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM menus WHERE id = ?')
  stmt.bind([id])
  const menu = stmt.step() ? (stmt.getAsObject() as unknown as MenuRow) : null
  stmt.free()
  return menu
}

/**
 * 创建菜单
 */
export async function createMenu(params: CreateMenuParams): Promise<MenuRow> {
  const db = await getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const stmt = db.prepare(`
    INSERT INTO menus (id, parent_id, route_name, label, icon, sort_order, is_visible, require_role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.bind([
    id,
    params.parentId ?? null,
    params.routeName ?? null,
    params.label,
    params.icon ?? null,
    params.sortOrder ?? 0,
    params.isVisible ?? 1,
    params.requireRole ?? null,
    now,
    now,
  ])
  stmt.step()
  stmt.free()

  const menu = await getMenuById(id)
  return menu!
}

/**
 * 更新菜单
 */
export async function updateMenu(id: string, params: UpdateMenuParams): Promise<MenuRow | null> {
  const db = await getDb()
  const now = new Date().toISOString()

  // 构建动态 UPDATE 语句
  const updates: string[] = []
  const values: (string | number | null)[] = []

  if (params.parentId !== undefined) {
    updates.push('parent_id = ?')
    values.push(params.parentId)
  }
  if (params.routeName !== undefined) {
    updates.push('route_name = ?')
    values.push(params.routeName)
  }
  if (params.label !== undefined) {
    updates.push('label = ?')
    values.push(params.label)
  }
  if (params.icon !== undefined) {
    updates.push('icon = ?')
    values.push(params.icon)
  }
  if (params.sortOrder !== undefined) {
    updates.push('sort_order = ?')
    values.push(params.sortOrder)
  }
  if (params.isVisible !== undefined) {
    updates.push('is_visible = ?')
    values.push(params.isVisible)
  }
  if (params.requireRole !== undefined) {
    updates.push('require_role = ?')
    values.push(params.requireRole)
  }

  if (updates.length === 0) {
    return getMenuById(id)
  }

  updates.push('updated_at = ?')
  values.push(now)
  values.push(id)

  const stmt = db.prepare(`UPDATE menus SET ${updates.join(', ')} WHERE id = ?`)
  stmt.bind(values)
  stmt.step()
  stmt.free()

  return getMenuById(id)
}

/**
 * 删除菜单（级联删除子菜单）
 */
export async function deleteMenu(id: string): Promise<boolean> {
  const db = await getDb()

  // 先删除角色菜单关联
  const unlinkStmt = db.prepare('DELETE FROM role_menus WHERE menu_id = ?')
  unlinkStmt.bind([id])
  unlinkStmt.step()
  unlinkStmt.free()

  // 删除子菜单的角色关联
  const unlinkChildrenStmt = db.prepare(`
    DELETE FROM role_menus WHERE menu_id IN (SELECT id FROM menus WHERE parent_id = ?)
  `)
  unlinkChildrenStmt.bind([id])
  unlinkChildrenStmt.step()
  unlinkChildrenStmt.free()

  // 删除子菜单
  const deleteChildrenStmt = db.prepare('DELETE FROM menus WHERE parent_id = ?')
  deleteChildrenStmt.bind([id])
  deleteChildrenStmt.step()
  deleteChildrenStmt.free()

  // 删除自身
  const deleteStmt = db.prepare('DELETE FROM menus WHERE id = ?')
  deleteStmt.bind([id])
  const changes = deleteStmt.step()
  deleteStmt.free()

  return changes
}

/**
 * 批量更新菜单排序
 */
export async function updateMenuSort(updates: { id: string; sortOrder: number }[]): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()

  const stmt = db.prepare('UPDATE menus SET sort_order = ?, updated_at = ? WHERE id = ?')
  for (const update of updates) {
    stmt.bind([update.sortOrder, now, update.id])
    stmt.step()
  }
  stmt.free()
}

/**
 * 获取角色菜单 ID 列表
 */
export async function getRoleMenus(role: string): Promise<string[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT menu_id FROM role_menus WHERE role = ?')
  stmt.bind([role])
  const menuIds: string[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as { menu_id: string }
    menuIds.push(row.menu_id)
  }
  stmt.free()
  return menuIds
}

/**
 * 设置角色菜单（先删后插）
 */
export async function setRoleMenus(role: string, menuIds: string[]): Promise<void> {
  const db = await getDb()

  // 删除该角色的旧关联
  const deleteStmt = db.prepare('DELETE FROM role_menus WHERE role = ?')
  deleteStmt.bind([role])
  deleteStmt.step()
  deleteStmt.free()

  // 插入新关联
  if (menuIds.length > 0) {
    const insertStmt = db.prepare('INSERT INTO role_menus (role, menu_id) VALUES (?, ?)')
    for (const menuId of menuIds) {
      insertStmt.bind([role, menuId])
      insertStmt.step()
    }
    insertStmt.free()
  }
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
