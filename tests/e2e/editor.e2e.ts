// Drives the real editor with a real mouse and keyboard. Needs npm run dev running.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'puppeteer-core'
import { launch, open, shot, wait, type OpenPage } from './harness.ts'

let browser: Browser
let page: OpenPage

const state = () => page.evaluate(() => {
  const { store, tools, chat, replay } = (window as any).clutch
  return {
    count: store.count,
    bricks: store.bricks as Array<{ id: number; part: string; color: string; x: number; y: number; z: number; rot: number }>,
    mode: tools.mode, part: tools.part, color: tools.color, rot: tools.rot, selected: tools.selected,
    locked: tools.isLocked, previewing: chat.isPreviewing, replaying: replay.active,
    canUndo: store.canUndo, canRedo: store.canRedo, name: store.name,
  }
})

// The screen position of a baseplate cell, or of the top of a stack at height y (in plates).
const screenOf = (x: number, z: number, y = 0) => page.evaluate((cx: number, cz: number, cy: number) => {
  const { stage } = (window as any).clutch
  const p = stage.camera.position.clone().set(cx - 32, cy * 0.4, cz - 32).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
}, x, z, y)

const openBuilds = async () => {
  await page.click('#builds-btn')
  await page.click('#open')
}

const clickAt = async (x: number, z: number, y = 0) => {
  const at = await screenOf(x, z, y)
  await page.mouse.move(at.x, at.y)
  await wait(60)
  await page.mouse.click(at.x, at.y)
  await wait(90)
}

const reset = async () => {
  await page.evaluate(() => {
    const { store, tools, chat, stage } = (window as any).clutch
    chat.reset()
    store.commit([], 'load')
    tools.setMode('select')
    tools.color = 'red'
    tools.rot = 0
    const view = stage.defaultView()
    stage.camera.position.copy(view.position)
    stage.controls.target.copy(view.target)
    stage.controls.update()
  })
  await page.keyboard.press('Escape')
  await page.click('[data-category="Bricks"]')
  await wait(40)
}

before(async () => {
  browser = await launch(true)
  page = await open(browser, '/?edit')
  await wait(500)
})

after(async () => { await browser.close() })

test('the parts menu shows about 40 parts, every picture drawn', async () => {
  await wait(800)
  const result = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.part-thumb')]
    const painted = canvases.filter((canvas) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 3; i < data.length; i += 4) if (data[i] > 200) return true
      return false
    })
    return { total: canvases.length, painted: painted.length }
  })
  assert.ok(result.total >= 38, `${result.total} parts`)
  assert.equal(result.painted, result.total)
})

test('the page is hidden until it is ready, then shown', async () => {
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ready')), true)
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app')!).visibility), 'visible')
  assert.equal(await page.$('#boot'), null, 'the loading screen is gone')
})

test('search narrows the menu and says when nothing matches', async () => {
  await page.type('#part-search', '2x4')
  const shown = await page.$$eval('.part-tile', (tiles) => tiles.filter((t) => !(t as HTMLElement).hidden).map((t) => (t as HTMLElement).title))
  assert.ok(shown.includes('Brick 2×4') && shown.includes('Plate 2×4'))
  assert.ok(!shown.includes('Brick 1×1'))
  await page.evaluate(() => { (document.getElementById('part-search') as HTMLInputElement).value = '' })
  await page.type('#part-search', 'zzz')
  assert.equal(await page.$eval('#part-empty', (el) => (el as HTMLElement).hidden), false)
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('#part-empty', (el) => (el as HTMLElement).hidden), true)
})

test('picking a part and clicking places it, with the ghost under the pointer', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  let s = await state()
  assert.equal(s.mode, 'place')
  assert.equal(s.part, 'brick_2x4')
  await clickAt(32, 32)
  s = await state()
  assert.equal(s.count, 1)
  assert.equal(s.bricks[0].part, 'brick_2x4')
  assert.equal(s.bricks[0].y, 0)
  assert.ok(Math.abs(s.bricks[0].x + 1 - 32) <= 1 && Math.abs(s.bricks[0].z + 2 - 32) <= 1, 'lands under the pointer')
  assert.equal(s.mode, 'place', 'stays ready for the next one')
})

