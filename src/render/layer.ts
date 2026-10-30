// A layer draws many pieces cheaply: one InstancedMesh per part, shared by every piece
// of that part, so a build of thousands of pieces is a few dozen draw calls.

import * as THREE from 'three'
import { SIZE, type Brick } from '../core/model.ts'
import { COLOR } from '../core/colors.ts'
import { PART } from '../core/parts.ts'
import { PLATE_H, subsFor, type Sub } from './geometry.ts'

const OFF = SIZE / 2

type MaterialsFor = (sub: Sub, glassBody: boolean) => THREE.Material[]

interface Pool {
  key: string
  subs: Sub[]
  meshes: THREE.InstancedMesh[][] // by sub, then by material
  ids: number[]
  capacity: number
  glassBody: boolean
}

interface Slot {
  brick: Brick
  pool: Pool
  index: number
  dy: number
  scale: number
  tint: THREE.Color | null
}

const matrix = new THREE.Matrix4()
const scaling = new THREE.Vector3()
const color = new THREE.Color()

export class BrickLayer {
  readonly group = new THREE.Group()
  private pools = new Map<string, Pool>()
  private slots = new Map<number, Slot>()
  private materials: MaterialsFor
  private shadows: boolean
  private onChange: () => void

  constructor(materials: MaterialsFor, shadows: boolean, onChange: () => void) {
    this.materials = materials
    this.shadows = shadows
    this.onChange = onChange
  }

  private makeMeshes(pool: Pool, capacity: number) {
    return pool.subs.map((sub) => this.materials(sub, pool.glassBody).map((material, order) => {
      const mesh = new THREE.InstancedMesh(sub.geometry, material, capacity)
      mesh.count = pool.ids.length
      mesh.frustumCulled = false
      mesh.renderOrder = order
      const opaque = !(material as THREE.MeshStandardMaterial).transparent
      mesh.castShadow = this.shadows && opaque
      mesh.receiveShadow = this.shadows && opaque
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
      this.group.add(mesh)
      return mesh
    }))
  }

  private poolFor(part: string, glassBody: boolean): Pool {
    const key = `${part}|${glassBody ? 1 : 0}`
    let pool = this.pools.get(key)
    if (!pool) {
      pool = { key, subs: subsFor(part), meshes: [], ids: [], capacity: 8, glassBody }
      pool.meshes = this.makeMeshes(pool, pool.capacity)
      this.pools.set(key, pool)
    }
    return pool
  }

  private grow(pool: Pool) {
    const capacity = pool.capacity * 2
    const next = this.makeMeshes(pool, capacity)
    pool.meshes.forEach((row, s) => row.forEach((mesh, m) => {
      next[s][m].instanceMatrix.array.set(mesh.instanceMatrix.array)
      next[s][m].instanceColor!.array.set(mesh.instanceColor!.array)
      this.group.remove(mesh)
      mesh.dispose()
    }))
    pool.meshes = next
    pool.capacity = capacity
  }

  private writeMatrix(slot: Slot) {
    const { brick, pool, index, dy, scale } = slot
    const def = PART.get(brick.part)!
    const rotated = def.rots[brick.rot]
    matrix.makeRotationY(-brick.rot * Math.PI / 2)
    if (scale !== 1) matrix.scale(scaling.setScalar(scale))
    matrix.setPosition(brick.x + rotated.w / 2 - OFF, brick.y * PLATE_H + dy, brick.z + rotated.d / 2 - OFF)
    for (const row of pool.meshes) {
      for (const mesh of row) {
        mesh.setMatrixAt(index, matrix)
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  private writeColor(slot: Slot) {
    const { brick, pool, index, tint } = slot
    const hex = COLOR.get(brick.color)!.hex
    pool.subs.forEach((sub, s) => {
      color.setHex(sub.fixed ?? hex)
      if (tint) color.lerp(tint, tint === RED_TINT || sub.fixed === undefined ? 0.5 : 0.25)
      for (const mesh of pool.meshes[s]) {
        mesh.setColorAt(index, color)
        mesh.instanceColor!.needsUpdate = true
      }
    })
  }

  has(id: number) { return this.slots.has(id) }
  brick(id: number) { return this.slots.get(id)?.brick }

  add(brick: Brick) {
    if (this.slots.has(brick.id)) this.remove(brick.id)
    const pool = this.poolFor(brick.part, Boolean(COLOR.get(brick.color)!.glass))
    if (pool.ids.length === pool.capacity) this.grow(pool)
    const slot: Slot = { brick, pool, index: pool.ids.length, dy: 0, scale: 1, tint: null }
    pool.ids.push(brick.id)
    for (const row of pool.meshes) for (const mesh of row) mesh.count = pool.ids.length
    this.slots.set(brick.id, slot)
    this.writeMatrix(slot)
    this.writeColor(slot)
    this.onChange()
  }

  remove(id: number) {
    const slot = this.slots.get(id)
    if (!slot) return
    const { pool, index } = slot
    const last = pool.ids.length - 1
    if (index !== last) {
      const movedId = pool.ids[last]
      const moved = this.slots.get(movedId)!
      pool.ids[index] = movedId
      moved.index = index
      this.writeMatrix(moved)
      this.writeColor(moved)
    }
    pool.ids.pop()
    for (const row of pool.meshes) {
      for (const mesh of row) {
        mesh.count = pool.ids.length
        mesh.instanceMatrix.needsUpdate = true
      }
    }
    this.slots.delete(id)
    this.onChange()
  }

  // A changed piece keeps its id; its pose and tint are reset.
  update(brick: Brick) {
    this.add(brick)
  }

  // Lifts and scales a piece for an animation, without moving it in the build.
  setPose(id: number, dy: number, scale = 1) {
    const slot = this.slots.get(id)
    if (!slot) return
    slot.dy = dy
    slot.scale = scale
    this.writeMatrix(slot)
    this.onChange()
  }

  setTint(id: number, tint: THREE.Color | null) {
    const slot = this.slots.get(id)
    if (!slot || slot.tint === tint) return
    slot.tint = tint
    this.writeColor(slot)
    this.onChange()
  }

  ids() { return [...this.slots.keys()] }

  clear() {
    for (const pool of this.pools.values()) {
      for (const row of pool.meshes) {
        for (const mesh of row) {
          this.group.remove(mesh)
          mesh.dispose()
        }
      }
    }
    this.pools.clear()
    this.slots.clear()
    this.onChange()
  }
}

export const RED_TINT = new THREE.Color(0xff3b30)
export const WHITE_TINT = new THREE.Color(0xffffff)

// The materials for real pieces. Tints and colours come from each instance.
export function solidMaterials() {
  const body = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0 })
  const glass = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false })
  return (sub: Sub, glassBody: boolean): THREE.Material[] => [sub.glass || (glassBody && sub.fixed === undefined) ? glass : body]
}

// Ghosts draw depth first, so they read as solid see-through shapes and not as a
// tangle of the faces behind them.
export function ghostMaterials(opacity: number) {
  const depth = new THREE.MeshBasicMaterial({ colorWrite: false })
  const ghost = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, transparent: true, opacity, depthWrite: false, depthFunc: THREE.LessEqualDepth })
  const set = (_sub: Sub): THREE.Material[] => [depth, ghost]
  return { set, ghost }
}
