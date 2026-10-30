import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import './styles/editor.css'
import './styles/chat.css'
import './styles/panels.css'

import { MAX_PIECES } from './core/model.ts'
import { BASEPLATES } from './core/file.ts'
import { COLOR } from './core/colors.ts'
import { Stage } from './render/stage.ts'
import { RED_TINT as REDDISH } from './render/layer.ts'
import { isMuted, setMuted } from './render/sound.ts'
import { Store } from './app/store.ts'
import { View } from './app/view.ts'
import { Tools, type Mode } from './app/tools.ts'
import { Sidebar } from './app/sidebar.ts'
import { Dock } from './app/dock.ts'
import { Replay } from './app/replay.ts'
import { PartsView } from './app/parts-view.ts'
import { Projects, readShareLink } from './app/projects.ts'
import { Chat } from './app/chat.ts'
import { Home } from './app/home.ts'
import { fillIcons, icon } from './app/icons.ts'

const $ = (id: string) => document.getElementById(id)!
const root = document.documentElement

fillIcons()

const stage = new Stage($('canvas') as HTMLCanvasElement, $('viewport'))
const store = new Store()
const view = new View(stage, store)
const tools = new Tools(stage, store, view)
const sidebar = new Sidebar(tools)
const dock = new Dock(tools, store)
const replay = new Replay(stage, store, view)
const partsView = new PartsView(store)
const projects = new Projects(store, stage)
const chat = new Chat(store, view, tools)

// ── Hints and labels ───────────────────────────────────────────
const hintBox = $('hint')
const hintText = $('hint-text')
let hintTimer = 0
let modeHint = ''
function setHint(text: string, ms?: number) {
  window.clearTimeout(hintTimer)
  if (ms) {
    hintText.textContent = text
    hintBox.classList.toggle('is-hidden', !text)
    hintTimer = window.setTimeout(() => setHint(modeHint), ms)
  } else {
    modeHint = text
    hintText.textContent = text
    hintBox.classList.toggle('is-hidden', !text)
  }
}
tools.onHint = setHint
projects.onHint = setHint

const label = $('where')
tools.onLabel = (text, warn) => {
  label.textContent = text
  label.hidden = !text
  label.classList.toggle('warn', warn)
}

// ── Tool rail, top bar and state ───────────────────────────────
const railButtons = document.querySelectorAll<HTMLButtonElement>('[data-mode]')
railButtons.forEach((button) => button.addEventListener('click', () => tools.setMode(button.dataset.mode as Mode)))

const colorDot = $('rail-color')
function refreshTools() {
  const locked = tools.isLocked
  railButtons.forEach((button) => {
    button.classList.toggle('active', !locked && button.dataset.mode === tools.mode)
    button.disabled = locked
  })
  colorDot.style.background = `#${COLOR.get(tools.color)!.hex.toString(16).padStart(6, '0')}`
  sidebar.refresh()
  $('sidebar').classList.toggle('is-locked', locked)
}
tools.onState = refreshTools
tools.onSelection = () => dock.refresh()

function refreshHistory() {
  ;($('undo') as HTMLButtonElement).disabled = !store.canUndo || tools.isLocked
  ;($('redo') as HTMLButtonElement).disabled = !store.canRedo || tools.isLocked
}

const looseChip = $('loose')
let looseIds: number[] = []
let countQueued = false
function refreshCounts() {
  if (countQueued) return
  countQueued = true
  requestAnimationFrame(() => {
    countQueued = false
    const empty = store.count === 0
    $('count').textContent = `${store.count} ${store.count === 1 ? 'piece' : 'pieces'}`
    $('count').classList.toggle('at-limit', store.count >= MAX_PIECES)
    $('stats').hidden = empty
    $('empty').hidden = !empty || chat.isPreviewing || replay.active
    $('clear').hidden = empty
    ;($('build-play') as HTMLButtonElement).disabled = empty
    looseIds = store.grid.loose()
    looseChip.hidden = !looseIds.length
    looseChip.textContent = `${looseIds.length} not attached`
    refreshHistory()
  })
}
store.onChange(refreshCounts)
looseChip.addEventListener('click', () => {
  // Flashes the loose pieces, so they can be found.
  const ids = [...looseIds]
  let on = true
  let count = 0
  const flash = window.setInterval(() => {
    for (const id of ids) view.tint(id, on ? REDDISH : null)
    on = !on
    if (++count >= 6) {
      window.clearInterval(flash)
      for (const id of ids) view.tint(id, null)
    }
  }, 180)
})

// ── The build's name and baseplate ─────────────────────────────
const nameField = $('name')
nameField.addEventListener('blur', () => {
  store.rename(nameField.textContent ?? '')
  nameField.textContent = store.name
})
nameField.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); nameField.blur() }
  if (event.key === 'Escape') { nameField.textContent = store.name; nameField.blur() }
})
const baseMenu = $('base-menu')
for (const id of BASEPLATES) {
  const color = COLOR.get(id)!
  const button = document.createElement('button')
  button.className = 'swatch'
  button.dataset.base = id
  button.style.setProperty('--sw', `#${color.hex.toString(16).padStart(6, '0')}`)
  button.title = color.name
  button.setAttribute('aria-label', `${color.name} baseplate`)
  button.addEventListener('click', () => {
    store.setBaseplate(id)
    baseMenu.hidden = true
  })
  baseMenu.append(button)
}
$('base-btn').addEventListener('click', () => { baseMenu.hidden = !baseMenu.hidden })
document.addEventListener('pointerdown', (event) => {
  if (!(event.target as HTMLElement).closest('#base-menu, #base-btn')) baseMenu.hidden = true
})
function refreshMeta() {
  if (document.activeElement !== nameField) nameField.textContent = store.name
  document.title = `${store.name} · Clutch`
  stage.setBaseplateColor(store.baseplate)
  baseMenu.querySelectorAll<HTMLElement>('[data-base]').forEach((button) => button.classList.toggle('active', button.dataset.base === store.baseplate))
}
store.onMeta(refreshMeta)