test('a piece placed on another stacks on top, and rotation swaps its footprint', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  const [first] = (await state()).bricks
  await clickAt(first.x + 1, first.z + 2, 3)
  let s = await state()
  assert.equal(s.count, 2)
  assert.equal(s.bricks[1].y, 3, 'sits on the first brick')
  await page.keyboard.press('r')
  assert.equal((await state()).rot, 1)
  await clickAt(10, 10)
  s = await state()
  assert.equal(s.bricks[2].rot, 1)
})

test('the ghost stays on the plate at the edge', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×8"]')
  await clickAt(63.5, 63.5)
  const s = await state()
  assert.equal(s.count, 1)
  assert.ok(s.bricks[0].x + 2 <= 64 && s.bricks[0].z + 8 <= 64)
})

test('undo and redo walk the history, by keyboard and buttons', async () => {
  await reset()
  await page.click('[data-category="Plates"]')
  await page.click('.part-tile[title="Plate 2×2"]')
  await clickAt(10, 10)
  await clickAt(20, 20)
  assert.equal((await state()).count, 2)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal((await state()).count, 1)
  await page.click('#undo')
  assert.equal((await state()).count, 0)
  await page.click('#redo')
  assert.equal((await state()).count, 1)
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
  assert.equal((await state()).count, 2)
})

test('select shows the dock, which recolours, turns and deletes', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  await wait(500)
  const [b] = (await state()).bricks
  await clickAt(b.x + 1, b.z + 2, 3)
  let s = await state()
  assert.equal(s.selected, b.id)
  assert.equal(await page.$eval('#dock', (el) => (el as HTMLElement).hidden), false)
  await shot(page, 'selected')
  await page.click('.dock-swatch[data-color="blue"]')
  s = await state()
  assert.equal(s.bricks[0].color, 'blue')
  await page.click('[data-do="rotate"]')
  s = await state()
  assert.equal(s.bricks[0].rot, 1)
  await page.click('[data-do="delete"]')
  s = await state()
  assert.equal(s.count, 0)
  assert.equal(await page.$eval('#dock', (el) => (el as HTMLElement).hidden), true)
})

test('paint and erase act on the piece clicked', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await wait(450)
  const [b] = (await state()).bricks
  await page.click('.swatch[title="Yellow"]')
  await page.click('[data-mode="paint"]')
  await clickAt(b.x + 1, b.z + 2, 3)
  assert.equal((await state()).bricks[0].color, 'yellow')
  await page.click('[data-mode="erase"]')
  await clickAt(b.x + 1, b.z + 2, 3)
  assert.equal((await state()).count, 0)
})

test('a piece with nothing to grip is flagged, and a floating one counts as loose', async () => {
  await reset()
  await page.evaluate(() => {
    const { store } = (window as any).clutch
    store.commit([{ id: 1, part: 'brick_1x1', color: 'red', x: 3, y: 9, z: 3, rot: 0 }], 'chat')
  })
  await wait(120)
  assert.equal(await page.$eval('#loose', (el) => (el as HTMLElement).hidden), false)
  assert.match(await page.$eval('#loose', (el) => el.textContent ?? ''), /1 not attached/)
})

test('a chat proposal previews without changing the build, and locks the tools until decided', async () => {
  await reset()
  const actions = [{ tool: 'walls', x1: 10, z1: 10, x2: 20, z2: 20, y: 0, height: 6, color: 'white' }]
  await page.evaluate((list) => (window as any).clutch.chat.preview(list), actions)
  let s = await state()
  assert.equal(s.count, 0)
  assert.equal(s.previewing, true)
  assert.equal(s.locked, true)
  assert.match(await page.$eval('#chat-pending-count', (el) => el.textContent ?? ''), /new pieces/)
  await clickAt(30, 30)
  assert.equal((await state()).count, 0, 'clicks do nothing during a preview')
  await page.click('#chat-decline')
  s = await state()
  assert.equal(s.count, 0)
  assert.equal(s.locked, false)

  await page.evaluate((list) => (window as any).clutch.chat.preview(list), actions)
  await page.click('#chat-accept')
  s = await state()
  assert.ok(s.count > 10)
  assert.equal(s.locked, false)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal((await state()).count, 0, 'the whole proposal is one undo')
})

