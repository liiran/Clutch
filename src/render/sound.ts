// The click of plastic on plastic, synthesised: a very short burst of noise through a
// band-pass filter, pitched a little differently each time so it never sounds canned.

let context: AudioContext | null = null
let noise: AudioBuffer | null = null
let muted = localStorage.getItem('clutch_muted') === '1'
let lastClick = 0
let unlocked = false

export const isMuted = () => muted

export function setMuted(value: boolean) {
  muted = value
  localStorage.setItem('clutch_muted', value ? '1' : '0')
}

function ready(): AudioContext | null {
  if (muted || !unlocked) return null
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    if (!noise) {
      const length = Math.floor(context.sampleRate * 0.04)
      noise = context.createBuffer(1, length, context.sampleRate)
      const samples = noise.getChannelData(0)
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 7)
    }
    return context
  } catch {
    return null
  }
}

function burst(frequency: number, q: number, volume: number) {
  const ctx = ready()
  if (!ctx || !noise) return
  const source = ctx.createBufferSource()
  const band = ctx.createBiquadFilter()
  const gain = ctx.createGain()
  source.buffer = noise
  band.type = 'bandpass'
  band.frequency.value = frequency
  band.Q.value = q
  gain.gain.value = volume
  source.connect(band).connect(gain).connect(ctx.destination)
  source.start()
}

export function playClick(volume = 0.7) {
  const now = performance.now()
  if (now - lastClick < 38) return
  lastClick = now
  burst(2400 + Math.random() * 900, 1.3, volume)
}

export function playRemove() {
  burst(1100 + Math.random() * 200, 1.1, 0.55)
}

export function playPaint() {
  burst(3600 + Math.random() * 400, 2.2, 0.28)
}

// The context can only start after the first gesture on the page.
const unlock = () => { unlocked = true; ready() }
window.addEventListener('pointerdown', unlock, { once: true })
window.addEventListener('keydown', unlock, { once: true })
