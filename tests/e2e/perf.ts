// Measures a large build on the real GPU: frame times while orbiting, hovering and
// animating, and how long the heavy operations take. Run with: npm run perf

import { launch, open, shot, wait } from './harness.ts'

const PIECES = Number(process.argv[2] || 3000)
const browser = await launch(!process.env.CLUTCH_SOFTWARE)
const page = await open(browser, '/?edit')
await wait(800)

const renderer = await page.evaluate(() => {
  const gl = (window as any).clutch.stage.renderer.getContext()
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
})
console.log('GPU:', renderer)

// A city of 2×4 bricks and slopes.
const build = await page.evaluate(async (count: number) => {
  const { store } = (window as any).clutch
  const parts = ['brick_2x4', 'brick_2x2', 'plate_2x4', 'slope_2x2', 'round_2x2', 'brick_1x4']
  const colors = ['red', 'blue', 'yellow', 'white', 'green', 'orange', 'lightgray', 'darkgray']
  const bricks: unknown[] = []
  let id = 1
  for (let y = 0; bricks.length < count && y < 84; y += 3) {
    for (let z = 0; z + 4 <= 48 && bricks.length < count; z += 4) {
      for (let x = 0; x + 2 <= 48 && bricks.length < count; x += 2) {
        bricks.push({ id: id++, part: parts[(x + z + y) % parts.length] === 'plate_2x4' ? 'brick_2x4' : parts[(x + z + y) % parts.length], color: colors[(x * 3 + z + y) % colors.length], x, y, z, rot: 0 })
      }
    }
  }
  const t0 = performance.now()
  store.commit(bricks, 'load')
  return { pieces: store.count, ms: Math.round(performance.now() - t0) }
}, PIECES)
console.log(`load ${build.pieces} pieces: ${build.ms} ms`)
await wait(400)

const info = await page.evaluate(() => {
  const r = (window as any).clutch.stage.renderer.info
  return { calls: r.render.calls, triangles: r.render.triangles }
})
console.log(`one frame: ${info.calls} draw calls, ${(info.triangles / 1e6).toFixed(2)} M triangles (with shadows when they redraw)`)

// Frame times from requestAnimationFrame while `drive` runs.
const measure = async (name: string, drive: () => Promise<void>) => {
  await page.evaluate(() => {
    const data: number[] = []
    let last = performance.now()
    ;(window as any).__frames = data
    ;(window as any).__measuring = true
    const tick = (now: number) => {
      data.push(now - last)
      last = now
      if ((window as any).__measuring) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await drive()
  const frames: number[] = await page.evaluate(() => {
    (window as any).__measuring = false
    return (window as any).__frames
  })
  frames.shift()
  const sorted = [...frames].sort((a, b) => a - b)
  const avg = frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  console.log(`${name.padEnd(26)} ${frames.length.toString().padStart(4)} frames   avg ${avg.toFixed(1)} ms   p95 ${p95.toFixed(1)} ms   worst ${max.toFixed(1)} ms   (${(1000 / avg).toFixed(0)} fps)`)
}

const box = (await page.$('#canvas'))!
const rect = (await box.boundingBox())!
const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2

await measure('orbit, full build', async () => {
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 0; i < 90; i++) {
    await page.mouse.move(cx + Math.sin(i / 14) * 240, cy + Math.cos(i / 20) * 70)
    await wait(16)
  }
  await page.mouse.up()
})

await measure('hover, select tool', async () => {
  for (let i = 0; i < 90; i++) {
    await page.mouse.move(cx + Math.sin(i / 9) * 260, cy + Math.cos(i / 7) * 180)
    await wait(16)
  }
})

await page.evaluate(() => (window as any).clutch.tools.pickPart('brick_2x4'))
await measure('hover, placement ghost', async () => {
  for (let i = 0; i < 90; i++) {
    await page.mouse.move(cx + Math.sin(i / 9) * 260, cy + Math.cos(i / 7) * 180)
    await wait(16)
  }
})

await measure('place and undo', async () => {
  for (let i = 0; i < 6; i++) {
    await page.mouse.click(cx + i * 30, cy - 160)
    await wait(220)
  }
  await page.evaluate(() => { for (let i = 0; i < 6; i++) (window as any).clutch.store.undo() })
  await wait(200)
})
await page.keyboard.press('Escape')

const ms = await page.evaluate(() => {
  const { store, view } = (window as any).clutch
  let t = performance.now()
  const loose = store.grid.loose()
  const looseMs = performance.now() - t
  t = performance.now()
  store.undo?.()
  const undoMs = performance.now() - t
  void view
  return { looseMs: Math.round(looseMs * 10) / 10, looseCount: loose.length, undoMs: Math.round(undoMs * 10) / 10 }
})
console.log(`attachment check: ${ms.looseMs} ms (${ms.looseCount} loose)`)

await measure('apply animation', async () => {
  await page.evaluate(() => {
    const { store, view } = (window as any).clutch
    store.commit(store.bricks, 'load')
    view.dropMany(store.bricks)
  })
  await wait(3200)
})

await measure('idle (no redraws)', async () => { await wait(1500) })
const idleCalls = await page.evaluate(async () => {
  const r = (window as any).clutch.stage.renderer.info.render
  const before = r.frame
  await new Promise((done) => setTimeout(done, 1000))
  return r.frame - before
})
console.log(`frames drawn while idle for 1 s: ${idleCalls}`)
console.log('after any quality steps:', await page.evaluate(() => { const { stage } = (window as any).clutch; return { pixelRatio: stage.renderer.getPixelRatio(), shadows: stage.key.castShadow } }))
await shot(page, 'perf-city')
if (page.errors.length) console.log('page errors:', page.errors)
await browser.close()
