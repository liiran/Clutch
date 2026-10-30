// The open build: its pieces, name and undo history. Everything that changes the build
// goes through here, and everything that shows the build listens.

import { MAX_PIECES, type Brick, type Rot } from '../core/model.ts'
import { Grid } from '../core/grid.ts'
import { DEFAULT_BASEPLATE, type Build } from '../core/file.ts'

export type Cause = 'hand' | 'chat' | 'undo' | 'load'

export interface Change {
  added: Brick[]
  removed: Brick[]
  changed: Brick[]
  cause: Cause
}

interface Snapshot {
  bricks: Brick[]
}

const HISTORY = 80

export class Store {
  grid = new Grid()
  name = 'Untitled'
  baseplate = DEFAULT_BASEPLATE
  projectId: string | null = null
  revision = 0

  private nextId = 1
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private listeners = new Set<(change: Change) => void>()
  private metaListeners = new Set<() => void>()

  get bricks(): Brick[] { return [...this.grid.bricks.values()] }
  get count() { return this.grid.bricks.size }
  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  onChange(listener: (change: Change) => void) { this.listeners.add(listener) }
  onMeta(listener: () => void) { this.metaListeners.add(listener) }

  private emit(change: Change) {
    this.revision++
    for (const listener of this.listeners) listener(change)
  }

  emitMeta() { for (const listener of this.metaListeners) listener() }

  private remember() {
    this.undoStack.push({ bricks: this.bricks })
    if (this.undoStack.length > HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }

  // Puts down a piece by hand. Returns it, or null if it does not fit.
  place(part: string, color: string, x: number, y: number, z: number, rot: Rot): Brick | null {
    if (this.count >= MAX_PIECES) return null
    if (!this.grid.fits(part, x, y, z, rot).ok) return null
    this.remember()
    const brick: Brick = { id: this.nextId++, part, color, x, y, z, rot }
    this.grid.add(brick)
    this.emit({ added: [brick], removed: [], changed: [], cause: 'hand' })
    return brick
  }

  remove(id: number) {
    const brick = this.grid.bricks.get(id)
    if (!brick) return
    this.remember()
    this.grid.remove(brick)
    this.emit({ added: [], removed: [brick], changed: [], cause: 'hand' })
  }

  // Changes a piece in place. Returns false if the new position does not fit.
  update(id: number, patch: Partial<Pick<Brick, 'color' | 'x' | 'y' | 'z' | 'rot'>>): boolean {
    const old = this.grid.bricks.get(id)
    if (!old) return false
    const next: Brick = { ...old, ...patch }
    if (!this.grid.fits(next.part, next.x, next.y, next.z, next.rot, id).ok) return false
    this.remember()
    this.grid.remove(old)
    this.grid.add(next)
    this.emit({ added: [], removed: [], changed: [next], cause: 'hand' })
    return true
  }

  // Makes the build exactly this list, as one undo step.
  commit(next: Brick[], cause: Cause) {
    if (cause !== 'load') this.remember()
    this.swapTo(next, cause)
  }

  private swapTo(next: Brick[], cause: Cause) {
    const before = this.grid.bricks
    const after = new Map(next.map((brick) => [brick.id, brick]))
    const added = next.filter((brick) => !before.has(brick.id))
    const changed = next.filter((brick) => before.has(brick.id) && before.get(brick.id) !== brick)
    const removed = [...before.values()].filter((brick) => !after.has(brick.id))
    this.grid = new Grid(next)
    this.nextId = next.reduce((max, brick) => Math.max(max, brick.id), this.nextId - 1) + 1
    this.emit({ added, removed, changed, cause })
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop()
    if (!snapshot) return false
    this.redoStack.push({ bricks: this.bricks })
    this.swapTo(snapshot.bricks, 'undo')
    return true
  }

  redo(): boolean {
    const snapshot = this.redoStack.pop()
    if (!snapshot) return false
    this.undoStack.push({ bricks: this.bricks })
    this.swapTo(snapshot.bricks, 'undo')
    return true
  }

  // Opens a build as the new starting point, with nothing to undo.
  open(build: Build, projectId: string | null) {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.name = build.name
    this.baseplate = build.baseplate
    this.projectId = projectId
    this.swapTo(build.bricks, 'load')
    this.emitMeta()
  }

  rename(name: string) {
    this.name = name.trim().slice(0, 80) || 'Untitled'
    this.emitMeta()
  }

  setBaseplate(id: string) {
    this.baseplate = id
    this.emitMeta()
  }
}
