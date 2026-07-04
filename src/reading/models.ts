import type { ModelCache, QuotaExhaustedCache } from './types.js'
import { systemPrompt, buildUserPrompt } from './prompt.js'
import { getLogger } from '../logger.js'
import { fetchWithProxy } from '../fetch-proxy.js'

const log = getLogger('gemini')

const MODEL_PRIORITY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]

// 不支持 generateContent 文本输出的模型黑名单关键字
// -tts: 文本转语音（仅 AUDIO）
// -image / imagen-: 图像生成（仅 IMAGE/IMAGE+TEXT）
// embedding / text-embedding: 文本嵌入（仅 EMBEDDING）
// learnlm / gemma-: 专用领域或纯语言模型
const TEXT_MODEL_BLACKLIST_KEYWORDS = [
  '-tts',
  '-image',
  '-image-generation',
  'imagen-',
  '-embedding',
  'text-embedding',
  'embedding-001',
  'aqa',
  'roboflow',
  'robotics',
  'learnlm',
  'gemma-',
]

function isTextGenerationModel(modelName: string): boolean {
  const lower = modelName.toLowerCase()
  return !TEXT_MODEL_BLACKLIST_KEYWORDS.some((kw) => lower.includes(kw))
}

const MODEL_CACHE_TTL = 5 * 60 * 1000

