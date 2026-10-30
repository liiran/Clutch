import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PART, PARTS } from '../src/core/parts.ts'
import { COLORS } from '../src/core/colors.ts'
import { Grid } from '../src/core/grid.ts'
import { applyActions, repairNotes, verdictFor } from '../src/core/actions.ts'
import { tileCells } from '../src/core/tiling.ts'
import { planSteps, countParts } from '../src/core/steps.ts'
import { fromFile, toFile } from '../src/core/file.ts'
import { describeBuild } from '../src/core/describe.ts'
import { alignTo, holdStud } from '../src/core/snap.ts'
import type { Brick } from '../src/core/model.ts'

const brick = (id: number, part: string, x: number, y: number, z: number, rot: 0 | 1 | 2 | 3 = 0): Brick => ({ id, part, color: 'red', x, y, z, rot })

test('the catalogue has about 40 parts with unique ids and palette letters', () => {
  assert.ok(PARTS.length >= 38 && PARTS.length <= 48, `${PARTS.length} parts`)
  assert.equal(new Set(PARTS.map((p) => p.id)).size, PARTS.length)
  assert.equal(new Set(COLORS.map((c) => c.letter)).size, COLORS.length)
})

test('rotating a part swaps its footprint and keeps every cell inside it', () => {
  for (const part of PARTS) {
    for (let r = 0; r < 4; r++) {
      const rotated = part.rots[r]
      assert.equal(rotated.w, r % 2 ? part.d : part.w)
      assert.equal(rotated.d, r % 2 ? part.w : part.d)
      for (const [cx, cz] of rotated.solid) assert.ok(cx >= 0 && cx < rotated.w && cz >= 0 && cz < rotated.d, part.id)
    }
  }
})

test('a slope keeps its studs on the high side as it turns', () => {
  const slope = PART.get('slope_2x2')!
  assert.deepEqual(slope.rots[0].studs.map((s) => s[1]), [0, 0])     // back row
  assert.deepEqual(slope.rots[1].studs.map((s) => s[0]), [1, 1])     // right column
  assert.deepEqual(slope.rots[2].studs.map((s) => s[1]), [1, 1])     // front row
  assert.deepEqual(slope.rots[3].studs.map((s) => s[0]), [0, 0])     // left column
})

test('pieces collide, and the baseplate and height limit are enforced', () => {
  const grid = new Grid([brick(1, 'brick_2x4', 0, 0, 0)])
  assert.deepEqual(grid.fits('brick_1x1', 1, 2, 3, 0), { ok: false, reason: 'collision', blocker: 1 })
  assert.equal(grid.fits('brick_1x1', 2, 0, 0, 0).ok, true)
  assert.equal(grid.fits('brick_1x1', 1, 3, 3, 0).ok, true)
  assert.deepEqual(grid.fits('brick_2x4', 63, 0, 0, 0), { ok: false, reason: 'bounds' })
  assert.deepEqual(grid.fits('brick_2x4', 61, 0, 60, 1), { ok: false, reason: 'bounds' })
  assert.equal(grid.fits('brick_2x4', 60, 0, 62, 1).ok, true)
  assert.deepEqual(grid.fits('brick_1x1', 0, 94, 40, 0), { ok: false, reason: 'height' })
})

test('walls leave the opening of an arch clear, and it only grips on its legs', () => {
  const r = applyActions([], [
    { tool: 'place', part: 'arch_1x6', color: 'red', at: [[5, 0, 5]] },
    { tool: 'walls', x1: 5, z1: 3, x2: 5, z2: 12, y: 0, height: 9, color: 'white' },
  ])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.loose, [])
  const arch = r.bricks.find((b) => b.part === 'arch_1x6')!
  assert.equal(new Grid(r.bricks).get(5, 0, 7), arch.id)
  assert.deepEqual(new Grid([brick(1, 'plate_1x1', 5, 0, 7), brick(2, 'arch_1x4', 5, 1, 6)]).loose(), [2])
  assert.deepEqual(new Grid([brick(1, 'plate_1x1', 5, 0, 6), brick(2, 'arch_1x4', 5, 1, 6)]).loose(), [])
})

