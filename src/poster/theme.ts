// 主题令牌系统
// 定义 PosterTheme 接口、dark/light 预设、CSS 变量生成工具

/** 主题类型 */
export type ThemeName = 'dark' | 'light'

/** 颜色值（纯色或渐变） */
export type ColorValue = string

/** 海报主题令牌定义 */
export interface PosterTheme {
  /** 主题名称 */
  name: ThemeName
  /** 颜色令牌 */
  colors: {
    /** 页面背景色 */
    bg: ColorValue
    /** 页面渐变背景（body 使用） */
    bgGradient: ColorValue
    /** 主文字色 */
    text: ColorValue
    /** 次要文字色（透明度由 CSS 控制，这里存基色） */
    textSecondary: ColorValue
    /** 强调色（金色） */
    accent: ColorValue
    /** 强调色光晕 */
    accentGlow: ColorValue
    /** 文字色 RGB 基值（逗号分隔，如 "224, 216, 200"） */
    rgbText: string
    /** 强调色 RGB 基值 */
    rgbAccent: string
    /** 表面色 RGB 基值（用于半透明叠加层） */
    rgbSurface: string
    /** 阴影色 RGB 基值 */
    rgbShadow: string
  }
  /** 排版令牌 */
  typography: {
    fontFamily: string
    fontSizeTitle: string
    fontWeightTitle: string
    fontSizeBody: string
    lineHeightBody: string
  }
  /** 间距令牌 */
  spacing: {
    pageV: string
    pageH: string
    cardGap: string
    sectionGap: string
  }
  /** 圆角令牌 */
  radius: {
    card: string
    section: string
  }
}

// ============================================================
// 暗黑主题（与当前默认样式完全一致）
// ============================================================
const darkTheme: PosterTheme = {
  name: 'dark',
  colors: {
    bg: '#0a0a1a',
    bgGradient: 'linear-gradient(160deg, #0a0a1a 0%, #1a1a2e 40%, #16213e 100%)',
    text: '#e0d8c8',
    textSecondary: 'rgba(224, 216, 200, 0.5)',
    accent: '#d4af37',
    accentGlow: '0 0 30px rgba(212, 175, 55, 0.2)',
    rgbText: '224, 216, 200',
    rgbAccent: '212, 175, 55',
    rgbSurface: '255, 255, 255',
    rgbShadow: '0, 0, 0',
  },
  typography: {
    fontFamily: "'Noto Serif SC', 'SimSun', 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', serif",
    fontSizeTitle: '36px',
    fontWeightTitle: '700',
    fontSizeBody: '15px',
    lineHeightBody: '1.8',
  },
  spacing: {
    pageV: '60px',
    pageH: '50px',
    cardGap: '28px',
    sectionGap: '40px',
  },
  radius: {
    card: '10px',
    section: '12px',
  },
}

// ============================================================
// 明亮主题
// ============================================================
const lightTheme: PosterTheme = {
  name: 'light',
  colors: {
    bg: '#faf6ef',
    bgGradient: 'linear-gradient(160deg, #faf6ef 0%, #f0e8d8 40%, #f5ede0 100%)',
    text: '#2c2416',
    textSecondary: 'rgba(44, 36, 22, 0.45)',
    accent: '#8b6914',
    accentGlow: '0 0 30px rgba(139, 105, 20, 0.15)',
    rgbText: '44, 36, 22',
    rgbAccent: '139, 105, 20',
    rgbSurface: '44, 36, 22',
    rgbShadow: '0, 0, 0',
  },
  typography: {
    fontFamily: "'Noto Serif SC', 'SimSun', 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', serif",
    fontSizeTitle: '36px',
    fontWeightTitle: '700',
    fontSizeBody: '15px',
    lineHeightBody: '1.8',
  },
  spacing: {
    pageV: '60px',
    pageH: '50px',
    cardGap: '28px',
    sectionGap: '40px',
  },
  radius: {
    card: '10px',
    section: '12px',
  },
}

// ============================================================
// 主题注册表
// ============================================================
const themeRegistry: Record<ThemeName, PosterTheme> = {
  dark: darkTheme,
  light: lightTheme,
}

/**
 * 根据主题名获取 PosterTheme 对象
 * @param name 主题名，默认 'dark'
 */
export function getTheme(name?: ThemeName | string): PosterTheme {
  if (name && name in themeRegistry) {
    return themeRegistry[name as ThemeName]
  }
  return darkTheme
}

/**
 * 将 PosterTheme 转换为 CSS 自定义属性字符串
 * 用于注入到 <style> 块中
 */
export function themeToCSSVars(theme: PosterTheme): string {
  const lines: string[] = []

  // 颜色
  lines.push(`  --t-color-bg: ${theme.colors.bg};`)
  lines.push(`  --t-color-bg-gradient: ${theme.colors.bgGradient};`)
  lines.push(`  --t-color-text: ${theme.colors.text};`)
  lines.push(`  --t-color-text-secondary: ${theme.colors.textSecondary};`)
  lines.push(`  --t-color-accent: ${theme.colors.accent};`)
  lines.push(`  --t-color-accent-glow: ${theme.colors.accentGlow};`)
  lines.push(`  --t-rgb-text: ${theme.colors.rgbText};`)
  lines.push(`  --t-rgb-accent: ${theme.colors.rgbAccent};`)
  lines.push(`  --t-rgb-surface: ${theme.colors.rgbSurface};`)
  lines.push(`  --t-rgb-shadow: ${theme.colors.rgbShadow};`)

  // 排版
  lines.push(`  --t-font-family: ${theme.typography.fontFamily};`)
  lines.push(`  --t-font-size-title: ${theme.typography.fontSizeTitle};`)
  lines.push(`  --t-font-weight-title: ${theme.typography.fontWeightTitle};`)
  lines.push(`  --t-font-size-body: ${theme.typography.fontSizeBody};`)
  lines.push(`  --t-line-height-body: ${theme.typography.lineHeightBody};`)

  // 间距
  lines.push(`  --t-spacing-page-v: ${theme.spacing.pageV};`)
  lines.push(`  --t-spacing-page-h: ${theme.spacing.pageH};`)
  lines.push(`  --t-spacing-card-gap: ${theme.spacing.cardGap};`)
  lines.push(`  --t-spacing-section-gap: ${theme.spacing.sectionGap};`)

  // 圆角
  lines.push(`  --t-radius-card: ${theme.radius.card};`)
  lines.push(`  --t-radius-section: ${theme.radius.section};`)

  return `:root {\n${lines.join('\n')}\n}`
}
