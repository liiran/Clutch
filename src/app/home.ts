// The landing scene: the title drops onto the baseplate in chunky bricks of mixed sizes,
// and a big button opens the editor. It is kept deliberately light. Hidden studs are never
// made, the little garden is one mesh, and nothing draws once the title has landed.
//
// It is the editor with its panels off screen, so opening it needs no new page: the title
// leaves, the camera glides and the panels slide in.

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COLOR } from '../core/colors.ts'
import { SIZE } from '../core/model.ts'
import { PLATE_H, pieceGeometry, plainBox, studsOn } from '../render/geometry.ts'
import { easeInOutCubic, type Stage } from '../render/stage.ts'
import { playClick } from '../render/sound.ts'

// One piece of a letter: from column x, w studs wide, from height y, h plates tall.
interface Piece { x: number; w: number; y: number; h: number }
interface Letter { color: string; width: number; pieces: Piece[] }

const p = (x: number, w: number, y: number, h: number): Piece => ({ x, w, y, h })

// Every letter is 15 plates tall, made of tall, medium and small bricks that differ from
// one stroke to the next. The H's left side is one big brick and a small one, and its
// right side two medium ones.
const LETTERS: Letter[] = [
  { color: 'red', width: 4, pieces: [p(0, 4, 0, 3), p(0, 1, 3, 6), p(0, 1, 9, 3), p(0, 3, 12, 3), p(3, 1, 12, 3)] },
  { color: 'yellow', width: 4, pieces: [p(1, 3, 0, 3), p(0, 1, 0, 9), p(0, 1, 9, 6)] },
  { color: 'white', width: 4, pieces: [p(0, 4, 0, 3), p(0, 1, 3, 9), p(0, 1, 12, 3), p(3, 1, 3, 3), p(3, 1, 6, 9)] },
  { color: 'blue', width: 5, pieces: [p(2, 1, 0, 3), p(2, 1, 3, 9), p(0, 3, 12, 3), p(3, 2, 12, 3)] },
  { color: 'orange', width: 4, pieces: [p(0, 2, 0, 3), p(2, 2, 0, 3), p(0, 1, 3, 3), p(0, 1, 6, 6), p(0, 4, 12, 3)] },
  { color: 'purple', width: 4, pieces: [p(0, 1, 0, 12), p(0, 1, 12, 3), p(3, 1, 0, 7), p(3, 1, 7, 8), p(1, 2, 6, 3)] },
]

const OFF = SIZE / 2
const TITLE_Z = 21, TITLE_DEPTH = 2
const FALL = 0.72
const CAP_LENGTH = 30, CAP_DEPTH = 7.6, CAP_H = 1.1, BASE_H = 0.28, GUARD_H = 0.72, PRESS = 0.42

interface Faller { mesh: THREE.Mesh; rest: number; start: number; landed: boolean }

function labelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const g = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const draw = () => {
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.font = "700 125px 'Space Grotesk', 'Inter', system-ui, sans-serif"
    g.textBaseline = 'middle'
    const text = 'Start building', mark = 66, gap = 35
    const total = g.measureText(text).width + gap + mark
    const x = canvas.width / 2 - total / 2
    g.fillStyle = '#2a2206'
    g.fillText(text, x, canvas.height / 2 + 6)
    const mx = x + total - mark, my = canvas.height / 2
    g.beginPath()
    g.moveTo(mx, my - mark / 2)
    g.lineTo(mx, my + mark / 2)
    g.lineTo(mx + mark * 0.86, my)
    g.closePath()
    g.fill()
    texture.needsUpdate = true
  }
  draw()
  void document.fonts?.load("700 125px 'Space Grotesk'").then(draw, () => {})
  return texture
}