test('the loose check follows studs, and tiles and slope faces do not grip', () => {
  assert.deepEqual(new Grid([brick(1, 'brick_2x2', 0, 0, 0), brick(2, 'brick_2x2', 1, 3, 1)]).loose(), [])
  assert.deepEqual(new Grid([brick(1, 'brick_2x2', 0, 3, 0)]).loose(), [1])
  assert.deepEqual(new Grid([brick(1, 'tile_2x2', 0, 0, 0), brick(2, 'brick_1x1', 0, 1, 0)]).loose(), [2])
  // The front row of a slope has no studs, the back row does.
  assert.deepEqual(new Grid([brick(1, 'slope_1x2', 0, 0, 0), brick(2, 'plate_1x1', 0, 3, 1)]).loose(), [2])
  assert.deepEqual(new Grid([brick(1, 'slope_1x2', 0, 0, 0), brick(2, 'plate_1x1', 0, 3, 0)]).loose(), [])
  // Side by side is not attached.
  assert.deepEqual(new Grid([brick(1, 'brick_1x1', 0, 0, 0), brick(2, 'brick_1x1', 1, 3, 0), brick(3, 'brick_1x1', 2, 3, 0)]).loose().sort(), [2, 3])
  // A piece can hang from a stud above it.
  const hung = new Grid([brick(1, 'brick_1x1', 0, 0, 0), brick(2, 'brick_1x1', 0, 3, 0), brick(3, 'plate_2x2', 0, 6, 0), brick(4, 'brick_1x1', 1, 3, 1)])
  assert.deepEqual(hung.loose(), [])
})

test('tiling covers every cell exactly once with real parts', () => {
  const cells: Array<[number, number]> = []
  for (let x = 0; x < 11; x++) for (let z = 0; z < 5; z++) cells.push([x, z])
  for (const [kind, axis, offset] of [['brick', 'x', false], ['brick', 'z', true], ['plate', 'x', false], ['tile', 'z', true]] as const) {
    const pieces = tileCells(cells, kind, axis, offset)
    const grid = new Grid(pieces.map((p, i) => ({ id: i + 1, part: p.part, color: 'red', x: p.x, y: 0, z: p.z, rot: p.rot })))
    let covered = 0
    for (const [x, z] of cells) if (grid.get(x, 0, z)) covered++
    assert.equal(covered, cells.length, `${kind} ${axis}`)
    for (const p of pieces) assert.ok(PART.has(p.part), p.part)
    const area = pieces.reduce((sum, p) => sum + PART.get(p.part)!.w * PART.get(p.part)!.d, 0)
    assert.equal(area, cells.length, 'no overlaps')
  }
})

test('tiling uses large pieces and staggers joints between layers', () => {
  const row: Array<[number, number]> = Array.from({ length: 16 }, (_, x) => [x, 0])
  const even = tileCells(row, 'brick', 'x', false)
  const odd = tileCells(row, 'brick', 'x', true)
  assert.equal(even.length, 2)
  const joints = (list: typeof even) => new Set(list.map((p) => p.x).filter((x) => x > 0))
  const shared = [...joints(even)].filter((x) => joints(odd).has(x))
  assert.deepEqual(shared, [])
})

test('place reports errors and adds what fits', () => {
  const r = applyActions([], [{ tool: 'place', part: 'brick_2x4', color: 'red', at: [[0, 0, 0], [0, 0, 0], [63, 0, 0]] }])
  assert.equal(r.added.length, 1)
  assert.equal(r.errors.length, 2)
  assert.match(r.errors[0], /overlaps piece #1/)
  assert.match(r.errors[1], /off the baseplate/)
  const bad = applyActions([], [{ tool: 'place', part: 'nope', color: 'red', at: [[0, 0, 0]] }, { tool: 'dance' }, { tool: 'place', part: 'brick_1x1', color: 'mauve', at: [[0, 0, 0]] }])
  assert.equal(bad.added.length, 0)
  assert.equal(bad.errors.length, 3)
})

test('walls make a closed, attached ring that interlocks at the corners', () => {
  const r = applyActions([], [{ tool: 'walls', x1: 4, z1: 4, x2: 13, z2: 11, y: 0, height: 12, color: 'white' }])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.loose, [])
  const grid = new Grid(r.bricks)
  for (let y = 0; y < 12; y++) {
    assert.ok(grid.get(4, y, 4) && grid.get(13, y, 11) && grid.get(8, y, 4) && grid.get(4, y, 8), `ring at ${y}`)
    assert.equal(grid.get(8, y, 8), 0, 'hollow')
  }
  // A corner is held by different pieces on the two layers.
  assert.notEqual(grid.get(4, 0, 4), grid.get(4, 3, 4))
})

