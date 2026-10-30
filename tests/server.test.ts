import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi, type ApiOptions } from '../server/api.ts'
import { askClaude, findClaude } from '../server/claude-cli.ts'
import { SCHEMA, SYSTEM } from '../server/prompt.ts'
import { COLORS } from '../src/core/colors.ts'
import { PARTS } from '../src/core/parts.ts'

async function withServer(options: ApiOptions, run: (url: string) => Promise<void>) {
  const api = createApi(options)
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void api(request, response, () => { response.writeHead(404); response.end() })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/clutch/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

const good = { reply: 'A brick.', actions: [{ tool: 'place', part: 'brick_2x4', color: 'red', at: [[0, 0, 0]] }] }
const floating = { reply: 'A floating brick.', actions: [{ tool: 'place', part: 'brick_2x4', color: 'red', at: [[0, 9, 0]] }] }

test('a clean reply goes straight through', async () => {
  const prompts: string[] = []
  await withServer({ ask: async (prompt) => { prompts.push(prompt); return good } }, async (url) => {
    const response = await post(url, { message: 'Build a brick', bricks: [] })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.reply, 'A brick.')
    assert.equal(data.attempts, 1)
    assert.equal(data.actions.length, 1)
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /The baseplate is empty/)
  assert.match(prompts[0], /Build a brick/)
})

test('a reply with floating pieces goes back once with the exact pieces, and the fix is used', async () => {
  const prompts: string[] = []
  const replies = [floating, good]
  await withServer({ ask: async (prompt) => { prompts.push(prompt); return replies.shift() } }, async (url) => {
    const data = await (await post(url, { message: 'Build', bricks: [] })).json()
    assert.equal(data.attempts, 2)
    assert.equal(data.reply, 'A brick.')
  })
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /brick_2x4 red rot 0 at \[0,9,0\]/)
})

test('a repair that is no better is dropped, and there is only one', async () => {
  let calls = 0
  await withServer({ ask: async () => { calls++; return floating } }, async (url) => {
    const data = await (await post(url, { message: 'Build', bricks: [] })).json()
    assert.equal(data.attempts, 1)
    assert.equal(data.reply, 'A floating brick.')
  })
  assert.equal(calls, 2)
})

test('a failed repair keeps the first answer', async () => {
  let calls = 0
  await withServer({ ask: async () => { if (calls++) throw new Error('nope'); return floating } }, async (url) => {
    const response = await post(url, { message: 'Build', bricks: [] })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).reply, 'A floating brick.')
  })
})

test('a question gets an answer with no actions and no repair', async () => {
  let calls = 0
  await withServer({ ask: async () => { calls++; return { reply: 'It looks solid.', actions: [] } } }, async (url) => {
    const data = await (await post(url, { message: 'Is this ok?', bricks: [] })).json()
    assert.equal(data.reply, 'It looks solid.')
  })
  assert.equal(calls, 1)
})

