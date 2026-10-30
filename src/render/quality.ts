// How much the device can draw. A slow device starts low and stays low, without having to
// lag first: the level is measured while drawing and remembered for later visits.
//
//   0  sharp on high-density screens
//   1  one pixel per point
//   2  also no shadows and simpler studs
//   3  also a lower resolution and no edge smoothing
//
// Shadows and pixels can change straight away. Studs and edge smoothing apply from the next load.

const KEY = 'clutch_quality'
const RETRY_AFTER = 3 * 24 * 60 * 60 * 1000 // try for better again after three days

export const MAX_LEVEL = 3

function looksLikeSoftware(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return true
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return /swiftshader|llvmpipe|software|basic render/i.test(name)
  } catch {
    return true
  }
}

function read(): number | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { level: number; at: number } | null
    if (saved && Date.now() - saved.at < RETRY_AFTER && saved.level >= 0 && saved.level <= MAX_LEVEL) return saved.level
  } catch { /* nothing usable saved */ }
  return null
}

export function saveLevel(level: number) {
  try { localStorage.setItem(KEY, JSON.stringify({ level, at: Date.now() })) } catch { /* storage is full or blocked */ }
}

function start(): number {
  const saved = read()
  if (saved !== null) return saved
  const level = looksLikeSoftware() ? MAX_LEVEL : 0
  if (level) saveLevel(level)
  return level
}

export const STARTING_LEVEL = start()

export const pixelRatioFor = (level: number) => level === 0 ? Math.min(window.devicePixelRatio || 1, 1.5) : level < 3 ? 1 : 0.75
export const shadowsFor = (level: number) => level < 2
