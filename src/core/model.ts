// The build as plain data. Nothing here knows about the browser, so the editor
// and the local server run exactly the same rules.

export const SIZE = 48           // the baseplate, in studs along x and z
export const MAX_Y = 96          // the build height limit, in plates (32 bricks)
export const BRICK = 3           // a brick is three plates tall
export const MAX_PIECES = 3000   // the most pieces one build can hold
export const MAX_PROPOSAL = 1500 // the most pieces one chat reply can add

export type Rot = 0 | 1 | 2 | 3

// x and z are the lowest cell the piece covers once rotated; y is its bottom, in plates.
export interface Brick {
  readonly id: number
  readonly part: string
  readonly color: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly rot: Rot
}

export const isRot = (value: unknown): value is Rot => value === 0 || value === 1 || value === 2 || value === 3