test('Enter applies a preview and Escape discards it', async () => {
  await reset()
  const actions = [{ tool: 'place', part: 'brick_2x2', color: 'red', at: [[5, 0, 5]] }]
  await page.evaluate((list) => (window as any).clutch.chat.preview(list), actions)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('Escape')
  assert.equal((await state()).count, 0)
  await page.evaluate((list) => (window as any).clutch.chat.preview(list), actions)
  await page.focus('#chat-input')
  await page.keyboard.press('Enter')
  assert.equal((await state()).count, 1)
})

test('a proposal can be dragged, turned and nudged, and lands where it was put', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 45, y: 0, z: 30, rot: 0 }], 'load'))
  await page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'fill', x1: 20, z1: 30, x2: 25, z2: 33, y: 0, height: 3, color: 'blue' }]))
  await wait(1000) // the camera glides to frame it
  const camera = await page.evaluate(() => (window as any).clutch.stage.camera.position.toArray())
  const before = await page.evaluate(() => (window as any).clutch.chat.mover.placing.current[0])

  // Drag it from its top, ten studs to the right.
  const from = await screenOf(22, 31, 3)
  const to = await screenOf(32, 31, 3)
  await page.mouse.move(from.x, from.y)
  await wait(30)
  assert.equal(await page.$eval('#canvas', (el) => (el as HTMLElement).style.cursor), 'grab')
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  const moved = await page.evaluate(() => (window as any).clutch.chat.mover.placing.current[0])
  assert.ok(Math.abs(moved.x - before.x - 10) <= 1, `it moved about ten studs: ${moved.x - before.x}`)
  assert.deepEqual(await page.evaluate(() => (window as any).clutch.stage.camera.position.toArray()), camera, 'dragging it did not orbit the camera')
  assert.equal((await state()).count, 1, 'nothing is built yet')

  // Onto the existing brick: red, and it cannot be applied.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => (window as any).clutch.chat.mover.placing.fits), false)
  assert.match(await page.$eval('#chat-pending-count', (el) => el.textContent ?? ''), /Doesn't fit/)
  assert.equal(await page.$eval('#chat-accept', (el) => (el as HTMLButtonElement).disabled), true)
  await wait(600)
  const inView = await page.evaluate(() => {
    const { stage, view, chat } = (window as any).clutch
    const box = view.boundsOf(chat.mover.placing.current)
    return stage.canSee([box.min, box.max])
  })
  assert.equal(inView, true, 'nudging it keeps it on screen')
  await shot(page, 'proposal-blocked')
  await page.keyboard.press('Enter')
  assert.equal((await state()).previewing, true, 'Enter does nothing while it does not fit')

  // Clear again, and turned.
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowLeft')
  assert.equal(await page.evaluate(() => (window as any).clutch.chat.mover.placing.fits), true)
  assert.match(await page.$eval('#chat-pending-count', (el) => el.textContent ?? ''), /new piece/)
  assert.equal(await page.$eval('#chat-accept', (el) => (el as HTMLButtonElement).disabled), false)
  await page.keyboard.press('r')
  await shot(page, 'proposal-moved')
  const final = await page.evaluate(() => (window as any).clutch.chat.mover.placing.current)
  await page.click('#chat-accept')
  const s = await state()
  assert.equal(s.count, final.length + 1)
  for (const brick of final) {
    const placed = s.bricks.find((b) => b.id === brick.id)!
    assert.deepEqual([placed.x, placed.y, placed.z, placed.rot], [brick.x, brick.y, brick.z, brick.rot])
  }
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal((await state()).count, 1, 'one undo takes it all back')
})

test('dragging away from a proposal still orbits, and an edit-only proposal has nothing to move', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'fill', x1: 40, z1: 40, x2: 45, z2: 43, y: 0, height: 3, color: 'blue' }]))
  await wait(1000)
  const camera = await page.evaluate(() => (window as any).clutch.stage.camera.position.toArray())
  const at = await screenOf(42, 41)
  await page.mouse.move(at.x - 220, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 140, at.y, { steps: 6 })
  await page.mouse.up()
  await wait(100)
  assert.notDeepEqual(await page.evaluate(() => (window as any).clutch.stage.camera.position.toArray()), camera)
  await page.click('#chat-decline')
  await page.evaluate(() => {
    const { store, chat } = (window as any).clutch
    store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 20, y: 0, z: 20, rot: 0 }], 'load')
    chat.preview([{ tool: 'recolor', ids: [1], color: 'blue' }])
  })
  assert.equal(await page.evaluate(() => (window as any).clutch.chat.mover.placing), null)
  await page.click('#chat-accept')
  assert.equal((await state()).bricks[0].color, 'blue')
})

