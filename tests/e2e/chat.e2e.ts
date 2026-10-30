// The chat panel in the real editor, with the model's answers stubbed at the network, so
// every path can be tested: success, failure, stopping, and the build changing mid-reply.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Browser, HTTPRequest } from 'puppeteer-core'
import { launch, open, wait, type OpenPage } from './harness.ts'

let browser: Browser
let page: OpenPage
let answer: (request: HTTPRequest) => void | Promise<void>
let bodies: Array<Record<string, unknown>> = []

const reply = (body: unknown, status = 200) => (request: HTTPRequest) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
const lastSystem = () => page.$$eval('.chat-msg.system', (els) => els.at(-1)?.textContent ?? '')
const done = () => page.waitForFunction(() => !document.getElementById('chat-send')!.classList.contains('is-stop'), { timeout: 20000 })

const clean = async () => {
  await page.evaluate(() => {
    const { chat, store } = (window as any).clutch
    chat.reset()
    store.commit([], 'load')
  })
  bodies = []
}

const send = async (text: string) => {
  await page.click('#chat-input')
  await page.type('#chat-input', text)
  await page.keyboard.press('Enter')
}

before(async () => {
  browser = await launch(true)
  page = await open(browser, '/?edit')
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    if (request.url().includes('/api/clutch/chat')) {
      bodies.push(JSON.parse(request.postData() || '{}'))
      void answer(request)
    } else void request.continue()
  })
  await wait(300)
})

after(async () => { await browser.close() })

test('a suggestion sends, previews with a check card, and Apply builds it with a drop', async () => {
  await clean()
  answer = async (request) => {
    await wait(400)
    await reply({ reply: 'A little **wall**.', actions: [{ tool: 'fill', x1: 20, z1: 20, x2: 27, z2: 21, y: 0, height: 6, color: 'blue' }], attempts: 1 })(request)
  }
  await page.click('.chat-suggest')
  await wait(100)
  assert.equal(await page.$eval('#chat-welcome', (el) => (el as HTMLElement).hidden), true)
  assert.ok(await page.$('.chat-msg.typing'), 'shows it is working')
  assert.equal(await page.$eval('#chat-send', (el) => el.classList.contains('is-stop')), true)
  await done()
  assert.equal(await page.$('.chat-msg.typing'), null)
  assert.equal(await page.$eval('.chat-msg.ai strong', (el) => el.textContent), 'wall', 'markdown is rendered')
  assert.match(await page.$eval('.verify', (el) => el.textContent ?? ''), /all attached/)
  assert.equal(await page.$eval('#chat-pending', (el) => (el as HTMLElement).hidden), false)
  assert.equal(await page.evaluate(() => (window as any).clutch.store.count), 0, 'nothing is built until Apply')

  await page.click('#chat-accept')
  const midway = await page.evaluate(() => (window as any).clutch.view.isAnimating)
  assert.equal(midway, true, 'the pieces are dropping')
  assert.ok((await page.evaluate(() => (window as any).clutch.store.count)) >= 2)
  await wait(1500)
  assert.equal(await page.evaluate(() => (window as any).clutch.view.isAnimating), false)
})

test('the request carries the build and the earlier chat', async () => {
  await clean()
  answer = reply({ reply: 'First.', actions: [{ tool: 'place', part: 'brick_2x4', color: 'red', at: [[3, 0, 3]] }] })
  await send('one')
  await done()
  await page.click('#chat-accept')
  answer = reply({ reply: 'Second.', actions: [] })
  await send('two')
  await done()
  assert.deepEqual(bodies[0].bricks, [])
  assert.deepEqual((bodies[1].bricks as unknown[][])[0].slice(1), ['brick_2x4', 'red', 3, 0, 3, 0])
  assert.deepEqual(bodies[1].history, [{ role: 'user', text: 'one' }, { role: 'model', text: 'First.' }])
  assert.equal(await page.$eval('#chat-pending', (el) => (el as HTMLElement).hidden), true, 'an answer with no actions has nothing to apply')
})

