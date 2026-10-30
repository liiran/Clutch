// The order a build goes together in: from the baseplate up, in small steps,
// like the pages of an instruction booklet.

import type { Brick } from './model.ts'

export const MAX_STEP = 10 // pieces per step

export interface Step {
  bricks: Brick[]
}

export interface PartCount {
  part: string
  color: string
  count: number
}

export function buildOrder(bricks: readonly Brick[]): Brick[] {
  return [...bricks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x || a.id - b.id)
}

export function planSteps(bricks: readonly Brick[]): Step[] {
  const steps: Step[] = []
  let layer: Brick[] = []
  const flush = () => {
    const parts = Math.max(1, Math.ceil(layer.length / MAX_STEP))
    const size = Math.ceil(layer.length / parts)
    for (let i = 0; i < layer.length; i += size) steps.push({ bricks: layer.slice(i, i + size) })
    layer = []
  }
  for (const brick of buildOrder(bricks)) {
    if (layer.length && layer[0].y !== brick.y) flush()
    layer.push(brick)
  }
  if (layer.length) flush()
  return steps
}

// One line per part and colour, most used first.
export function countParts(bricks: readonly Brick[]): PartCount[] {
  const counts = new Map<string, PartCount>()
  for (const brick of bricks) {
    const key = `${brick.part}|${brick.color}`
    const row = counts.get(key)
    if (row) row.count++
    else counts.set(key, { part: brick.part, color: brick.color, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.part.localeCompare(b.part) || a.color.localeCompare(b.color))
}
