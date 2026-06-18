export interface CardInput {
  position: string
  name: string
  isUpright: boolean
  uprightMeaning: string
  reversedMeaning: string
  keywords: string[]
}

export interface ReadingRequestBody {
  question: string
  cards: CardInput[]
}

export interface ModelCache {
  geminiUp: boolean
  detail: string
  availableModels: string[]
  timestamp: number
}

export interface QuotaExhaustedCache {
  models: Set<string>
  date: string
}
