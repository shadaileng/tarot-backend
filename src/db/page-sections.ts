import { getDb } from './index.js'

export interface PageSectionRow {
  id: string
  page_key: string
  section_key: string
  label: string
  visible: number
  updated_at: string
}

export async function getAllPageSections(): Promise<PageSectionRow[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM page_section_visibility ORDER BY page_key, id')
  const rows: PageSectionRow[] = []
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as PageSectionRow)
  stmt.free()
  return rows
}

export async function getPageSectionsByPage(pageKey: string): Promise<PageSectionRow[]> {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM page_section_visibility WHERE page_key = ? ORDER BY id')
  stmt.bind([pageKey])
  const rows: PageSectionRow[] = []
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as PageSectionRow)
  stmt.free()
  return rows
}

export async function updatePageSectionVisibility(id: string, visible: number): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  db.run('UPDATE page_section_visibility SET visible = ?, updated_at = ? WHERE id = ?', [visible, now, id])
}