test('an edit proposal tints what goes and shows what changes', async () => {
  await reset()
  await page.evaluate(() => {
    const { store } = (window as any).clutch
    store.commit([
      { id: 1, part: 'brick_2x4', color: 'red', x: 20, y: 0, z: 20, rot: 0 },
      { id: 2, part: 'brick_2x4', color: 'red', x: 26, y: 0, z: 20, rot: 0 },
    ], 'load')
    ;(window as any).clutch.chat.preview([{ tool: 'remove', ids: [1] }, { tool: 'recolor', ids: [2], color: 'blue' }])
  })
  assert.match(await page.$eval('#chat-pending-count', (el) => el.textContent ?? ''), /1 changed, 1 removed/)
  await page.click('#chat-accept')
  const s = await state()
  assert.equal(s.count, 1)
  assert.equal(s.bricks[0].color, 'blue')
})

test('Build replays the model step by step, leaves it untouched and locks editing', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'walls', x1: 10, z1: 10, x2: 16, z2: 16, y: 0, height: 9, color: 'white' }]))
  await page.click('#chat-accept')
  await wait(1500)
  const before = await state()
  await page.click('#build-play')
  let s = await state()
  assert.equal(s.replaying, true)
  assert.equal(s.locked, true)
  assert.equal(await page.$eval('#replay', (el) => (el as HTMLElement).hidden), false)
  await wait(1200)
  await shot(page, 'replay')
  assert.match(await page.$eval('#replay-count', (el) => el.textContent ?? ''), /Step [1-9]/)
  await page.click('#replay-prev')
  await page.click('#replay-next')
  await page.keyboard.press('Escape')
  s = await state()
  assert.equal(s.replaying, false)
  assert.equal(s.locked, false)
  assert.deepEqual(s.bricks, before.bricks)
})

test('the Parts tab lists what the build needs, and a step opens the replay there', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.chat.preview([
    { tool: 'fill', x1: 10, z1: 10, x2: 13, z2: 13, y: 0, height: 3, color: 'white' },
    { tool: 'place', part: 'brick_1x1', color: 'red', at: [[10, 3, 10], [12, 3, 12]] },
  ]))
  await page.click('#chat-accept')
  await wait(800)
  await page.click('[data-view="parts"]')
  await wait(250)
  assert.equal(await page.$eval('#parts-view', (el) => (el as HTMLElement).hidden), false)
  const rows = await page.$$eval('.parts-row', (els) => els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ')))
  assert.ok(rows.some((row) => /Brick 1×1 Red × 2/.test(row)), rows.join(' | '))
  await shot(page, 'parts-tab')
  await page.click('.step-row[data-step="1"]')
  await wait(150)
  const s = await state()
  assert.equal(s.replaying, true)
  assert.equal(await page.$eval('#parts-view', (el) => (el as HTMLElement).hidden), true)
  assert.match(await page.$eval('#replay-count', (el) => el.textContent ?? ''), /Step 2 of/)
  await page.keyboard.press('Escape')
  await wait(750)
})

test('the build saves itself, comes back after a reload, and can be renamed', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const field = document.getElementById('name')!
    field.focus()
    field.textContent = 'My build'
    field.blur()
  })
  assert.equal((await state()).count, 1)
  await wait(1000)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => (window as any).clutch)
  const s = await state()
  assert.equal(s.count, 1)
  assert.equal(s.name, 'My build')
  assert.equal(await page.$eval('#name', (el) => el.textContent), 'My build')
})

test('emptying a saved build stays empty after a reload', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  await wait(900)
  await page.evaluate(() => {
    const { store } = (window as any).clutch
    store.remove(store.bricks[0].id)
  })
  await wait(900)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => (window as any).clutch)
  assert.equal((await state()).count, 0)
})

