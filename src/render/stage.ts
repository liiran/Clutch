// The 3D stage: renderer, camera, lights, the baseplate and the frame loop. Nothing runs
// unless something changed: an idle page draws no frames at all, and shadows are redrawn
// only when the build changes, so orbiting stays smooth.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SIZE } from '../core/model.ts'
import { COLOR } from '../core/colors.ts'
import { plainBox } from './geometry.ts'
import { MAX_LEVEL, STARTING_LEVEL, pixelRatioFor, saveLevel, shadowsFor } from './quality.ts'

const BACKGROUND = 0x1d1f24
const OFF = SIZE / 2
const SHADOW_EVERY = 66 // ms between shadow redraws while pieces are moving

export type Ticker = (time: number) => void

export const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3)
export const easeInOutCubic = (k: number) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2

// The baseplate's studs are painted, not modelled: one stud in a texture, repeated. It is
// two triangles instead of over a hundred thousand, and reads the same from any normal view.
function studTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const size = 96
  const paint = document.createElement('canvas')
  paint.width = paint.height = size
  const g = paint.getContext('2d')!
  const mid = size / 2, r = size * 0.3
  g.fillStyle = '#d0d0d0'
  g.fillRect(0, 0, size, size)
  // The shadow the stud throws, away from the light.
  g.fillStyle = 'rgba(0,0,0,0.3)'
  g.beginPath(); g.arc(mid + 4, mid + 5, r + 1, 0, Math.PI * 2); g.fill()
  // Its side, seen a little from above.
  g.fillStyle = '#b4b4b4'
  g.beginPath(); g.arc(mid + 1, mid + 2.5, r, 0, Math.PI * 2); g.fill()
  // Its top, with a lit edge.
  g.fillStyle = '#f2f2f2'
  g.beginPath(); g.arc(mid, mid, r - 1, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#ffffff'
  g.lineWidth = 2
  g.beginPath(); g.arc(mid, mid, r - 2, Math.PI * 0.85, Math.PI * 1.65); g.stroke()
  const texture = new THREE.CanvasTexture(paint)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(SIZE, SIZE)
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  return texture
}

