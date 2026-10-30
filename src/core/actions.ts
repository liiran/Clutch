// The one place that decides what a list of chat actions builds. The server runs it
// to check a reply and ask for a repair, and the editor runs it again to preview and
// apply, so what was checked is exactly what lands on the baseplate.

import { BRICK, MAX_PIECES, MAX_PROPOSAL, MAX_Y, SIZE, isRot, type Brick, type Rot } from './model.ts'
import { COLOR, COLOR_BY_LETTER } from './colors.ts'
import { PART } from './parts.ts'
import { Grid } from './grid.ts'
import { spans, tileCells, type Kind } from './tiling.ts'

export const MAX_ACTIONS = 400

export interface ApplyResult {
  bricks: Brick[]    // the whole build afterwards
  added: Brick[]
  removed: Brick[]
  changed: Brick[]   // the new state of pieces that were moved or recoloured
  errors: string[]
  loose: number[]    // ids of pieces left connected to nothing, that were not before
}

type Raw = Record<string, unknown>

const isInt = (value: unknown): value is number => Number.isInteger(value)

class Session {
  grid: Grid
  errors: string[] = []
  nextId: number
  added = 0
  full = false
  private firstNew: number

  constructor(start: Brick[]) {
    this.grid = new Grid(start)
    this.nextId = start.reduce((max, brick) => Math.max(max, brick.id), 0) + 1
    this.firstNew = this.nextId
  }

  // Puts down one piece. Macros stay quiet about taken cells, because they build around them.
  put(part: string, color: string, x: number, y: number, z: number, rot: Rot, where: string, quiet = false): boolean {
    if (this.full) return false
    if (this.added >= MAX_PROPOSAL || this.grid.bricks.size >= MAX_PIECES) {
      this.full = true
      this.errors.push(`${where}: stopped at the limit of ${this.added >= MAX_PROPOSAL ? `${MAX_PROPOSAL} new pieces in one reply` : `${MAX_PIECES} pieces in a build`}.`)
      return false
    }
    const fit = this.grid.fits(part, x, y, z, rot)
    if (!fit.ok) {
      if (!quiet || fit.reason !== 'collision') {
        const at = `[${x},${y},${z}]`
        const why = fit.reason === 'bounds' ? `is off the baseplate (x and z run 0 to ${SIZE - 1})`
          : fit.reason === 'height' ? `is over the height limit of ${MAX_Y} plates`
          : fit.reason === 'collision' ? `overlaps piece #${fit.blocker}` : 'is not a known part'
        this.errors.push(`${where}: ${part} rot ${rot} at ${at} ${why}.`)
      }
      return false
    }
    this.grid.add({ id: this.nextId++, part, color, x, y, z, rot })
    this.added++
    return true
  }

  isNew(id: number) { return id >= this.firstNew }
}

const colorOf = (value: unknown): string | null => typeof value === 'string' && COLOR.has(value) ? value : null

// Two corners, in either order, on the baseplate.
function rect(a: Raw): { x1: number; x2: number; z1: number; z2: number } | null {
  if (!isInt(a.x1) || !isInt(a.x2) || !isInt(a.z1) || !isInt(a.z2)) return null
  const x1 = Math.min(a.x1, a.x2), x2 = Math.max(a.x1, a.x2), z1 = Math.min(a.z1, a.z2), z2 = Math.max(a.z1, a.z2)
  if (x1 < 0 || z1 < 0 || x2 >= SIZE || z2 >= SIZE) return null
  return { x1, x2, z1, z2 }
}

// Layers from `height` plates: as many bricks as fit, then plates for the rest.
function courses(kind: Kind, height: number): Array<{ kind: Kind; h: number }> {
  if (kind !== 'brick') return Array.from({ length: height }, () => ({ kind, h: 1 }))
  const out: Array<{ kind: Kind; h: number }> = []
  for (let i = 0; i < Math.floor(height / BRICK); i++) out.push({ kind: 'brick', h: BRICK })
  for (let i = 0; i < height % BRICK; i++) out.push({ kind: 'plate', h: 1 })
  return out
}

// Fills the free cells of `cells`, one layer at a time, from y upward.
function stack(s: Session, cells: Array<[number, number]>, y: number, height: number, kind: Kind, color: string, where: string) {
  let level = y
  courses(kind, height).forEach((course, index) => {
    const free = cells.filter(([x, z]) => {
      for (let layer = 0; layer < course.h; layer++) if (s.grid.get(x, level + layer, z)) return false
      return true
    })
    const odd = index % 2 === 1
    for (const piece of tileCells(free, course.kind, odd ? 'z' : 'x', odd)) {
      s.put(piece.part, color, piece.x, level, piece.z, piece.rot, where, true)
    }
    level += course.h
  })
}