test('the Open dialog lists builds and makes new ones', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  await wait(900)
  await openBuilds()
  await wait(200)
  assert.ok((await page.$$('.project-card[data-open]')).length >= 1)
  await shot(page, 'open-dialog')
  await page.click('[data-do="new"]')
  await wait(200)
  const s = await state()
  assert.equal(s.count, 0)
  assert.notEqual(s.name, (await page.evaluate(() => 'none')))
  assert.equal(await page.$eval('.project-dialog', (el) => (el as HTMLDialogElement).open), false)
})

test('a share link opens an independent copy', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  const link = await page.evaluate(async () => {
    const { store } = (window as any).clutch
    const { createShareLink } = await import('/src/app/projects.ts' as string)
    const { toFile } = await import('/src/core/file.ts' as string)
    return createShareLink(toFile('Shared', 'sky', store.bricks))
  })
  const mine = await page.evaluate(() => (window as any).clutch.store.projectId)
  const other = await open(browser, new URL(link).pathname + new URL(link).search + new URL(link).hash)
  try {
    await wait(400)
    const opened = await other.evaluate(() => {
      const { store } = (window as any).clutch
      return { count: store.count, name: store.name, baseplate: store.baseplate, project: store.projectId }
    })
    assert.equal(opened.count, 1)
    assert.equal(opened.name, 'Shared')
    assert.equal(opened.baseplate, 'sky')
    assert.notEqual(opened.project, mine)
  } finally {
    await other.close()
    await page.bringToFront()
  }
})

test('clear asks first, and undo brings it back', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(32, 32)
  await page.keyboard.press('Escape')
  await wait(100)
  await page.click('#clear')
  await wait(120)
  assert.equal(await page.$eval('#clear-modal', (el) => (el as HTMLDialogElement).open), true)
  await page.click('#clear-cancel')
  assert.equal((await state()).count, 1)
  await page.click('#clear')
  await wait(120)
  await page.click('#clear-confirm')
  assert.equal((await state()).count, 0)
  await page.click('#undo')
  assert.equal((await state()).count, 1)
})

test('a .clutch file opens, and one over 5 MB is refused before it is read', async () => {
  await reset()
  const dir = mkdtempSync(join(tmpdir(), 'clutch-files-'))
  const small = join(dir, 'small.clutch'), big = join(dir, 'big.clutch')
  writeFileSync(small, JSON.stringify({ version: 2, name: 'From a file', baseplate: 'green', bricks: [['brick_2x4', 'red', 3, 0, 3, 0]] }))
  writeFileSync(big, 'x'.repeat(5 * 1024 * 1024 + 1))
  const choose = async (file: string) => {
    await openBuilds()
    await wait(100)
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-do="file"]')])
    await chooser.accept([file])
    await wait(300)
  }
  await choose(big)
  assert.match(await page.$eval('#hint-text', (el) => el.textContent ?? ''), /too large/)
  assert.equal((await state()).count, 0)
  await choose(small)
  const after = await state()
  assert.deepEqual([after.count, after.name], [1, 'From a file'])
  rmSync(dir, { recursive: true })
})