export class Stage {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.5, 600)
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly canvas: HTMLCanvasElement
  readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  level = STARTING_LEVEL
  private container: HTMLElement
  private key = new THREE.DirectionalLight(0xfff4e6, 2.3)
  private tickers = new Set<Ticker>()
  private dirty = true
  private shadowsDirty = true
  private lastShadow = 0
  private plateTop: THREE.MeshLambertMaterial
  private plateSide: THREE.MeshLambertMaterial
  private gliding = false
  private started = false
  private firstFrame = false
  private glideRun = 0
  private running = false
  private idleFrames = 0
  private slowFrames = 0
  private lastDraw = 0
  onViewChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.canvas = canvas
    this.container = container
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.level < MAX_LEVEL,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(pixelRatioFor(this.level))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false

    this.scene.background = new THREE.Color(BACKGROUND)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa8, 1.95))
    const key = this.key
    key.position.set(-26, 60, 34)
    key.castShadow = shadowsFor(this.level)
    key.shadow.mapSize.set(2048, 2048)
    Object.assign(key.shadow.camera, { near: 10, far: 170, left: -40, right: 40, top: 40, bottom: -40 })
    key.shadow.bias = -0.0006
    key.shadow.normalBias = 0.03
    this.scene.add(key)

    this.plateTop = new THREE.MeshLambertMaterial({ map: studTexture(this.renderer), color: 0x1f8f3c })
    this.plateSide = new THREE.MeshLambertMaterial({ color: 0x1f8f3c })
    this.addBaseplate()

    this.controls = new OrbitControls(this.camera, canvas)
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.09, minDistance: 8, maxDistance: 240,
      maxPolarAngle: Math.PI * 0.485, panSpeed: 1.2, zoomSpeed: 0.6, screenSpacePanning: true,
    })
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('change', () => this.onControlsChange())
    this.controls.addEventListener('start', () => { this.glideRun++; this.gliding = false; this.wake() })
    this.controls.addEventListener('end', () => this.wake())
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())

    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)
    const start = this.defaultView()
    this.camera.position.copy(start.position)
    this.controls.target.copy(start.target)
    this.started = true
    this.wake()
  }

  private addBaseplate() {
    const slab = new THREE.Mesh(plainBox(-OFF, OFF, -0.2, -0.004, -OFF, OFF, 0.05), this.plateSide)
    const top = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), this.plateTop)
    top.rotation.x = -Math.PI / 2
    top.receiveShadow = true
    this.scene.add(slab, top)
  }

  setBaseplateColor(id: string) {
    const color = COLOR.get(id)
    if (color) {
      this.plateTop.color.setHex(color.hex)
      this.plateSide.color.setHex(color.hex).multiplyScalar(0.72)
    }
    this.invalidate()
  }

  private onControlsChange() {
    // The camera cannot be panned away from the baseplate.
    const target = this.controls.target
    const limit = OFF + 8
    const x = THREE.MathUtils.clamp(target.x, -limit, limit)
    const y = THREE.MathUtils.clamp(target.y, -1, 42)
    const z = THREE.MathUtils.clamp(target.z, -limit, limit)
    if (x !== target.x || y !== target.y || z !== target.z) {
      this.camera.position.x += x - target.x
      this.camera.position.y += y - target.y
      this.camera.position.z += z - target.z
      target.set(x, y, z)
    }
    this.invalidate()
    this.onViewChange?.()
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight
    if (!w || !h) return
    // A view that was showing the whole plate keeps showing it.
    const refit = this.started && !this.gliding && this.isAtDefaultView()
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    if (refit) {
      const view = this.defaultView()
      this.camera.position.copy(view.position)
      this.controls.target.copy(view.target)
      this.camera.lookAt(view.target)
    }
    if (this.started) this.draw() // Resizing clears the canvas, so draw straight away or it flashes.
  }

  // The frame loop only runs while there is something to do.
  private wake() {
    if (this.running) return
    this.running = true
    this.idleFrames = 0
    this.lastDraw = 0
    requestAnimationFrame((now) => this.frame(now))
  }

  private frame(now: number) {
    const busy = this.tickers.size > 0
    if (busy) {
      const time = now / 1000
      for (const ticker of [...this.tickers]) {
        try { ticker(time) } catch (error) { console.warn(error); this.tickers.delete(ticker) }
      }
    }
    this.controls.update() // carries on the camera's damping, and marks the frame dirty if it moved
    if (this.dirty || busy || this.shadowsDirty) {
      this.watchFrameRate(now)
      this.draw(now)
      this.idleFrames = 0
    } else if (++this.idleFrames > 3) {
      this.running = false
      return
    }
    requestAnimationFrame((next) => this.frame(next))
  }

  // If drawing keeps falling behind, it steps down until it keeps up, and remembers.
  // A single stall changes nothing.
  private watchFrameRate(now: number) {
    const gap = this.lastDraw ? now - this.lastDraw : 0
    this.lastDraw = now
    if (!gap || gap > 500) return
    this.slowFrames = gap > 26 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2)
    if (this.slowFrames < 18 || this.level >= MAX_LEVEL) return
    this.slowFrames = 0
    this.level++
    saveLevel(this.level)
    this.key.castShadow = shadowsFor(this.level)
    this.renderer.setPixelRatio(pixelRatioFor(this.level))
    this.resize()
  }

  private draw(now = performance.now()) {
    if (this.shadowsDirty && now - this.lastShadow > SHADOW_EVERY) {
      this.renderer.shadowMap.needsUpdate = this.key.castShadow
      this.shadowsDirty = false
      this.lastShadow = now
    }
    this.renderer.render(this.scene, this.camera)
    this.dirty = false
    if (!this.firstFrame) {
      this.firstFrame = true
      performance.mark('clutch-first-frame')
    }
  }

  invalidate() { this.dirty = true; this.wake() }
  invalidateShadows() { this.shadowsDirty = true; this.dirty = true; this.wake() }

  addTicker(ticker: Ticker) { this.tickers.add(ticker); this.wake() }
  removeTicker(ticker: Ticker) { this.tickers.delete(ticker); this.invalidate() }

  // Runs step(k) with k from 0 to 1 over `ms`, once per frame.
  tween(ms: number, step: (k: number) => void): Promise<void> {
    return new Promise((done) => {
      const t0 = performance.now()
      const tick = () => {
        const k = ms <= 0 ? 1 : Math.min(1, (performance.now() - t0) / ms)
        step(k)
        if (k === 1) { this.removeTicker(tick); done() }
      }
      this.addTicker(tick)
    })
  }

  // The view that shows the whole baseplate for the canvas's current shape.
  defaultView(aspect = this.camera.aspect) {
    return this.fitBox(new THREE.Box3(new THREE.Vector3(-OFF, -0.2, -OFF), new THREE.Vector3(OFF, 1, OFF)), aspect, 0.94)
  }

  // Backs a camera away along the editor's three-quarter angle until the box fits.
  fitBox(box: THREE.Box3, aspect = this.camera.aspect, margin = 0.86) {
    const target = box.getCenter(new THREE.Vector3())
    const direction = new THREE.Vector3(-0.3, 0.86, 1).normalize()
    const probe = this.camera.clone()
    probe.aspect = aspect
    probe.updateProjectionMatrix()
    const corners: THREE.Vector3[] = []
    for (let k = 0; k < 8; k++) corners.push(new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z))
    const fits = (distance: number) => {
      probe.position.copy(target).addScaledVector(direction, distance)
      probe.lookAt(target)
      probe.updateMatrixWorld()
      return corners.every((corner) => {
        const p = corner.clone().project(probe)
        return Math.abs(p.x) <= margin && Math.abs(p.y) <= margin && p.z < 1
      })
    }
    let near = 8, far = 400
    for (let i = 0; i < 24; i++) {
      const mid = (near + far) / 2
      if (fits(mid)) far = mid
      else near = mid
    }
    return { position: target.clone().addScaledVector(direction, far), target }
  }

  glideTo(view: { position: THREE.Vector3; target: THREE.Vector3 }, ms = 650): Promise<void> {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone()
    const run = ++this.glideRun
    this.gliding = true
    return this.tween(this.reducedMotion ? 0 : ms, (k) => {
      if (run !== this.glideRun) return
      const e = easeInOutCubic(k)
      this.camera.position.lerpVectors(p0, view.position, e)
      this.controls.target.lerpVectors(t0, view.target, e)
      if (k === 1) this.gliding = false
    })
  }

  resetView() { return this.glideTo(this.defaultView()) }

  isAtDefaultView() {
    if (this.gliding) return true
    const view = this.defaultView()
    return this.camera.position.distanceTo(view.position) < 1 && this.controls.target.distanceTo(view.target) < 1
  }

  // Are these world points all on screen right now?
  canSee(points: THREE.Vector3[]) {
    this.camera.updateMatrixWorld()
    return points.every((point) => {
      const p = point.clone().project(this.camera)
      return Math.abs(p.x) <= 0.98 && Math.abs(p.y) <= 0.98
    })
  }
}
