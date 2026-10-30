// Connects the build to the screen: every change to the store lands here and is shown
// with the right animation. Also draws the placement ghost, the chat's preview and the
// selection frame.

import * as THREE from 'three'
import { SIZE, type Brick } from '../core/model.ts'
import { PART } from '../core/parts.ts'
import { buildOrder } from '../core/steps.ts'
import type { ApplyResult } from '../core/actions.ts'
import { BrickLayer, RED_TINT, ghostMaterials, solidMaterials } from '../render/layer.ts'
import { PLATE_H } from '../render/geometry.ts'
import { playClick, playPaint, playRemove } from '../render/sound.ts'
import type { Stage } from '../render/stage.ts'
import type { Change, Store } from './store.ts'

const OFF = SIZE / 2
const FALL = 0.72

// Height above rest for a piece partway through its drop: a fall, then a small hop.
const dropHeight = (k: number, lift: number) => k < FALL
  ? lift * (1 - (k / FALL) ** 2)
  : lift * 0.07 * 4 * ((k - FALL) / (1 - FALL)) * (1 - (k - FALL) / (1 - FALL))

interface Falling {
  id: number
  start: number
  ms: number
  lift: number
  landed: boolean
  quiet: boolean
}

export class View {
  readonly layer: BrickLayer
  private stage: Stage
  private store: Store
  private cursor: BrickLayer
  private cursorMaterials = ghostMaterials(0.62)
  private cursorKey = ''
  private cursorOffset = new THREE.Vector3()
  private cursorAt: THREE.Vector3 | null = null
  private cursorTicking = false
  private preview: BrickLayer
  private previewMaterials = ghostMaterials(0.55)
  private previewTint: number[] = []
  private previewHidden: Brick[] = []
  private breathe: ((time: number) => void) | null = null
  private falling: Falling[] = []
  private fallTicking = false
  private frame: THREE.InstancedMesh
  private frameBrick: Brick | null = null

