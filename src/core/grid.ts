// The occupancy grid: one cell per stud and plate height, holding the piece there.
// Collisions, the pointer's ray and the attachment check all read this, so none of
// them slow down as a build grows.

import { MAX_Y, SIZE, type Brick, type Rot } from './model.ts'
import { PART } from './parts.ts'

export type Fit = { ok: true } | { ok: false; reason: 'unknown' | 'bounds' | 'height' | 'collision'; blocker?: number }

export class Grid {
  private cells = new Int32Array(SIZE * SIZE * MAX_Y)
  readonly bricks = new Map<number, Brick>()

  constructor(bricks: Iterable<Brick> = []) {
    for (const brick of bricks) this.add(brick)
  }

  get(x: number, y: number, z: number): number {
    if (x < 0 || z < 0 || y < 0 || x >= SIZE || z >= SIZE || y >= MAX_Y) return 0
    return this.cells[x + z * SIZE + y * SIZE * SIZE]
  }

  add(brick: Brick) {
    this.write(brick, brick.id)
    this.bricks.set(brick.id, brick)
  }

  remove(brick: Brick) {
    this.write(brick, 0)
    this.bricks.delete(brick.id)
  }

  private write(brick: Brick, value: number) {
    const rotated = PART.get(brick.part)!.rots[brick.rot]
    for (const [cx, cz, layer] of rotated.solid) {
      this.cells[brick.x + cx + (brick.z + cz) * SIZE + (brick.y + layer) * SIZE * SIZE] = value
    }
  }

  // Would this piece fit here? `ignore` lets a piece be tested against everything but itself.
  fits(part: string, x: number, y: number, z: number, rot: Rot, ignore = 0): Fit {
    const def = PART.get(part)
    if (!def) return { ok: false, reason: 'unknown' }
    const rotated = def.rots[rot]
    if (x < 0 || z < 0 || y < 0 || x + rotated.w > SIZE || z + rotated.d > SIZE) return { ok: false, reason: 'bounds' }
    if (y + def.h > MAX_Y) return { ok: false, reason: 'height' }
    for (const [cx, cz, layer] of rotated.solid) {
      const at = this.cells[x + cx + (z + cz) * SIZE + (y + layer) * SIZE * SIZE]
      if (at && at !== ignore) return { ok: false, reason: 'collision', blocker: at }
    }
    return { ok: true }
  }

  // Does a piece here grip the baseplate or another piece, through a stud?
  grips(part: string, x: number, y: number, z: number, rot: Rot, ignore = 0): boolean {
    const def = PART.get(part)!
    const rotated = def.rots[rot]
    if (y === 0 && rotated.bottom.length) return true
    for (const [cx, cz] of rotated.bottom) {
      const below = this.get(x + cx, y - 1, z + cz)
      if (!below || below === ignore) continue
      if (hasStudAt(this.bricks.get(below)!, x + cx, z + cz, y)) return true
    }
    const top = y + def.h
    for (const [cx, cz] of rotated.studs) {
      const above = this.get(x + cx, top, z + cz)
      if (!above || above === ignore) continue
      if (hasBottomAt(this.bricks.get(above)!, x + cx, z + cz, top)) return true
    }
    return false
  }

  // Every piece that does not connect back to the baseplate, by id.
  loose(): number[] {
    const links = new Map<number, number[]>()
    const link = (a: number, b: number) => {
      if (!links.has(a)) links.set(a, [])
      links.get(a)!.push(b)
    }
    const queue: number[] = []
    const reached = new Set<number>()
    for (const brick of this.bricks.values()) {
      const def = PART.get(brick.part)!
      const rotated = def.rots[brick.rot]
      if (brick.y === 0 && rotated.bottom.length && !reached.has(brick.id)) {
        reached.add(brick.id)
        queue.push(brick.id)
      }
      const top = brick.y + def.h
      for (const [cx, cz] of rotated.studs) {
        const above = this.get(brick.x + cx, top, brick.z + cz)
        if (above && above !== brick.id && hasBottomAt(this.bricks.get(above)!, brick.x + cx, brick.z + cz, top)) {
          link(brick.id, above)
          link(above, brick.id)
        }
      }
    }
    while (queue.length) {
      for (const next of links.get(queue.pop()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next)
          queue.push(next)
        }
      }
    }
    return [...this.bricks.keys()].filter((id) => !reached.has(id))
  }
}

// Does this piece grip downward at this cell, starting from this height?
function hasBottomAt(brick: Brick, x: number, z: number, y: number): boolean {
  if (brick.y !== y) return false
  const rotated = PART.get(brick.part)!.rots[brick.rot]
  return rotated.bottomMask[x - brick.x + (z - brick.z) * rotated.w] === 1
}

// Does this piece have a stud at this cell, at this height?
function hasStudAt(brick: Brick, x: number, z: number, top: number): boolean {
  const def = PART.get(brick.part)!
  if (brick.y + def.h !== top) return false
  return def.rots[brick.rot].studs.some(([cx, cz]) => brick.x + cx === x && brick.z + cz === z)
}
