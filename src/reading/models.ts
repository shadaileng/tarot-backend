import type { ModelCache, QuotaExhaustedCache } from './types.js'
import { systemPrompt, buildUserPrompt } from './prompt.js'

const MODEL_PRIORITY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]

const MODEL_CACHE_TTL = 5 * 60 * 1000

let modelCache: ModelCache | null = null
let quotaExhaustedCache: QuotaExhaustedCache = {
  models: new Set(),
  date: '',
}

function checkAndResetQuotaCache(): void {
  const today = new Date().toISOString().slice(0, 10)
  if (quotaExhaustedCache.date !== today) {
    quotaExhaustedCache = { models: new Set(), date: today }
  }
}

function markModelQuotaExhausted(modelName: string): void {
  checkAndResetQuotaCache()
  quotaExhaustedCache.models.add(modelName)
}

function getAvailableModelsOrdered(availableModelNames: string[]): string[] {
  checkAndResetQuotaCache()
  const exhausted = quotaExhaustedCache.models
  const result: string[] = []

  for (const preferred of MODEL_PRIORITY) {
    if (
      !exhausted.has(preferred) &&
      (availableModelNames.includes(preferred) ||
        availableModelNames.some((m) => m.startsWith(preferred)))
    ) {
      result.push(preferred)
    }
  }

  for (const m of availableModelNames) {
    if (
      !result.includes(m) &&
      !exhausted.has(m) &&
      m.includes('flash') &&
      m.includes('gemini')
    ) {
      result.push(m)
    }
  }

  for (const m of availableModelNames) {
    if (!result.includes(m) && !exhausted.has(m) && m.includes('gemini')) {
      result.push(m)
    }
  }

  return result
}

function selectBestModel(availableModelNames: string[]): string | null {
  const ordered = getAvailableModelsOrdered(availableModelNames)
  return ordered.length > 0 ? ordered[0] : null
}

function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429) return true
  if (status === 503) return true
  if (status === 500) return true
  if (status === 403) {
    const lower = errorText.toLowerCase()
    if (
      lower.includes('quota') ||
      lower.includes('rate') ||
      lower.includes('limit') ||
      lower.includes('exhausted') ||
      lower.includes('billing')
    ) {
      return true
    }
  }
  return false
}

function shouldMarkQuotaExhausted(status: number): boolean {
  if (status === 503) return false
  if (status === 500) return false
  return true
}

async function fetchAvailableModels(apiKey: string): Promise<{ up: boolean; detail: string; models: string[] }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { method: 'GET' },
    )
    if (!res.ok) {
      return { up: false, detail: `Gemini API returned ${res.status}`, models: [] }
    }
    const data: any = await res.json()
    const models: string[] = (data.models || [])
      .filter(
        (m: any) =>
          m.supportedGenerationMethods &&
          m.supportedGenerationMethods.includes('generateContent'),
      )
      .map((m: any) => {
        const name: string = m.name || ''
        return name.replace(/^models\//, '')
      })
    return { up: true, detail: 'Gemini API available', models }
  } catch (e: any) {
    return { up: false, detail: e.message || 'Gemini API unreachable', models: [] }
  }
}

async function getCachedModels(apiKey: string): Promise<ModelCache> {
  const now = Date.now()
  if (modelCache && now - modelCache.timestamp < MODEL_CACHE_TTL) {
    return modelCache
  }
  const result = await fetchAvailableModels(apiKey)
  modelCache = {
    geminiUp: result.up,
    detail: result.detail,
    availableModels: result.models,
    timestamp: now,
  }
  return modelCache
}

export interface ReadingResult {
  success: boolean
  reading?: string
  model?: string
  incomplete?: boolean
  warning?: string
  status: number
  error?: string
  detail?: string
  exhaustedModels?: string[]
  lastGeminiStatus?: number
}

export async function callGeminiReading(apiKey: string, question: string, cards: any[]): Promise<ReadingResult> {
  const cardsInfo = cards
    .map(
      (c: any) =>
        `位置「${c.position}」：${c.name}（${c.isUpright ? '正位' : '逆位'}）
关键词：${c.keywords.join('、')}
通用含义：${c.isUpright ? c.uprightMeaning : c.reversedMeaning}`,
    )
    .join('\n\n')

  const userPrompt = buildUserPrompt(question, cardsInfo)

  const cache = await getCachedModels(apiKey)
  if (!cache.geminiUp || cache.availableModels.length === 0) {
    return { success: false, status: 502, error: 'No available Gemini model found' }
  }

  const modelsToTry = getAvailableModelsOrdered(cache.availableModels)
  if (modelsToTry.length === 0) {
    return {
      success: false,
      status: 429,
      error: 'All Gemini models quota exhausted',
      detail: 'All available models have reached their daily quota. Please try again tomorrow.',
      exhaustedModels: [...quotaExhaustedCache.models],
    }
  }

  let lastErrorStatus = 0
  let lastErrorText = ''
  let lastUsedModel = ''

  for (const model of modelsToTry) {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.8,
          },
        }),
      },
    )

    if (geminiResponse.ok) {
      const data: any = await geminiResponse.json()
      const reading = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const finishReason = data.candidates?.[0]?.finishReason || ''
      const truncated = finishReason === 'MAX_TOKENS'
      const hasSummary = /✨\s*\*{0,2}综合解读/.test(reading)
      const incomplete = truncated || !hasSummary

      const result: ReadingResult = {
        success: true,
        reading,
        model,
        incomplete,
        status: 200,
      }
      if (incomplete) {
        result.warning = truncated
          ? '解读可能不完整，AI 输出被 token 限制截断'
          : '解读格式不完整，缺少综合解读部分'
      }
      return result
    }

    const errorText = await geminiResponse.text()
    lastErrorStatus = geminiResponse.status
    lastErrorText = errorText
    lastUsedModel = model

    if (isRetryableError(geminiResponse.status, errorText)) {
      if (shouldMarkQuotaExhausted(geminiResponse.status)) {
        markModelQuotaExhausted(model)
      }
      continue
    }

    break
  }

  return {
    success: false,
    status: 502,
    error: 'AI service error',
    detail: lastErrorText.slice(0, 500),
    model: lastUsedModel,
    exhaustedModels: [...quotaExhaustedCache.models],
    lastGeminiStatus: lastErrorStatus,
  }
}

export { selectBestModel, getCachedModels, getAvailableModelsOrdered, quotaExhaustedCache }
