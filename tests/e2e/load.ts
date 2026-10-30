// How fast the landing page appears, from a cold browser cache. Run with: npm run load
// CLUTCH_URL picks the server, so the dev server and the production build can be compared.

import { BASE, launch, wait } from './harness.ts'

const browser = await launch(true)
for (const run of ['cold', 'warm']) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  if (run === 'cold') await page.setCacheEnabled(false)
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as { __long: number[] }
    w.__long = []
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration)) }).observe({ type: 'longtask', buffered: true })
  })
  let requests = 0
  page.on('request', () => requests++)
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 120000 })
  await wait(1800)
  const times = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    const paint = (name: string) => Math.round(performance.getEntriesByName(name)[0]?.startTime ?? -1)
    const mark = (name: string) => Math.round(performance.getEntriesByName(name)[0]?.startTime ?? -1)
    return {
      firstPaint: paint('first-paint'),
      contentLoaded: Math.round(nav.domContentLoadedEventEnd),
      firstFrame: mark('clutch-first-frame'),
      longTasks: (window as unknown as { __long: number[] }).__long,
    }
  })
  console.log(`${run.padEnd(5)} requests ${String(requests).padStart(3)}  first paint ${times.firstPaint} ms  DOM ready ${times.contentLoaded} ms  first 3D frame ${times.firstFrame} ms  long tasks ${JSON.stringify(times.longTasks)}`)
  await page.close()
}
await browser.close()
