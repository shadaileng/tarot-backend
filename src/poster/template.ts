// 海报 HTML 模板生成
// 数据预处理 + 牌面循环 + AI 解读提取，最终交给 engine 渲染

import fs from 'node:fs'
import path from 'node:path'
import type { PosterData, PosterCardInput } from './types.js'
import { renderTemplate } from './engine.js'
import { getTheme, themeToCSSVars } from './theme.js'
import { getTemplate } from './templates/index.js'
import { getLogger } from '../logger.js'

const log = getLogger('Template')

/** assets/cards 目录的绝对路径 */
const CARDS_DIR = path.resolve(import.meta.dirname, '../../assets/cards')

/** 从 card.image 中提取文件名，读取 SVG 并转为 Base64 Data URI（零网络依赖） */
function resolveCardImage(card: PosterCardInput): string {
  const fileName = card.image.split('/').pop() || ''
  const filePath = path.join(CARDS_DIR, fileName)

  try {
    const svgContent = fs.readFileSync(filePath, 'utf-8')
    const base64 = Buffer.from(svgContent).toString('base64')
    return `data:image/svg+xml;base64,${base64}`
  } catch (err) {
    log.error({ err, filePath }, 'Failed to read card SVG')
    // 返回一个占位 data URI（灰色方块），避免海报渲染中断
    const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="260" viewBox="0 0 160 260"><rect width="160" height="260" fill="#2a2a3e"/><text x="80" y="130" text-anchor="middle" fill="#555" font-size="14" font-family="sans-serif">暂无图片</text></svg>`
    const base64 = Buffer.from(placeholderSvg).toString('base64')
    return `data:image/svg+xml;base64,${base64}`
  }
}

/** 提取 "✨ 综合解读" 之后的内容，去掉前面逐张牌的个性化解读 */
function extractComprehensivePart(interpretation: string): string {
  const marker = '✨ 综合解读'
  const idx = interpretation.lastIndexOf(marker)
  if (idx === -1) return interpretation
  const after = interpretation.substring(idx + marker.length).trim()
  return after
}

/** 生成单张牌的 HTML 片段 */
function generateCardHTML(card: PosterCardInput): string {
  const isReversed = card.orientation === 'reversed'
  const keywordsStr = card.keywords.slice(0, 4).join(' · ')
  const cardSrc = resolveCardImage(card)

  return `
    <div class="card-item">
      <div class="card-position">${escapeHTML(card.position)}</div>
      <div class="card-image-wrap ${isReversed ? 'reversed' : ''}">
        <img class="card-image" src="${escapeHTML(cardSrc)}" alt="${escapeHTML(card.name)}" />
        <div class="card-badge ${card.orientation}">${isReversed ? '逆位' : '正位'}</div>
      </div>
      <div class="card-name">${escapeHTML(card.name)}</div>
      <div class="card-keywords">${escapeHTML(keywordsStr)}</div>
      <div class="card-meaning">${escapeHTML(card.meaning)}</div>
    </div>`
}

/** 生成解读区域的 HTML 片段 */
function generateInterpretationHTML(data: PosterData): string {
  const comprehensiveText = data.comprehensiveInterpretation || extractComprehensivePart(data.interpretation || '') || ''
  if (!comprehensiveText) return ''

  return `<div class="interpretation-section">
         <div class="section-title">✨ 综合解读</div>
         <div class="interpretation-text">${escapeHTML(comprehensiveText)}</div>
       </div>`
}

/**
 * 构建海报 HTML
 * 数据预处理 + 牌面循环在 TypeScript 侧完成，
 * 最终由 renderTemplate() 注入到模板文件
 */
export function buildPosterHTML(data: PosterData): string {
  const template = getTemplate(data.template)
  const cardsHTML = data.cards.map(generateCardHTML).join('')
  const interpretationHTML = generateInterpretationHTML(data)

  // 如果没有指定 theme，使用模板默认主题
  const theme = getTheme(data.theme || template.defaultTheme)
  const themeCSSVars = themeToCSSVars(theme)

  return renderTemplate(template.html, template.css, {
    spreadName: data.spreadName,
    date: data.date,
    question: data.question,
    cardsHTML,
    interpretationHTML,
  }, themeCSSVars)
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