function place(s: Session, a: Raw, where: string) {
  const color = colorOf(a.color)
  if (typeof a.part !== 'string' || !PART.has(a.part)) { s.errors.push(`${where}: "${String(a.part)}" is not a known part.`); return }
  if (!color) { s.errors.push(`${where}: "${String(a.color)}" is not a palette colour.`); return }
  const rot = a.rot === undefined || a.rot === null ? 0 : a.rot
  if (!isRot(rot)) { s.errors.push(`${where}: rot must be 0, 1, 2 or 3.`); return }
  if (!Array.isArray(a.at) || !a.at.length) { s.errors.push(`${where}: "at" needs a list of [x, y, z].`); return }
  for (const at of a.at) {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(isInt)) { s.errors.push(`${where}: "at" entries must be [x, y, z] whole numbers.`); continue }
    s.put(a.part, color, at[0], at[1], at[2], rot, where)
  }
}

function fill(s: Session, a: Raw, where: string, hollow: boolean) {
  const box = rect(a)
  const color = colorOf(a.color)
  const kind: Kind = a.kind === 'plate' || a.kind === 'tile' ? a.kind : 'brick'
  if (!box) { s.errors.push(`${where}: the rectangle must have whole-number corners on the baseplate.`); return }
  if (!color) { s.errors.push(`${where}: "${String(a.color)}" is not a palette colour.`); return }
  if (!isInt(a.y) || a.y < 0 || !isInt(a.height) || a.height < 1 || a.y + a.height > MAX_Y) { s.errors.push(`${where}: y and height must be whole plates within the ${MAX_Y} plate limit.`); return }
  const cells: Array<[number, number]> = []
  for (let z = box.z1; z <= box.z2; z++) {
    for (let x = box.x1; x <= box.x2; x++) {
      if (!hollow || x === box.x1 || x === box.x2 || z === box.z1 || z === box.z2) cells.push([x, z])
    }
  }
  stack(s, cells, a.y, a.height, kind, color, where)
}

// A gable roof. Each course steps in one stud from both sides and rises one brick,
// and the two ends are filled in, up to a ridge.
function roof(s: Session, a: Raw, where: string) {
  const box = rect(a)
  const color = colorOf(a.color)
  const gable = colorOf(a.gable) ?? color
  if (!box) { s.errors.push(`${where}: the rectangle must have whole-number corners on the baseplate.`); return }
  if (!color || !gable) { s.errors.push(`${where}: "${String(a.color)}" is not a palette colour.`); return }
  if (!isInt(a.y) || a.y < 0) { s.errors.push(`${where}: y must be a whole number of plates.`); return }
  const alongX = a.ridge !== 'z'
  // `u` runs along the ridge, `v` across it.
  const u1 = alongX ? box.x1 : box.z1, u2 = alongX ? box.x2 : box.z2
  const length = u2 - u1 + 1
  let low = alongX ? box.z1 : box.x1
  let high = alongX ? box.z2 : box.x2
  let y = a.y
  const at = (u: number, v: number): [number, number] => alongX ? [u, v] : [v, u]
  const lay = (sizes: number[], part: (size: number) => string, v: number, rot: Rot) => {
    let u = u1
    for (const size of spans(length, sizes)) {
      const [x, z] = at(u, v)
      s.put(part(size), color, x, y, z, rot, where, true)
      u += size
    }
  }
  // At rot 0 a slope runs down toward high z, so the two sides of a ridge along x
  // are rot 2 (down toward low z) and rot 0. Along z they turn a quarter: 1 and 3.
  const downLow: Rot = alongX ? 2 : 1
  const downHigh: Rot = alongX ? 0 : 3
  const beam = (v: number, offset: boolean, h: number, kind: Kind) => {
    const cells: Array<[number, number]> = []
    for (let u = u1; u <= u2; u++) cells.push(at(u, v))
    for (const piece of tileCells(cells, kind, alongX ? 'x' : 'z', offset)) s.put(piece.part, color, piece.x, y + h, piece.z, piece.rot, where, true)
  }
  while (high - low + 1 >= 4) {
    lay([4, 2, 1], (size) => size === 4 ? 'slope_4x2' : size === 2 ? 'slope_2x2' : 'slope_1x2', low, downLow)
    lay([4, 2, 1], (size) => size === 4 ? 'slope_4x2' : size === 2 ? 'slope_2x2' : 'slope_1x2', high - 1, downHigh)
    // The ends of the roof, between the two slopes.
    for (const end of [u1, u2]) {
      for (let v = low + 2; v <= high - 2; v++) {
        const [x, z] = at(end, v)
        s.put('brick_1x1', gable, x, y, z, 0, where, true)
      }
    }
    low++
    high--
    y += BRICK
  }
  const left = high - low + 1
  if (left === 2) {
    let u = u1
    for (const size of spans(length, [2, 1])) {
      const [x, z] = at(u, low)
      s.put(`ridge_${size}x2`, color, x, y, z, alongX ? 0 : 1, where, true)
      u += size
    }
  } else if (left === 3) {
    lay([1], () => 'slope_1x1', low, downLow)
    lay([1], () => 'slope_1x1', high, downHigh)
    beam(low + 1, false, 0, 'brick')
    beam(low + 1, true, BRICK, 'plate')
  } else if (left === 1) {
    beam(low, false, 0, 'brick')
    beam(low, true, BRICK, 'plate')
  }
}

