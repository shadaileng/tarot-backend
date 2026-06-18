// 海报相关类型定义
// 与前端 src/utils/poster/types.ts 保持一致

export interface PosterCardInput {
  /** 牌面图片 URL */
  image: string
  /** 牌名 */
  name: string
  /** 在牌阵中的位置 */
  position: string
  /** 正位/逆位 */
  orientation: 'upright' | 'reversed'
  /** 含义文本 */
  meaning: string
  /** 关键词 */
  keywords: string[]
  /** 花色类型（major/minor/court） */
  type: string
  /** 大阿卡纳序号（小阿卡纳为 -1） */
  number: number
}

/** 模板名称类型 */
export type TemplateName = 'default' | 'minimal' | 'wechat'

export interface PosterData {
  cards: PosterCardInput[]
  question: string
  spreadName: string
  interpretation?: string
  /** 综合解读文本（优先使用，由调用方提取/生成） */
  comprehensiveInterpretation?: string
  date: string
  /** 主题选择，默认 'dark' */
  theme?: 'dark' | 'light'
  /** 模板选择，默认 'default' */
  template?: TemplateName
}
