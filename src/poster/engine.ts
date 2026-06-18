// 模板加载 + 变量注入引擎
// 零依赖，纯正则替换实现

import fs from 'node:fs'
import path from 'node:path'

/** 模板文件目录 */
const TEMPLATES_DIR = path.resolve(import.meta.dirname, 'templates')

/** 模板变量映射 */
type TemplateVars = Record<string, string>

/** 模板缓存（生产模式使用，避免每次 fs.readFileSync） */
const templateCache = new Map<string, string>()

/** 是否开发模式 */
const isDev = process.env.NODE_ENV !== 'production'

/**
 * 读取模板文件
 * - 开发模式：每次重新读取（修改立即生效）
 * - 生产模式：首次读取后缓存到内存
 */
function readTemplate(filename: string): string {
  if (!isDev && templateCache.has(filename)) {
    return templateCache.get(filename)!
  }
  const filePath = path.join(TEMPLATES_DIR, filename)
  const content = fs.readFileSync(filePath, 'utf-8')
  if (!isDev) {
    templateCache.set(filename, content)
  }
  return content
}

/**
 * 模板渲染引擎
 *
 * 支持两种占位符语法：
 * - {{ key }}    → HTML 转义后替换（用于用户输入文本）
 * - {{{ key }}}  → 原样注入（用于预编译的 HTML 片段）
 *
 * 特殊占位符 {{ css }} 会将 CSS 文件内容注入
 *
 * @param templateFile 模板文件名（如 'default.html'）
 * @param cssFile      CSS 文件名（如 'default.css'）
 * @param vars         模板变量映射
 */
export function renderTemplate(
  templateFile: string,
  cssFile: string,
  vars: TemplateVars,
  themeCSSVars?: string,
): string {
  let html = readTemplate(templateFile)
  const css = readTemplate(cssFile)

  // 注入 CSS 自定义属性到 <style> 占位符（在 CSS 内容之前，不转义）
  if (themeCSSVars) {
    html = html.replace('{{ themeCSSVars }}', themeCSSVars)
  }

  // 注入 CSS 到 <style> 占位符
  html = html.replace('{{ css }}', css)

  // 先替换 {{{ raw }}}（不转义），避免被后续 {{ escaped }} 的正则误匹配
  html = html.replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_, key: string) => {
    return vars[key] ?? ''
  })

  // 替换 {{ escaped }}（HTML 转义）
  html = html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const val = vars[key] ?? ''
    return escapeHTML(val)
  })

  return html
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