// Layers of letters, one letter per stud, for shapes that are not boxes.
function voxels(s: Session, a: Raw, where: string) {
  if (!isInt(a.x) || !isInt(a.y) || !isInt(a.z)) { s.errors.push(`${where}: x, y and z must be whole numbers.`); return }
  if (!Array.isArray(a.layers) || !a.layers.length) { s.errors.push(`${where}: "layers" needs at least one layer of rows.`); return }
  const h = a.unit === 'plate' ? 1 : BRICK
  const kind: Kind = h === 1 ? 'plate' : 'brick'
  let level = a.y
  a.layers.forEach((rows: unknown, index: number) => {
    if (!Array.isArray(rows)) { s.errors.push(`${where}: layer ${index} must be a list of text rows.`); return }
    const groups = new Map<string, Array<[number, number]>>()
    rows.forEach((row: unknown, rz: number) => {
      if (typeof row !== 'string') { s.errors.push(`${where}: layer ${index} row ${rz} is not text.`); return }
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx]
        if (ch === '.' || ch === ' ') continue
        const color = COLOR_BY_LETTER.get(ch)
        if (!color) { s.errors.push(`${where}: "${ch}" in layer ${index} is not a palette letter.`); continue }
        const x = (a.x as number) + rx, z = (a.z as number) + rz
        if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) { s.errors.push(`${where}: layer ${index} runs off the baseplate at x ${x}, z ${z}.`); return }
        let open = true
        for (let layer = 0; layer < h; layer++) if (s.grid.get(x, level + layer, z)) open = false
        if (!open) continue
        if (!groups.has(color.id)) groups.set(color.id, [])
        groups.get(color.id)!.push([x, z])
      }
    })
    const odd = index % 2 === 1
    for (const [color, cells] of groups) {
      for (const piece of tileCells(cells, kind, odd ? 'z' : 'x', odd)) s.put(piece.part, color, piece.x, level, piece.z, piece.rot, where, true)
    }
    level += h
  })
}

// Pieces that sit wholly inside a box.
function inBox(s: Session, a: Raw, where: string): Brick[] | null {
  if (![a.x1, a.y1, a.z1, a.x2, a.y2, a.z2].every(isInt)) { s.errors.push(`${where}: the box needs whole-number corners x1 y1 z1 x2 y2 z2.`); return null }
  const [x1, x2] = [a.x1 as number, a.x2 as number].sort((p, q) => p - q)
  const [y1, y2] = [a.y1 as number, a.y2 as number].sort((p, q) => p - q)
  const [z1, z2] = [a.z1 as number, a.z2 as number].sort((p, q) => p - q)
  return [...s.grid.bricks.values()].filter((b) => {
    const def = PART.get(b.part)!
    const r = def.rots[b.rot]
    return b.x >= x1 && b.x + r.w - 1 <= x2 && b.z >= z1 && b.z + r.d - 1 <= z2 && b.y >= y1 && b.y + def.h - 1 <= y2
  })
}

function byIds(s: Session, a: Raw, where: string): Brick[] {
  if (!Array.isArray(a.ids)) { s.errors.push(`${where}: "ids" must be a list of piece numbers.`); return [] }
  const out: Brick[] = []
  for (const id of a.ids) {
    const brick = s.grid.bricks.get(id as number)
    if (brick) out.push(brick)
    else s.errors.push(`${where}: there is no piece #${String(id)}.`)
  }
  return out
}

function recolor(s: Session, list: Brick[], color: string) {
  for (const brick of list) {
    s.grid.bricks.set(brick.id, { ...brick, color })
  }
}