test('walls flow around a door placed first', () => {
  const r = applyActions([], [
    { tool: 'place', part: 'door_1x4', color: 'red', rot: 1, at: [[6, 0, 4]] },
    { tool: 'walls', x1: 4, z1: 4, x2: 13, z2: 11, y: 0, height: 21, color: 'white' },
  ])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.loose, [])
  const door = r.bricks.find((b) => b.part === 'door_1x4')!
  assert.equal(new Grid(r.bricks).get(7, 17, 4), door.id)
  assert.notEqual(new Grid(r.bricks).get(7, 18, 4), door.id)
  assert.notEqual(new Grid(r.bricks).get(7, 18, 4), 0)
})

test('fill makes solid layers, and plates fill out a height that is not whole bricks', () => {
  const r = applyActions([], [{ tool: 'fill', x1: 0, z1: 0, x2: 7, z2: 7, y: 0, height: 4, color: 'blue' }])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.loose, [])
  const grid = new Grid(r.bricks)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) assert.ok(grid.get(x, y, z))
  assert.equal(grid.get(0, 4, 0), 0)
  assert.ok(r.bricks.some((b) => b.part.startsWith('plate')))
  assert.ok(r.added.length < 30, 'uses large pieces')
})

for (const [width, name] of [[8, 'even'], [9, 'odd'], [4, 'narrow'], [3, 'three wide'], [2, 'two wide']] as const) {
  for (const ridge of ['x', 'z'] as const) {
    test(`a gable roof over walls is fully attached: ${name}, ridge along ${ridge}`, () => {
      const long = 20
      const x2 = ridge === 'x' ? long - 1 : width - 1
      const z2 = ridge === 'x' ? width - 1 : long - 1
      const r = applyActions([], [
        { tool: 'walls', x1: 0, z1: 0, x2, z2, y: 0, height: 6, color: 'white' },
        { tool: 'roof', x1: 0, z1: 0, x2, z2, y: 6, ridge, color: 'red', gable: 'white' },
      ])
      assert.deepEqual(r.errors, [])
      assert.deepEqual(r.loose, [], `loose: ${r.loose.map((id) => JSON.stringify(r.bricks.find((b) => b.id === id)))}`)
      assert.ok(r.bricks.some((b) => b.part.startsWith('slope') || b.part.startsWith('ridge') || width <= 1))
    })
  }
}

test('roof slopes face outward on both sides', () => {
  const r = applyActions([], [{ tool: 'roof', x1: 0, z1: 0, x2: 3, z2: 5, y: 0, ridge: 'x', color: 'red' }])
  const slopes = r.bricks.filter((b) => b.part.startsWith('slope') && b.y === 0)
  assert.ok(slopes.some((b) => b.z === 0 && b.rot === 2), 'low side runs down to low z')
  assert.ok(slopes.some((b) => b.z === 4 && b.rot === 0), 'high side runs down to high z')
  const across = applyActions([], [{ tool: 'roof', x1: 0, z1: 0, x2: 5, z2: 3, y: 0, ridge: 'z', color: 'red' }])
  const side = across.bricks.filter((b) => b.part.startsWith('slope') && b.y === 0)
  assert.ok(side.some((b) => b.x === 0 && b.rot === 1), 'low side runs down to low x')
  assert.ok(side.some((b) => b.x === 4 && b.rot === 3), 'high side runs down to high x')
  // Rot 1 is high on +x, so it runs down toward -x. Rot 3 is the reverse.
  assert.deepEqual(PART.get('slope_1x2')!.rots[1].studs, [[1, 0]])
  assert.deepEqual(PART.get('slope_1x2')!.rots[3].studs, [[0, 0]])
})

test('voxels become bricks by colour, and interlock between layers', () => {
  const r = applyActions([], [{
    tool: 'voxels', x: 2, y: 0, z: 2, unit: 'brick',
    layers: [['rrrr', 'rrrr'], ['.yy.', '.yy.'], ['.bb.']],
  }])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.loose, [])
  const grid = new Grid(r.bricks)
  assert.equal(grid.bricks.get(grid.get(2, 0, 2))!.color, 'red')
  assert.equal(grid.bricks.get(grid.get(3, 3, 2))!.color, 'yellow')
  assert.equal(grid.bricks.get(grid.get(4, 6, 2))!.color, 'blue')
  assert.equal(grid.get(2, 3, 2), 0)
  assert.equal(r.added.filter((b) => b.color === 'red').length, 1, 'merges into one 2×4')
})

