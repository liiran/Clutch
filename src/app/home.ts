// The landing scene: the title drops onto the baseplate in real bricks, and a big button
// opens the editor. It is the editor with its panels off screen, so opening it needs no
// new page: the title leaves, the camera glides and the panels slide in.

import * as THREE from 'three'
import type { Brick, Rot } from '../core/model.ts'
import { tileCells } from '../core/tiling.ts'
import { BrickLayer, solidMaterials } from '../render/layer.ts'
import { plainBox, studsOn } from '../render/geometry.ts'
import { easeInOutCubic, type Stage } from '../render/stage.ts'
import { playClick } from '../render/sound.ts'

const LETTERS: Array<{ color: string; rows: string[] }> = [
  { color: 'red', rows: ['####', '#...', '#...', '#...', '####'] },
  { color: 'yellow', rows: ['#...', '#...', '#...', '#...', '####'] },
  { color: 'white', rows: ['#..#', '#..#', '#..#', '#..#', '####'] },
  { color: 'blue', rows: ['#####', '..#..', '..#..', '..#..', '..#..'] },
  { color: 'orange', rows: ['####', '#...', '#...', '#...', '####'] },
  { color: 'purple', rows: ['#..#', '#..#', '####', '#..#', '#..#'] },
]

const TITLE_Z = 13
const FALL = 0.72
const CAP_LENGTH = 30, CAP_DEPTH = 7.6, CAP_H = 1.1, BASE_H = 0.28, GUARD_H = 0.72, PRESS = 0.42

function titleBricks(): Brick[][] {
  let x = 9
  let id = 1
  const out: Brick[][] = []
  for (const letter of LETTERS) {
    const pieces: Brick[] = []
    const height = letter.rows.length
    // Rows are written top first, and built from the bottom up.
    for (let level = 0; level < height; level++) {
      const row = letter.rows[height - 1 - level]
      const cells: Array<[number, number]> = []
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '#') cells.push([x + i, TITLE_Z], [x + i, TITLE_Z + 1])
      }
      for (const piece of tileCells(cells, 'brick', 'x', level % 2 === 1)) {
        pieces.push({ id: id++, part: piece.part, color: letter.color, x: piece.x, y: level * 3, z: piece.z, rot: piece.rot as Rot })
      }
    }
    out.push(pieces)
    x += letter.rows[0].length + 1
  }
  // A little garden around the title.
  const garden: Brick[] = []
  const put = (part: string, color: string, px: number, y: number, pz: number) => {
    garden.push({ id: id++, part, color, x: px, y, z: pz, rot: 0 })
  }
  for (const [tx, tz] of [[3, 11], [43, 13]]) {
    put('round_2x2', 'brown', tx, 0, tz)
    put('cone_2x2', 'green', tx, 3, tz)
  }
  const flowers: Array<[string, number, number]> = [['red', 6, 15], ['pink', 2, 16], ['yellow', 7, 12], ['purple', 40, 16], ['white', 45, 17], ['orange', 41, 12]]
  for (const [color, fx, fz] of flowers) put('flower_1x1', color, fx, 0, fz)
  out.push(garden)
  return out
}

function labelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 512
  const g = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  const draw = () => {
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.font = "700 250px 'Space Grotesk', 'Inter', system-ui, sans-serif"
    g.textBaseline = 'middle'
    const text = 'Start building', mark = 130, gap = 70
    const total = g.measureText(text).width + gap + mark
    const x = canvas.width / 2 - total / 2
    g.fillStyle = '#2a2206'
    g.fillText(text, x, canvas.height / 2 + 12)
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
  void document.fonts?.load("700 250px 'Space Grotesk'").then(draw, () => {})
  return texture
}

export class Home {
  private stage: Stage
  private layer: BrickLayer
  private letters = titleBricks()
  private group = new THREE.Group()
  private cap = new THREE.Group()
  private hitMeshes: THREE.Mesh[] = []
  private capMaterial = new THREE.MeshStandardMaterial({ color: 0xf7d117, roughness: 0.34, emissive: 0x6b5400, emissiveIntensity: 0.1 })
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private capTarget = BASE_H
  private held = false
  private leaving = false
  private lastTime: number | null = null
  private listening = new AbortController()
  onEnter: () => void = () => {}
  onEntered: () => void = () => {}

