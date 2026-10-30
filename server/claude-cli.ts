import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Runs the Claude Code CLI signed in on this machine as the chat model, so no API key is
// needed. No tools are enabled and the model can only return reply JSON, so a prompt
// cannot make it touch files or run commands.

export interface ClaudeOptions {
  bin?: string
  binArgs?: string[] // placed before the CLI's own arguments (used by tests)
  model?: string
  effort?: string
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
  let envelope: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown }
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error('Claude Code returned output that is not JSON.')
  }
  if (envelope.is_error || envelope.subtype !== 'success') throw new Error(`Claude Code did not finish the reply: ${envelope.result ?? envelope.subtype ?? 'unknown'}`)
  if (envelope.structured_output !== undefined) return envelope.structured_output
  return JSON.parse(envelope.result || '')
}

function run(command: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const child = spawn(command, args, { cwd: workdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value = '') => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => { child.kill(); finish(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT) { child.kill(); finish(new Error('Claude Code returned too much output.')) }
    })
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
    child.stdin.on('error', () => { /* the process may exit before reading the whole prompt */ })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT'
        ? new ClaudeUnavailableError('The chat needs Claude Code on this computer. Install it, sign in, and restart the server.')
        : error)
    })
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout)
      else {
        const detail = (stderr.trim() || stdout.trim()).slice(0, 400)
        finish(/log ?in|auth|credential/i.test(detail)
          ? new ClaudeUnavailableError('Claude Code is not signed in. Run claude in a terminal, sign in, and try again.')
          : new Error(`Claude Code exited with code ${code}: ${detail}`))
      }
    })
    child.stdin.end(input)
  })
}
