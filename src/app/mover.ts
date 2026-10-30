// Lets the person pick up a chat proposal and put it somewhere else before applying it:
// drag the ghost, press R to turn it, or nudge it with the arrow keys. Dragging anywhere
// else still orbits the camera.

import * as THREE from 'three'
import { SIZE, type Brick } from '../core/model.ts'
import { Grid } from '../core/grid.ts'
import { Placing } from '../core/placing.ts'
import { holdStud } from '../core/snap.ts'
import { PLATE_H } from '../render/geometry.ts'
import { castRay } from '../render/raycast.ts'
import type { Stage } from '../render/stage.ts'
import type { View } from './view.ts'

const OFF = SIZE / 2

export class Mover {
  placing: Placing | null = null
  onChange: () => void = () => {}
  private stage: Stage
  private view: View
  private ghost = new Grid()
  private ghostBricks: Brick[] = []
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private drag: { id: number; startDx: number; startDz: number; grabX: number; grabZ: number; plane: THREE.Plane } | null = null

  constructor(stage: Stage, view: View) {
    this.stage = stage
    this.view = view
    const canvas = stage.canvas
    // Before the camera sees this press, so grabbing the ghost does not also orbit.
    canvas.addEventListener('pointerdown', (event) => this.down(event), { capture: true })
    canvas.addEventListener('pointermove', (event) => this.move(event))
    canvas.addEventListener('pointerup', (event) => this.up(event))
    canvas.addEventListener('pointercancel', (event) => this.up(event))
    document.addEventListener('keydown', (event) => this.key(event))
  }

  begin(base: readonly Brick[], added: readonly Brick[]) {
    this.placing = added.length ? new Placing(base, added) : null
    if (!this.placing) return
    this.syncGhost()
    this.view.setProposalState(this.placing.fits)
  }

  end() {
    this.placing = null
    this.release()
    this.setGhost([])
    this.stage.canvas.style.cursor = ''
  }

  private setGhost(bricks: Brick[]) {
    for (const brick of this.ghostBricks) this.ghost.remove(brick)
    for (const brick of bricks) this.ghost.add(brick)
    this.ghostBricks = bricks
  }

  private syncGhost() { this.setGhost(this.placing!.current) }

  private point(event: PointerEvent) {
    const rect = this.stage.canvas.getBoundingClientRect()
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.stage.camera)
  }

  private overGhost() {
    const hit = castRay(this.ray.ray.origin, this.ray.ray.direction, this.ghost)
    return hit?.kind === 'brick' ? hit : null
  }

  private down(event: PointerEvent) {
    if (!this.placing || !event.isPrimary || event.button !== 0) return
    this.point(event)
    const hit = this.overGhost()
    if (!hit) return
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.y * PLATE_H)
    const at = this.ray.ray.intersectPlane(plane, new THREE.Vector3())
    if (!at) return
    this.drag = { id: event.pointerId, startDx: this.placing.dx, startDz: this.placing.dz, grabX: at.x + OFF, grabZ: at.z + OFF, plane }
    this.stage.controls.enabled = false
    this.stage.canvas.setPointerCapture?.(event.pointerId)
    this.stage.canvas.style.cursor = 'grabbing'
  }

  private move(event: PointerEvent) {
    if (!this.placing) return
    this.point(event)
    if (!this.drag) {
      this.stage.canvas.style.cursor = this.overGhost() ? 'grab' : ''
      return
    }
    if (event.pointerId !== this.drag.id) return
    const at = this.ray.ray.intersectPlane(this.drag.plane, new THREE.Vector3())
    if (!at) return
    const { startDx, startDz, grabX, grabZ } = this.drag
    const dx = holdStud(startDx + at.x + OFF - grabX, this.placing.dx)
    const dz = holdStud(startDz + at.z + OFF - grabZ, this.placing.dz)
    if (this.placing.moveTo(dx, dz)) this.moved()
  }

  private up(event: PointerEvent) {
    if (this.drag && event.pointerId === this.drag.id) this.release()
  }

  private release() {
    if (!this.drag) return
    this.drag = null
    this.stage.controls.enabled = true
    if (this.placing) this.stage.canvas.style.cursor = 'grab'
  }

  private moved() {
    const placing = this.placing!
    this.syncGhost()
    this.view.moveProposal(placing.dx, placing.dy, placing.dz)
    this.view.setProposalState(placing.fits)
    this.onChange()
  }

  private key(event: KeyboardEvent) {
    const placing = this.placing
    if (!placing || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]')) return
    const el = document.activeElement as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    const key = event.key.toLowerCase()
    if (key === 'r') {
      placing.turn()
      this.view.setProposalModel(placing.model)
      this.moved()
      this.view.reveal(placing.current, true)
      return
    }
    const step = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key]
    if (!step) return
    event.preventDefault()
    if (placing.moveTo(placing.dx + step[0], placing.dz + step[1])) {
      this.moved()
      this.view.reveal(placing.current, true)
    }
  }
}
