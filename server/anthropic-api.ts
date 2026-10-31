import Anthropic from '@anthropic-ai/sdk'
import { ClaudeUnavailableError, type ClaudeRequest } from './claude-cli.ts'

// Runs the chat on the Anthropic API with the person's own key, instead of the signed-in
// CLI. The key stays on this server and every request is billed to it. As with the CLI, no
// tools are offered and the model can only return reply JSON.

export interface ApiKeyOptions {
  apiKey: string
  model?: string
  effort?: string
  fetch?: typeof fetch // replaces the network, for tests
}

// The same short names the CLI takes. Any other value is used as a full model name.
const MODELS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' }

// Dollars per million tokens, in and out, for the cost shown in the server's log.
const PRICES: Record<string, [number, number]> = {
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-opus-5-5': [4, 20],
}

export function logUsage(source: string, input: number, output: number, cost: number | null) {
  const dollars = cost === null ? '' : `, about $${cost.toFixed(3)}`
  console.log(`[clutch chat] ${source}: ${input} tokens in, ${output} out${dollars}`)
}

// A problem the person can fix gets its own message; anything else is reported generally.
function explain(error: unknown): Error {
  if (error instanceof Anthropic.APIUserAbortError) return new Error('aborted')
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeUnavailableError('The API key was rejected. Check ANTHROPIC_API_KEY in .env.local and restart the server.')
  }
  if (error instanceof Anthropic.RateLimitError) return new ClaudeUnavailableError('The API key has reached its rate limit. Wait a moment and try again.')
  if (error instanceof Anthropic.APIError && /credit balance/i.test(error.message)) {
    return new ClaudeUnavailableError('The API account is out of credits. Add some in the Claude Console and try again.')
  }
  return error as Error
}

export async function askAnthropic(request: ClaudeRequest, options: ApiKeyOptions): Promise<unknown> {
  const client = new Anthropic({ apiKey: options.apiKey, fetch: options.fetch })
  const name = options.model || 'sonnet'
  const model = MODELS[name] ?? name
  // Haiku has no server-side fallback. On the others, a request a safety check declines by
  // mistake is retried on another model instead of failing.
  const fallback = model.includes('haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
  let message: Anthropic.Beta.BetaMessage
  try {
    message = await client.beta.messages.stream({
      model,
      max_tokens: 64000,
      system: request.system,
      output_config: {
        effort: (options.effort || 'medium') as Anthropic.Beta.BetaOutputConfig['effort'],
        format: { type: 'json_schema', schema: request.schema as Record<string, unknown> },
      },
      messages: [{ role: 'user', content: request.prompt }],
      ...fallback,
    }, { signal: request.signal }).finalMessage()
  } catch (error) {
    throw explain(error)
  }
  const { input_tokens: input, output_tokens: output } = message.usage
  const price = PRICES[model]
  logUsage(`API ${model}`, input, output, price ? (input * price[0] + output * price[1]) / 1e6 : null)
  if (message.stop_reason === 'refusal') throw new ClaudeUnavailableError('The model declined that request. Try asking another way.')
  if (message.stop_reason !== 'end_turn') throw new Error(`The model stopped early: ${message.stop_reason}`)
  return JSON.parse(message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''))
}