test('the chat can be hidden and comes back, including for a preview', async () => {
  await reset()
  const width = () => page.$eval('#viewport', (el) => el.getBoundingClientRect().width)
  const display = () => page.$eval('#chat', (el) => getComputedStyle(el).display)
  const settled = () => page.evaluate(() => {
    const { stage } = (window as any).clutch
    const rect = document.getElementById('viewport')!.getBoundingClientRect()
    return {
      sliding: document.documentElement.classList.contains('chat-sliding'),
      offset: stage.camera.view?.enabled ?? false,
      canvas: Math.round(stage.canvas.getBoundingClientRect().width) === Math.round(rect.width),
      aspect: Math.abs(stage.camera.aspect - rect.width / rect.height) < 0.01,
    }
  })
  const clean = { sliding: false, offset: false, canvas: true, aspect: true }
  const before = await width()

  // The canvas resizes once, however long the slide takes.
  await page.evaluate(() => {
    const canvas = document.getElementById('canvas')!
    ;(window as any).__resizes = 0
    new MutationObserver(() => { (window as any).__resizes++ }).observe(canvas, { attributes: true, attributeFilter: ['width'] })
  })
  await page.click('#chat-hide')
  await wait(100)
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('chat-sliding')), true, 'it is still moving')
  assert.notEqual(await page.$eval('#chat', (el) => (el as HTMLElement).style.transform), '')
  await wait(350)
  assert.equal(await display(), 'none')
  assert.ok(await width() > before + 300, 'the 3D view takes the room')
  assert.deepEqual(await settled(), clean)
  assert.ok(await page.evaluate(() => (window as any).__resizes) <= 1)

  await page.keyboard.press('h')
  await wait(450)
  assert.notEqual(await display(), 'none')
  assert.equal(await width(), before)
  assert.deepEqual(await settled(), clean)

  // Asking twice quickly ends where the last request says.
  await page.click('#chat-toggle')
  await wait(60)
  await page.click('#chat-toggle')
  await wait(800)
  assert.notEqual(await display(), 'none')
  assert.deepEqual(await settled(), clean)

  await page.click('#chat-hide')
  await page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'place', part: 'brick_2x4', color: 'red', at: [[0, 0, 0]] }]))
  await wait(800)
  assert.notEqual(await display(), 'none', 'Apply and Discard are in the chat')
  assert.deepEqual(await settled(), clean)
  await page.click('#chat-decline')

  // It also slides on the Parts list, and pieces still land where clicked after all that.
  await page.click('[data-view="parts"]')
  await page.keyboard.press('h')
  await wait(450)
  assert.equal(await display(), 'none')
  await page.keyboard.press('h')
  await wait(450)
  assert.equal(await page.$eval('#chat', (el) => (el as HTMLElement).style.marginRight), '')
  await page.click('[data-view="build"]')
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(20, 20)
  assert.deepEqual((await state()).bricks.map((b) => [b.x, b.z]), [[19, 18]], 'a 2×4 centres on the pointer')
})

test('clean view leaves only the build, and everything comes back', async () => {
  await reset()
  const isClean = () => page.evaluate(() => document.documentElement.classList.contains('clean'))
  // Everything on the page that is still showing, apart from the 3D view.
  const showing = () => page.evaluate(() => ['sidebar', 'chat', 'nameplate', 'actions', 'rail', 'hint', 'empty', 'where', 'build-bar', 'dock', 'help']
    .filter((id) => {
      const el = document.getElementById(id)!
      return el.checkVisibility({ visibilityProperty: true }) && !el.classList.contains('is-hidden')
    }))
  const canvas = () => page.evaluate(() => {
    const rect = document.getElementById('canvas')!.getBoundingClientRect()
    return [rect.left, rect.top, rect.width, rect.height]
  })
  const windowSize = () => page.evaluate(() => [0, 0, innerWidth, innerHeight])
  const exitOpacity = () => page.$eval('#clean-exit', (el) => Number(getComputedStyle(el).opacity))

  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(20, 20)
  await page.keyboard.press('v')
  await clickAt(20, 20)
  assert.notEqual((await state()).selected, null)
  const before = await canvas()

  await page.click('#clean-btn')
  await wait(400)
  assert.equal(await isClean(), true)
  assert.deepEqual(await showing(), [])
  assert.deepEqual(await canvas(), await windowSize(), 'the build has the whole window')
  assert.equal((await state()).selected, null, 'no selection frame in the picture')
  assert.equal(await exitOpacity(), 1, 'it says how to get back')

  // The camera works, and clicks do nothing to the build.
  const camera = () => page.evaluate(() => (window as any).clutch.stage.camera.position.toArray())
  const from = await camera()
  await page.mouse.move(640, 500)
  await page.mouse.down()
  await page.mouse.move(720, 460, { steps: 4 })
  await page.mouse.up()
  await wait(200)
  assert.notDeepEqual(await camera(), from)
  await clickAt(20, 20)
  assert.equal((await state()).selected, null)
  assert.equal((await state()).count, 1)

  // The way back fades, and returns over its corner.
  await page.mouse.move(640, 500)
  await page.evaluate(() => document.getElementById('clean-exit')!.classList.remove('is-showing'))
  await wait(400)
  assert.equal(await exitOpacity(), 0)
  await page.hover('#clean-exit')
  await wait(400)
  assert.equal(await exitOpacity(), 1)
  await page.click('#clean-exit')
  await wait(100)
  assert.equal(await isClean(), false)
  assert.deepEqual(await canvas(), before)
  assert.ok((await showing()).includes('actions'))
  assert.equal((await state()).locked, false)

  // By key, and it leaves the tool as it was.
  await page.keyboard.press('b')
  await page.keyboard.press('u')
  await wait(100)
  assert.equal(await isClean(), true)
  assert.deepEqual(await showing(), [])
  await page.keyboard.press('h')
  await page.keyboard.press('?')
  await page.keyboard.press('Escape')
  await wait(100)
  assert.equal(await isClean(), false)
  assert.equal((await state()).mode, 'place')
  assert.equal(await page.$eval('#help', (el) => (el as HTMLElement).hidden), true)
  assert.notEqual(await page.$eval('#chat', (el) => getComputedStyle(el).display), 'none')

  // A piece on the pointer goes back first.
  await page.keyboard.press('v')
  await clickAt(20, 20)
  await page.keyboard.press('g')
  assert.equal((await state()).count, 0)
  await page.keyboard.press('u')
  assert.equal((await state()).count, 1)
  await page.keyboard.press('u')

  // A preview needs its Apply and Discard: it refuses clean view, and a reply ends it.
  const preview = () => page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'place', part: 'brick_2x4', color: 'blue', at: [[40, 0, 40]] }]))
  await preview()
  await wait(200)
  await page.click('#clean-btn')
  assert.equal(await isClean(), false)
  await page.click('#chat-decline')
  await wait(100)
  await page.keyboard.press('u')
  assert.equal(await isClean(), true)
  await preview()
  await wait(200)
  assert.equal(await isClean(), false)
  await page.click('#chat-decline')
  await wait(100)

  // Not from the Parts list, where there is nothing to show.
  await page.click('[data-view="parts"]')
  await page.keyboard.press('u')
  assert.equal(await isClean(), false)
  await page.click('[data-view="build"]')
})

