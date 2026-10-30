// Saving: autosave in this browser, the Open dialog, .clutch files and share links.

import { fromFile, toFile, type Build, type BuildFile } from '../core/file.ts'
import { PART } from '../core/parts.ts'
import * as THREE from 'three'
import { SIZE } from '../core/model.ts'
import { PLATE_H } from '../render/geometry.ts'
import type { Stage } from '../render/stage.ts'
import { escapeHtml, icon } from './icons.ts'
import type { Store } from './store.ts'

const KEY = 'clutch_projects'
const LAST = 'clutch_last'
const SHARE = '#build=v1.'
const MAX_PROJECTS = 24
const MAX_LINK = 64000
const THUMB_EVERY = 12000 // ms between refreshing a saved build's picture

interface Saved {
  id: string
  updatedAt: string
  thumb?: string
  file: BuildFile
}

const read = (): Saved[] => {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

const count = (item: Saved) => {
  const n = item.file?.bricks?.length ?? 0
  return `${n} ${n === 1 ? 'piece' : 'pieces'}`
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export async function createShareLink(file: BuildFile): Promise<string> {
  const compressed = await pipe(new TextEncoder().encode(JSON.stringify(file)), new CompressionStream('deflate'))
  let binary = ''
  for (const byte of compressed) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const url = new URL(window.location.href)
  url.search = '?edit'
  url.hash = SHARE + encoded
  if (url.href.length > MAX_LINK) throw new Error('This build is too large for a link. Use Download instead.')
  return url.href
}

export async function readShareLink(hash: string): Promise<Build> {
  if (!hash.startsWith(SHARE) || hash.length > MAX_LINK * 2) throw new Error('This link is not a Clutch build.')
  try {
    const binary = atob(hash.slice(SHARE.length).replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const text = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate')))
    return fromFile(JSON.parse(text))
  } catch {
    throw new Error('This link is damaged or not a Clutch build.')
  }
}

export class Projects {
  private store: Store
  private stage: Stage
  private timer = 0
  private lastThumb = 0
  private dialog: HTMLDialogElement
  onHint: (text: string, ms?: number) => void = () => {}
  onOpened: () => void = () => {}
  isAnimating: () => boolean = () => false
  showOverlays: (show: boolean) => void = () => {}
  enabled = false

  constructor(store: Store, stage: Stage) {
    this.store = store
    this.stage = stage
    this.dialog = document.createElement('dialog')
    this.dialog.className = 'project-dialog'
    document.body.append(this.dialog)
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.dialog.close() })
    store.onChange(() => this.schedule())
    store.onMeta(() => this.schedule())
    window.addEventListener('pagehide', () => this.flush())
  }

  schedule() {
    if (!this.enabled) return
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      if (this.isAnimating()) this.schedule()
      else this.save()
    }, 700)
  }

  flush() {
    if (this.enabled && this.timer) {
      window.clearTimeout(this.timer)
      this.timer = 0
      this.save()
    }
  }

  private file(): BuildFile { return toFile(this.store.name, this.store.baseplate, this.store.bricks) }

  private save(forceThumb = false) {
    this.timer = 0
    const store = this.store
    // An empty plate is only worth saving if it used to hold something.
    if (!store.count && !store.projectId) return
    if (!store.projectId) store.projectId = newId()
    const list = read()
    const index = list.findIndex((item) => item.id === store.projectId)
    const entry: Saved = { id: store.projectId, updatedAt: new Date().toISOString(), thumb: index >= 0 ? list[index].thumb : undefined, file: this.file() }
    const now = Date.now()
    if (!store.count) entry.thumb = undefined
    else if (forceThumb || !entry.thumb || now - this.lastThumb > THUMB_EVERY) {
      this.lastThumb = now
      entry.thumb = this.capture() ?? entry.thumb
    }
    if (index >= 0) list.splice(index, 1)
    list.unshift(entry)
    this.write(list.slice(0, MAX_PROJECTS))
    localStorage.setItem(LAST, store.projectId)
  }

  private write(list: Saved[]) {
    for (let keep = list.length; keep > 0; keep--) {
      try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, keep)))
        return
      } catch { /* over quota: drop the oldest and try again */ }
    }
    this.onHint('This browser is out of space for saved builds. Download this one to keep it.', 5000)
  }

  // A small picture of the build, from the usual three-quarter angle.
  private capture(): string | undefined {
    try {
      const bricks = this.store.bricks
      const box = new THREE.Box3()
      for (const b of bricks) {
        const def = PART.get(b.part)!
        const r = def.rots[b.rot]
        box.expandByPoint(new THREE.Vector3(b.x - SIZE / 2, b.y * PLATE_H, b.z - SIZE / 2))
        box.expandByPoint(new THREE.Vector3(b.x + r.w - SIZE / 2, (b.y + def.h) * PLATE_H, b.z + r.d - SIZE / 2))
      }
      const view = this.stage.fitBox(box.expandByScalar(2), this.stage.camera.aspect, 0.8)
      const camera = this.stage.camera
      const p = camera.position.clone(), q = camera.quaternion.clone()
      camera.position.copy(view.position)
      camera.lookAt(view.target)
      camera.updateMatrixWorld()
      this.showOverlays(false)
      this.stage.renderer.render(this.stage.scene, camera)
      this.showOverlays(true)
      const source = this.stage.canvas
      const small = document.createElement('canvas')
      small.width = 320
      small.height = Math.round((320 * source.height) / source.width)
      small.getContext('2d')!.drawImage(source, 0, 0, small.width, small.height)
      camera.position.copy(p)
      camera.quaternion.copy(q)
      camera.updateMatrixWorld()
      this.stage.invalidate()
      return small.toDataURL('image/jpeg', 0.72)
    } catch {
      return undefined
    }
  }

  lastBuild(): { build: Build; id: string } | null {
    const list = read()
    const id = localStorage.getItem(LAST)
    const saved = list.find((item) => item.id === id) ?? list[0]
    if (!saved) return null
    try { return { build: fromFile(saved.file), id: saved.id } } catch { return null }
  }

  private fresh() {
    this.store.open({ name: this.nextName(), baseplate: this.store.baseplate, bricks: [], dropped: 0 }, null)
    localStorage.removeItem(LAST)
    this.onOpened()
  }

  nextName() {
    const names = new Set(read().map((item) => item.file?.name))
    if (!names.has('Untitled')) return 'Untitled'
    let n = 2
    while (names.has(`Untitled ${n}`)) n++
    return `Untitled ${n}`
  }

  private openBuild(build: Build, id: string | null) {
    this.store.open(build, id)
    if (id) localStorage.setItem(LAST, id)
    this.onOpened()
    if (build.dropped) this.onHint(`${build.dropped} ${build.dropped === 1 ? 'piece' : 'pieces'} could not be placed and ${build.dropped === 1 ? 'was' : 'were'} left out`, 4000)
    else this.onHint(`Opened "${build.name}"`, 2000)
  }

  openDialog() {
    this.flush()
    if (this.store.count) this.save(true)
    const list = read()
    this.dialog.innerHTML = `
      <div class="project-head">
        <h2>Your builds</h2>
        <button class="icon-btn" data-do="close" aria-label="Close" title="Close">${icon('close', 15)}</button>
      </div>
      <div class="project-grid">
        <button class="project-card project-new" data-do="new">${icon('plus', 22)}<span>New build</span></button>
        ${list.map((item, i) => `
          <div class="project-card" data-open="${i}" role="button" tabindex="0">
            <div class="project-picture">${item.thumb?.startsWith('data:image/') ? `<img src="${item.thumb}" alt="" draggable="false">` : ''}</div>
            <div class="project-foot">
              <span class="project-name">${escapeHtml(item.file?.name || 'Untitled')}</span>
              <span class="project-count">${count(item)}</span>
              <button class="project-delete" data-delete="${i}" title="Delete this build" aria-label="Delete this build">${icon('trash', 13)}</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="project-actions">
        <span class="project-note">Builds save automatically in this browser.</span>
        <button class="btn-secondary" data-do="file">Open a file…</button>
      </div>`
    const close = () => this.dialog.close()
    this.dialog.onclick = (event) => {
      const target = event.target as HTMLElement
      const del = target.closest<HTMLElement>('[data-delete]')
      if (del) {
        const item = list[Number(del.dataset.delete)]
        const remaining = read().filter((saved) => saved.id !== item.id)
        this.write(remaining)
        if (item.id === this.store.projectId) this.fresh()
        this.openDialog()
        return
      }
      const action = target.closest<HTMLElement>('[data-do]')?.dataset.do
      if (action === 'close') close()
      if (action === 'new') { this.fresh(); close() }
      if (action === 'file') { close(); this.openFile() }
      const open = target.closest<HTMLElement>('[data-open]')
      if (open) {
        const item = list[Number(open.dataset.open)]
        try {
          this.openBuild(fromFile(item.file), item.id)
          close()
        } catch (error) {
          this.onHint((error as Error).message, 4000)
        }
      }
    }
    if (!this.dialog.open) this.dialog.showModal()
  }

  openFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.clutch,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        this.openBuild(fromFile(JSON.parse(await file.text())), null)
      } catch (error) {
        this.onHint(error instanceof SyntaxError ? 'That file is not a Clutch build.' : (error as Error).message, 4000)
      }
    }
    input.click()
  }

  download() {
    const blob = new Blob([JSON.stringify(this.file(), null, 1)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${this.store.name.replace(/[^\w\s-]/g, '').trim() || 'build'}.clutch`
    link.click()
    URL.revokeObjectURL(url)
    this.onHint(`Saved "${this.store.name}"`, 2200)
  }

  async share() {
    try {
      const link = await createShareLink(this.file())
      try {
        await navigator.clipboard.writeText(link)
        this.onHint('Link copied', 2400)
      } catch {
        window.prompt('Copy this link:', link)
      }
    } catch (error) {
      this.onHint((error as Error).message, 4000)
    }
  }
}
