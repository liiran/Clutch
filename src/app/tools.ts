// What the pointer and keyboard do in the viewport. There are four tools: Select, Place,
// Paint and Erase. Left drag always orbits and right drag always pans, whatever the tool.

import * as THREE from 'three'
import { MAX_PIECES, MAX_Y, SIZE, type Brick, type Rot } from '../core/model.ts'
import { COLOR, DEFAULT_COLOR } from '../core/colors.ts'
import { DEFAULT_PART, PART } from '../core/parts.ts'
import { alignTo, holdStud } from '../core/snap.ts'
import { WHITE_TINT, RED_TINT } from '../render/layer.ts'
import { castRay, type Hit } from '../render/raycast.ts'
import type { Stage } from '../render/stage.ts'
import type { Store } from './store.ts'
import type { View } from './view.ts'

export type Mode = 'select' | 'place' | 'paint' | 'erase'

interface Spot {
  x: number
  y: number
  z: number
  ok: boolean
  why: string
  grips: boolean
}

const DRAG = 7 // pixels of travel that turn a click into an orbit

export class Tools {
  mode: Mode = 'select'
  part = DEFAULT_PART
  color = DEFAULT_COLOR
  rot: Rot = 0
  selected: number | null = null
  private locked = true
  private stage: Stage
  private store: Store
  private view: View

  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private pointer: { x: number; y: number } | null = null
  private hoverQueued = false
  private hoverId: number | null = null
  private paintTint = new THREE.Color()
  private down: { x: number; y: number; id: number } | null = null
  private dragged = false
  private lifted: number | null = null // the piece on the pointer, picked up by Move
  private heldSpot: { x: number; y: number; z: number; key: string } | null = null // where the ghost is holding

  onState: () => void = () => {}
  onSelection: () => void = () => {}
  onHint: (text: string, ms?: number) => void = () => {}
  onLabel: (text: string, warn: boolean) => void = () => {}