test('the build and the earlier chat reach the model', async () => {
  let prompt = ''
  await withServer({ ask: async (text) => { prompt = text; return { reply: 'ok', actions: [] } } }, async (url) => {
    await post(url, { message: 'Now paint it', history: [{ role: 'user', text: 'Make a wall' }, { role: 'model', text: 'Done' }], bricks: [[7, 'brick_2x4', 'red', 3, 0, 5, 1]] })
  })
  assert.match(prompt, /Person: Make a wall/)
  assert.match(prompt, /Clutch: Done/)
  assert.match(prompt, /brick_2x4 red rot1: #7@3,0,5/)
})

test('bad requests are refused and do not reach the model', async () => {
  let calls = 0
  await withServer({ ask: async () => { calls++; return good } }, async (url) => {
    assert.equal((await post(url, 'not json')).status, 400)
    assert.equal((await post(url, { message: '', bricks: [] })).status, 400)
    assert.equal((await post(url, { message: 'x'.repeat(5000), bricks: [] })).status, 400)
    assert.equal((await post(url, { message: 'hi', bricks: [[1, 'ghost', 'red', 0, 0, 0, 0]] })).status, 400)
    assert.equal((await post(url, { message: 'hi', bricks: [[1, 'brick_1x1', 'red', 99, 0, 0, 0]] })).status, 400)
    assert.equal((await post(url, { message: 'hi', bricks: [[1, 'brick_1x1', 'red', 0, 0, 0, 0], [2, 'brick_1x1', 'red', 0, 0, 0, 0]] })).status, 400)
    assert.equal((await post(url, { message: 'hi', history: 'no', bricks: [] })).status, 400)
    assert.equal((await fetch(`${url}/api/clutch/chat`, { method: 'GET' })).status, 405)
    assert.equal((await fetch(`${url}/api/clutch/chat`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415)
  })
  assert.equal(calls, 0)
})

test('other websites and other hosts cannot use the signed-in CLI', async () => {
  let calls = 0
  await withServer({ ask: async () => { calls++; return good } }, async (url) => {
    assert.equal((await post(url, { message: 'hi', bricks: [] }, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(url, { message: 'hi', bricks: [] }, { Origin: url })).status, 200)
  })
  assert.equal(calls, 1)
})

test('a model that returns junk gives a clear error and leaves the build alone', async () => {
  const logged = console.error
  console.error = () => {}
  try {
    await withServer({ ask: async () => ({ nonsense: true }) }, async (url) => {
      const response = await post(url, { message: 'hi', bricks: [] })
      assert.equal(response.status, 502)
      assert.match((await response.json()).error, /has not changed/)
    })
  } finally {
    console.error = logged
  }
})

test('status reports ready when a model is wired up, and unknown paths pass through', async () => {
  await withServer({ ask: async () => good, model: 'sonnet' }, async (url) => {
    const status = await (await fetch(`${url}/api/clutch/status`)).json()
    assert.equal(status.ready, true)
    assert.equal(status.model, 'Sonnet')
    assert.equal((await fetch(`${url}/nothing`)).status, 404)
  })
})

function fakeCli(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'clutch-fake-'))
  const file = join(dir, 'fake.mjs')
  writeFileSync(file, script)
  return { bin: process.execPath, binArgs: [file] }
}

test('the CLI runs with no tools, reads the prompt from stdin and returns structured output', async () => {
  const cli = fakeCli(`
    let input = ''
    process.stdin.on('data', (chunk) => { input += chunk })
    process.stdin.on('end', () => {
      const args = process.argv.slice(2)
      const value = (flag) => args[args.indexOf(flag) + 1]
      console.log(JSON.stringify({ is_error: false, subtype: 'success', structured_output: {
        input, tools: value('--tools'), model: value('--model'), effort: value('--effort'),
        hasPrompt: args.includes('--system-prompt-file'), noPersist: args.includes('--no-session-persistence'),
        strict: args.includes('--strict-mcp-config'),
      } }))
    })
  `)
  const out = await askClaude({ system: 'sys', prompt: 'build', schema: { type: 'object' } }, { ...cli, model: 'sonnet', effort: 'low' }) as Record<string, unknown>
  assert.deepEqual(out, { input: 'build', tools: '', model: 'sonnet', effort: 'low', hasPrompt: true, noPersist: true, strict: true })
})

test('CLI failures are told apart: not signed in, an error, and being stopped', async () => {
  const signedOut = fakeCli(`console.error('Please log in'); process.exit(1)`)
  await assert.rejects(askClaude({ system: 's', prompt: 'p', schema: {} }, signedOut), { name: 'ClaudeUnavailableError' })
  const broken = fakeCli(`console.error('boom'); process.exit(3)`)
  await assert.rejects(askClaude({ system: 's', prompt: 'p', schema: {} }, broken), /exited with code 3: boom/)
  const missing = { bin: join(tmpdir(), 'no-such-program-here') }
  await assert.rejects(askClaude({ system: 's', prompt: 'p', schema: {} }, missing), { name: 'ClaudeUnavailableError' })
  const slow = fakeCli(`setTimeout(() => {}, 60000)`)
  const controller = new AbortController()
  const pending = askClaude({ system: 's', prompt: 'p', schema: {}, signal: controller.signal }, slow)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /aborted/)
})

test('the prompt names every part and colour, and the schema matches its tools', () => {
  for (const part of PARTS) assert.ok(SYSTEM.includes(part.id), part.id)
  for (const color of COLORS) assert.ok(SYSTEM.includes(`${color.letter}=${color.id}`), color.id)
  const tools = (SCHEMA.properties.actions.items.properties.tool as { enum: string[] }).enum
  for (const tool of tools) assert.ok(SYSTEM.includes(`"tool":"${tool}"`), tool)
  assert.ok(findClaude())
})
