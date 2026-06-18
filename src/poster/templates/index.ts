// 模板注册表
// 根据模板名返回对应的 HTML/CSS 文件名、宽度和默认主题

import type { TemplateName } from '../types.js'

export interface TemplateMeta {
  name: string
  html: string
  css: string
  width: number
  defaultTheme: string
}

const registry: Record<TemplateName, TemplateMeta> = {
  default: {
    name: 'default',
    html: 'default.html',
    css: 'default.css',
    width: 750,
    defaultTheme: 'dark',
  },
  minimal: {
    name: 'minimal',
    html: 'minimal.html',
    css: 'minimal.css',
    width: 750,
    defaultTheme: 'light',
  },
  wechat: {
    name: 'wechat',
    html: 'wechat.html',
    css: 'wechat.css',
    width: 1080,
    defaultTheme: 'dark',
  },
}

export function getTemplate(name?: string): TemplateMeta {
  if (name && registry[name as TemplateName]) {
    return registry[name as TemplateName]
  }
  return registry.default
}
