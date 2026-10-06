import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Gemini wants `user` / `model` roles (not `assistant`) and a transcript
 * that starts on the customer. Merge consecutive turns and drop leading
 * assistant turns, mirroring the Anthropic adapter.
 */
function toGeminiContents(messages: ChatMessage[]) {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    merged.push({
      role: 'user',
      content: '(The customer has not sent a message yet.)',
    })
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google Gemini's generateContent endpoint with the caller's own
 * key (from Google AI Studio). Returns the raw assistant text + token
 * usage (handoff parsing happens in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: toGeminiContents(messages),
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    // Gemini reports a bad key as HTTP 400 "API key not valid", not 401,
    // so peek at the body and remap it so the "Test key" button shows
    // "invalid key" like the other providers.
    const bodyText = await res.clone().text().catch(() => '')
    if (res.status === 400 && /API[_ ]KEY[_ ]INVALID|API key not valid/i.test(bodyText)) {
      throw new AiError('Gemini rejected the API key', {
        code: 'invalid_key',
        status: 401,
      })
    }
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