test('My builds holds saved builds, download and share, and closes itself', async () => {
  await reset()
  const menuHidden = () => page.$eval('#builds-menu', (el) => (el as HTMLElement).hidden)
  assert.equal(await menuHidden(), true)
  await page.click('#builds-btn')
  assert.equal(await menuHidden(), false)
  await page.keyboard.press('Escape')
  assert.equal(await menuHidden(), true)
  await openBuilds()
  await wait(100)
  assert.equal(await menuHidden(), true)
  await page.click('[data-do="close"]')
})

test('the parts menu shows one category, search looks through them all, and a picked-up part opens its own', async () => {
  await reset()
  const shownSections = () => page.$$eval('.part-section', (all) => all.filter((el) => !(el as HTMLElement).hidden).map((el) => el.querySelector('h3')!.textContent))
  assert.deepEqual(await shownSections(), ['Bricks'])
  await page.click('[data-category="Slopes"]')
  assert.deepEqual(await shownSections(), ['Slopes'])
  await page.type('#part-search', '2x2')
  assert.ok((await shownSections()).length > 1)
  await page.click('[data-category="Round"]')
  assert.deepEqual(await shownSections(), ['Round'])
  assert.equal(await page.$eval('#part-search', (el) => (el as HTMLInputElement).value), '')
  await page.evaluate(() => (window as any).clutch.tools.pickPart('brick_2x4'))
  assert.deepEqual(await shownSections(), ['Bricks'])
  // Pictures drawn while closed are square, not stretched.
  const sizes = await page.$$eval('.part-thumb', (all) => all.map((el) => (el as HTMLCanvasElement).width === (el as HTMLCanvasElement).height))
  assert.ok(sizes.every(Boolean))
  await page.keyboard.press('Escape')
})

test('typing in the chat during a replay stays in the chat', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 3, y: 0, z: 3, rot: 0 }], 'load'))
  await page.click('#build-play')
  await page.click('#chat-input')
  await page.type('#chat-input', 'a tall tower')
  assert.equal(await page.$eval('#chat-input', (el) => (el as HTMLTextAreaElement).value), 'a tall tower')
  await page.keyboard.press('Escape')
  assert.equal((await state()).replaying, true, 'Esc in the chat box does not stop the replay')
  await page.evaluate(() => { (document.getElementById('chat-input') as HTMLTextAreaElement).value = ''; (document.activeElement as HTMLElement).blur() })
  await page.keyboard.press('Escape')
  assert.equal((await state()).replaying, false)
})

