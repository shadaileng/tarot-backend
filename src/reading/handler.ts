import type { Request, Response } from 'express'
import { config } from '../config.js'
import { callGeminiReading } from './models.js'
import type { ReadingRequestBody } from './types.js'

export async function readingHandler(req: Request, res: Response): Promise<void> {
  if (!config.geminiApiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }

  const body = req.body as ReadingRequestBody
  const { question, cards } = body

  if (!question || !cards || cards.length === 0) {
    res.status(400).json({ error: 'Missing question or cards' })
    return
  }

  try {
    const result = await callGeminiReading(config.geminiApiKey, question, cards)

    if (result.success) {
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
      res.status(result.status).json({
        error: result.error,
        detail: result.detail,
        model: result.model,
        exhaustedModels: result.exhaustedModels,
      })
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
}