  constructor(stage: Stage, store: Store) {
    this.stage = stage
    this.store = store
    const changed = () => stage.invalidateShadows()
    this.layer = new BrickLayer(solidMaterials(), true, changed)
    stage.scene.add(this.layer.group)
    const redraw = () => stage.invalidate()
    this.cursor = new BrickLayer(this.cursorMaterials.set, false, redraw)
    this.preview = new BrickLayer(this.previewMaterials.set, false, redraw)
    stage.scene.add(this.cursor.group, this.preview.group)

    this.frame = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffd21f, toneMapped: false }),
      12,
    )
    this.frame.visible = false
    this.frame.frustumCulled = false
    stage.scene.add(this.frame)

    store.onChange((change) => this.apply(change))
  }

  // Compiles the ghost's shaders ahead of time, so the first pick of a part does not hitch.
  warmUp() {
    this.cursor.add({ id: 1, part: 'plate_1x1', color: 'red', x: 0, y: 0, z: 0, rot: 0 })
    this.stage.renderer.compile(this.stage.scene, this.stage.camera)
    this.cursor.clear()
  }

  private apply(change: Change) {
    for (const brick of change.removed) {
      if (change.cause === 'hand') this.popOut(brick.id)
      else this.layer.remove(brick.id)
    }
    for (const brick of change.changed) this.layer.update(brick)
    for (const brick of change.added) this.layer.add(brick)
    if (change.cause === 'hand') {
      for (const brick of change.added) this.drop([brick], { ms: 340, lift: 1.5, spread: 0 })
      if (change.changed.length) playPaint()
    } else if (change.cause === 'chat') {
      this.dropMany(change.added)
    }
    if (this.frameBrick) {
      const current = this.store.grid.bricks.get(this.frameBrick.id)
      this.showFrame(current ?? null)
    }
    this.stage.invalidateShadows()
  }

  // ── Drops ────────────────────────────────────────────────────
  private drop(bricks: Brick[], options: { ms: number; lift: number; spread: number; quiet?: boolean }) {
    if (this.stage.reducedMotion) {
      if (bricks.length) playClick()
      return
    }
    const now = performance.now()
    bricks.forEach((brick, index) => {
      this.falling = this.falling.filter((item) => item.id !== brick.id)
      this.falling.push({
        id: brick.id, start: now + index * options.spread, ms: options.ms, lift: options.lift,
        landed: false, quiet: Boolean(options.quiet),
      })
      this.layer.setPose(brick.id, options.lift, 0)
    })
    if (!this.fallTicking) {
      this.fallTicking = true
      this.stage.addTicker(this.fallTick)
    }
  }

  // A whole set of pieces going together in build order, in a couple of seconds at most.
  dropMany(bricks: Brick[]) {
    if (!bricks.length) return
    const ordered = buildOrder(bricks)
    const total = Math.min(2600, ordered.length * 70)
    this.drop(ordered, { ms: 360, lift: 2.2, spread: total / ordered.length })
  }

  // One step of a replay.
  dropStep(bricks: Brick[], totalMs: number) {
    const ordered = buildOrder(bricks)
    this.drop(ordered, { ms: 320, lift: 2.2, spread: totalMs / Math.max(1, ordered.length) })
  }

  private fallTick = () => {
    const now = performance.now()
    let active = false
    for (const item of this.falling) {
      const k = Math.min(1, Math.max(0, (now - item.start) / item.ms))
      if (now < item.start) { active = true; continue }
      if (!this.layer.has(item.id)) { item.ms = 0; continue }
      this.layer.setPose(item.id, k >= 1 ? 0 : dropHeight(k, item.lift), Math.min(1, 0.4 + k * 6))
      if (!item.landed && k >= FALL) {
        item.landed = true
        if (!item.quiet) playClick()
      }
      if (k < 1) active = true
    }
    this.falling = this.falling.filter((item) => now < item.start || (item.ms > 0 && now - item.start < item.ms))
    if (!active && !this.falling.length) {
      this.fallTicking = false
      this.stage.removeTicker(this.fallTick)
    }
  }

  private popOut(id: number) {
    playRemove()
    if (this.stage.reducedMotion) { this.layer.remove(id); return }
    this.falling = this.falling.filter((item) => item.id !== id)
    void this.stage.tween(130, (k) => {
      if (this.store.grid.bricks.has(id)) return // undone while it was leaving
      if (k === 1) this.layer.remove(id)
      else this.layer.setPose(id, k * 0.3, 1 - k * k)
    })
  }

  // Freezes or finishes all drops, for a replay or a new animation taking over.
  settle() {
    for (const item of this.falling) this.layer.setPose(item.id, 0, 1)
    this.falling = []
    if (this.fallTicking) {
      this.fallTicking = false
      this.stage.removeTicker(this.fallTick)
    }
  }

  get isAnimating() { return this.falling.length > 0 }

  // The ghost and the selection frame stay out of saved pictures.
  setOverlaysVisible(show: boolean) {
    this.cursor.group.visible = show
    this.preview.group.visible = show
    this.frame.visible = show && Boolean(this.frameBrick)
  }

  hide(id: number) { this.layer.setPose(id, 0, 0) }
  show(id: number) { this.layer.setPose(id, 0, 1) }

  // ── Placement ghost ──────────────────────────────────────────
  showCursor(part: string, color: string, x: number, y: number, z: number, rot: 0 | 1 | 2 | 3, ok: boolean) {
    const key = `${part}|${color}|${x}|${y}|${z}|${rot}|${ok}`
    if (key === this.cursorKey) return
    this.cursorKey = key
    const rotated = PART.get(part)!.rots[rot]
    const at = new THREE.Vector3(x + rotated.w / 2 - OFF, y * PLATE_H, z + rotated.d / 2 - OFF)
    // Slide from where it was, so the ghost feels attached to the pointer and not jumpy.
    if (this.cursorAt && !this.stage.reducedMotion) {
      this.cursorOffset.add(this.cursorAt).sub(at)
      if (this.cursorOffset.length() > 6) this.cursorOffset.set(0, 0, 0)
    }
    this.cursorAt = at
    this.cursor.clear()
    this.cursor.add({ id: 1, part, color, x, y, z, rot })
    if (!ok) this.cursor.setTint(1, RED_TINT)
    this.cursor.group.position.copy(this.cursorOffset)
    if (!this.cursorTicking) {
      this.cursorTicking = true
      let last = performance.now()
      const tick = () => {
        const now = performance.now()
        const decay = Math.exp(-(now - last) / 28)
        last = now
        this.cursorOffset.multiplyScalar(decay)
        this.cursor.group.position.copy(this.cursorOffset)
        if (this.cursorOffset.lengthSq() < 0.0001) {
          this.cursorOffset.set(0, 0, 0)
          this.cursor.group.position.set(0, 0, 0)
          this.cursorTicking = false
          this.stage.removeTicker(tick)
        }
      }
      this.stage.addTicker(tick)
    }
    this.stage.invalidate()
  }

  hideCursor() {
    if (!this.cursorKey) return
    this.cursorKey = ''
    this.cursorAt = null
    this.cursorOffset.set(0, 0, 0)
    this.cursor.clear()
    this.stage.invalidate()
  }

  // ── Chat preview ─────────────────────────────────────────────
  showProposal(result: ApplyResult) {
    this.clearProposal()
    for (const brick of [...result.added, ...result.changed]) this.preview.add(brick)
    for (const brick of result.removed) {
      this.layer.setTint(brick.id, RED_TINT)
      this.previewTint.push(brick.id)
    }
    // A moved or recoloured piece shows only as its new self.
    for (const brick of result.changed) {
      const old = this.layer.brick(brick.id)
      if (old) {
        this.hide(brick.id)
        this.previewHidden.push(old)
      }
    }
    if (!this.stage.reducedMotion) {
      this.breathe = (time) => {
        this.previewMaterials.ghost.opacity = 0.5 + 0.1 * Math.sin(time * 3.2)
      }
      this.stage.addTicker(this.breathe)
    }
    this.stage.invalidate()
  }

  clearProposal() {
    if (this.breathe) {
      this.stage.removeTicker(this.breathe)
      this.breathe = null
    }
    this.preview.clear()
    for (const id of this.previewTint) this.layer.setTint(id, null)
    for (const brick of this.previewHidden) this.show(brick.id)
    this.previewTint = []
    this.previewHidden = []
    this.stage.invalidate()
  }

  // Colours the piece under the pointer. Pass null to restore it.
  tint(id: number, color: THREE.Color | null) { this.layer.setTint(id, color) }

  // ── Selection frame ──────────────────────────────────────────
  showFrame(brick: Brick | null) {
    this.frameBrick = brick
    this.frame.visible = Boolean(brick)
    if (brick) {
      const def = PART.get(brick.part)!
      const rotated = def.rots[brick.rot]
      const w = rotated.w + 0.05, d = rotated.d + 0.05, h = def.h * PLATE_H + 0.05
      const cx = brick.x + rotated.w / 2 - OFF, cz = brick.z + rotated.d / 2 - OFF, cy = brick.y * PLATE_H + (def.h * PLATE_H) / 2
      const t = 0.05
      const bar = new THREE.Matrix4()
      let i = 0
      const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
        bar.makeScale(sx, sy, sz).setPosition(cx + x, cy + y, cz + z)
        this.frame.setMatrixAt(i++, bar)
      }
      for (const sy of [-1, 1]) {
        for (const s of [-1, 1]) {
          put(0, (sy * h) / 2, (s * d) / 2, w + t, t, t)
          put((s * w) / 2, (sy * h) / 2, 0, t, t, d + t)
          put((s * w) / 2, 0, (sy * d) / 2, t, h + t, t)
        }
      }
      this.frame.instanceMatrix.needsUpdate = true
    }
    this.stage.invalidate()
  }

  // The world corners of a set of pieces, for framing the camera.
  boundsOf(bricks: readonly Brick[]): THREE.Box3 {
    const box = new THREE.Box3()
    for (const brick of bricks) {
      const def = PART.get(brick.part)!
      const rotated = def.rots[brick.rot]
      box.expandByPoint(new THREE.Vector3(brick.x - OFF, brick.y * PLATE_H, brick.z - OFF))
      box.expandByPoint(new THREE.Vector3(brick.x + rotated.w - OFF, (brick.y + def.h) * PLATE_H, brick.z + rotated.d - OFF))
    }
    return box
  }

  // Moves the camera only if these pieces are not all in view already.
  reveal(bricks: readonly Brick[]) {
    if (!bricks.length) return
    const box = this.boundsOf(bricks)
    const corners: THREE.Vector3[] = []
    for (let k = 0; k < 8; k++) corners.push(new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z))
    const view = this.stage.fitBox(box.clone().expandByScalar(2), this.stage.camera.aspect, 0.8)
    const distance = this.stage.camera.position.distanceTo(this.stage.controls.target)
    const fitted = view.position.distanceTo(view.target)
    if (!this.stage.canSee(corners) || distance > fitted * 1.5) void this.stage.glideTo(view, 750)
  }

  frameAll() {
    const bricks = this.store.bricks
    if (!bricks.length) { void this.stage.resetView(); return }
    void this.stage.glideTo(this.stage.fitBox(this.boundsOf(bricks).expandByScalar(1.5)), 650)
  }
}
