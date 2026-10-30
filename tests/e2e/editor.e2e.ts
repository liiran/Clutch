// Drives the real editor with a real mouse and keyboard. Needs npm run dev running.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
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
  const p = stage.camera.position.clone().set(cx - 24, cy * 0.4, cz - 24).project(stage.camera)
  const rect = stage.canvas.getBoundingClientRect()
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
}, x, z, y)

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
  await clickAt(24, 24)
  s = await state()
  assert.equal(s.count, 1)
  assert.equal(s.bricks[0].part, 'brick_2x4')
  assert.equal(s.bricks[0].y, 0)
  assert.ok(Math.abs(s.bricks[0].x + 1 - 24) <= 1 && Math.abs(s.bricks[0].z + 2 - 24) <= 1, 'lands under the pointer')
  assert.equal(s.mode, 'place', 'stays ready for the next one')
})

test('a piece placed on another stacks on top, and rotation swaps its footprint', async () => {
  await reset()
  await page.click('.part-tile[title="Brick 2×4"]')
  await clickAt(24, 24)
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
  await clickAt(47.5, 47.5)
  const s = await state()
  assert.equal(s.count, 1)
  assert.ok(s.bricks[0].x + 2 <= 48 && s.bricks[0].z + 8 <= 48)
})

test('undo and redo walk the history, by keyboard and buttons', async () => {
  await reset()
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
  await clickAt(24, 24)
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
  await clickAt(24, 24)
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
  await clickAt(24, 24)
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
  await clickAt(24, 24)
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
  await clickAt(24, 24)
  await page.keyboard.press('Escape')
  await wait(900)
  await page.click('#open')
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
  await clickAt(24, 24)
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
  await clickAt(24, 24)
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
  await page.click('#open')
  await wait(150)
  assert.equal((await state()).replaying, false)
  await page.click('[data-do="close"]')
  await page.evaluate(() => (window as any).clutch.tools.select(1))
  await page.click('#open')
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
