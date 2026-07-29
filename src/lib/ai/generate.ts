import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, SEND_IMAGE_RE, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, imageUrl, usage }`.
 * The sentinel can appear alone or trailing a partial reply; either way
 * we treat the turn as a handoff and strip the marker from any remaining
 * text. A `[[SEND_IMAGE:<url>]]` marker is captured the same way — first
 * one wins — and stripped. `usage` is passed straight through (null when
 * the provider didn't report it).
 *
 * Both markers are stripped unconditionally, for every caller: the draft
 * route hands `text` straight back to the composer, so a marker the
 * model emitted unprompted must never survive into user-visible text.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)

  // Trailing sentence punctuation is easy for a model to sweep into the
  // marker; it would otherwise break the exact-match check the caller
  // uses to verify the URL came from the knowledge base.
  const imageUrl =
    raw.match(SEND_IMAGE_RE)?.[1].replace(/[.,;:!?]+$/, '') ?? null

  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .replace(new RegExp(SEND_IMAGE_RE.source, 'g'), '')
    .trim()

  return { text, handoff, imageUrl, usage }
}