test('voxels reject letters outside the palette and rows off the baseplate', () => {
  assert.match(applyActions([], [{ tool: 'voxels', x: 0, y: 0, z: 0, layers: [['r?r']] }]).errors[0], /not a palette letter/)
  assert.match(applyActions([], [{ tool: 'voxels', x: 63, y: 0, z: 0, layers: [['rr']] }]).errors[0], /off the baseplate/)
})

test('remove, recolor, move and clear change the right pieces', () => {
  const start = [brick(1, 'brick_2x2', 0, 0, 0), brick(2, 'brick_2x2', 4, 0, 0), brick(3, 'brick_2x2', 8, 0, 0)]
  const removed = applyActions(start, [{ tool: 'remove', ids: [2] }])
  assert.deepEqual(removed.removed.map((b) => b.id), [2])
  assert.equal(removed.bricks.length, 2)

  const box = applyActions(start, [{ tool: 'remove_box', x1: 0, y1: 0, z1: 0, x2: 5, y2: 2, z2: 1 }])
  assert.deepEqual(box.removed.map((b) => b.id).sort(), [1, 2])

  const painted = applyActions(start, [{ tool: 'recolor', ids: [1], color: 'blue' }, { tool: 'recolor_box', x1: 8, y1: 0, z1: 0, x2: 9, y2: 2, z2: 1, color: 'green' }])
  assert.deepEqual(painted.changed.map((b) => [b.id, b.color]).sort(), [[1, 'blue'], [3, 'green']])

  const moved = applyActions(start, [{ tool: 'move_box', x1: 8, y1: 0, z1: 0, x2: 9, y2: 2, z2: 1, dx: 2, dy: 0, dz: 3 }])
  assert.deepEqual(moved.changed.map((b) => [b.id, b.x, b.z]), [[3, 10, 3]])
  assert.equal(new Grid(moved.bricks).get(8, 0, 0), 0)

  const blocked = applyActions(start, [{ tool: 'move_box', x1: 0, y1: 0, z1: 0, x2: 1, y2: 2, z2: 1, dx: 4, dy: 0, dz: 0 }])
  assert.equal(blocked.errors.length, 1)
  assert.equal(blocked.changed.length, 0)

  const cleared = applyActions(start, [{ tool: 'clear' }, { tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 0, 0]] }])
  assert.equal(cleared.removed.length, 3)
  assert.equal(cleared.added.length, 1)
  assert.equal(cleared.added[0].id, 4, 'new ids never reuse old ones')
})

test('a reply cannot add more than the proposal limit', () => {
  const at: number[][] = []
  for (let y = 0; y < 60; y += 3) for (let x = 0; x < 64; x++) for (let z = 0; z < 2; z++) at.push([x, y, z])
  const r = applyActions([], [{ tool: 'place', part: 'brick_1x1', color: 'red', at }])
  assert.equal(r.added.length, 1500)
  assert.match(r.errors.join(' '), /limit of 1500/)
})

test('the verdict names problems and passes a clean build', () => {
  assert.equal(verdictFor(applyActions([], [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 0, 0]] }])).ok, true)
  const floating = verdictFor(applyActions([], [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 6, 0]] }]))
  assert.equal(floating.ok, false)
  assert.match(floating.problems[0], /not be attached/)
  const notes = repairNotes(applyActions([], [{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[0, 6, 0]] }]))
  assert.match(notes[0], /brick_1x1 red rot 0 at \[0,6,0\]/)
})

test('steps run bottom up, cover every piece once and stay small', () => {
  const r = applyActions([], [{ tool: 'walls', x1: 0, z1: 0, x2: 30, z2: 30, y: 0, height: 9, color: 'white' }])
  const steps = planSteps(r.bricks)
  const seen = steps.flatMap((s) => s.bricks.map((b) => b.id))
  assert.equal(seen.length, r.bricks.length)
  assert.equal(new Set(seen).size, r.bricks.length)
  let last = 0
  for (const step of steps) {
    assert.ok(step.bricks.length <= 10)
    assert.ok(step.bricks[0].y >= last)
    last = step.bricks[0].y
  }
  assert.equal(countParts([brick(1, 'brick_2x2', 0, 0, 0), brick(2, 'brick_2x2', 4, 0, 0), brick(3, 'plate_1x1', 8, 0, 0)])[0].count, 2)
})