  private capTick = (time: number) => {
    const dt = this.lastTime === null ? 0 : Math.min(0.1, time - this.lastTime)
    this.lastTime = time
    this.cap.position.y += (this.capTarget - this.cap.position.y) * (1 - Math.exp(-dt * 26))
    this.capMaterial.emissiveIntensity = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(time * 1.8))
  }

  constructor(stage: Stage) {
    this.stage = stage
    this.layer = new BrickLayer(solidMaterials(), true, () => stage.invalidateShadows())
    stage.scene.add(this.layer.group)
    this.buildButton()
    this.frame()
    this.dropTitle()
    stage.addTicker(this.capTick)
    this.listen()
  }

  private buildButton() {
    const L = CAP_LENGTH, D = CAP_DEPTH
    const dark = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.55 })
    const guard = new THREE.MeshStandardMaterial({ color: 0x8d9198, roughness: 0.42, metalness: 0.4 })
    const base = new THREE.Mesh(plainBox(-L / 2 - 1.1, L / 2 + 1.1, 0, BASE_H, -D / 2 - 1.1, D / 2 + 1.1, 0.06), dark)
    // The guard is four walls around the cap.
    const t = 0.55, gx = L / 2 + 0.75, gz = D / 2 + 0.75
    const walls = [
      plainBox(-gx, gx, BASE_H, BASE_H + GUARD_H, -gz, -gz + t, 0.05),
      plainBox(-gx, gx, BASE_H, BASE_H + GUARD_H, gz - t, gz, 0.05),
      plainBox(-gx, -gx + t, BASE_H, BASE_H + GUARD_H, -gz + t, gz - t, 0.05),
      plainBox(gx - t, gx, BASE_H, BASE_H + GUARD_H, -gz + t, gz - t, 0.05),
    ].map((geometry) => new THREE.Mesh(geometry, guard))
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
      new THREE.MeshBasicMaterial({ map: labelTexture(), transparent: true, depthWrite: false, toneMapped: false }),
    )
    label.rotation.x = -Math.PI / 2
    label.position.y = CAP_H + 0.012
    label.renderOrder = 1
    this.cap.position.y = BASE_H
    this.cap.add(cap, studs, label)
    this.hitMeshes = [cap, label]
    this.group.add(base, ...walls, this.cap)
    this.group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && object !== label) {
        object.castShadow = object.receiveShadow = true
      }
    })
    this.group.position.set(0, 0, 9.5)
    this.stage.scene.add(this.group)
  }

  // Frames the whole scene from low at the front, far enough back that it all fits.
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
        const p = corner.clone().project(camera)
        return Math.abs(p.x) <= 0.97 && Math.abs(p.y) <= 0.88
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

  // Letter by letter, each from the bottom up: the bricks fall, land and hop.
  private dropTitle() {
    const pieces = this.letters.flat()
    for (const brick of pieces) this.layer.add(brick)
    if (this.stage.reducedMotion) return
    const lift = 7, ms = 620, stagger = 34, begin = 420
    const fallers = pieces.map((brick, index) => ({ brick, start: begin + index * stagger, landed: false }))
    for (const faller of fallers) this.layer.setPose(faller.brick.id, lift, 0)
    const t0 = performance.now()
    const tick = () => {
      const now = performance.now() - t0
      let done = true
      for (const faller of fallers) {
        const k = Math.min(1, Math.max(0, (now - faller.start) / ms))
        if (k < 1) done = false
        if (now < faller.start) continue
        if (this.leaving) continue
        const height = k < FALL ? lift * (1 - (k / FALL) ** 2) : lift * 0.05 * 4 * ((k - FALL) / (1 - FALL)) * (1 - (k - FALL) / (1 - FALL))
        this.layer.setPose(faller.brick.id, k >= 1 ? 0 : height, Math.min(1, 0.3 + k * 5))
        if (!faller.landed && k >= FALL) {
          faller.landed = true
          playClick(0.4)
        }
      }
      if (done || this.leaving) this.stage.removeTicker(tick)
    }
    this.stage.addTicker(tick)
  }

  private over(event: PointerEvent) {
    const rect = this.stage.canvas.getBoundingClientRect()
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.stage.camera)
    return this.ray.intersectObjects(this.hitMeshes, false).length > 0
  }

  private listen() {
    const canvas = this.stage.canvas
    const signal = this.listening.signal
    const down = BASE_H - PRESS
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.over(event)) return
      canvas.setPointerCapture?.(event.pointerId)
      this.held = true
      this.capTarget = down
      this.stage.controls.enabled = false
      playClick(0.5)
    }, { signal })
    canvas.addEventListener('pointerup', (event) => {
      if (!this.held) return
      this.held = false
      this.stage.controls.enabled = true
      if (this.over(event)) this.open()
      else this.capTarget = BASE_H
    }, { signal })
    canvas.addEventListener('pointercancel', () => {
      this.held = false
      this.capTarget = BASE_H
      this.stage.controls.enabled = true
    }, { signal })
    canvas.addEventListener('pointermove', (event) => {
      const over = this.over(event)
      canvas.style.cursor = over ? 'pointer' : ''
      if (this.held && !this.leaving) this.capTarget = over ? down : BASE_H // slide off to cancel
    }, { signal })
    window.addEventListener('resize', () => { if (!this.leaving) requestAnimationFrame(() => this.frame()) }, { signal })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.open()
    }, { signal })
  }

  open() {
    if (this.leaving) return
    this.leaving = true
    this.capTarget = BASE_H - PRESS
    this.listening.abort()
    this.stage.canvas.style.cursor = ''
    window.setTimeout(() => void this.enter(), 130)
  }

  private async enter() {
    const stage = this.stage
    const reduce = stage.reducedMotion
    const ms = reduce ? 1 : 1100
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

    // Everything leaves: the title pieces lift and shrink, the button sinks into the plate.
    const pieces = this.letters.flat()
    const leaveStart = pieces.map(() => Math.random() * 320)
    void stage.tween(reduce ? 1 : 620, (k) => {
      const now = k * 620
      pieces.forEach((brick, i) => {
        const p = Math.min(1, Math.max(0, (now - leaveStart[i]) / 280))
        this.layer.setPose(brick.id, p * 1.8, 1 - p * p)
      })
      this.group.position.y = -k * k * 3
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

    // From here on this is the editor.
    stage.removeTicker(this.capTick)
    stage.scene.remove(this.layer.group, this.group)
    this.layer.clear()
    camera.clearViewOffset()
    root.classList.remove('entering')
    this.onEntered()
    history.replaceState(null, '', '?edit')
  }
}