test('Open stops a replay, and opening a build clears the selection', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 3, y: 0, z: 3, rot: 0 }, { id: 2, part: 'brick_2x4', color: 'blue', x: 9, y: 0, z: 3, rot: 0 }], 'load'))
  await wait(900)
  await page.click('#build-play')
  await openBuilds()
  await wait(150)
  assert.equal((await state()).replaying, false)
  await page.click('[data-do="close"]')
  await page.evaluate(() => (window as any).clutch.tools.select(1))
  await openBuilds()
  await wait(100)
  await page.click('.project-card[data-open]')
  await wait(100)
  assert.equal((await state()).selected, null)
  assert.equal(await page.$eval('#dock', (el) => (el as HTMLElement).hidden), true)
})

test('the dock follows the piece when it changes from elsewhere', async () => {
  await reset()
  await page.evaluate(() => {
    const { store, tools } = (window as any).clutch
    store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 3, y: 0, z: 3, rot: 0 }], 'load')
    tools.select(1)
  })
  await page.click('#palette .swatch[title="Blue"]')
  assert.match(await page.$eval('.dock-meta', (el) => el.textContent ?? ''), /^Blue/)
  await page.click('#undo')
  assert.match(await page.$eval('.dock-meta', (el) => el.textContent ?? ''), /^Red/)
})

test('Move then Esc puts the piece back, and putting it down moves it', async () => {
  await reset()
  await page.evaluate(() => {
    const { store, tools } = (window as any).clutch
    store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 20, y: 0, z: 20, rot: 0 }], 'load')
    tools.select(1)
  })
  await page.keyboard.press('g')
  let s = await state()
  assert.equal(s.count, 0)
  assert.equal(s.mode, 'place')
  await page.keyboard.press('Escape')
  s = await state()
  assert.equal(s.count, 1, 'it came back')
  assert.equal(s.mode, 'select')
  assert.equal(s.selected, 1)
  await page.keyboard.press('g')
  await clickAt(10, 10)
  s = await state()
  assert.equal(s.count, 1)
  assert.notEqual(s.bricks[0].x, 20)
  await page.keyboard.press('Escape')
  assert.equal((await state()).count, 1, 'Esc after putting it down does not undo the move')
})

test('undo straight after erasing brings back a visible piece', async () => {
  await reset()
  const visible = await page.evaluate(async () => {
    const { store, view } = (window as any).clutch
    store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 20, y: 0, z: 20, rot: 0 }], 'load')
    store.remove(1)
    store.undo()
    await new Promise((done) => setTimeout(done, 300))
    return view.layer.has(1)
  })
  assert.equal(visible, true)
})

test('Enter applies a preview even when a button has focus', async () => {
  await reset()
  await page.evaluate(() => {
    (window as any).clutch.chat.preview([{ tool: 'place', part: 'brick_2x2', color: 'red', at: [[5, 0, 5]] }])
    document.getElementById('chat-send')!.focus()
  })
  await page.keyboard.press('Enter')
  assert.equal((await state()).count, 1)
})

test('Build is off during a preview, and a saved list over the limit says what went', async () => {
  await reset()
  await page.evaluate(() => (window as any).clutch.store.commit([{ id: 1, part: 'brick_2x4', color: 'red', x: 3, y: 0, z: 3, rot: 0 }], 'load'))
  await wait(50)
  await page.evaluate(() => (window as any).clutch.chat.preview([{ tool: 'place', part: 'brick_1x1', color: 'red', at: [[20, 0, 20]] }]))
  await wait(50)
  assert.equal(await page.$eval('#build-play', (el) => (el as HTMLButtonElement).disabled), true)
  await page.click('#chat-decline')
  await wait(50)
  assert.equal(await page.$eval('#build-play', (el) => (el as HTMLButtonElement).disabled), false)

  await page.evaluate(() => {
    const old = Array.from({ length: 24 }, (_, i) => ({ id: 'old' + i, updatedAt: '', file: { version: 1, name: 'Old ' + i, baseplate: 'green', bricks: [] } }))
    localStorage.setItem('clutch_projects', JSON.stringify(old))
    const { store } = (window as any).clutch
    store.projectId = null
    store.place('brick_1x1', 'red', 40, 0, 40, 0)
  })
  await wait(1000)
  assert.match(await page.$eval('#hint-text', (el) => el.textContent ?? ''), /"Old 23" was removed/)
})

test('nothing went wrong in the page', () => {
  assert.deepEqual(page.errors, [])
})
