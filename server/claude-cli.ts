import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { logUsage } from './anthropic-api.ts'

// Runs the Claude Code CLI signed in on this machine as the chat model, which needs no API
// key. It is the default; anthropic-api.ts takes over when a key is set. No tools are enabled and the model can only return reply JSON, so a prompt
// cannot make it touch files or run commands.

export interface ClaudeOptions {
  bin?: string
  binArgs?: string[] // placed before the CLI's own arguments (used by tests)
  model?: string
  effort?: string
  onModel?: (id: string) => void // told which model actually answered
}

export interface ClaudeRequest {
  system: string
  prompt: string
  schema: object
  signal?: AbortSignal
}

export class ClaudeUnavailableError extends Error {
  name = 'ClaudeUnavailableError'
}

const MAX_OUTPUT = 8 * 1024 * 1024

// A folder with no project files, so the CLI does not pick up a repo's settings.
function workdir() {
  const dir = join(tmpdir(), 'clutch-claude')
  mkdirSync(dir, { recursive: true })
  return dir
}

// A long system prompt goes in a file: command lines have a length limit on Windows.
function promptFile(system: string) {
  const name = `system-${createHash('sha1').update(system).digest('hex').slice(0, 12)}.txt`
  const file = join(workdir(), name)
  if (!existsSync(file)) writeFileSync(file, system)
  return file
}

// On Windows, npm installs `claude` as a .cmd wrapper, which Node cannot start directly
// and which has a much shorter command line limit. Find the real program behind it.
export function findClaude(): string {
  if (process.platform !== 'win32') return 'claude'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const exe = join(dir, 'claude.exe')
    if (existsSync(exe)) return exe
    if (existsSync(join(dir, 'claude.cmd'))) {
      const inner = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      if (existsSync(inner)) return inner
    }
  }
  return 'claude'
}

// Whether Claude Code is installed and signed in. This reads local state and makes no AI call.
// A version that cannot answer the question counts as ready, and a real problem still shows
// up when a message is sent.
export function checkClaude(options: ClaudeOptions = {}): Promise<'ready' | 'missing' | 'signed-out'> {
  return new Promise((resolve) => {
    execFile(options.bin || findClaude(), [...(options.binArgs ?? []), 'auth', 'status', '--json'], { cwd: workdir(), windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error?.code === 'ENOENT') { resolve('missing'); return }
      try {
        resolve(JSON.parse(stdout).loggedIn === false ? 'signed-out' : 'ready')
      } catch {
        resolve('ready')
      }
    })
  })
}

export async function askClaude(request: ClaudeRequest, options: ClaudeOptions = {}): Promise<unknown> {
  const args = [
    '-p', '--output-format', 'json',
    '--json-schema', JSON.stringify(request.schema),
    '--system-prompt-file', promptFile(request.system),
    '--model', options.model || 'sonnet',
    '--effort', options.effort || 'medium',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
  ]
  const stdout = await run(options.bin || findClaude(), [...(options.binArgs ?? []), ...args], request.prompt, request.signal)
  let envelope: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; total_cost_usd?: number; usage?: { input_tokens: number; output_tokens: number }; modelUsage?: Record<string, unknown> }
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error('Claude Code returned output that is not JSON.')
  }
  const answered = Object.keys(envelope.modelUsage ?? {})[0]
  if (answered) options.onModel?.(answered)
  // What the same request would cost on an API key. The signed-in plan is not charged per request.
  if (envelope.usage) logUsage(`CLI ${options.model || 'sonnet'}`, envelope.usage.input_tokens, envelope.usage.output_tokens, envelope.total_cost_usd ?? null)
  if (envelope.is_error || envelope.subtype !== 'success') throw new Error(`Claude Code did not finish the reply: ${envelope.result ?? envelope.subtype ?? 'unknown'}`)
  if (envelope.structured_output !== undefined) return envelope.structured_output
  return JSON.parse(envelope.result || '')
}

function run(command: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: workdir(), windowsHide: true, maxBuffer: MAX_OUTPUT, signal }, (error, stdout, stderr) => {
      if (error) reject(explain(error, stderr || stdout))
      else resolve(stdout)
    })
    child.stdin?.on('error', () => { /* the process may exit before reading the whole prompt */ })
    child.stdin?.end(input)
  })
}

function explain(error: ExecFileException, output: string): Error {
  if (error.name === 'AbortError') return new Error('aborted')
  if (error.code === 'ENOENT') return new ClaudeUnavailableError('The chat is not connected. Install Claude Code and sign in, or add an API key to .env.local and restart the server.')
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('Claude Code returned too much output.')
  const detail = output.trim().slice(0, 400)
  if (/log ?in|auth|credential/i.test(detail)) return new ClaudeUnavailableError('Claude Code is not signed in. Run claude in a terminal and sign in, or add an API key to .env.local and restart the server.')
  return new Error(`Claude Code exited with code ${error.code}: ${detail}`)
}
