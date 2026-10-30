// Starts the real editor in Chrome for the browser tests.
import { existsSync, mkdirSync } from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

export const BASE = process.env.CLUTCH_URL || 'http://127.0.0.1:5173'
export const SHOTS = new URL('./shots/', import.meta.url)
mkdirSync(SHOTS, { recursive: true })

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)

export async function launch(gpu = false): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600000,
    args: gpu
      ? ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--mute-audio']
      : ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
  })
}

export interface OpenPage extends Page {
  errors: string[]
}

export async function open(browser: Browser, path = '/?edit', size = { width: 1440, height: 900 }, keepStorage = false): Promise<OpenPage> {
  const page = await browser.newPage() as OpenPage
  await page.setViewport({ ...size, deviceScaleFactor: 1 })
  if (!keepStorage) await page.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('keep')) { localStorage.clear(); sessionStorage.setItem('keep', '1') } })
  page.errors = []
  page.on('pageerror', (error) => page.errors.push((error as Error).message))
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warn') page.errors.push(`${message.type()}: ${message.text()}`) })
  await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForFunction(() => (window as unknown as { clutch?: unknown }).clutch, { timeout: 60000 })
  return page
}

export const shot = (page: Page, name: string) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, '$1') as `${string}.png` })
export const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
