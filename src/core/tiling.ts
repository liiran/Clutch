// Turns a layer of cells into real pieces, as a builder would: the largest pieces
// that fit, long sides crossing from one layer to the next, and joints staggered so
// walls hold together instead of standing in separate columns.

import type { Rot } from './model.ts'

export type Kind = 'brick' | 'plate' | 'tile'

// Short side, long side, largest first.
const SIZES: Record<Kind, Array<[number, number]>> = {
  brick: [[2, 8], [2, 6], [2, 4], [2, 3], [2, 2], [1, 8], [1, 6], [1, 4], [1, 3], [1, 2], [1, 1]],
  plate: [[6, 6], [4, 8], [4, 4], [2, 8], [2, 6], [2, 4], [2, 2], [1, 4], [1, 2], [1, 1]],
  tile: [[2, 2], [1, 4], [1, 2], [1, 1]],
}

export interface Placed {
  part: string
  x: number
  z: number
  rot: Rot
}

const key = (x: number, z: number) => x * 1000 + z

// How long the first piece of a run may be on an offset layer, so its joints miss the layer below.
function firstLength(run: number, kind: Kind): number {
  if (run <= 1) return 1
  if (run <= 8) return Math.max(1, Math.floor(run / 2))
  return kind === 'brick' ? 4 : 2
}

// `cells` holds [x, z] pairs. `axis` is the way long sides run on this layer, and
// `offset` staggers the joints of narrow runs.
export function tileCells(cells: Array<[number, number]>, kind: Kind, axis: 'x' | 'z', offset: boolean): Placed[] {
  const all = new Set(cells.map(([x, z]) => key(x, z)))
  const open = new Set(all)
  const has = (x: number, z: number) => open.has(key(x, z))
  // Scan along the axis, so each run is taken from its start.
  const order = [...cells].sort(axis === 'x' ? (a, b) => a[1] - b[1] || a[0] - b[0] : (a, b) => a[0] - b[0] || a[1] - b[1])
  const placed: Placed[] = []

  const clear = (x: number, z: number, sx: number, sz: number) => {
    for (let dz = 0; dz < sz; dz++) for (let dx = 0; dx < sx; dx++) if (!has(x + dx, z + dz)) return false
    return true
  }

  for (const [x, z] of order) {
    if (!has(x, z)) continue
    const along = (step: number) => (axis === 'x' ? has(x + step, z) : has(x, z + step))
    let limit = Infinity
    const before = axis === 'x' ? key(x - 1, z) : key(x, z - 1)
    if (offset && !all.has(before)) {
      let run = 1
      while (along(run)) run++
      limit = firstLength(run, kind)
    }
    let done = false
    for (const [short, long] of SIZES[kind]) {
      if (long > limit) continue
      // The id reads short along x at rot 0, so rot 1 lays the long side along x.
      const lay: Array<[number, number, Rot]> = axis === 'x' ? [[long, short, 1], [short, long, 0]] : [[short, long, 0], [long, short, 1]]
      for (const [sx, sz, rot] of lay) {
        if (!clear(x, z, sx, sz)) continue
        for (let dz = 0; dz < sz; dz++) for (let dx = 0; dx < sx; dx++) open.delete(key(x + dx, z + dz))
        placed.push({ part: `${kind}_${short}x${long}`, x, z, rot: short === long ? 0 : rot })
        done = true
        break
      }
      if (done) break
    }
    // The 1×1 piece always fits, so every cell is covered.
    if (!done) {
      open.delete(key(x, z))
      placed.push({ part: `${kind}_1x1`, x, z, rot: 0 })
    }
  }
  return placed
}

// Lengths for a run of slopes or ridges: 4, then 2, then 1.
export function spans(length: number, sizes: number[]): number[] {
  const out: number[] = []
  let left = length
  for (const size of sizes) {
    while (left >= size) {
      out.push(size)
      left -= size
    }
  }
  return out
}
