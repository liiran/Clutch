// The 3D stage: renderer, camera, lights, the baseplate and the frame loop. A frame is
// drawn only when something changed, so an idle editor costs nothing, and shadows are
// redrawn only when the build changes, so orbiting a large build stays smooth.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { SIZE } from '../core/model.ts'
import { COLOR } from '../core/colors.ts'
import { baseplateStud, plainBox } from './geometry.ts'

const BACKGROUND = 0x25282e
const OFF = SIZE / 2

export type Ticker = (time: number) => void

export const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3)
export const easeInOutCubic = (k: number) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2

export class Stage {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.5, 600)
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly canvas: HTMLCanvasElement
  readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  private container: HTMLElement
  private tickers = new Set<Ticker>()
  private dirty = true
  private shadowsDirty = true
  private lastShadow = 0
  private plateMaterial: THREE.MeshStandardMaterial
  private gliding = false
  private started = false
  private glideRun = 0
  private slowFrames = 0
  private lastDraw = 0
  onViewChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.canvas = canvas
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false

    this.scene.background = new THREE.Color(BACKGROUND)
    this.scene.fog = new THREE.Fog(BACKGROUND, 150, 340)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55
    pmrem.dispose()

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a55, 0.5))
    const key = new THREE.DirectionalLight(0xfff5e8, 2.3)
    key.position.set(-26, 60, 34)
    key.castShadow = true
    key.shadow.mapSize.set(3072, 3072)
    Object.assign(key.shadow.camera, { near: 10, far: 170, left: -40, right: 40, top: 40, bottom: -40 })
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.025
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.5)
    rim.position.set(30, 22, -40)
    this.scene.add(rim)

    this.plateMaterial = new THREE.MeshStandardMaterial({ color: 0x1f8f3c, roughness: 0.55, envMapIntensity: 0.7 })
    this.addBench()
    this.addBaseplate()

    this.controls = new OrbitControls(this.camera, canvas)
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.09, minDistance: 8, maxDistance: 240,
      maxPolarAngle: Math.PI * 0.485, panSpeed: 1.2, zoomSpeed: 1.1, screenSpacePanning: true,
    })
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('change', () => this.onControlsChange())
    this.controls.addEventListener('start', () => { this.glideRun++; this.gliding = false })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())

    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)
    const start = this.defaultView()
    this.camera.position.copy(start.position)
    this.controls.target.copy(start.target)
    this.started = true
    requestAnimationFrame((now) => this.frame(now))
  }

  private addBench() {
    const size = 1024
    const paint = document.createElement('canvas')
    paint.width = paint.height = size
    const g = paint.getContext('2d')!
    g.fillStyle = '#17181c'
    g.fillRect(0, 0, size, size)
    g.strokeStyle = 'rgba(255,255,255,0.045)'
    g.lineWidth = 3
    for (let i = 0; i <= size; i += size / 8) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke()
      g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke()
    }
    const texture = new THREE.CanvasTexture(paint)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(40, 40)
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    const bench = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, envMapIntensity: 0.3 }))
    bench.rotation.x = -Math.PI / 2
    bench.position.y = -0.2
    bench.receiveShadow = true
    this.scene.add(bench)
  }

  private addBaseplate() {
    const slab = new THREE.Mesh(plainBox(-OFF, OFF, -0.2, 0, -OFF, OFF, 0.05), this.plateMaterial)
    slab.castShadow = slab.receiveShadow = true
    this.scene.add(slab)
    const studs = new THREE.InstancedMesh(baseplateStud(), this.plateMaterial, SIZE * SIZE)
    const m = new THREE.Matrix4()
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        m.makeTranslation(x + 0.5 - OFF, 0, z + 0.5 - OFF)
        studs.setMatrixAt(x + z * SIZE, m)
      }
    }
    studs.castShadow = studs.receiveShadow = true
    studs.frustumCulled = false
    this.scene.add(studs)
  }

  setBaseplateColor(id: string) {
    const color = COLOR.get(id)
    if (color) this.plateMaterial.color.setHex(color.hex).multiplyScalar(id === 'white' ? 0.92 : 0.82)
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
    this.draw() // Resizing clears the canvas, so draw straight away or it flashes.
  }

  private frame(now: number) {
    requestAnimationFrame((next) => this.frame(next))
    const busy = this.tickers.size > 0
    if (busy) {
      const time = now / 1000
      for (const ticker of [...this.tickers]) {
        try { ticker(time) } catch (error) { console.warn(error); this.tickers.delete(ticker) }
      }
    }
    this.controls.update()
    if (this.dirty || busy) {
      this.watchFrameRate(now)
      this.draw(now)
    }
  }

  // If drawing keeps falling well behind on a high-density screen, it drops to one
  // pixel per point, which is the biggest saving there is and hardly shows in motion.
  private watchFrameRate(now: number) {
    const gap = now - this.lastDraw
    this.lastDraw = now
    if (gap > 200) return // it was idle, not slow
    this.slowFrames = gap > 30 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1)
    if (this.slowFrames > 25 && this.renderer.getPixelRatio() > 1) {
      this.slowFrames = 0
      this.renderer.setPixelRatio(1)
      this.resize()
    }
  }

  private draw(now = performance.now()) {
    if (this.shadowsDirty && now - this.lastShadow > 30) {
      this.renderer.shadowMap.needsUpdate = true
      this.shadowsDirty = false
      this.lastShadow = now
    }
    this.renderer.render(this.scene, this.camera)
    this.dirty = false
  }

  invalidate() { this.dirty = true }
  invalidateShadows() { this.shadowsDirty = true; this.dirty = true }

  addTicker(ticker: Ticker) { this.tickers.add(ticker) }
  removeTicker(ticker: Ticker) { this.tickers.delete(ticker); this.dirty = true }

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
