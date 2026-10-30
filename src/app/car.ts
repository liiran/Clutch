// The toy car on the landing page, driven with WASD. It draws nothing while it is parked,
// and has a soft painted shadow instead of a real one, so driving costs almost nothing.

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CAR_RADIUS, isResting, newCar, speedOf, stepCar, floorAt, type Box, type Car, type Ramp, type World } from '../core/drive.ts'
import { SIZE } from '../core/model.ts'
import { pieceGeometry, rampGeometry, studsOn } from '../render/geometry.ts'
import { playClick } from '../render/sound.ts'
import type { Stage } from '../render/stage.ts'

const FOLLOW = 0.32 // how much the camera follows the car around the plate

// Paints every vertex of a part one colour, ready to merge with the others.
function tinted(geometry: THREE.BufferGeometry, hex: number, x: number, y: number, z: number) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  flat.deleteAttribute('uv')
  flat.translate(x, y, z)
  const color = new THREE.Color(hex)
  const count = flat.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3)
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return flat
}

function carMesh(): THREE.Mesh {
  const RED = 0xd01012, WHITE = 0xf4f4f0, BLACK = 0x1e2024, YELLOW = 0xf7d117, GLASS = 0x6fb7ec, GRAY = 0xc9ccd0
  const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.42, 12)
  wheel.rotateZ(Math.PI / 2)
  const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.46, 8)
  hub.rotateZ(Math.PI / 2)
  const parts = [
    tinted(pieceGeometry(2, 4, 2, []), RED, 0, 0.42, 0),
    tinted(studsOn([[-0.5, 1.22, 1.5], [0.5, 1.22, 1.5], [-0.5, 1.22, 0.5], [0.5, 1.22, 0.5]], 0.3, 0.2), RED, 0, 0, 0),
    tinted(pieceGeometry(2, 1, 1, []), GLASS, 0, 1.22, -0.1),
    tinted(pieceGeometry(2, 2, 2, [0, 1]), WHITE, 0, 1.22, -1),
    tinted(pieceGeometry(1, 1, 1, []), YELLOW, -0.55, 0.62, 2),
    tinted(pieceGeometry(1, 1, 1, []), YELLOW, 0.55, 0.62, 2),
  ]
  for (const sx of [-1.12, 1.12]) {
    for (const sz of [-1.25, 1.25]) {
      parts.push(tinted(wheel, BLACK, sx, 0.5, sz), tinted(hub, GRAY, sx, 0.5, sz))
    }
  }
  const merged = mergeGeometries(parts)!
  parts.forEach((part) => part.dispose())
  wheel.dispose()
  hub.dispose()
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }))
}

function softShadow(): THREE.Mesh {
  const paint = document.createElement('canvas')
  paint.width = paint.height = 64
  const g = paint.getContext('2d')!
  const fade = g.createRadialGradient(32, 32, 6, 32, 32, 32)
  fade.addColorStop(0, 'rgba(0,0,0,0.55)')
  fade.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = fade
  g.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(paint)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 5.4), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }))
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = 1
  return mesh
}

// Where the car starts: lined up with the first ramp, so W sends it straight at the title.
const START = { x: 10, z: 7.4 }

// Two ramps: one aimed at the title, and one somewhere different on every visit.
export function makeRamps(boxes: Box[], random: () => number = Math.random): Ramp[] {
  const nearTitle: Ramp = { x0: 7, x1: 13, z0: -4, z1: 1, h: 1.9, rise: 'z-' }
  const ramps = [nearTitle]
  const clear = (ramp: Ramp) => {
    const m = 3.5
    const free = (a: { x0: number; x1: number; z0: number; z1: number }) =>
      ramp.x1 + m < a.x0 || ramp.x0 - m > a.x1 || ramp.z1 + m < a.z0 || ramp.z0 - m > a.z1
    return boxes.every(free) && ramps.every(free)
  }
  const edge = SIZE / 2 - 2
  const rises: Ramp['rise'][] = ['x+', 'x-', 'z+', 'z-']
  for (let tries = 0; tries < 60; tries++) {
    const rise = rises[Math.floor(random() * 4)]
    const alongX = rise[0] === 'x'
    const w = alongX ? 7 : 6, d = alongX ? 6 : 7
    const x0 = -edge + random() * (2 * edge - w), z0 = -edge + random() * (2 * edge - d)
    const ramp: Ramp = { x0, x1: x0 + w, z0, z1: z0 + d, h: 1.9, rise }
    // In front of the title, where it can be seen, and clear of everything.
    if (Math.abs(x0 + w / 2) < 26 && z0 + d / 2 > -6 && z0 + d / 2 < 20 && clear(ramp)) {
      ramps.push(ramp)
      break
    }
  }
  return ramps
}

export class ToyCar {
  readonly group = new THREE.Group()
  private stage: Stage
  private car: Car
  private world: World
  private mesh = carMesh()
  private shadow = softShadow()
  private rampMeshes: THREE.Mesh[] = []
  private keys = new Set<string>()
  private ticking = false
  private last = 0
  private lastBump = 0
  private follow = new THREE.Vector3()
  private listening = new AbortController()

