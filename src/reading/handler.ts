import type { Request, Response } from 'express'
import { config } from '../config.js'
import { callGeminiReading } from './models.js'
import { getLogger } from '../logger.js'
import type { ReadingRequestBody } from './types.js'

const log = getLogger('reading')

export async function readingHandler(req: Request, res: Response): Promise<void> {
  const requestLogger = log.child({ logId: (req as any).logId || 'unknown' })

  if (!config.geminiApiKey) {
    requestLogger.warn('GEMINI_API_KEY not configured — reading endpoint unavailable')
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }

  const body = req.body as ReadingRequestBody
  const { question, cards } = body

  if (!cards || cards.length === 0) {
    requestLogger.warn({ cardCount: cards?.length ?? 0 }, 'Invalid reading request: missing cards')
    res.status(400).json({ error: 'Missing cards' })
    return
  }

  try {
    const result = await callGeminiReading(config.geminiApiKey, question, cards)

    if (result.success) {
      if (result.incomplete) {
        requestLogger.warn({ model: result.model, warning: result.warning }, 'Reading succeeded but incomplete')
      }
      const responseBody: any = {
        reading: result.reading,
        model: result.model,
        incomplete: result.incomplete,
      }
      if (result.warning) {
        responseBody.warning = result.warning
      }
      res.json(responseBody)
    } else {
      requestLogger.warn({
        error: result.error,
        detail: result.detail?.slice(0, 200),
        model: result.model,
        geminiStatus: result.lastGeminiStatus,
        exhaustedModels: result.exhaustedModels,
      }, `Reading failed: ${result.error}`)
      res.status(result.status).json({
        error: result.error,
        detail: result.detail,
        status: result.lastGeminiStatus,
        model: result.model,
        exhaustedModels: result.exhaustedModels,
      })
    }
  } catch (error: any) {
    requestLogger.error({ err: error, stack: error.stack }, 'Unhandled error in reading handler')
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
}