// Two trees and a few flowers, as one mesh with one colour per vertex.
function garden(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = []
  const add = (geometry: THREE.BufferGeometry, hex: number, x: number, y: number, z: number) => {
    const flat = geometry.toNonIndexed()
    flat.deleteAttribute('uv')
    flat.translate(x - OFF + 0.5, y, z - OFF + 0.5)
    const color = new THREE.Color(hex)
    const count = flat.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3)
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(flat)
  }
  const trunk = new THREE.CylinderGeometry(0.45, 0.55, 1.6, 8)
  const crown = new THREE.ConeGeometry(1.5, 3.2, 10)
  const top = new THREE.ConeGeometry(1.05, 2.2, 10)
  for (const [x, z] of [[11.5, 19.5], [51.5, 21.5]]) {
    add(trunk, COLOR.get('brown')!.hex, x, 0.8, z)
    add(crown, COLOR.get('green')!.hex, x, 2.9, z)
    add(top, COLOR.get('green')!.hex, x, 4.7, z)
  }
  const stem = new THREE.CylinderGeometry(0.06, 0.06, 0.9, 5)
  const head = new THREE.CylinderGeometry(0.3, 0.2, 0.14, 7)
  const flowers: Array<[string, number, number]> = [['red', 14, 23], ['pink', 10, 24], ['yellow', 15, 20], ['purple', 48, 24], ['white', 53, 25], ['orange', 49, 20]]
  for (const [color, x, z] of flowers) {
    add(stem, COLOR.get('green')!.hex, x, 0.45, z)
    add(head, COLOR.get(color)!.hex, x, 0.95, z)
  }
  const merged = mergeGeometries(parts)!
  parts.forEach((part) => part.dispose())
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }))
  mesh.castShadow = true
  return mesh
}

export class Home {
  private stage: Stage
  private title = new THREE.Group()
  private button = new THREE.Group()
  private plants: THREE.Mesh
  private cap = new THREE.Group()
  private fallers: Faller[] = []
  private materials = new Map<string, THREE.MeshPhongMaterial>()
  private hitMeshes: THREE.Mesh[] = []
  private capMaterial = new THREE.MeshPhongMaterial({ color: 0xf7d117, shininess: 40, specular: 0x444444 })
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private capTarget = BASE_H
  private capMoving = false
  private lastTime: number | null = null
  private held = false
  private leaving = false
  private listening = new AbortController()
  onEnter: () => void = () => {}
  onEntered: () => void = () => {}

  // The cap only runs while it has somewhere to go.
  private capTick = (time: number) => {
    const dt = this.lastTime === null ? 0.016 : Math.min(0.1, time - this.lastTime)
    this.lastTime = time
    const gap = this.capTarget - this.cap.position.y
    this.cap.position.y += gap * (1 - Math.exp(-dt * 26))
    if (Math.abs(gap) < 0.002) {
      this.cap.position.y = this.capTarget
      this.capMoving = false
      this.lastTime = null
      this.stage.removeTicker(this.capTick)
    }
    this.stage.invalidateShadows()
  }

  constructor(stage: Stage) {
    this.stage = stage
    this.plants = garden()
    stage.scene.add(this.title, this.button, this.plants)
    this.buildTitle()
    this.buildButton()
    this.frame()
    this.dropTitle()
    this.listen()
    stage.invalidateShadows()
  }

  private materialFor(color: string) {
    let material = this.materials.get(color)
    if (!material) {
      material = new THREE.MeshPhongMaterial({ color: COLOR.get(color)!.hex, shininess: 40, specular: 0x333333 })
      this.materials.set(color, material)
    }
    return material
  }

  private buildTitle() {
    let x = 17
    let order = 0
    for (const letter of LETTERS) {
      for (const piece of [...letter.pieces].sort((a, b) => a.y - b.y || a.x - b.x)) {
        // Only studs that are not under another piece of the letter get made.
        const open: number[] = []
        for (let c = 0; c < piece.w; c++) {
          const cx = piece.x + c
          const covered = letter.pieces.some((other) => other.y === piece.y + piece.h && cx >= other.x && cx < other.x + other.w)
          if (!covered) open.push(c)
        }
        const mesh = new THREE.Mesh(pieceGeometry(piece.w, TITLE_DEPTH, piece.h, open), this.materialFor(letter.color))
        const rest = piece.y * PLATE_H
        mesh.position.set(x + piece.x + piece.w / 2 - OFF, rest, TITLE_Z + TITLE_DEPTH / 2 - OFF)
        mesh.castShadow = true
        this.title.add(mesh)
        this.fallers.push({ mesh, rest, start: order++ * 34, landed: false })
      }
      x += letter.width + 1
    }
  }