// ── Views ──────────────────────────────────────────────────────
const viewButtons = document.querySelectorAll<HTMLButtonElement>('[data-view]')
function showView(which: 'build' | 'parts') {
  const parts = which === 'parts'
  viewButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === which))
  $('parts-view').hidden = !parts
  $('viewport').classList.toggle('is-covered', parts)
  if (parts) {
    replay.stop()
    partsView.render()
  }
}
viewButtons.forEach((button) => button.addEventListener('click', () => showView(button.dataset.view as 'build' | 'parts')))
store.onChange(() => { if (!$('parts-view').hidden) partsView.render() })
partsView.onOpenStep = (index) => {
  showView('build')
  replay.start(index)
}

// ── Replay ─────────────────────────────────────────────────────
const lockWhile = () => tools.setLocked(replay.active || chat.isPreviewing)
replay.onChange = () => {
  lockWhile()
  root.classList.toggle('is-replaying', replay.active)
  const button = $('build-play')
  button.classList.toggle('is-stop', replay.active)
  button.innerHTML = `${icon(replay.active ? 'close' : 'play', 12, 2.4)} ${replay.active ? 'Stop' : 'Build'}`
  refreshCounts()
  refreshHistory()
}
$('build-play').addEventListener('click', () => {
  if (replay.active) { replay.stop(); return }
  showView('build')
  replay.start()
})
chat.onPreviewChange = () => {
  lockWhile()
  refreshHistory()
  refreshCounts()
}

// ── Top bar commands ───────────────────────────────────────────
$('undo').addEventListener('click', () => store.undo())
$('redo').addEventListener('click', () => store.redo())
$('open').addEventListener('click', () => projects.openDialog())
$('download').addEventListener('click', () => projects.download())
$('share').addEventListener('click', () => void projects.share())
$('frame').addEventListener('click', () => view.frameAll())
$('reset').addEventListener('click', () => void stage.resetView())

const muteBtn = $('mute')
function refreshMute() {
  muteBtn.innerHTML = icon(isMuted() ? 'mute' : 'sound', 15)
  muteBtn.title = isMuted() ? 'Turn sound on' : 'Turn sound off'
  muteBtn.setAttribute('aria-label', muteBtn.title)
}
muteBtn.addEventListener('click', () => { setMuted(!isMuted()); refreshMute() })
refreshMute()

const helpCard = $('help')
$('help-btn').addEventListener('click', () => { helpCard.hidden = !helpCard.hidden })
document.addEventListener('pointerdown', (event) => {
  if (!(event.target as HTMLElement).closest('#help, #help-btn')) helpCard.hidden = true
})
document.addEventListener('keydown', (event) => {
  const el = document.activeElement as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if (event.key === '?') helpCard.hidden = !helpCard.hidden
  if (event.key === 'Escape') helpCard.hidden = true
})

// ── Clearing ───────────────────────────────────────────────────
const clearModal = $('clear-modal') as HTMLDialogElement
$('clear').addEventListener('click', () => clearModal.showModal())
$('clear-cancel').addEventListener('click', () => clearModal.close())
$('clear-confirm').addEventListener('click', () => {
  clearModal.close()
  store.commit([], 'undo')
  setHint('Cleared. Undo brings it back.', 2600)
})
clearModal.addEventListener('click', (event) => { if (event.target === clearModal) clearModal.close() })

// ── Saved views of the camera ──────────────────────────────────
const resetBtn = $('reset')
function refreshReset() { resetBtn.hidden = stage.isAtDefaultView() }
stage.onViewChange = refreshReset

// ── Start ──────────────────────────────────────────────────────
projects.onOpened = () => {
  tools.setMode('select')
  chat.reset()
  void stage.resetView()
}

function startEditor() {
  tools.setLocked(false)
  projects.enabled = true
  tools.setMode('select')
  refreshCounts()
  refreshHistory()
  refreshReset()
}

refreshTools()
refreshMeta()
refreshCounts()
refreshHistory()
dock.refresh()

const shared = location.hash.startsWith('#build=')
if (root.classList.contains('scene')) {
  const home = new Home(stage)
  home.onEnter = () => {
    const last = projects.lastBuild()
    if (last) {
      store.name = last.build.name
      store.baseplate = last.build.baseplate
      store.projectId = last.id
    } else {
      store.name = projects.nextName()
    }
    refreshMeta()
  }
  home.onEntered = () => {
    const last = projects.lastBuild()
    startEditor()
    if (last) {
      store.commit(last.build.bricks, 'load')
      view.dropMany(last.build.bricks)
    }
  }
  $('skip-link').addEventListener('click', (event) => {
    event.preventDefault()
    home.open()
  })
} else {
  const last = shared ? null : projects.lastBuild()
  if (last) store.open(last.build, last.id)
  else store.name = projects.nextName()
  refreshMeta()
  startEditor()
  if (shared) {
    readShareLink(location.hash).then((build) => {
      store.open(build, null)
      history.replaceState(null, '', location.pathname + location.search)
      setHint(`Opened a shared build: "${build.name}"`, 3000)
    }).catch((error: Error) => setHint(error.message, 5000))
  }
}

// For tests: a window into the running editor.
;(window as unknown as Record<string, unknown>).clutch = { stage, store, view, tools, chat, replay, projects }
