// Moving a whole proposal around before it is applied. The new pieces move together as one
// rigid model, always stay on the baseplate, and are checked at every spot: overlapping
// something blocks it, and anything left floating is reported.

import { SIZE, type Brick, type Rot } from './model.ts'
import { PART } from './parts.ts'
import { Grid } from './grid.ts'

interface Area { x0: number; x1: number; z0: number; z1: number }

function areaOf(bricks: readonly Brick[]): Area {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const b of bricks) {
    const r = PART.get(b.part)!.rots[b.rot]
    x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + r.w)
    z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z + r.d)
  }
  return { x0, x1, z0, z1 }
}

// A quarter turn clockwise seen from above, around the middle of the model.
export function turnModel(bricks: readonly Brick[]): Brick[] {
  if (!bricks.length) return []
  const { x0, x1, z0, z1 } = areaOf(bricks)
  const W = x1 - x0, D = z1 - z0
  // trunc, so four turns come back to exactly where they started
  const nx0 = x0 + Math.trunc((W - D) / 2), nz0 = z0 + Math.trunc((D - W) / 2)
  return bricks.map((b) => {
    const r = PART.get(b.part)!.rots[b.rot]
    return { ...b, x: nx0 + D - (b.z - z0) - r.d, z: nz0 + (b.x - x0), rot: ((b.rot + 1) % 4) as Rot }
  })
}

export class Placing {
  dx = 0
  dz = 0
  dy = 0
  overlapping = 0        // how many pieces are inside something
  floating = 0           // how many pieces would not be attached
  private grid: Grid
  private wasLoose: Set<number>
  private turned: Brick[]
  private shape: Area
  private moved = false

  constructor(base: readonly Brick[], added: readonly Brick[]) {
    this.grid = new Grid(base)
    this.wasLoose = new Set(this.grid.loose())
    this.turned = [...added]
    this.shape = areaOf(this.turned)
    this.check()
  }

  get fits() { return this.overlapping === 0 }

  // The model before its offset, and the model where it is now.
  get model(): readonly Brick[] { return this.turned }
  get current(): Brick[] {
    return this.turned.map((b) => ({ ...b, x: b.x + this.dx, y: b.y + this.dy, z: b.z + this.dz }))
  }

  // Moves it by whole studs from where it started. It stops at the edges of the baseplate.
  moveTo(dx: number, dz: number) {
    const { x0, x1, z0, z1 } = this.shape
    const nx = Math.max(-x0, Math.min(SIZE - x1, dx))
    const nz = Math.max(-z0, Math.min(SIZE - z1, dz))
    if (nx === this.dx && nz === this.dz && this.moved) return false
    if (nx === this.dx && nz === this.dz) return false
    this.dx = nx
    this.dz = nz
    this.moved = true
    this.check()
    return true
  }

  turn() {
    this.turned = turnModel(this.turned)
    this.shape = areaOf(this.turned)
    this.moved = true
    const { dx, dz } = this
    this.dx = this.dz = NaN // so moveTo applies the clamp and the check
    this.moveTo(dx, dz)
  }

  private fitsAt(dy: number) {
    let blocked = 0
    for (const b of this.turned) {
      if (!this.grid.fits(b.part, b.x + this.dx, b.y + dy, b.z + this.dz, b.rot).ok) blocked++
    }
    return blocked
  }

  private check() {
    if (!this.turned.length) return
    // Moved away from what it was sitting on, it comes down until something holds it.
    this.dy = 0
    if (this.moved) {
      const lowest = this.turned.reduce((low, b) => Math.min(low, b.y), Infinity)
      while (lowest + this.dy > 0 && this.fitsAt(this.dy - 1) === 0) this.dy--
    }
    this.overlapping = this.fitsAt(this.dy)
    this.floating = 0
    if (this.overlapping) return
    const placed = this.current
    for (const b of placed) this.grid.add(b)
    this.floating = this.grid.loose().filter((id) => !this.wasLoose.has(id)).length
    for (const b of placed) this.grid.remove(b)
  }
}