  private buildButton() {
    const L = CAP_LENGTH, D = CAP_DEPTH
    const dark = new THREE.MeshLambertMaterial({ color: 0x24262b })
    const guard = new THREE.MeshPhongMaterial({ color: 0x8d9198, shininess: 30, specular: 0x444444 })
    const base = new THREE.Mesh(plainBox(-L / 2 - 1.1, L / 2 + 1.1, 0, BASE_H, -D / 2 - 1.1, D / 2 + 1.1, 0.06), dark)
    // The guard is four walls around the cap, as one mesh.
    const t = 0.55, gx = L / 2 + 0.75, gz = D / 2 + 0.75
    const walls = new THREE.Mesh(mergeGeometries([
      plainBox(-gx, gx, BASE_H, BASE_H + GUARD_H, -gz, -gz + t, 0.05),
      plainBox(-gx, gx, BASE_H, BASE_H + GUARD_H, gz - t, gz, 0.05),
      plainBox(-gx, -gx + t, BASE_H, BASE_H + GUARD_H, -gz + t, gz - t, 0.05),
      plainBox(gx - t, gx, BASE_H, BASE_H + GUARD_H, -gz + t, gz - t, 0.05),
    ])!, guard)
    const cap = new THREE.Mesh(plainBox(-L / 2, L / 2, 0, CAP_H, -D / 2, D / 2, 0.14), this.capMaterial)
    // Studs at both ends, so it reads as a brick you can press.
    const positions: Array<[number, number, number]> = []
    for (const side of [-1, 1]) {
      for (let cx = 0; cx < 2; cx++) {
        for (let cz = 0; cz < 3; cz++) positions.push([side * (L / 2 - 1.3 - cx * 2.1), CAP_H, -2.4 + cz * 2.4])
      }
    }
    const studs = new THREE.Mesh(studsOn(positions, 0.76, 0.42), this.capMaterial)
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(19.5, 4.88),
      new THREE.MeshBasicMaterial({ map: labelTexture(), transparent: true, depthWrite: false }),
    )
    label.rotation.x = -Math.PI / 2
    label.position.y = CAP_H + 0.012
    label.renderOrder = 1
    this.cap.position.y = BASE_H
    this.cap.add(cap, studs, label)
    this.hitMeshes = [cap, label]
    cap.castShadow = true
    base.castShadow = true
    this.button.add(base, walls, this.cap)
    this.button.position.set(0, 0, 9.5)
  }

  // Frames the title and button from low at the front, as close as they fit.
  private frame() {
    const stage = this.stage
    const camera = stage.camera
    const direction = new THREE.Vector3(0, 0.5, 1).normalize()
    const target = new THREE.Vector3(0, 1.6, 2)
    const corners: THREE.Vector3[] = []
    for (const x of [-21, 21]) for (const y of [0, 7]) for (const z of [-13, 16]) corners.push(new THREE.Vector3(x, y, z))
    const place = (distance: number) => {
      camera.position.copy(target).addScaledVector(direction, distance)
      camera.lookAt(target)
      camera.updateMatrixWorld()
    }
    const fits = (distance: number) => {
      place(distance)
      return corners.every((corner) => {
        const projected = corner.clone().project(camera)
        return Math.abs(projected.x) <= 0.97 && Math.abs(projected.y) <= 0.88
      })
    }
    let near = 10, far = 300
    for (let i = 0; i < 24; i++) {
      const mid = (near + far) / 2
      if (fits(mid)) far = mid
      else near = mid
    }
    place(far)
    stage.controls.target.copy(target)
    stage.controls.update()
    stage.invalidate()
  }

  // Letter by letter, from the bottom up: the bricks fall, land and hop.
  private dropTitle() {
    if (this.stage.reducedMotion) return
    const lift = 8, ms = 480, begin = 100
    const lastStart = this.fallers[this.fallers.length - 1].start
    for (const faller of this.fallers) faller.mesh.visible = false
    let t0 = 0
    const tick = () => {
      t0 ||= performance.now()
      const now = performance.now() - t0 - begin
      for (const faller of this.fallers) {
        const k = Math.min(1, Math.max(0, (now - faller.start) / ms))
        if (now < faller.start) continue
        faller.mesh.visible = true
        const u = (k - FALL) / (1 - FALL)
        const height = k < FALL ? lift * (1 - (k / FALL) ** 2) : lift * 0.05 * 4 * u * (1 - u)
        faller.mesh.position.y = faller.rest + height
        if (!faller.landed && k >= FALL) {
          faller.landed = true
          playClick(0.4)
          this.stage.invalidateShadows()
        }
      }
      if (now > lastStart + ms || this.leaving) {
        this.stage.removeTicker(tick)
        this.stage.invalidateShadows()
      }
    }
    this.stage.addTicker(tick)
  }

  private over(event: PointerEvent) {
    const rect = this.stage.canvas.getBoundingClientRect()
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.stage.camera)
    return this.ray.intersectObjects(this.hitMeshes, false).length > 0
  }

  private moveCap(target: number) {
    this.capTarget = target
    if (!this.capMoving) {
      this.capMoving = true
      this.stage.addTicker(this.capTick)
    }
  }

  private listen() {
    const canvas = this.stage.canvas
    const signal = this.listening.signal
    const down = BASE_H - PRESS
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.over(event)) return
      canvas.setPointerCapture?.(event.pointerId)
      this.held = true
      this.moveCap(down)
      this.stage.controls.enabled = false
      playClick(0.5)
    }, { signal })
    canvas.addEventListener('pointerup', (event) => {
      if (!this.held) return
      this.held = false
      this.stage.controls.enabled = true
      if (this.over(event)) this.open()
      else this.moveCap(BASE_H)
    }, { signal })
    canvas.addEventListener('pointercancel', () => {
      this.held = false
      this.moveCap(BASE_H)
      this.stage.controls.enabled = true
    }, { signal })
    canvas.addEventListener('pointermove', (event) => {
      const over = this.over(event)
      canvas.style.cursor = over ? 'pointer' : ''
      if (this.held && !this.leaving) this.moveCap(over ? down : BASE_H) // slide off to cancel
    }, { signal })
    window.addEventListener('resize', () => { if (!this.leaving) requestAnimationFrame(() => this.frame()) }, { signal })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.open()
    }, { signal })
  }

  open() {
    if (this.leaving) return
    this.leaving = true
    this.held = false
    this.stage.controls.enabled = true
    this.moveCap(BASE_H - PRESS)
    this.listening.abort()
    this.stage.canvas.style.cursor = ''
    window.setTimeout(() => void this.enter(), 130)
  }

  private async enter() {
    const stage = this.stage
    const reduce = stage.reducedMotion
    const ms = reduce ? 1 : 1000
    this.onEnter()

    // The panels slide in over the canvas while it keeps its size, and the camera's view
    // narrows to the space they leave. Nothing is resized until the end, so it stays smooth.
    const root = document.documentElement
    const topbar = document.getElementById('topbar')!, side = document.getElementById('sidebar')!, chat = document.getElementById('chat')!
    const stacked = window.innerWidth <= 1024
    const fullW = window.innerWidth, fullH = window.innerHeight
    const L = stacked ? 0 : side.offsetWidth, R = stacked ? 0 : chat.offsetWidth, T = topbar.offsetHeight
    const B = stacked ? side.offsetHeight + chat.offsetHeight : 0
    const viewW = fullW - L - R, viewH = fullH - T - B
    root.classList.remove('scene')
    root.classList.add('entering')

    // Everything leaves: the bricks lift and shrink away, the button sinks into the plate.
    const delays = this.fallers.map(() => Math.random() * 240)
    void stage.tween(reduce ? 1 : 460, (k) => {
      const now = k * 460
      this.fallers.forEach((faller, i) => {
        const u = Math.min(1, Math.max(0, (now - delays[i]) / 220))
        faller.mesh.visible = u < 1
        faller.mesh.position.y = faller.rest + u * 1.6
        faller.mesh.scale.setScalar(Math.max(0.001, 1 - u * u))
      })
      this.plants.scale.y = Math.max(0.001, 1 - k * k)
      this.button.position.y = -k * k * 3
    })

    const view = stage.defaultView(viewW / viewH)
    const p0 = stage.camera.position.clone(), t0 = stage.controls.target.clone()
    const camera = stage.camera
    await stage.tween(ms, (k) => {
      const e = easeInOutCubic(k)
      camera.position.lerpVectors(p0, view.position, e)
      stage.controls.target.lerpVectors(t0, view.target, e)
      const w = fullW + (viewW - fullW) * e, h = fullH + (viewH - fullH) * e
      camera.aspect = w / h
      camera.setViewOffset(w, h, -L * e, -T * e, fullW, fullH)
    })

    // From here on this is the editor, and all of this is gone from memory.
    stage.removeTicker(this.capTick)
    stage.scene.remove(this.title, this.button, this.plants)
    for (const group of [this.title, this.button, this.plants]) {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const material = mesh.material as THREE.MeshBasicMaterial
        material.map?.dispose()
        material.dispose()
      })
    }
    stage.invalidateShadows()
    camera.clearViewOffset()
    root.classList.remove('entering')
    this.onEntered()
    history.replaceState(null, '', '?edit')
  }
}