test('Stop cancels the request and leaves the build alone', async () => {
  await clean()
  answer = async () => { /* never answers */ }
  await send('something huge')
  await wait(100)
  await page.click('#chat-send')
  await done()
  assert.equal(await lastSystem(), 'Stopped.')
  assert.equal(await page.$('.chat-msg.typing'), null)
})

test('server errors are shown plainly and can be retried', async () => {
  await clean()
  answer = reply({ error: 'Claude Code is not signed in. Run claude in a terminal, sign in, and try again.' }, 503)
  await send('build')
  await done()
  assert.match(await lastSystem(), /not signed in/)
  answer = async (request) => { await request.respond({ status: 500, contentType: 'text/html', body: '<h1>oops</h1>' }) }
  await send('build')
  await done()
  assert.match(await lastSystem(), /could not be reached/)
  answer = reply({ reply: 'Fine now.', actions: [] })
  await send('build')
  await done()
  assert.equal(await page.$$eval('.chat-msg.ai', (els) => els.at(-1)?.textContent), 'Fine now.')
})

test('if the build changes while waiting, the old answer is not applied', async () => {
  await clean()
  answer = async (request) => {
    await wait(300)
    await reply({ reply: 'Too late.', actions: [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 0, 0]] }] })(request)
  }
  await send('build')
  await wait(60)
  await page.evaluate(() => (window as any).clutch.store.place('brick_2x2', 'blue', 10, 0, 10, 0))
  await done()
  assert.match(await lastSystem(), /changed while I was working/)
  assert.equal(await page.$eval('#chat-pending', (el) => (el as HTMLElement).hidden), true)
})

test('a proposal with problems says so, and can still be applied', async () => {
  await clean()
  answer = reply({ reply: 'Mostly.', attempts: 2, actions: [
    { tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 9, 0]] },
    { tool: 'place', part: 'brick_2x2', color: 'red', at: [[5, 0, 5]] },
  ] })
  await send('build')
  await done()
  const card = await page.$eval('.verify', (el) => el.textContent ?? '')
  assert.match(card, /Not quite right/)
  assert.match(card, /1 piece would not be attached/)
  assert.match(card, /not all fixed/)
  await page.click('#chat-accept')
  await wait(100)
  assert.equal(await page.$eval('#loose', (el) => (el as HTMLElement).hidden), false)
})

test('New chat clears the conversation and any preview', async () => {
  await clean()
  answer = reply({ reply: 'Here.', actions: [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 0, 0]] }] })
  await send('build')
  await done()
  await page.click('#chat-new')
  assert.equal(await page.$('.chat-msg'), null)
  assert.equal(await page.$eval('#chat-welcome', (el) => (el as HTMLElement).hidden), false)
  assert.equal(await page.evaluate(() => (window as any).clutch.tools.isLocked), false)
  assert.equal(await page.evaluate(() => (window as any).clutch.store.count), 0)
})

test('asking during a replay stops it, and asking from the Parts tab returns to the model', async () => {
  await clean()
  await page.evaluate(() => (window as any).clutch.store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 3, y: 0, z: 3, rot: 0 }], 'load'))
  await page.click('#build-play')
  assert.equal(await page.evaluate(() => (window as any).clutch.replay.active), true)
  answer = reply({ reply: 'Ok.', actions: [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[20, 0, 20]] }] })
  await send('add one')
  await done()
  assert.equal(await page.evaluate(() => (window as any).clutch.replay.active), false)
  await page.click('#chat-decline')
  await page.click('[data-view="parts"]')
  await send('add one')
  await done()
  assert.equal(await page.$eval('#parts-view', (el) => (el as HTMLElement).hidden), true)
  await page.click('#chat-decline')
})

test('nothing went wrong in the page', () => {
  const real = page.errors.filter((text) => !/status of (500|503)/.test(text))
  assert.deepEqual(real, [])
})
