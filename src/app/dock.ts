// The bar along the bottom of the viewport for the selected piece: what it is and what
// can be done to it.

import { COLOR, COLORS } from '../core/colors.ts'
import { PART } from '../core/parts.ts'
import { escapeHtml, icon } from './icons.ts'
import type { Store } from './store.ts'
import type { Tools } from './tools.ts'

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

export class Dock {
  private el = document.getElementById('dock')!
  private tools: Tools
  private store: Store

  constructor(tools: Tools, store: Store) {
    this.tools = tools
    this.store = store
    this.el.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-do], [data-color]')
      if (!target) return
      if (target.dataset.color) { this.tools.pickColor(target.dataset.color); this.refresh(); return }
      const action = target.dataset.do
      if (action === 'rotate') this.tools.rotateSelected()
      if (action === 'move') this.tools.moveSelected()
      if (action === 'copy') this.tools.copySelected()
      if (action === 'delete') this.tools.deleteSelected()
    })
  }

  refresh() {
    const id = this.tools.selected
    const brick = id === null ? undefined : this.store.grid.bricks.get(id)
    if (!brick) {
      this.el.hidden = true
      return
    }
    const def = PART.get(brick.part)!
    const swatches = COLORS.map((color) => `<button class="dock-swatch${color.id === brick.color ? ' on' : ''}${color.glass ? ' swatch-glass' : ''}" data-color="${color.id}" style="--sw:${hex(color.hex)}" title="${escapeHtml(color.name)}" aria-label="${escapeHtml(color.name)}"></button>`).join('')
    const button = (action: string, name: string, title: string, extra = '') => `<button class="dock-btn${extra}" data-do="${action}" title="${title}" aria-label="${title}">${icon(name, 15)}</button>`
    this.el.innerHTML = `
      <div class="dock-info">
        <span class="dock-title">${escapeHtml(def.name)}</span>
        <span class="dock-meta">${escapeHtml(COLOR.get(brick.color)!.name)} · x ${brick.x} · z ${brick.z} · height ${brick.y}</span>
      </div>
      <div class="dock-swatches">${swatches}</div>
      <div class="dock-actions">
        ${button('rotate', 'rotate', 'Rotate (R)')}
        ${button('move', 'move', 'Move (G)')}
        ${button('copy', 'copy', 'Copy (C)')}
        ${button('delete', 'trash', 'Delete (Del)', ' dock-delete')}
      </div>`
    this.el.hidden = false
  }
}
