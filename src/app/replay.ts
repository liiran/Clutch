// The Build button: plays the model going together, step by step, like the pages of an
// instruction booklet. The build itself is not touched; pieces are only hidden and shown.

import { COLOR } from '../core/colors.ts'
import { PART } from '../core/parts.ts'
import { countParts, planSteps, type Step } from '../core/steps.ts'
import { escapeHtml, icon } from './icons.ts'
import type { Store } from './store.ts'
import type { View } from './view.ts'
import type { Stage } from '../render/stage.ts'

const STEP_MS = 800

export class Replay {
  active = false
  onChange: () => void = () => {}
  private stage: Stage
  private store: Store
  private view: View
  private steps: Step[] = []
  private index = -1
  private playing = false
  private timer = 0
  private speed = 1
  private el = document.getElementById('replay')!
  private range = document.getElementById('replay-range') as HTMLInputElement
  private playBtn = document.getElementById('replay-play')!
  private count = document.getElementById('replay-count')!
  private detail = document.getElementById('replay-detail')!
  private speedBtn = document.getElementById('replay-speed')!

  constructor(stage: Stage, store: Store, view: View) {
    this.stage = stage
    this.store = store
    this.view = view
    this.playBtn.addEventListener('click', () => this.togglePlay())
    document.getElementById('replay-prev')!.addEventListener('click', () => { this.pause(); this.jump(this.index - 1) })
    document.getElementById('replay-next')!.addEventListener('click', () => { this.pause(); this.jump(this.index + 1, true) })
    document.getElementById('replay-close')!.addEventListener('click', () => this.stop())
    this.speedBtn.addEventListener('click', () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1
      this.speedBtn.textContent = `${this.speed}×`
    })
    this.range.addEventListener('input', () => { this.pause(); this.jump(Number(this.range.value) - 1) })
    document.addEventListener('keydown', (event) => {
      if (!this.active || document.querySelector('dialog[open]')) return
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && el !== this.range))
      if (typing) return
      if (event.key === 'Escape') this.stop()
      if (event.key === ' ') { event.preventDefault(); this.togglePlay() }
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.pause(); this.jump(this.index - 1) }
      if (event.key === 'ArrowRight') { event.preventDefault(); this.pause(); this.jump(this.index + 1, true) }
    })
  }

  start(atStep?: number) {
    if (!this.store.count) return
    if (this.active) this.stop()
    this.view.settle()
    this.active = true
    this.steps = planSteps(this.store.bricks)
    this.range.max = String(this.steps.length)
    for (const step of this.steps) for (const brick of step.bricks) this.view.hide(brick.id)
    this.index = -1
    this.el.hidden = false
    this.onChange()
    this.view.frameAll()
    if (atStep !== undefined) {
      this.jump(atStep)
      this.setPlaying(false)
    } else {
      this.setPlaying(true)
      this.timer = window.setTimeout(() => this.advance(), 500)
    }
    this.render()
  }

  stop() {
    if (!this.active) return
    window.clearTimeout(this.timer)
    this.view.settle()
    this.active = false
    this.playing = false
    for (const step of this.steps) for (const brick of step.bricks) this.view.show(brick.id)
    this.steps = []
    this.el.hidden = true
    this.onChange()
  }

  private setPlaying(playing: boolean) {
    this.playing = playing
    this.playBtn.innerHTML = icon(playing ? 'pause' : 'play', 16)
    this.playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)'
    this.playBtn.setAttribute('aria-label', this.playBtn.title)
  }

  private pause() {
    window.clearTimeout(this.timer)
    this.setPlaying(false)
  }

  private togglePlay() {
    if (this.playing) { this.pause(); return }
    if (this.index >= this.steps.length - 1) this.jump(-1)
    this.setPlaying(true)
    this.advance()
  }

  private advance() {
    if (!this.active || !this.playing) return
    if (this.index >= this.steps.length - 1) { this.setPlaying(false); return }
    this.jump(this.index + 1, true)
    this.timer = window.setTimeout(() => this.advance(), STEP_MS / this.speed)
  }

  // Shows everything up to this step. `animate` drops the step's pieces in.
  private jump(target: number, animate = false) {
    const index = Math.max(-1, Math.min(this.steps.length - 1, target))
    this.view.settle()
    this.steps.forEach((step, i) => {
      for (const brick of step.bricks) {
        if (i <= index) this.view.show(brick.id)
        else this.view.hide(brick.id)
      }
    })
    this.index = index
    if (animate && index >= 0) this.view.dropStep(this.steps[index].bricks, Math.max(120, (STEP_MS * 0.6) / this.speed))
    this.stage.invalidateShadows()
    this.render()
  }

  private render() {
    this.range.value = String(this.index + 1)
    this.count.textContent = `Step ${Math.max(0, this.index + 1)} of ${this.steps.length}`
    if (this.index < 0) {
      this.detail.innerHTML = '<span class="replay-note">Ready to build</span>'
      return
    }
    const rows = countParts(this.steps[this.index].bricks).slice(0, 4)
    const more = countParts(this.steps[this.index].bricks).length - rows.length
    this.detail.innerHTML = rows.map((row) => {
      const color = COLOR.get(row.color)!
      return `<span class="replay-chip"><i style="background:#${color.hex.toString(16).padStart(6, '0')}"></i>${row.count} × ${escapeHtml(PART.get(row.part)!.name)}</span>`
    }).join('') + (more > 0 ? `<span class="replay-note">+${more} more</span>` : '')
  }
}
