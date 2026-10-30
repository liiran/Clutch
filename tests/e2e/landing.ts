// What the landing page costs, from load through the transition into the editor.
// Run with: npm run landing, or CLUTCH_SOFTWARE=1 npm run landing to stand in for a
// low-end device with no real GPU.

import { BASE, launch, wait } from './harness.ts'

const software = Boolean(process.env.CLUTCH_SOFTWARE)
const browser = await launch(!software)
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: Number(process.env.CLUTCH_DPR || 1) })
await page.evaluateOnNewDocument(() => {
  const w = window as any
  try { localStorage.removeItem('clutch_quality') } catch { /* no storage yet */ }
  w.__frames = []
  w.__long = []
  let last = performance.now()
  const tick = (now: number) => { w.__frames.push([now, now - last]); last = now; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration)) }).observe({ type: 'longtask', buffered: true })
})
const t0 = Date.now()
await page.goto(BASE + '/', { waitUntil: 'load', timeout: 120000 })
await page.waitForFunction(() => document.documentElement.classList.contains('ready'), { timeout: 60000 })
const readyAt = Date.now() - t0

const summary = (from: number, to: number) => page.evaluate((a: number, b: number) => {
  const gaps = ((window as any).__frames as Array<[number, number]>).filter(([t]) => t >= a && t < b).map(([, gap]) => gap).sort((p, q) => p - q)
  if (!gaps.length) return 'no frames'
  const avg = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  return `${Math.round(1000 / avg)} fps, worst frame ${Math.round(gaps[gaps.length - 1])} ms`
}, from, to)
const now = () => page.evaluate(() => performance.now())

const start = await now()
await wait(2200)
const afterDrop = await now()
console.log(`renderer:        ${await page.evaluate(() => {
  const gl = (window as any).clutch.stage.renderer.getContext()
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
})}`)
console.log(`page shown after ${readyAt} ms`)
console.log(`title drop:      ${await summary(start, afterDrop)}`)

const info = await page.evaluate(() => {
  const { render, memory, programs } = (window as any).clutch.stage.renderer.info
  return { calls: render.calls, triangles: render.triangles, geometries: memory.geometries, textures: memory.textures, programs: programs.length }
})
console.log(`one frame:       ${info.calls} draw calls, ${info.triangles.toLocaleString()} triangles, ${info.programs} shaders, ${info.textures} textures`)

await wait(1500)
const idle = await page.evaluate(async () => {
  const render = (window as any).clutch.stage.renderer.info.render
  const before = render.frame
  await new Promise((done) => setTimeout(done, 1000))
  return render.frame - before
})
console.log(`sitting idle:    ${idle} frames drawn per second`)

const at = await page.evaluate(() => {
  const { stage } = (window as any).clutch
  const p = stage.camera.position.clone().set(0, 1.4, 9.5).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
})
await page.mouse.move(at.x, at.y)
await page.mouse.down()
await wait(120)
await page.mouse.up()
const before = await now()
await wait(1500)
console.log(`into the editor: ${await summary(before, await now())}`)

const long = await page.evaluate(() => (window as any).__long as number[])
console.log(`long tasks:      ${long.length ? `${long.join(', ')} ms` : 'none'}`)
const orbitStart = await now()
const canvas = (await (await page.$('#canvas'))!.boundingBox())!
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2
await page.mouse.move(cx, cy)
await page.mouse.down()
for (let i = 0; i < 40; i++) {
  await page.mouse.move(cx + Math.sin(i / 8) * 200, cy + Math.cos(i / 11) * 60)
  await wait(16)
}
await page.mouse.up()
console.log(`orbit, empty:    ${await summary(orbitStart, await now())}`)
const quality = await page.evaluate(() => {
  const { stage } = (window as any).clutch
  return `quality level ${stage.level}, pixel ratio ${stage.renderer.getPixelRatio()}, shadows ${stage.scene.children.some((o: any) => o.isDirectionalLight && o.castShadow)}`
})
console.log(`ended at:        ${quality}`)
await browser.close()