  private tick = (time: number) => {
    const seconds = this.last ? Math.min(0.05, time - this.last) : 1 / 60
    this.last = time
    const input = {
      throttle: (this.held('w', 'arrowup') ? 1 : 0) - (this.held('s', 'arrowdown') ? 1 : 0),
      steer: (this.held('a', 'arrowleft') ? 1 : 0) - (this.held('d', 'arrowright') ? 1 : 0),
    }
    const hit = stepCar(this.car, input, this.world, seconds)
    if (hit > 3 && time - this.lastBump > 0.12) {
      this.lastBump = time
      playClick(Math.min(0.8, 0.25 + hit / 25))
    }
    this.show(seconds)
    if (!this.keys.size && isResting(this.car)) {
      this.ticking = false
      this.last = 0
      this.stage.removeTicker(this.tick)
    }
  }

  constructor(stage: Stage, boxes: Box[], startDelayed: boolean) {
    this.stage = stage
    this.world = { boxes, ramps: makeRamps(boxes), bound: SIZE / 2 - CAR_RADIUS }
    this.car = newCar(START.x, START.z, Math.PI, startDelayed ? 11 : 0)
    this.group.add(this.mesh, this.shadow)
    for (const ramp of this.world.ramps) this.addRamp(ramp)
    this.mesh.position.set(this.car.x, this.car.y, this.car.z)
    this.show(0)
    const signal = this.listening.signal
    document.addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase()
      if (!['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(key)) return
      event.preventDefault()
      this.keys.add(key)
      this.wake()
    }, { signal })
    document.addEventListener('keyup', (event) => { this.keys.delete(event.key.toLowerCase()) }, { signal })
    window.addEventListener('blur', () => this.keys.clear(), { signal })
  }

  private held(a: string, b: string) { return this.keys.has(a) || this.keys.has(b) }

  private addRamp(ramp: Ramp) {
    const alongX = ramp.rise[0] === 'x'
    const w = alongX ? ramp.z1 - ramp.z0 : ramp.x1 - ramp.x0
    const d = alongX ? ramp.x1 - ramp.x0 : ramp.z1 - ramp.z0
    const material = new THREE.MeshPhongMaterial({ color: 0xf57d20, shininess: 30, specular: 0x333333 })
    const mesh = new THREE.Mesh(rampGeometry(w, d, ramp.h), material)
    mesh.position.set((ramp.x0 + ramp.x1) / 2, 0, (ramp.z0 + ramp.z1) / 2)
    mesh.rotation.y = { 'z-': 0, 'x-': Math.PI / 2, 'z+': Math.PI, 'x+': -Math.PI / 2 }[ramp.rise]
    mesh.castShadow = true
    this.rampMeshes.push(mesh)
    this.group.add(mesh)
  }

  // Lets it fall in, once the title has landed.
  wake() {
    if (this.ticking) return
    this.ticking = true
    this.last = 0
    this.stage.addTicker(this.tick)
  }

  private show(seconds: number) {
    const { mesh, shadow, car } = this
    mesh.position.set(car.x, car.y, car.z)
    mesh.rotation.y = car.heading
    // It tips with the slope it is on, or the way it is flying.
    const ahead = 1.3
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading)
    const target = car.grounded
      ? Math.atan2(floorAt(this.world, car.x - fx * ahead, car.z - fz * ahead, car.y) - floorAt(this.world, car.x + fx * ahead, car.z + fz * ahead, car.y), ahead * 2)
      : THREE.MathUtils.clamp(-car.vy * 0.035, -0.45, 0.45)
    mesh.rotation.order = 'YXZ'
    mesh.rotation.x += (target - mesh.rotation.x) * (1 - Math.exp(-seconds * 14))

    const ground = floorAt(this.world, car.x, car.z, car.y)
    const air = Math.max(0, car.y - ground)
    shadow.position.set(car.x, ground + 0.03, car.z)
    shadow.rotation.z = car.heading
    shadow.scale.setScalar(Math.max(0.55, 1 - air * 0.12))

    // The camera drifts a little after the car, so it stays in the picture.
    const want = new THREE.Vector3((car.x - START.x) * FOLLOW, 0, (car.z - START.z) * FOLLOW)
    const move = want.sub(this.follow).multiplyScalar(1 - Math.exp(-seconds * 3))
    this.follow.add(move)
    this.stage.camera.position.add(move)
    this.stage.controls.target.add(move)
    this.stage.invalidate()
  }

  get state() { return { ...this.car, speed: speedOf(this.car), ramps: this.world.ramps.length, bound: this.world.bound, keys: this.keys.size, ticking: this.ticking } }

  stop() {
    this.listening.abort()
    this.keys.clear()
    this.stage.removeTicker(this.tick)
    this.ticking = false
  }

  dispose() {
    this.stop()
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const material = mesh.material as THREE.MeshBasicMaterial
      material.map?.dispose()
      material.dispose()
    })
  }
}