function move(s: Session, list: Brick[], dx: number, dy: number, dz: number, where: string) {
  for (const brick of list) s.grid.remove(brick)
  const moved = list.map((brick) => ({ ...brick, x: brick.x + dx, y: brick.y + dy, z: brick.z + dz }))
  const blocked = moved.find((brick) => !s.grid.fits(brick.part, brick.x, brick.y, brick.z, brick.rot).ok)
  if (blocked) {
    for (const brick of list) s.grid.add(brick)
    s.errors.push(`${where}: moving by [${dx},${dy},${dz}] puts piece #${blocked.id} off the baseplate or inside another piece.`)
    return
  }
  for (const brick of moved) s.grid.add(brick)
}

export function applyActions(start: readonly Brick[], actions: unknown): ApplyResult {
  const s = new Session([...start])
  const wasLoose = new Set(s.grid.loose())
  if (!Array.isArray(actions)) s.errors.push('The actions must be a list.')
  const list: unknown[] = Array.isArray(actions) ? actions : []
  if (list.length > MAX_ACTIONS) s.errors.push(`Only the first ${MAX_ACTIONS} actions were used.`)
  list.slice(0, MAX_ACTIONS).forEach((action, index) => {
    const a = (action ?? {}) as Raw
    const where = `action ${index + 1} (${String(a.tool)})`
    switch (a.tool) {
      case 'place': place(s, a, where); break
      case 'fill': fill(s, a, where, false); break
      case 'walls': fill(s, a, where, true); break
      case 'roof': roof(s, a, where); break
      case 'voxels': voxels(s, a, where); break
      case 'remove': for (const brick of byIds(s, a, where)) s.grid.remove(brick); break
      case 'remove_box': for (const brick of inBox(s, a, where) ?? []) s.grid.remove(brick); break
      case 'recolor':
      case 'recolor_box': {
        const color = colorOf(a.color)
        if (!color) { s.errors.push(`${where}: "${String(a.color)}" is not a palette colour.`); break }
        const from = colorOf(a.from)
        const targets = a.tool === 'recolor' ? byIds(s, a, where) : inBox(s, a, where) ?? []
        recolor(s, from ? targets.filter((brick) => brick.color === from) : targets, color)
        break
      }
      case 'move_box': {
        if (![a.dx, a.dy, a.dz].every(isInt)) { s.errors.push(`${where}: dx, dy and dz must be whole numbers.`); break }
        move(s, inBox(s, a, where) ?? [], a.dx as number, a.dy as number, a.dz as number, where)
        break
      }
      case 'clear': for (const brick of [...s.grid.bricks.values()]) s.grid.remove(brick); break
      default: s.errors.push(`${where}: unknown tool.`)
    }
  })

  const bricks = [...s.grid.bricks.values()]
  const before = new Map(start.map((brick) => [brick.id, brick]))
  const added = bricks.filter((brick) => s.isNew(brick.id))
  const changed = bricks.filter((brick) => {
    const old = before.get(brick.id)
    return old !== undefined && old !== brick
  })
  const removed = start.filter((brick) => !s.grid.bricks.has(brick.id))
  return { bricks, added, removed, changed, errors: s.errors, loose: s.grid.loose().filter((id) => !wasLoose.has(id)) }
}

// What a repair is told: exactly which pieces, because the model never sees new ids.
export function repairNotes(result: ApplyResult): string[] {
  const notes = result.errors.slice(0, 24)
  const byId = new Map(result.bricks.map((brick) => [brick.id, brick]))
  const loose = result.loose.map((id) => byId.get(id)!)
  if (loose.length) {
    const rows = loose.slice(0, 30).map((b) => `${b.part} ${b.color} rot ${b.rot} at [${b.x},${b.y},${b.z}]`)
    notes.push(`These ${loose.length} pieces connect to nothing, directly or through other pieces, so they would float: ${rows.join('; ')}${loose.length > 30 ? '; and more' : ''}. Each piece needs a stud under one of its cells at exactly its y, or a piece gripping its studs from above, in a chain down to the baseplate. A tile, slope face, flower or ridge has no studs to grip. Move them, or add something for them to grip.`)
  }
  return notes
}

export interface Verdict {
  ok: boolean
  summary: string
  problems: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// What the chat's check card says about a result, and what a repair is asked to fix.
export function verdictFor(result: ApplyResult): Verdict {
  const problems = result.errors.slice(0, 12)
  if (result.errors.length > 12) problems.push(`And ${result.errors.length - 12} more like these.`)
  if (result.loose.length) {
    problems.push(`${plural(result.loose.length, 'piece')} would not be attached to anything.`)
  }
  const total = result.bricks.length
  if (problems.length) return { ok: false, summary: `${plural(total, 'piece')} checked, with problems.`, problems }
  return { ok: true, summary: `${plural(total, 'piece')}, all attached, nothing overlapping.`, problems }
}
