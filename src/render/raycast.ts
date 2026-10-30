// Finds what the pointer is over by walking the occupancy grid along the ray. The cost
// depends on the grid's size and not the number of pieces, so hovering stays instant.

import type * as THREE from 'three'
import { MAX_Y, SIZE } from '../core/model.ts'
import type { Grid } from '../core/grid.ts'
import { PLATE_H } from './geometry.ts'

const OFF = SIZE / 2

export type Hit =
  | { kind: 'plate'; x: number; z: number }
  | { kind: 'brick'; id: number; cell: [number, number, number]; normal: [number, number, number]; x: number; y: number; z: number }

export function castRay(origin: THREE.Vector3, direction: THREE.Vector3, grid: Grid): Hit | null {
  const o = [origin.x + OFF, origin.y / PLATE_H, origin.z + OFF]
  const d = [direction.x, direction.y / PLATE_H, direction.z]
  const max = [SIZE, MAX_Y, SIZE]

  let tEnter = 0, tExit = Infinity, axis = -1
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < 0 || o[i] > max[i]) { tExit = -1; break }
      continue
    }
    const a = (0 - o[i]) / d[i], b = (max[i] - o[i]) / d[i]
    const near = Math.min(a, b), far = Math.max(a, b)
    if (near > tEnter) { tEnter = near; axis = i }
    if (far < tExit) tExit = far
  }

  if (tEnter <= tExit) {
    const t0 = tEnter + 1e-6
    const cell = [0, 1, 2].map((i) => Math.min(max[i] - 1, Math.max(0, Math.floor(o[i] + d[i] * t0))))
    const step = d.map((v) => v > 0 ? 1 : -1)
    const next = d.map((v, i) => Math.abs(v) < 1e-9 ? Infinity : ((v > 0 ? cell[i] + 1 : cell[i]) - o[i]) / v)
    const delta = d.map((v) => Math.abs(v) < 1e-9 ? Infinity : Math.abs(1 / v))
    let t = t0
    for (let guard = 0; guard < SIZE * 2 + MAX_Y + 4; guard++) {
      const id = grid.get(cell[0], cell[1], cell[2])
      if (id) {
        const normal: [number, number, number] = [0, 0, 0]
        if (axis >= 0) normal[axis] = -step[axis]
        else normal[1] = 1
        return { kind: 'brick', id, cell: [cell[0], cell[1], cell[2]], normal, x: o[0] + d[0] * t, y: o[1] + d[1] * t, z: o[2] + d[2] * t }
      }
      axis = next[0] < next[1] ? (next[0] < next[2] ? 0 : 2) : (next[1] < next[2] ? 1 : 2)
      t = next[axis]
      if (t > tExit) break
      cell[axis] += step[axis]
      if (cell[axis] < 0 || cell[axis] >= max[axis]) break
      next[axis] += delta[axis]
    }
  }

  if (d[1] >= 0) return null
  const t = -o[1] / d[1]
  if (t < 0) return null
  return { kind: 'plate', x: o[0] + d[0] * t, z: o[2] + d[2] * t }
}