  constructor(stage: Stage, store: Store, view: View) {
    this.stage = stage
    this.store = store
    this.view = view
    const canvas = stage.canvas

    canvas.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return
      this.down = { x: event.clientX, y: event.clientY, id: event.pointerId }
      this.dragged = false
    })
    canvas.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY }
      if (this.down && event.pointerId === this.down.id) {
        if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > DRAG) this.dragged = true
      }
      this.queueHover()
    })
    canvas.addEventListener('pointerup', (event) => {
      if (!this.down || event.pointerId !== this.down.id) return
      this.down = null
      if (this.dragged || this.locked) return
      this.pointer = { x: event.clientX, y: event.clientY }
      this.click(event.altKey)
    })
    canvas.addEventListener('pointercancel', () => { this.down = null })
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null
      this.clearHover()
    })
    stage.controls.addEventListener('change', () => this.queueHover())
    store.onChange((change) => {
      if (change.cause === 'undo') this.lifted = null
      if (this.selected !== null) {
        if (store.grid.bricks.has(this.selected)) this.onSelection()
        else this.select(null)
      }
      this.queueHover()
    })
    document.addEventListener('keydown', (event) => this.key(event))
  }

  // Locked while a preview or a replay is on screen: the camera works, the tools do not.
  setLocked(locked: boolean) {
    this.locked = locked
    if (locked) {
      this.clearHover()
      this.select(null)
      this.onHint('')
    }
    this.queueHover()
    this.refreshCursor()
    this.onState()
    this.showModeHint()
  }

  get isLocked() { return this.locked }

  // Puts a piece picked up by Move back where it was.
  cancelLift() {
    if (this.lifted === null) return
    const id = this.lifted
    this.lifted = null
    this.store.undo()
    return id
  }

  setMode(mode: Mode) {
    const back = mode === 'place' ? undefined : this.cancelLift()
    this.mode = mode
    if (mode !== 'select') this.select(null)
    else if (back !== undefined) this.select(back)
    this.clearHover()
    this.refreshCursor()
    this.queueHover()
    this.onState()
    this.showModeHint()
  }

  private showModeHint() {
    if (this.locked) return
    const color = COLOR.get(this.color)!.name.toLowerCase()
    this.onHint({
      select: '',
      place: 'Click to place · R rotates · Esc stops',
      paint: `Click a piece to paint it ${color}`,
      erase: 'Click a piece to remove it',
    }[this.mode])
  }

  pickPart(part: string) {
    this.cancelLift()
    this.part = part
    this.setMode('place')
  }

  pickColor(color: string) {
    this.color = color
    if (this.selected !== null) this.store.update(this.selected, { color })
    else if (this.mode === 'erase') this.mode = 'paint'
    this.clearHover()
    this.queueHover()
    this.onState()
    this.showModeHint()
  }

  rotate() {
    this.rot = ((this.rot + 1) % 4) as Rot
    this.queueHover()
    this.onState()
  }

  select(id: number | null) {
    if (this.selected === id) return
    this.selected = id
    this.view.showFrame(id === null ? null : this.store.grid.bricks.get(id) ?? null)
    this.onSelection()
  }

  // ── Actions on the selected piece ────────────────────────────
  deleteSelected() {
    if (this.selected !== null) this.store.remove(this.selected)
  }

  rotateSelected() {
    if (this.selected === null) return
    const brick = this.store.grid.bricks.get(this.selected)!
    for (let turn = 1; turn < 4; turn++) {
      const rot = ((brick.rot + turn) % 4) as Rot
      if (this.store.update(brick.id, { rot })) { this.onSelection(); return }
    }
    this.onHint('No room to turn it here', 2200)
  }

  // Lifts the selected piece onto the pointer, to put down somewhere else.
  moveSelected() {
    if (this.selected === null) return
    const brick = this.store.grid.bricks.get(this.selected)!
    this.grab(brick)
    this.store.remove(brick.id)
    this.setMode('place')
    this.lifted = brick.id
    this.onHint('Click to put it down · Esc puts it back')
  }

  copySelected() {
    if (this.selected === null) return
    this.grab(this.store.grid.bricks.get(this.selected)!)
    this.setMode('place')
  }

  private grab(brick: Brick) {
    this.part = brick.part
    this.color = brick.color
    this.rot = brick.rot
  }

  // ── Hover ────────────────────────────────────────────────────
  private queueHover() {
    if (this.hoverQueued) return
    this.hoverQueued = true
    requestAnimationFrame(() => {
      this.hoverQueued = false
      this.hover()
    })
  }

  private hit(): Hit | null {
    if (!this.pointer) return null
    const rect = this.stage.canvas.getBoundingClientRect()
    this.ndc.set(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.stage.camera)
    return castRay(this.ray.ray.origin, this.ray.ray.direction, this.store.grid)
  }

  private clearHover() {
    if (this.hoverId !== null) this.view.tint(this.hoverId, null)
    this.hoverId = null
    this.view.hideCursor()
    this.onLabel('', false)
  }

  private setHoverTint(id: number | null, tint: THREE.Color) {
    if (this.hoverId !== id) {
      if (this.hoverId !== null) this.view.tint(this.hoverId, null)
      this.hoverId = id
    }
    if (id !== null) this.view.tint(id, tint)
  }

  private hover() {
    if (this.locked || !this.pointer) {
      this.clearHover()
      return
    }
    const hit = this.hit()
    if (this.mode === 'place') {
      this.setHoverTint(null, WHITE_TINT)
      const spot = hit ? this.spotFor(hit) : null
      if (!spot) {
        this.view.hideCursor()
        this.onLabel('', false)
        return
      }
      this.view.showCursor(this.part, this.color, spot.x, spot.y, spot.z, this.rot, spot.ok)
      const where = `x ${spot.x} · z ${spot.z} · height ${spot.y}`
      if (!spot.ok) this.onLabel(`${where} · ${spot.why}`, true)
      else if (!spot.grips) this.onLabel(`${where} · no studs to grip here, it won't be attached`, true)
      else this.onLabel(where, false)
      return
    }
    const id = hit?.kind === 'brick' ? hit.id : null
    const brick = id === null ? undefined : this.store.grid.bricks.get(id)
    if (this.mode === 'erase') this.setHoverTint(id, RED_TINT)
    else if (this.mode === 'paint') {
      this.paintTint.setHex(COLOR.get(this.color)!.hex)
      this.setHoverTint(id, this.paintTint)
    } else this.setHoverTint(id === this.selected ? null : id, WHITE_TINT)
    this.stage.canvas.style.cursor = this.mode === 'select' && brick ? 'pointer' : this.modeCursor()
    this.onLabel(brick ? PART.get(brick.part)!.name : '', false)
  }

  private modeCursor() {
    if (this.locked) return ''
    return this.mode === 'select' ? '' : this.mode === 'place' ? 'crosshair' : 'pointer'
  }

  private refreshCursor() {
    this.stage.canvas.style.cursor = this.modeCursor()
  }

  // Where the picked part would land for what is under the pointer.
  private spotFor(hit: Hit): Spot | null {
    const def = PART.get(this.part)!
    const rotated = def.rots[this.rot]
    const { w, d } = rotated
    const clampX = (value: number) => Math.max(0, Math.min(SIZE - w, value))
    const clampZ = (value: number) => Math.max(0, Math.min(SIZE - d, value))
    const grid = this.store.grid
    let x: number, z: number, y: number
    let settle = false
    // The ghost holds its stud until the pointer has clearly moved on, and only for this
    // part and rotation.
    const key = `${this.part}|${this.rot}`
    const held = this.heldSpot?.key === key ? this.heldSpot : null
    const stud = (ideal: number, axis: 'x' | 'z') => holdStud(ideal, held ? held[axis] : null)
    const onPiece = hit.kind === 'brick' ? grid.bricks.get(hit.id)! : null
    const under = onPiece ? PART.get(onPiece.part)!.rots[onPiece.rot] : null
    const alignedX = (ideal: number) => onPiece && under ? alignTo(ideal, w, onPiece.x, under.w) : ideal
    const alignedZ = (ideal: number) => onPiece && under ? alignTo(ideal, d, onPiece.z, under.d) : ideal

    if (hit.kind === 'plate') {
      // A little way past the edge the ghost stays on the plate. Further out, it is gone.
      if (hit.x < -5 || hit.z < -5 || hit.x > SIZE + 5 || hit.z > SIZE + 5) return null
      x = clampX(stud(hit.x - w / 2, 'x'))
      z = clampZ(stud(hit.z - d / 2, 'z'))
      y = 0
    } else {
      const [nx, ny, nz] = hit.normal
      const [cx, cy, cz] = hit.cell
      if (ny > 0) {
        x = clampX(stud(alignedX(hit.x - w / 2), 'x'))
        z = clampZ(stud(alignedZ(hit.z - d / 2), 'z'))
        y = cy + 1
      } else if (ny < 0) {
        x = clampX(stud(alignedX(hit.x - w / 2), 'x'))
        z = clampZ(stud(alignedZ(hit.z - d / 2), 'z'))
        y = Math.max(0, cy - def.h)
      } else {
        x = nx > 0 ? clampX(cx + 1) : nx < 0 ? clampX(cx - w) : clampX(stud(alignedX(hit.x - w / 2), 'x'))
        z = nz > 0 ? clampZ(cz + 1) : nz < 0 ? clampZ(cz - d) : clampZ(stud(alignedZ(hit.z - d / 2), 'z'))
        y = cy
        settle = true
      }
    }

    // Beside a piece, it comes down until something holds it.
    if (settle) {
      while (y > 0 && grid.fits(this.part, x, y - 1, z, this.rot).ok && !grid.grips(this.part, x, y, z, this.rot)) y--
    }
    // Then up until it is clear of everything.
    while (y + def.h <= MAX_Y && !grid.fits(this.part, x, y, z, this.rot).ok) y++
    this.heldSpot = { x, y, z, key }
    if (y + def.h > MAX_Y) {
      return { x, y: Math.max(0, MAX_Y - def.h), z, ok: false, why: `the height limit is ${MAX_Y / 3} bricks`, grips: false }
    }
    if (this.store.count >= MAX_PIECES) {
      return { x, y, z, ok: false, why: `this build has reached ${MAX_PIECES} pieces`, grips: true }
    }
    return { x, y, z, ok: true, why: '', grips: grid.grips(this.part, x, y, z, this.rot) }
  }

  private click(pickUp: boolean) {
    const hit = this.hit()
    if (pickUp) {
      if (hit?.kind === 'brick') {
        this.grab(this.store.grid.bricks.get(hit.id)!)
        this.setMode('place')
      }
      return
    }
    if (this.mode === 'place') {
      const spot = hit ? this.spotFor(hit) : null
      if (!spot) return
      if (!spot.ok) { this.onHint(`Can't place here: ${spot.why}`, 2400); return }
      if (this.store.place(this.part, this.color, spot.x, spot.y, spot.z, this.rot)) this.lifted = null
      return
    }
    const id = hit?.kind === 'brick' ? hit.id : null
    if (this.mode === 'select') { this.select(id); return }
    if (id === null) return
    if (this.mode === 'erase') {
      this.setHoverTint(null, WHITE_TINT)
      this.store.remove(id)
    } else if (this.mode === 'paint') {
      if (this.store.grid.bricks.get(id)!.color !== this.color) {
        this.setHoverTint(null, WHITE_TINT)
        this.store.update(id, { color: this.color })
      }
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────
  private key(event: KeyboardEvent) {
    const el = document.activeElement as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (document.querySelector('dialog[open]')) return
    if (document.documentElement.classList.contains('scene')) return

    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'z' && !this.locked) {
        event.preventDefault()
        if (event.shiftKey) this.store.redo()
        else this.store.undo()
      } else if (event.key.toLowerCase() === 'y' && !this.locked) {
        event.preventDefault()
        this.store.redo()
      }
      return
    }
    if (event.key.toLowerCase() === 'f') { this.view.frameAll(); return }
    if (this.locked) return

    switch (event.key.toLowerCase()) {
      case 'v': this.setMode('select'); break
      case 'b': this.setMode('place'); break
      case 'p': this.setMode('paint'); break
      case 'e': this.setMode('erase'); break
      case 'r':
        if (this.selected !== null) this.rotateSelected()
        else this.rotate()
        break
      case 'g': this.moveSelected(); break
      case 'c': this.copySelected(); break
      case 'escape':
        if (this.selected !== null) this.select(null)
        else this.setMode('select')
        break
      case 'delete':
      case 'backspace':
        event.preventDefault()
        this.deleteSelected()
        break
    }
  }
}
