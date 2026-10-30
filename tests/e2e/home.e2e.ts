// The landing scene: the title falls, the button presses, and it turns into the editor
// with no new page.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Browser } from 'puppeteer-core'
import { launch, open, shot, wait, type OpenPage } from './harness.ts'

let browser: Browser
let page: OpenPage

// Where the middle of the button is on screen.
const buttonAt = () => page.evaluate(() => {
  const { stage } = (window as any).clutch
  const p = stage.camera.position.clone().set(0, 1.4, 14.5).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
})

before(async () => { browser = await launch(true) })
after(async () => { await browser.close() })

test('the landing shows only the scene, and sliding off the button cancels', async () => {
  page = await open(browser, '/')
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('topbar')!).position), 'fixed', 'the styles are in before the scripts run')
  await wait(3200)
  await shot(page, 'home')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('scene')), true)
  const panels = await page.evaluate(() => ['topbar', 'sidebar', 'chat'].map((id) => {
    const rect = document.getElementById(id)!.getBoundingClientRect()
    return rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0
  }))
  assert.deepEqual(panels, [true, true, true], 'the panels are off screen')

  const at = await buttonAt()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await wait(250)
  await page.mouse.move(at.x, 40)
  await page.mouse.up()
  await wait(300)
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('scene')), true, 'still on the landing')
})

const car = () => page.evaluate(() => (window as any).clutchHome.car)
const hold = async (key: 'w' | 'a' | 's' | 'd', ms: number) => {
  await page.keyboard.down(key)
  await wait(ms)
  await page.keyboard.up(key)
}

test('the car drives with WASD, shows its legend, and draws nothing when parked', async () => {
  assert.equal(await page.$eval('#drive-legend', (el) => getComputedStyle(el).display), 'flex')
  const start = await car()
  assert.equal(start.ramps, 2)
  // W goes straight up the first ramp and into the title.
  await page.evaluate(() => {
    const w = window as any
    w.__high = 0
    w.__watch = setInterval(() => { w.__high = Math.max(w.__high, w.clutchHome.car.y) }, 10)
  })
  await hold('w', 1500)
  const high = await page.evaluate(() => { const w = window as any; clearInterval(w.__watch); return w.__high })
  assert.ok(high > 1.9, `it flew off the ramp: ${high}`)
  const moved = await car()
  assert.ok(moved.z > -9 + 1.4, `it bounced off the title, not through it: ${moved.z}`)
  assert.ok(Math.hypot(moved.x - start.x, moved.z - start.z) > 2, 'it moved')
  await hold('s', 300)
  await page.waitForFunction(() => !(window as any).clutchHome.car.ticking, { timeout: 10000 })
  await wait(100)
  const frames = await page.evaluate(async () => {
    const render = (window as any).clutch.stage.renderer.info.render
    const before = render.frame
    await new Promise((done) => setTimeout(done, 500))
    return render.frame - before
  })
  assert.equal(frames, 0)
})

test('driving hard into everything leaves the car on the plate', async () => {
  for (const [key, ms] of [['w', 1500], ['a', 500], ['w', 1200], ['d', 800], ['w', 1500]] as const) await hold(key, ms)
  const state = await car()
  assert.ok(Number.isFinite(state.x + state.y + state.z))
  assert.ok(Math.abs(state.x) <= state.bound + 0.01 && Math.abs(state.z) <= state.bound + 0.01)
  await shot(page, 'home-driving')
  await wait(800)
})

test('pressing the button turns the scene into the editor in place', async () => {
  const at = await buttonAt()
  await page.evaluate(() => { (window as any).__marker = 'same page' })
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await wait(120)
  await page.mouse.up()
  await wait(600)
  await shot(page, 'home-entering')
  await wait(1300)
  await shot(page, 'home-entered')
  assert.equal(await page.$eval('#drive-legend', (el) => getComputedStyle(el).display), 'none')
  const result = await page.evaluate(() => {
    const { tools, stage } = (window as any).clutch
    const canvas = stage.canvas.getBoundingClientRect()
    const viewport = document.getElementById('viewport')!.getBoundingClientRect()
    return {
      marker: (window as any).__marker,
      url: location.search,
      scene: document.documentElement.className,
      locked: tools.isLocked,
      fits: Math.abs(canvas.width - viewport.width) < 1 && Math.abs(canvas.height - viewport.height) < 1,
      sidebar: document.getElementById('sidebar')!.getBoundingClientRect().left,
      aspect: Math.abs(stage.camera.aspect - viewport.width / viewport.height) < 0.01,
    }
  })
  assert.equal(result.marker, 'same page')
  assert.equal(result.url, '?edit')
  assert.doesNotMatch(result.scene, /scene|entering/)
  assert.equal(result.locked, false)
  assert.equal(result.fits, true)
  assert.equal(result.sidebar, 0)
  assert.equal(result.aspect, true)
})

test('the editor works straight after the landing', async () => {
  await page.click('.part-tile[title="Brick 2×4"]')
  const at = await page.evaluate(() => {
    const { stage } = (window as any).clutch
    const p = stage.camera.position.clone().set(0, 0, 0).project(stage.camera)
    const rect = stage.canvas.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  })
  await page.mouse.move(at.x, at.y)
  await wait(80)
  await page.mouse.click(at.x, at.y)
  await wait(100)
  assert.equal(await page.evaluate(() => (window as any).clutch.store.count), 1)
  assert.deepEqual(page.errors, [])
})

test('reduced motion puts the title straight in place', async () => {
  const quiet = await browser.newPage()
  await quiet.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await quiet.setViewport({ width: 1280, height: 800 })
  await quiet.goto(page.url().replace(/\?.*$/, ''), { waitUntil: 'networkidle2' })
  await wait(300)
  await quiet.keyboard.press('Enter')
  await wait(700)
  assert.equal(await quiet.evaluate(() => document.documentElement.classList.contains('scene')), false)
  await quiet.close()
})
