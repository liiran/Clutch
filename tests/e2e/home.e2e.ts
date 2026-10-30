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
  const p = stage.camera.position.clone().set(0, 1.4, 9.5).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
})

before(async () => { browser = await launch(true) })
after(async () => { await browser.close() })

test('the landing shows only the scene, and sliding off the button cancels', async () => {
  page = await open(browser, '/')
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
  assert.equal(result.scene, '')
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
