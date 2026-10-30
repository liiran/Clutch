// The Parts tab: what the build needs, and the steps to put it together.

import { COLOR } from '../core/colors.ts'
import { PART } from '../core/parts.ts'
import { countParts, planSteps } from '../core/steps.ts'
import { drawThumb } from '../render/thumbs.ts'
import { escapeHtml } from './icons.ts'
import type { Store } from './store.ts'

export class PartsView {
  private el = document.getElementById('parts-view')!
  private store: Store
  onOpenStep: (index: number) => void = () => {}

  constructor(store: Store) {
    this.store = store
    this.el.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-step]')
      if (row) this.onOpenStep(Number(row.dataset.step))
    })
  }

  render() {
    const bricks = this.store.bricks
    const summary = document.getElementById('parts-summary')!
    const list = document.getElementById('parts-list')!
    const steps = document.getElementById('parts-steps')!
    const empty = !bricks.length
    this.el.classList.toggle('is-empty', empty)
    if (empty) {
      summary.textContent = 'Nothing on the baseplate yet.'
      list.innerHTML = ''
      steps.innerHTML = ''
      return
    }
    const rows = countParts(bricks)
    const plan = planSteps(bricks)
    const colours = new Set(bricks.map((brick) => brick.color)).size
    summary.textContent = `${bricks.length} ${bricks.length === 1 ? 'piece' : 'pieces'} · ${rows.length} ${rows.length === 1 ? 'kind' : 'kinds'} · ${colours} ${colours === 1 ? 'colour' : 'colours'} · ${plan.length} ${plan.length === 1 ? 'step' : 'steps'}`

    list.innerHTML = rows.map((row, i) => `
      <div class="parts-row">
        <canvas class="parts-thumb" data-index="${i}"></canvas>
        <div class="parts-info">
          <span class="parts-name">${escapeHtml(PART.get(row.part)!.name)}</span>
          <span class="parts-color">${escapeHtml(COLOR.get(row.color)!.name)}</span>
        </div>
        <span class="parts-count">× ${row.count}</span>
      </div>`).join('')

    steps.innerHTML = plan.map((step, i) => {
      const chips = countParts(step.bricks).slice(0, 5).map((row) => {
        const color = COLOR.get(row.color)!
        return `<span class="step-chip"><i style="background:#${color.hex.toString(16).padStart(6, '0')}"></i>${row.count} × ${escapeHtml(PART.get(row.part)!.name)}</span>`
      }).join('')
      return `<button class="step-row" data-step="${i}"><span class="step-number">${i + 1}</span><span class="step-chips">${chips}</span></button>`
    }).join('')

    // The pictures are drawn a few per frame, so a long list opens at once.
    const canvases = [...list.querySelectorAll<HTMLCanvasElement>('canvas')]
    const draw = () => {
      if (!this.el.isConnected || this.el.hidden) return
      const until = performance.now() + 6
      while (canvases.length && performance.now() < until) {
        const canvas = canvases.shift()!
        const row = rows[Number(canvas.dataset.index)]
        drawThumb(canvas, row.part, row.color)
      }
      if (canvases.length) requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  }
}
