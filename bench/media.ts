// Records the README's pictures and videos from the real app, with the real chat.
//
//   npm run dev                  (in another window)
//   FFMPEG_PATH=/path/to/ffmpeg npm run media
//
// This sends two real chat messages. Waiting for the model is sped up in the videos, and
// everything else plays at its real speed. The results go to docs/media/.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CDPSession, Page } from 'puppeteer-core'
import { BASE, launch, wait } from '../tests/e2e/harness.ts'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const OUT = new URL('../docs/media/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(OUT, { recursive: true })

const FIRST_REQUEST = 'Build a small house with a red roof, a door and two windows.'
const SECOND_REQUEST = 'Now add a garden: a path to the door, a tree on each side of the house and a fence along the front.'

// A visible pointer, because a headless browser does not draw one.
const POINTER = `
  addEventListener('DOMContentLoaded', () => {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:26px;z-index:99999;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))'
    el.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2v19l5-4.6 3.4 7.6 3.6-1.6-3.4-7.4H17z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    document.documentElement.append(el)
    addEventListener('mousemove', (e) => { el.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)' }, true)
  })
`

interface Frame { time: number; file: string }
interface Cut { start: number; end: number }

class Recorder {
  frames: Frame[] = []
  cuts: Cut[] = []
  private dir = mkdtempSync(join(tmpdir(), 'clutch-media-'))
  private client!: CDPSession
  private stopped = false
  private page: Page

  constructor(page: Page) { this.page = page }

  async start() {
    this.client = await this.page.createCDPSession()
    this.client.on('Page.screencastFrame', (event) => {
      if (this.stopped) return
      const file = join(this.dir, `${String(this.frames.length).padStart(6, '0')}.jpg`)
      writeFileSync(file, Buffer.from(event.data, 'base64'))
      this.frames.push({ time: Date.now(), file })
      void this.client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    })
    await this.client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 })
  }

  async stop() {
    this.stopped = true
    await this.client.send('Page.stopScreencast')
  }

  // Waiting for the model shows for about a second and a half.
  cut(start: number, end: number) { this.cuts.push({ start, end }) }

  private mapped(time: number) {
    let out = time
    for (const { start, end } of this.cuts) {
      const keep = 1500
      const length = end - start
      if (length <= keep) continue
      if (time >= end) out -= length - keep
      else if (time > start) out -= (time - start) * (1 - keep / length)
    }
    return out
  }

  encode(name: string, width: number, fps: number, tail = 1800) {
    const frames = this.frames
    let list = ''
    frames.forEach((frame, i) => {
      const next = i + 1 < frames.length ? this.mapped(frames[i + 1].time) : this.mapped(frame.time) + tail
      list += `file '${frame.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, (next - this.mapped(frame.time)) / 1000).toFixed(4)}\n`
    })
    list += `file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'\n`
    const listFile = join(this.dir, 'list.txt')
    writeFileSync(listFile, list)
    const run = (args: string[]) => {
      const result = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, ...args], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || result.error}`)
    }
    const gif = join(OUT, `${name}.gif`)
    run(['-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, gif])
    const mp4 = join(OUT, `${name}.mp4`)
    run(['-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-movflags', '+faststart', mp4])
    console.log(`${name}: ${(statSync(gif).size / 1e6).toFixed(1)} MB gif, ${(statSync(mp4).size / 1e6).toFixed(1)} MB mp4, ${frames.length} frames`)
  }

  clean() { rmSync(this.dir, { recursive: true, force: true }) }
}

let pointer = { x: 640, y: 400 }

async function glide(page: Page, x: number, y: number, ms = 450) {
  const from = { ...pointer }
  const steps = Math.max(4, Math.round(ms / 16))
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e)
    await wait(16)
  }
  pointer = { x, y }
}

async function clickOn(page: Page, selector: string, ms = 450) {
  const box = (await (await page.$(selector))!.boundingBox())!
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, ms)
  await wait(120)
  await page.mouse.down()
  await wait(70)
  await page.mouse.up()
}

const screen = (page: Page, x: number, z: number, y = 0) => page.evaluate((cx: number, cz: number, cy: number) => {
  const { stage } = (window as any).clutch
  const p = stage.camera.position.clone().set(cx - 32, cy * 0.4, cz - 32).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
}, x, z, y)

async function plateClick(page: Page, x: number, z: number, y = 0, ms = 420) {
  const at = await screen(page, x, z, y)
  await glide(page, at.x, at.y, ms)
  await wait(120)
  await page.mouse.down()
  await wait(60)
  await page.mouse.up()
  await wait(320)
}

async function orbit(page: Page, dx: number, ms: number) {
  const box = (await (await page.$('#viewport'))!.boundingBox())!
  const sx = box.x + box.width * 0.5, sy = box.y + 90
  await glide(page, sx, sy, 300)
  await page.mouse.down()
  const steps = Math.round(ms / 16)
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + (dx * i) / steps, sy + Math.sin((i / steps) * Math.PI) * 10)
    await wait(16)
  }
  pointer = { x: sx + dx, y: sy }
  await page.mouse.up()
  await wait(350)
}

const still = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) as `${string}.png` })

const browser = await launch(true)

// ── The main video: from the menu to a house, then a garden added onto it ──
async function hero() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(POINTER)
  await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('keep')) { localStorage.clear(); sessionStorage.setItem('keep', '1') } })
  const record = new Recorder(page)
  await record.start()
  await page.goto(BASE + '/', { waitUntil: 'load' })
  await page.waitForFunction(() => (window as any).clutch)
  await page.mouse.move(pointer.x, pointer.y)
  await wait(1900)
  await still(page, 'landing')

  const at = await page.evaluate(() => {
    const { stage } = (window as any).clutch
    const p = stage.camera.position.clone().set(0, 1.4, 9.5).project(stage.camera)
    const rect = stage.canvas.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  })
  await glide(page, at.x, at.y, 450)
  await wait(100)
  await page.mouse.down()
  await wait(140)
  await page.mouse.up()
  await wait(1250)
  await page.evaluate(() => (window as any).clutch.store.rename('My first house'))

  const ask = async (text: string) => {
    await clickOn(page, '#chat-input', 380)
    await wait(80)
    await page.keyboard.type(text, { delay: 14 })
    await wait(180)
    await page.keyboard.press('Enter')
    const start = Date.now()
    await page.waitForFunction(() => !document.getElementById('chat-send')!.classList.contains('is-stop'), { timeout: 300000, polling: 100 })
    record.cut(start, Date.now())
    console.log(`  reply after ${Math.round((Date.now() - start) / 1000)} s:`, await page.$$eval('.chat-msg.ai', (els) => (els[els.length - 1] as HTMLElement).innerText.replace(/\n/g, ' ')))
    console.log('  card:', await page.$$eval('.verify', (els) => (els[els.length - 1] as HTMLElement)?.innerText.replace(/\n/g, ' ')))
  }

  await ask(FIRST_REQUEST)
  await wait(1200)
  await still(page, 'preview')

  // Dragging the preview to a different spot before applying it.
  const grab = await page.evaluate(() => {
    const { stage, view, chat } = (window as any).clutch
    const box = view.boundsOf(chat.mover.placing.current)
    const p = stage.camera.position.clone().set((box.min.x + box.max.x) / 2, box.max.y * 0.55, box.max.z).project(stage.camera)
    const rect = stage.canvas.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  })
  await glide(page, grab.x, grab.y, 420)
  await wait(120)
  await page.mouse.down()
  await glide(page, grab.x - 90, grab.y + 22, 650)
  await glide(page, grab.x + 60, grab.y - 8, 700)
  await page.mouse.up()
  await wait(350)
  await clickOn(page, '#chat-accept', 420)
  await wait(2900)

  await ask(SECOND_REQUEST)
  await wait(1300)
  await clickOn(page, '#chat-accept', 420)
  await wait(2300)
  await page.evaluate(() => (window as any).clutch.view.frameAll())
  await wait(800)
  // A small look around, ending back near the front.
  await orbit(page, 60, 650)
  await orbit(page, -100, 900)
  await still(page, 'garden')

  await clickOn(page, '#build-play', 450)
  await wait(120)
  await clickOn(page, '#replay-speed', 300)
  await wait(80)
  await clickOn(page, '#replay-speed', 80)
  await wait(1500)
  await still(page, 'replay')
  await page.waitForFunction(() => {
    const count = document.getElementById('replay-count')?.textContent ?? ''
    const match = /Step (\d+) of (\d+)/.exec(count)
    return match && match[1] === match[2]
  }, { timeout: 30000, polling: 100 })
  await wait(350)
  await record.stop()
  record.encode('demo', 800, 10)
  record.clean()

  await page.keyboard.press('Escape')
  await wait(300)
  await clickOn(page, '[data-view="parts"]', 100)
  await wait(500)
  await still(page, 'parts')
  await clickOn(page, '[data-view="build"]', 100)
  const summary = await page.evaluate(() => {
    const { store } = (window as any).clutch
    return { pieces: store.count, loose: store.grid.loose().length }
  })
  console.log('  build:', summary)
  await page.close()
}

// ── Building by hand ───────────────────────────────────────────
async function byHand() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(POINTER)
  await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('keep')) { localStorage.clear(); sessionStorage.setItem('keep', '1') } })
  await page.goto(BASE + '/?edit', { waitUntil: 'load' })
  await page.waitForFunction(() => (window as any).clutch)
  await wait(900)
  await page.evaluate(() => {
    const { stage } = (window as any).clutch
    stage.controls.target.set(1, 1, 0)
    stage.camera.position.set(-8, 24, 28)
    stage.controls.update()
  })
  await wait(300)
  await page.mouse.move(pointer.x, pointer.y)
  const record = new Recorder(page)
  await record.start()
  await wait(400)

  await clickOn(page, '#palette .swatch[title="Blue"]', 500)
  await clickOn(page, '.part-tile[title="Brick 2×4"]', 450)
  await plateClick(page, 30, 32)
  await page.keyboard.press('r')
  await plateClick(page, 35, 30)
  await clickOn(page, '#palette .swatch[title="Yellow"]', 500)
  await clickOn(page, '.part-tile[title="Brick 2×2"]', 450)
  await plateClick(page, 31, 32, 3)
  await plateClick(page, 36, 31, 3)
  await clickOn(page, '#palette .swatch[title="Red"]', 500)
  await page.evaluate(() => (document.querySelector('#part-list') as HTMLElement).scrollTop = 1250)
  await wait(200)
  await clickOn(page, '.part-tile[title="Slope 2×2"]', 450)
  await plateClick(page, 31, 32, 6)
  await plateClick(page, 36, 31, 6)
  await wait(500)
  await page.keyboard.press('Escape')
  await wait(250)
  const house = await page.evaluate(() => (window as any).clutch.store.bricks[0])
  await clickOn(page, '[data-mode="paint"]', 450)
  await clickOn(page, '#palette .swatch[title="White"]', 400)
  await plateClick(page, house.x + 1, house.z + 2, 3, 500)
  await wait(400)
  await clickOn(page, '[data-mode="select"]', 400)
  await plateClick(page, house.x + 1, house.z + 2, 3, 450)
  await wait(900)
  await record.stop()
  record.encode('by-hand', 760, 12, 1000)
  record.clean()
  await page.close()
}

await hero()
await byHand()
await browser.close()
