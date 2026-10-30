// The build as text for the chat model: compact, because it is sent with every message.

import type { Brick } from './model.ts'
import { PART } from './parts.ts'

export function describeBuild(bricks: readonly Brick[]): string {
  if (!bricks.length) return 'The baseplate is empty.'
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 0
  const groups = new Map<string, string[]>()
  for (const b of bricks) {
    const def = PART.get(b.part)!
    const r = def.rots[b.rot]
    minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + r.w - 1)
    minZ = Math.min(minZ, b.z); maxZ = Math.max(maxZ, b.z + r.d - 1)
    maxY = Math.max(maxY, b.y + def.h)
    const key = `${b.part} ${b.color} rot${b.rot}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(`#${b.id}@${b.x},${b.y},${b.z}`)
  }
  const lines = [...groups].map(([key, list]) => `${key}: ${list.join(' ')}`)
  return `${bricks.length} pieces, covering x ${minX} to ${maxX}, z ${minZ} to ${maxZ}, up to height ${maxY} plates.\nEach entry is #id@x,y,z.\n${lines.join('\n')}`
}
