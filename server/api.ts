import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { applyActions, verdictFor, type ApplyResult } from '../src/core/actions.ts'
import { describeBuild } from '../src/core/describe.ts'
import { Grid } from '../src/core/grid.ts'
import { MAX_PIECES, isRot, type Brick } from '../src/core/model.ts'
import { COLOR } from '../src/core/colors.ts'
import { PART } from '../src/core/parts.ts'
import { askClaude, findClaude, type ClaudeOptions } from './claude-cli.ts'
import { SCHEMA, SYSTEM } from './prompt.ts'

export type Ask = (prompt: string, signal: AbortSignal) => Promise<unknown>

export interface ApiOptions extends ClaudeOptions {
  ask?: Ask // replaces the CLI, for tests
}

const TIMEOUT = 240000

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<string> {
  let input = ''
  for await (const chunk of request) {
    input += chunk.toString()
    if (input.length > 600000) throw new Error('too large')
  }
  return input
}

function parseBricks(rows: unknown): Brick[] {
  if (!Array.isArray(rows) || rows.length > MAX_PIECES) throw new Error('bad build')
  const grid = new Grid()
  for (const row of rows) {
    const [id, part, color, x, y, z, rot] = (Array.isArray(row) ? row : []) as unknown[]
    if (!Number.isInteger(id) || (id as number) < 1) throw new Error('bad piece')
    if (typeof part !== 'string' || !PART.has(part) || typeof color !== 'string' || !COLOR.has(color) || !isRot(rot)) throw new Error('bad piece')
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) throw new Error('bad piece')
    if (!grid.fits(part, x as number, y as number, z as number, rot).ok) throw new Error('bad piece')
    grid.add({ id: id as number, part, color, x: x as number, y: y as number, z: z as number, rot })
  }
  return [...grid.bricks.values()]
}

function buildPrompt(message: string, history: Array<{ role: string; text: string }>, bricks: Brick[]) {
  const earlier = history.map((entry) => `${entry.role === 'user' ? 'Person' : 'Clutch'}: ${entry.text}`).join('\n\n')
  return `${earlier ? `Earlier in this chat:\n${earlier}\n\n` : ''}The build right now:\n${describeBuild(bricks)}\n\nRequest:\n${message}`
}

function repairPrompt(original: string, reply: unknown, problems: string[]) {
  return `${original}\n\nYour previous answer was:\n${JSON.stringify(reply)}\n\nIt has these problems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nSend the whole answer again with these fixed. Remember that y counts plates and a brick is 3 tall, that pieces cannot overlap, and that every piece needs a stud under it (or a stud-gripping piece above) in a chain back to the baseplate.`
}

interface Answer {
  reply: string
  actions: unknown[]
}

function readAnswer(value: unknown): Answer {
  const answer = value as Partial<Answer> | null
  if (!answer || typeof answer.reply !== 'string' || !Array.isArray(answer.actions)) throw new Error('The model did not return a reply and actions.')
  return { reply: answer.reply, actions: answer.actions }
}

const score = (result: ApplyResult) => result.errors.length + result.loose.length

export function createChatHandler(options: ApiOptions = {}) {
  const ask: Ask = options.ask ?? ((prompt, signal) => askClaude({ system: SYSTEM, prompt, schema: SCHEMA, signal }, options))
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed.' }); return }
    if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'Send application/json.' }); return }

    let message: string, history: Array<{ role: string; text: string }>, bricks: Brick[]
    try {
      const body = JSON.parse(await readBody(request))
      message = body?.message
      if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new Error('bad message')
      history = body.history ?? []
      if (!Array.isArray(history) || history.length > 12) throw new Error('bad history')
      if (history.some((entry) => !entry || !['user', 'model'].includes(entry.role) || typeof entry.text !== 'string' || entry.text.length > 8000)) throw new Error('bad history')
      bricks = parseBricks(body.bricks)
    } catch {
      json(response, 400, { error: 'That request could not be read. Your build has not changed.' })
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT)
    const cancel = () => { if (!response.writableEnded) controller.abort() }
    response.on('close', cancel)
    try {
      const prompt = buildPrompt(message, history, bricks)
      let answer = readAnswer(await ask(prompt, controller.signal))
      let attempts = 1
      let result = applyActions(bricks, answer.actions)
      // Collisions and floating pieces go back to the model once.
      if (answer.actions.length && !verdictFor(result).ok) {
        try {
          const second = readAnswer(await ask(repairPrompt(prompt, answer, verdictFor(result).problems), controller.signal))
          const retried = applyActions(bricks, second.actions)
          if (second.actions.length && score(retried) < score(result)) {
            answer = second
            result = retried
            attempts = 2
          }
        } catch (error) {
          if (controller.signal.aborted) throw error
          // The first answer stands, and its problems show on the check card.
        }
      }
      json(response, 200, { reply: answer.reply, actions: answer.actions, attempts })
    } catch (error) {
      if ((error as Error).name === 'ClaudeUnavailableError') json(response, 503, { error: (error as Error).message })
      else if (controller.signal.aborted) json(response, 504, { error: 'That took too long. Try asking for something smaller. Your build has not changed.' })
      else {
        console.error('[clutch chat]', (error as Error).message)
        json(response, 502, { error: 'The chat could not return a valid build. Your build has not changed. Try again.' })
      }
    } finally {
      clearTimeout(timeout)
      response.off('close', cancel)
    }
  }
}

export function createApi(options: ApiOptions = {}) {
  const chat = createChatHandler(options)
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = request.url?.split('?')[0]
    if (path !== '/api/clutch/chat' && path !== '/api/clutch/status') { next(); return }
    // Only this machine's own editor may use the signed-in CLI.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(request.headers.host ?? '')) { json(response, 403, { error: 'Use the local address to reach Clutch.' }); return }
    const origin = request.headers.origin
    if (origin && origin !== `http://${request.headers.host}`) { json(response, 403, { error: 'Only this editor can use the chat.' }); return }
    if (path === '/api/clutch/chat') { await chat(request, response); return }
    const model = options.model || 'sonnet'
    json(response, 200, { ready: Boolean(options.ask) || options.bin !== undefined || findClaude() !== 'claude' || process.platform !== 'win32', model: model[0].toUpperCase() + model.slice(1), error: 'The chat needs Claude Code on this computer.' })
  }
}

export function clutchApi(options: ApiOptions = {}): Plugin {
  return {
    name: 'clutch-local-api',
    configureServer(server) { server.middlewares.use(createApi(options)) },
    configurePreviewServer(server) { server.middlewares.use(createApi(options)) },
  }
}