let modelCache = new Map<string, ModelCache>()
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
  log.warn({ model: modelName, exhaustedCount: quotaExhaustedCache.models.size }, 'Model marked as quota exhausted')
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
      m.includes('gemini') &&
      isTextGenerationModel(m)
    ) {
      result.push(m)
    }
  }

  for (const m of availableModelNames) {
    if (!result.includes(m) && !exhausted.has(m) && m.includes('gemini') && isTextGenerationModel(m)) {
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
  // 模型本身不支持请求的功能（如 TTS 模型只支持 AUDIO，却被请求生成文本）
  if (status === 400) {
    const lower = errorText.toLowerCase()
    if (
      lower.includes('response_modalities') ||
      lower.includes('response modalities') ||
      lower.includes('invalid_argument') ||
      lower.includes('not supported by the model')
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
    const res = await fetchWithProxy(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { method: 'GET' },
    )
    if (!res.ok) {
      log.warn({ status: res.status }, 'Gemini model list fetch failed')
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
    log.info({ modelCount: models.length }, 'Gemini model list refreshed')
    return { up: true, detail: 'Gemini API available', models }
  } catch (e: any) {
    log.warn({ err: e }, 'Gemini model list fetch failed (network)')
    return { up: false, detail: e.message || 'Gemini API unreachable', models: [] }
  }
}

async function getCachedModels(apiKey: string): Promise<ModelCache> {
  const now = Date.now()
  const cached = modelCache.get(apiKey)
  if (cached && now - cached.timestamp < MODEL_CACHE_TTL) {
    return cached
  }
  const result = await fetchAvailableModels(apiKey)
  const entry: ModelCache = {
    geminiUp: result.up,
    detail: result.detail,
    availableModels: result.models,
    timestamp: now,
  }
  modelCache.set(apiKey, entry)
  return entry
}

/**
 * 获取 Gemini 健康状态（带缓存），同时返回当前选中的模型名
 * 当所有模型配额耗尽时，返回 allExhausted: true
 */
export async function getCachedGeminiHealth(apiKey: string): Promise<{
  up: boolean
  detail: string
  model: string | null
  allExhausted: boolean
}> {
  checkAndResetQuotaCache()
  const cache = await getCachedModels(apiKey)

  if (!cache.geminiUp) {
    return { up: false, detail: cache.detail, model: null, allExhausted: false }
  }

  const ordered = getAvailableModelsOrdered(cache.availableModels)
  if (ordered.length === 0) {
    // 有可用模型但全部被标记为配额耗尽
    return {
      up: true,
      detail: 'All models quota exhausted for today',
      model: null,
      allExhausted: true,
    }
  }

  return {
    up: true,
    detail: cache.detail,
    model: ordered[0],
    allExhausted: false,
  }
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

export async function callGeminiReading(
  apiKey: string,
  question: string | undefined,
  cards: any[],
  signal?: AbortSignal,
): Promise<ReadingResult> {
  const cardsInfo = cards
    .map(
      (c: any) =>
        `位置「${c.position}」：${c.name}（${c.isUpright ? '正位' : '逆位'}）
关键词：${c.keywords.join('、')}
通用含义：${c.isUpright ? c.uprightMeaning : c.reversedMeaning}`,
    )
    .join('\n\n')

  const userPrompt = buildUserPrompt(question || '', cardsInfo)

  const cache = await getCachedModels(apiKey)
  if (!cache.geminiUp || cache.availableModels.length === 0) {
    return { success: false, status: 502, error: 'No available Gemini model found' }
  }

  const modelsToTry = getAvailableModelsOrdered(cache.availableModels)
  if (modelsToTry.length === 0) {
    log.error({ exhaustedModels: [...quotaExhaustedCache.models] }, 'All Gemini models quota exhausted for today')
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
  let fallbackReading: { reading: string; model: string; incomplete: boolean; truncated: boolean } | null = null

  for (const model of modelsToTry) {
    let geminiResponse: Response
    try {
      geminiResponse = await fetchWithProxy(
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
          signal,
        },
      )
    } catch (err: any) {
      // AbortError：任务被取消，不重试，直接向上传播
      if (err.name === 'AbortError') throw err
      // 其他网络错误：尝试下一个模型
      log.warn({ model, err }, 'Gemini fetch failed, trying next model')
      lastErrorStatus = 0
      lastErrorText = err.message || 'Network error'
      lastUsedModel = model
      continue
    }

    if (geminiResponse.ok) {
      const data: any = await geminiResponse.json()
      const reading = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const finishReason = data.candidates?.[0]?.finishReason || ''
      const truncated = finishReason === 'MAX_TOKENS'
      const hasSummary = /✨\s*\*{0,2}综合解读/.test(reading)
      const incomplete = truncated || !hasSummary

      // 1. 空读解 → 视为失败，重试下一个模型
      if (!reading || reading.trim().length === 0) {
        log.warn({ model, finishReason }, 'Gemini returned empty reading, trying next model')
        continue
      }

      // 2. 不完整但有更多模型 → 保存结果，继续尝试获取更好的
      if (incomplete && modelsToTry.indexOf(model) < modelsToTry.length - 1) {
        log.warn({ model, readingLength: reading.length }, 'Reading incomplete, trying next model for better result')
        if (!fallbackReading) {
          fallbackReading = { reading, model, incomplete, truncated }
        }
        continue
      }

      log.info({ model, finishReason, incomplete, readingLength: reading.length }, 'Gemini reading generated successfully')

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

    const retryable = isRetryableError(geminiResponse.status, errorText)
    log.warn({
      model,
      status: geminiResponse.status,
      retryable,
      errorPreview: errorText.slice(0, 200),
    }, `Gemini model '${model}' returned ${geminiResponse.status}${retryable ? ' (will retry)' : ' (fatal)'}`)

    if (retryable) {
      if (shouldMarkQuotaExhausted(geminiResponse.status)) {
        markModelQuotaExhausted(model)
      }
      continue
    }

    break
  }

  // 所有模型都未能返回完整读解，但可能有 fallback（不完整的结果）
  if (fallbackReading) {
    log.warn({
      model: fallbackReading.model,
      readingLength: fallbackReading.reading.length,
    }, 'All models tried, returning best available (incomplete) reading')
    return {
      success: true,
      reading: fallbackReading.reading,
      model: fallbackReading.model,
      incomplete: true,
      status: 200,
      warning: fallbackReading.truncated
        ? '解读可能不完整，AI 输出被 token 限制截断'
        : '解读格式不完整，缺少综合解读部分',
    }
  }

  const exhaustedList = [...quotaExhaustedCache.models]
  log.error({
    lastModel: lastUsedModel,
    lastStatus: lastErrorStatus,
    exhaustedModels: exhaustedList,
    triedCount: modelsToTry.length,
  }, 'All Gemini models failed — giving up')

  return {
    success: false,
    status: 502,
    error: 'AI service error',
    detail: lastErrorText.slice(0, 500),
    model: lastUsedModel,
    exhaustedModels: exhaustedList,
    lastGeminiStatus: lastErrorStatus,
  }
}

/**
 * 绕过缓存，直接探测 Gemini 健康状态（结果会写回缓存以续期 TTL）
 * 适用于 ?noCache=1 等即时诊断场景
 */
export async function getGeminiHealthDirectly(apiKey: string): Promise<{
  up: boolean
  detail: string
  model: string | null
  allExhausted: boolean
}> {
  checkAndResetQuotaCache()
  // 跳过缓存，强制重新探测并写回
  const result = await fetchAvailableModels(apiKey)
  const now = Date.now()
  modelCache.set(apiKey, {
    geminiUp: result.up,
    detail: result.detail,
    availableModels: result.models,
    timestamp: now,
  })

  if (!result.up) {
    return { up: false, detail: result.detail, model: null, allExhausted: false }
  }

  const ordered = getAvailableModelsOrdered(result.models)
  if (ordered.length === 0) {
    return {
      up: true,
      detail: 'All models quota exhausted for today',
      model: null,
      allExhausted: true,
    }
  }

  return {
    up: true,
    detail: result.detail,
    model: ordered[0],
    allExhausted: false,
  }
}

export { selectBestModel, getCachedModels, getAvailableModelsOrdered, quotaExhaustedCache }
