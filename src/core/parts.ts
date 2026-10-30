// The parts catalogue: what each piece occupies, where its studs are, and where it
// can grip from below. The 3D models are generated from these in render/geometry.ts.
//
// Every id reads as N along x by M along z at rot 0. Slopes at rot 0 are high at the
// back (low z) and run down to the front (high z).

export type Category = 'Bricks' | 'Plates' | 'Tiles' | 'Slopes' | 'Round' | 'Special'
export type Shape = 'box' | 'tile' | 'slope' | 'inverted' | 'ridge' | 'round' | 'cone' | 'arch' | 'window' | 'door' | 'fence' | 'wheels' | 'flower'

export interface Rotated {
  w: number // cells along x
  d: number // cells along z
  solid: Array<[number, number, number]> // cell x, cell z, layer
  studs: Array<[number, number]>
  bottom: Array<[number, number]>
  bottomMask: Uint8Array // w * d, by cell x + cell z * w
}

export interface PartDef {
  id: string
  name: string
  category: Category
  w: number
  d: number
  h: number // in plates
  shape: Shape
  rots: Rotated[]
}

interface Spec {
  id: string
  name: string
  category: Category
  w: number
  d: number
  h: number
  shape: Shape
  solidAt?: (cx: number, cz: number, layer: number) => boolean
  studAt?: (cx: number, cz: number) => boolean
  bottomAt?: (cx: number, cz: number) => boolean
}

// A quarter turn clockwise seen from above, r times.
function rotateCell(cx: number, cz: number, w: number, d: number, r: number): [number, number] {
  if (r === 1) return [d - 1 - cz, cx]
  if (r === 2) return [w - 1 - cx, d - 1 - cz]
  if (r === 3) return [cz, w - 1 - cx]
  return [cx, cz]
}

function define(spec: Spec): PartDef {
  const { w, d, h } = spec
  const solidAt = spec.solidAt ?? (() => true)
  const studAt = spec.studAt ?? (() => true)
  const bottomAt = spec.bottomAt ?? (() => true)
  const rots: Rotated[] = [0, 1, 2, 3].map((r) => {
    const rw = r % 2 ? d : w
    const rd = r % 2 ? w : d
    const out: Rotated = { w: rw, d: rd, solid: [], studs: [], bottom: [], bottomMask: new Uint8Array(rw * rd) }
    for (let cz = 0; cz < d; cz++) {
      for (let cx = 0; cx < w; cx++) {
        const [ax, az] = rotateCell(cx, cz, w, d, r)
        for (let layer = 0; layer < h; layer++) if (solidAt(cx, cz, layer)) out.solid.push([ax, az, layer])
        if (studAt(cx, cz)) out.studs.push([ax, az])
        if (bottomAt(cx, cz)) {
          out.bottom.push([ax, az])
          out.bottomMask[ax + az * rw] = 1
        }
      }
    }
    return out
  })
  return { id: spec.id, name: spec.name, category: spec.category, w, d, h, shape: spec.shape, rots }
}

const box = (id: string, name: string, category: Category, w: number, d: number, h: number) =>
  define({ id, name, category, w, d, h, shape: 'box' })

const sizes = (list: Array<[number, number]>, kind: string, label: string, category: Category, h: number) =>
  list.map(([w, d]) => box(`${kind}_${w}x${d}`, `${label} ${w}×${d}`, category, w, d, h))

const tile = (w: number, d: number) =>
  define({ id: `tile_${w}x${d}`, name: `Tile ${w}×${d}`, category: 'Tiles', w, d, h: 1, shape: 'tile', studAt: () => false })

const slope = (w: number, d: number) =>
  define({ id: `slope_${w}x${d}`, name: `Slope ${w}×${d}`, category: 'Slopes', w, d, h: 3, shape: 'slope', studAt: (_cx, cz) => d > 1 && cz === 0 })

const ridge = (w: number) =>
  define({ id: `ridge_${w}x2`, name: `Roof ridge ${w}×2`, category: 'Slopes', w, d: 2, h: 3, shape: 'ridge', studAt: () => false })

const arch = (d: number, h: number) =>
  define({
    id: `arch_1x${d}`, name: `Arch 1×${d}`, category: 'Special', w: 1, d, h, shape: 'arch',
    solidAt: (_cx, cz, layer) => cz === 0 || cz === d - 1 || layer >= h - Math.max(1, Math.floor(h / 2)),
    bottomAt: (_cx, cz) => cz === 0 || cz === d - 1,
  })

export const PARTS: PartDef[] = [
  ...sizes([[1, 1], [1, 2], [1, 3], [1, 4], [1, 6], [1, 8], [2, 2], [2, 3], [2, 4], [2, 6], [2, 8]], 'brick', 'Brick', 'Bricks', 3),
  ...sizes([[1, 1], [1, 2], [1, 4], [2, 2], [2, 4], [2, 6], [2, 8], [4, 4], [4, 8], [6, 6]], 'plate', 'Plate', 'Plates', 1),
  tile(1, 1), tile(1, 2), tile(1, 4), tile(2, 2),
  slope(1, 1), slope(1, 2), slope(2, 2), slope(4, 2),
  define({
    id: 'inverted_2x2', name: 'Inverted slope 2×2', category: 'Slopes', w: 2, d: 2, h: 3, shape: 'inverted',
    solidAt: (_cx, cz, layer) => cz === 0 || layer > 0,
    bottomAt: (_cx, cz) => cz === 0,
  }),
  ridge(1), ridge(2),
  define({ id: 'round_1x1', name: 'Round brick 1×1', category: 'Round', w: 1, d: 1, h: 3, shape: 'round' }),
  define({ id: 'round_2x2', name: 'Round brick 2×2', category: 'Round', w: 2, d: 2, h: 3, shape: 'round' }),
  define({ id: 'round_plate_1x1', name: 'Round plate 1×1', category: 'Round', w: 1, d: 1, h: 1, shape: 'round' }),
  define({ id: 'cone_1x1', name: 'Cone 1×1', category: 'Round', w: 1, d: 1, h: 3, shape: 'cone' }),
  define({ id: 'cone_2x2', name: 'Cone 2×2', category: 'Round', w: 2, d: 2, h: 6, shape: 'cone', studAt: () => false }),
  arch(4, 3), arch(6, 6),
  define({ id: 'window_1x2', name: 'Window 1×2', category: 'Special', w: 1, d: 2, h: 6, shape: 'window' }),
  define({ id: 'door_1x4', name: 'Door 1×4', category: 'Special', w: 1, d: 4, h: 18, shape: 'door' }),
  define({ id: 'fence_1x4', name: 'Fence 1×4', category: 'Special', w: 1, d: 4, h: 3, shape: 'fence', studAt: (_cx, cz) => cz === 0 || cz === 3 }),
  define({
    id: 'wheels_4x2', name: 'Wheel set 4×2', category: 'Special', w: 4, d: 2, h: 5, shape: 'wheels',
    studAt: (cx) => cx === 1 || cx === 2,
    bottomAt: (cx) => cx === 1 || cx === 2,
  }),
  define({ id: 'flower_1x1', name: 'Flower 1×1', category: 'Special', w: 1, d: 1, h: 3, shape: 'flower', studAt: () => false }),
]

export const PART = new Map(PARTS.map((part) => [part.id, part]))
export const PART_IDS = PARTS.map((part) => part.id)
export const CATEGORIES: Category[] = ['Bricks', 'Plates', 'Tiles', 'Slopes', 'Round', 'Special']
export const DEFAULT_PART = 'brick_2x4'
