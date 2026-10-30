// The .clutch file: plain JSON, checked piece by piece when it is opened. Pieces that
// no longer fit are left out rather than failing the whole file.

import { MAX_PIECES, isRot, type Brick } from './model.ts'
import { COLOR } from './colors.ts'
import { PART } from './parts.ts'
import { Grid } from './grid.ts'

export const FILE_VERSION = 2
const OLD_PLATE_SHIFT = 8 // version 1 was a 48 stud plate, so its builds move to the new middle
export const BASEPLATES = ['green', 'lightgray', 'darkgray', 'sky', 'tan', 'white']
export const DEFAULT_BASEPLATE = 'green'

export type Row = [string, string, number, number, number, number]

export interface BuildFile {
  version: number
  name: string
  baseplate: string
  bricks: Row[]
}

export interface Build {
  name: string
  baseplate: string
  bricks: Brick[]
  dropped: number
}

export function toFile(name: string, baseplate: string, bricks: readonly Brick[]): BuildFile {
  return {
    version: FILE_VERSION,
    name,
    baseplate,
    bricks: bricks.map((b) => [b.part, b.color, b.x, b.y, b.z, b.rot]),
  }
}

export function fromFile(data: unknown): Build {
  const file = data as Partial<BuildFile> | null
  if (!file || typeof file !== 'object') throw new Error('This is not a Clutch build.')
  if (file.version !== FILE_VERSION && file.version !== 1) throw new Error('This build was saved in a version Clutch cannot read.')
  const shift = file.version === 1 ? OLD_PLATE_SHIFT : 0
  if (!Array.isArray(file.bricks)) throw new Error('This is not a Clutch build.')
  if (file.bricks.length > MAX_PIECES) throw new Error(`This build has more than ${MAX_PIECES} pieces.`)
  const grid = new Grid()
  let dropped = 0
  file.bricks.forEach((row, index) => {
    const [part, color, x, y, z, rot] = (Array.isArray(row) ? row : []) as unknown[]
    const valid = typeof part === 'string' && PART.has(part) && typeof color === 'string' && COLOR.has(color) &&
      Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && isRot(rot)
    if (!valid || !grid.fits(part, (x as number) + shift, y as number, (z as number) + shift, rot).ok) { dropped++; return }
    grid.add({ id: index + 1, part, color, x: (x as number) + shift, y: y as number, z: (z as number) + shift, rot })
  })
  const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim().slice(0, 80) : 'Untitled'
  const baseplate = typeof file.baseplate === 'string' && BASEPLATES.includes(file.baseplate) ? file.baseplate : DEFAULT_BASEPLATE
  return { name, baseplate, bricks: [...grid.bricks.values()], dropped }
}
