// The parts menu on the left: search, parts by category, and the colour palette.
// Every picture is drawn from the real model in the current colour.

import { COLORS } from '../core/colors.ts'
import { CATEGORIES, PARTS, type PartDef } from '../core/parts.ts'
import { drawThumb } from '../render/thumbs.ts'
import type { Tools } from './tools.ts'

// The menu's sections already name the kind of part, so its tiles can be brief.
const label = (part: PartDef) => part.name
  .replace(/^(Brick|Plate|Tile) /, '')
  .replace('Inverted slope', 'Inverted')
  .replace('Roof ridge', 'Ridge')
  .replace('Round brick', 'Round')
  .replace('Round plate', 'Disc')
  .replace('Wheel set', 'Wheels')

export class Sidebar {
  private tools: Tools
  private tiles = new Map<string, { button: HTMLButtonElement; canvas: HTMLCanvasElement }>()
  private swatches = new Map<string, HTMLButtonElement>()
  private sections: Array<{ el: HTMLElement; parts: PartDef[] }> = []
  private drawnColor = ''
  private drawing = 0

  constructor(tools: Tools) {
    this.tools = tools
    const list = document.getElementById('part-list')!
    for (const category of CATEGORIES) {
      const parts = PARTS.filter((part) => part.category === category)
      const section = document.createElement('section')
      section.className = 'part-section'
      section.innerHTML = `<h3 class="section-label">${category}</h3>`
      const grid = document.createElement('div')
      grid.className = 'part-grid'
      for (const part of parts) {
        const button = document.createElement('button')
        button.className = 'part-tile'
        button.title = part.name
        button.setAttribute('aria-label', part.name)
        const canvas = document.createElement('canvas')
        canvas.className = 'part-thumb'
        const name = document.createElement('span')
        name.className = 'part-name'
        name.textContent = label(part)
        button.append(canvas, name)
        button.addEventListener('click', () => {
          if (this.tools.mode === 'place' && this.tools.part === part.id) this.tools.setMode('select')
          else this.tools.pickPart(part.id)
        })
        grid.append(button)
        this.tiles.set(part.id, { button, canvas })
      }
      section.append(grid)
      list.append(section)
      this.sections.push({ el: section, parts })
    }

    const palette = document.getElementById('palette')!
    for (const color of COLORS) {
      const swatch = document.createElement('button')
      swatch.className = `swatch${color.glass ? ' swatch-glass' : ''}`
      swatch.style.setProperty('--sw', `#${color.hex.toString(16).padStart(6, '0')}`)
      swatch.title = color.name
      swatch.setAttribute('aria-label', color.name)
      swatch.addEventListener('click', () => this.tools.pickColor(color.id))
      palette.append(swatch)
      this.swatches.set(color.id, swatch)
    }

    const search = document.getElementById('part-search') as HTMLInputElement
    search.addEventListener('input', () => this.filter(search.value))
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = ''
        this.filter('')
        search.blur()
      }
    })
  }

  private filter(text: string) {
    const words = text.toLowerCase().replace(/[x×]/g, '×').split(/\s+/).filter(Boolean)
    let any = false
    for (const section of this.sections) {
      let shown = 0
      for (const part of section.parts) {
        const hay = part.name.toLowerCase()
        const match = words.every((word) => hay.includes(word))
        this.tiles.get(part.id)!.button.hidden = !match
        if (match) shown++
      }
      section.el.hidden = shown === 0
      any ||= shown > 0
    }
    document.getElementById('part-empty')!.hidden = any
  }

  // Redraws the pictures when the colour changes, a few per frame so nothing stutters.
  private drawAll(color: string) {
    if (this.drawnColor === color) return
    this.drawnColor = color
    const run = ++this.drawing
    const queue = [...this.tiles.entries()]
    const step = () => {
      if (run !== this.drawing) return
      const until = performance.now() + 6
      while (queue.length && performance.now() < until) {
        const [part, tile] = queue.shift()!
        drawThumb(tile.canvas, part, color)
      }
      if (queue.length) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  refresh() {
    const { mode, part, color } = this.tools
    for (const [id, tile] of this.tiles) tile.button.classList.toggle('active', mode === 'place' && part === id)
    for (const [id, swatch] of this.swatches) swatch.classList.toggle('active', color === id)
    this.drawAll(color)
  }
}