test('a file round trips, and bad or overlapping rows are left out', () => {
  const bricks = [brick(1, 'brick_2x4', 0, 0, 0, 1), brick(2, 'slope_2x2', 10, 3, 10, 3)]
  const back = fromFile(JSON.parse(JSON.stringify(toFile('Tower', 'sky', bricks))))
  assert.equal(back.name, 'Tower')
  assert.equal(back.baseplate, 'sky')
  assert.deepEqual(back.bricks.map((b) => [b.part, b.x, b.y, b.z, b.rot]), [['brick_2x4', 0, 0, 0, 1], ['slope_2x2', 10, 3, 10, 3]])
  const messy = fromFile({ version: 1, name: '', baseplate: 'lava', bricks: [['brick_1x1', 'red', 0, 0, 0, 0], ['brick_1x1', 'red', 0, 0, 0, 0], ['ghost', 'red', 1, 0, 0, 0], ['brick_1x1', 'red', 99, 0, 0, 0], 'junk'] })
  assert.equal(messy.bricks.length, 1)
  assert.equal(messy.dropped, 4)
  assert.equal(messy.name, 'Untitled')
  assert.equal(messy.baseplate, 'green')
  assert.throws(() => fromFile({ version: 9, bricks: [] }), /version/)
  assert.throws(() => fromFile('nope'), /not a Clutch build/)
})

test('the ghost holds its stud until the pointer has clearly moved on', () => {
  assert.equal(holdStud(5.4, null), 5)
  assert.equal(holdStud(5.6, null), 6)
  assert.equal(holdStud(5.6, 5), 5, 'just past halfway, it holds')
  assert.equal(holdStud(4.4, 5), 5)
  assert.equal(holdStud(5.8, 5), 6, 'clearly past, it moves')
  assert.equal(holdStud(4.2, 5), 4)
  assert.equal(holdStud(9.2, 5), 9, 'a big move goes straight there')
})

test('the ghost pulls into line with the piece under it', () => {
  // A 2 wide piece over a 2 wide piece at 10: anywhere near lines up exactly.
  assert.equal(alignTo(10.7, 2, 10, 2), 10)
  assert.equal(alignTo(9.3, 2, 10, 2), 10)
  // A 2 wide piece on a 4 wide piece at 10: either edge, or the middle, whichever is nearest.
  assert.equal(alignTo(10.2, 2, 10, 4), 10)
  assert.equal(alignTo(11.1, 2, 10, 4), 11)
  assert.equal(alignTo(11.9, 2, 10, 4), 12)
  // Far away, it is left alone, so offset stacking still works.
  assert.equal(alignTo(14.5, 2, 10, 4), 14.5)
  // A centre that falls between studs is not an option.
  assert.equal(alignTo(10.5, 1, 10, 4), 10.5 - 0.5)
})

test('a build saved on the old 48 stud plate moves to the middle of the new one', () => {
  const old = fromFile({ version: 1, name: 'Old', baseplate: 'green', bricks: [['brick_2x4', 'red', 0, 0, 0, 0], ['brick_1x1', 'red', 47, 3, 47, 0]] })
  assert.equal(old.dropped, 0)
  assert.deepEqual(old.bricks.map((b) => [b.x, b.y, b.z]), [[8, 0, 8], [55, 3, 55]])
  const saved = toFile('New', 'green', old.bricks)
  assert.equal(saved.version, 2)
  assert.deepEqual(fromFile(saved).bricks.map((b) => [b.x, b.z]), [[8, 8], [55, 55]], 'and only once')
})

test('the description lists ids and positions', () => {
  assert.equal(describeBuild([]), 'The baseplate is empty.')
  const text = describeBuild([brick(7, 'brick_2x4', 3, 0, 5, 1)])
  assert.match(text, /brick_2x4 red rot1: #7@3,0,5/)
  assert.match(text, /x 3 to 6, z 5 to 6, up to height 3/)
})
