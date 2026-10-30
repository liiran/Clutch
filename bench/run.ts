// Sends real requests through the real editor and chat, applies what comes back, checks
// the result and saves a picture of each, so build quality can be measured and seen.
//
//   npm run dev                 (in another window)
//   npm run bench               every case, once
//   npm run bench -- house car  only these cases
//
// Results go to bench/results/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, open, wait, type OpenPage } from '../tests/e2e/harness.ts'

interface Case {
  id: string
  prompt: string
  min: number      // the fewest pieces a real attempt would take
  parts?: RegExp[] // part ids the build must include
}

const CASES: Case[] = [
  { id: 'house', prompt: 'Build a small house with a red roof, a door and two windows.', min: 60, parts: [/door/, /window/, /slope|ridge/] },
  { id: 'car', prompt: 'Build a red racing car.', min: 15, parts: [/wheels/] },
  { id: 'tower', prompt: 'Build a castle tower with battlements and an arched gate.', min: 60, parts: [/arch/] },
  { id: 'tree', prompt: 'Build a tree with a brown trunk and green leaves, with a few flowers around it.', min: 15, parts: [/flower/] },
  { id: 'duck', prompt: 'Build a yellow rubber duck.', min: 15 },
  { id: 'rocket', prompt: 'Build a rocket on a launch pad.', min: 20 },
  { id: 'robot', prompt: 'Build a friendly robot standing up.', min: 20 },
  { id: 'bridge', prompt: 'Build a stone bridge over a blue river.', min: 30 },
  { id: 'edit', prompt: 'Build a small white house with a blue roof.', min: 40, parts: [/slope|ridge/] },
]

const FOLLOW_UP: Record<string, string> = {
  edit: 'Make the roof green and add a tree next to the house.',
}

const argv = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const cases = argv.length ? CASES.filter((item) => argv.includes(item.id)) : CASES
const POOL = Number(process.env.CLUTCH_BENCH_POOL || 3)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dir = new URL(`./results/${stamp}/`, import.meta.url)
mkdirSync(dir, { recursive: true })
const file = (name: string) => new URL(name, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function say(page: OpenPage, text: string) {
  const t0 = Date.now()
  await page.evaluate((message) => { void (window as any).clutch.chat.ask(message) }, text)
  await page.waitForFunction(() => !document.getElementById('chat-send')!.classList.contains('is-stop'), { timeout: 600000, polling: 300 })
  return page.evaluate((seconds) => {
    const verdicts = [...document.querySelectorAll('.verify')]
    const last = verdicts[verdicts.length - 1] as HTMLElement | undefined
    const messages = [...document.querySelectorAll('.chat-msg.ai, .chat-msg.system')]
    return {
      seconds,
      reply: (messages[messages.length - 1] as HTMLElement | undefined)?.innerText ?? '',
      verdict: last?.innerText ?? null,
      ok: last?.classList.contains('ok') ?? false,
      pending: !document.getElementById('chat-pending')!.hidden,
      changes: document.getElementById('chat-pending-count')!.textContent,
    }
  }, Math.round((Date.now() - t0) / 1000))
}

const browser = await launch(true)
const results: unknown[] = []
const queue = [...cases]
await Promise.all(Array.from({ length: POOL }, async () => {
  while (queue.length) {
    const item = queue.shift()!
    const page = await open(browser, '/?edit', { width: 1280, height: 800 })
    let result: Record<string, unknown> = { id: item.id }
    try {
      let answer = await say(page, item.prompt)
      result = { ...result, ...answer }
      if (answer.pending) {
        await page.screenshot({ path: file(`${item.id}-preview.png`) as `${string}.png` })
        await page.evaluate(() => (window as any).clutch.chat.accept())
        await wait(3400)
      }
      const follow = FOLLOW_UP[item.id]
      if (follow && answer.pending) {
        answer = await say(page, follow)
        result = { ...result, followUp: answer }
        if (answer.pending) {
          await page.evaluate(() => (window as any).clutch.chat.accept())
          await wait(3400)
        }
      }
      const state = await page.evaluate(() => {
        const { store } = (window as any).clutch
        const bricks = store.bricks
        return {
          pieces: bricks.length,
          loose: store.grid.loose().length,
          kinds: [...new Set(bricks.map((b: { part: string }) => b.part))] as string[],
          colors: [...new Set(bricks.map((b: { color: string }) => b.color))] as string[],
        }
      })
      const missing = (item.parts ?? []).filter((re) => !state.kinds.some((kind) => re.test(kind))).map(String)
      const pass = answer.ok && state.pieces >= item.min && state.loose === 0 && missing.length === 0
      result = { ...result, ...state, missing, pass }
      await page.evaluate(() => (window as any).clutch.view.frameAll())
      await wait(900)
      await page.screenshot({ path: file(`${item.id}.png`) as `${string}.png` })
    } catch (error) {
      result = { ...result, pass: false, error: (error as Error).message }
    }
    if (page.errors.length) result.pageErrors = page.errors
    results.push(result)
    const r = result as { pass?: boolean; seconds?: number; pieces?: number; loose?: number; missing?: string[]; verdict?: string | null; error?: string }
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${item.id.padEnd(8)} ${String(r.seconds ?? '?').padStart(4)}s  ${String(r.pieces ?? '?').padStart(5)} pieces  loose ${r.loose ?? '?'}  ${r.missing?.length ? `missing ${r.missing.join(' ')}` : ''} ${r.error ?? ''}`)
    if (!r.pass && r.verdict) console.log(`      ${r.verdict.replace(/\n/g, ' | ').slice(0, 400)}`)
    await page.close()
  }
}))
await browser.close()
writeFileSync(file('results.json'), JSON.stringify(results, null, 2))
const passed = results.filter((r) => (r as { pass?: boolean }).pass).length
console.log(`\n${passed}/${results.length} passed. Pictures in ${file('')}`)
