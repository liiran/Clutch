// The chat panel: ask, preview as ghosts, apply or discard. The server checks each reply
// and asks the model for one repair. Here the same actions run against the build as it
// is now, so what is previewed is exactly what gets applied.

import { applyActions, verdictFor, type ApplyResult, type Verdict } from '../core/actions.ts'
import type { Brick } from '../core/model.ts'
import { escapeHtml, icon } from './icons.ts'
import type { Store } from './store.ts'
import type { Tools } from './tools.ts'
import type { View } from './view.ts'
import { Mover } from './mover.ts'
import type { Stage } from '../render/stage.ts'

interface ChatReply {
  reply: string
  actions: unknown[]
  attempts: number
}

const STAGES = ['Reading the plate…', 'Planning the build…', 'Laying out the pieces…', 'Checking every stud…', 'Almost there…']
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Small, safe markdown: escaped first, then bold, code and lists.
function renderMarkdown(text: string) {
  const inline = (s: string) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const out: string[] = []
  let list: string[] | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      list ??= []
      list.push(`<li>${inline(item[1])}</li>`)
      continue
    }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`)
  return out.join('')
}

export class Chat {
  private store: Store
  private view: View
  private tools: Tools
  private history: Array<{ role: 'user' | 'model'; text: string }> = []
  private pending: { result: ApplyResult; revision: number; base: Brick[] } | null = null
  private mover: Mover
  private controller: AbortController | null = null
  private messages = document.getElementById('chat-messages')!
  private welcome = document.getElementById('chat-welcome')!
  private input = document.getElementById('chat-input') as HTMLTextAreaElement
  private send = document.getElementById('chat-send') as HTMLButtonElement
  private bar = document.getElementById('chat-pending')!
  private accepting = document.getElementById('chat-accept') as HTMLButtonElement
  private barCount = document.getElementById('chat-pending-count')!
  onPreviewChange: (open: boolean) => void = () => {}
  onAsk: () => void = () => {}
  onBeforePreview: () => void = () => {}
  onHint: (text: string, ms?: number) => void = () => {}

  constructor(store: Store, view: View, tools: Tools, stage: Stage) {
    this.store = store
    this.view = view
    this.tools = tools
    this.mover = new Mover(stage, view)
    this.mover.onChange = () => this.refreshBar()
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        // With nothing typed, Enter confirms the preview.
        if (!this.input.value.trim() && this.pending) this.accept()
        else void this.ask()
      }
    })
    this.input.addEventListener('input', () => this.fitInput())
    this.send.addEventListener('click', () => {
      if (this.controller) this.controller.abort()
      else void this.ask()
    })
    document.getElementById('chat-new')!.addEventListener('click', () => this.reset())
    document.getElementById('chat-accept')!.addEventListener('click', () => this.accept())
    document.getElementById('chat-decline')!.addEventListener('click', () => this.decline())
    this.welcome.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-ask]')
      if (button) void this.ask(button.dataset.ask)
    })
    document.addEventListener('keydown', (event) => {
      if (!this.pending || document.querySelector('dialog[open]')) return
      const active = document.activeElement as HTMLElement | null
      if (event.key === 'Escape') this.decline()
      else if (event.key === 'Enter') {
        const typing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
        if (typing || active?.closest('#chat-pending')) return
        event.preventDefault() // or Enter also presses whichever button has focus
        this.accept()
      }
    })
    void this.loadStatus()
  }

  private async loadStatus() {
    const el = document.getElementById('chat-status')!
    try {
      const status = await (await fetch('/api/clutch/status')).json()
      el.textContent = status.ready ? `${status.model} on this computer` : status.error
      el.classList.toggle('bad', !status.ready)
    } catch {
      el.textContent = 'The chat needs the local server. Run npm run dev.'
      el.classList.add('bad')
    }
  }

  private fitInput() {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 130)}px`
  }

  private addMessage(text: string, role: 'user' | 'ai' | 'system') {
    this.welcome.hidden = true
    const el = document.createElement('div')
    el.className = `chat-msg ${role}`
    if (role === 'ai') el.innerHTML = renderMarkdown(text)
    else el.textContent = text
    this.messages.append(el)
    this.messages.scrollTop = this.messages.scrollHeight
    return el
  }

  private addTyping() {
    this.welcome.hidden = true
    const el = document.createElement('div')
    el.className = 'chat-msg typing'
    el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label"></span>'
    this.messages.append(el)
    this.messages.scrollTop = this.messages.scrollHeight
    const label = el.querySelector('.typing-label')!
    let stage = 0
    label.textContent = STAGES[0]
    const timer = window.setInterval(() => {
      stage = Math.min(stage + 1, STAGES.length - 1)
      label.textContent = STAGES[stage]
    }, 4500)
    return { el, stop: () => { window.clearInterval(timer); el.remove() } }
  }

  private addVerdict(verdict: Verdict, attempts: number) {
    const el = document.createElement('div')
    el.className = `verify ${verdict.ok ? 'ok' : 'bad'}`
    const problems = !verdict.ok && verdict.problems.length
      ? `<ul class="verify-problems">${verdict.problems.slice(0, 4).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''
    el.innerHTML = `
      <div class="verify-head">${icon(verdict.ok ? 'check' : 'warn', 14, 2.6)}<span>${verdict.ok ? 'Checked' : 'Not quite right'}</span></div>
      <div class="verify-body">${escapeHtml(verdict.summary)}</div>${problems}
      ${attempts > 1 ? `<div class="verify-meta">${verdict.ok ? 'Fixed on a second try' : 'Better on a second try, but not all fixed. You can still apply it and finish by hand.'}</div>` : ''}`
    this.messages.append(el)
    this.messages.scrollTop = this.messages.scrollHeight
  }

  private setBusy(busy: boolean) {
    this.send.innerHTML = icon(busy ? 'stop' : 'send', 15, 2.4)
    this.send.title = busy ? 'Stop' : 'Send'
    this.send.setAttribute('aria-label', this.send.title)
    this.send.classList.toggle('is-stop', busy)
  }

  private async request(message: string, signal: AbortSignal): Promise<ChatReply> {
    const response = await fetch('/api/clutch/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: this.history.slice(-10),
        bricks: this.store.bricks.map((b: Brick) => [b.id, b.part, b.color, b.x, b.y, b.z, b.rot]),
      }),
      signal,
    })
    let data: (ChatReply & { error?: string }) | null = null
    try { data = await response.json() } catch { /* an HTML error page */ }
    if (!response.ok || !data) throw new Error(data?.error || 'The chat could not be reached. Is npm run dev running?')
    return { reply: data.reply || '', actions: Array.isArray(data.actions) ? data.actions : [], attempts: data.attempts || 1 }
  }

  async ask(text?: string) {
    const message = (text ?? this.input.value).trim()
    if (!message || this.controller) return
    this.onAsk()
    this.closePreview()
    this.addMessage(message, 'user')
    this.input.value = ''
    this.fitInput()
    const typing = this.addTyping()
    const controller = new AbortController()
    this.controller = controller
    this.setBusy(true)
    const revision = this.store.revision
    try {
      const data = await this.request(message, controller.signal)
      typing.stop()
      if (this.controller !== controller) return
      if (revision !== this.store.revision) {
        this.addMessage('The build changed while I was working. Send the request again and I will start from what is there now.', 'system')
        return
      }
      this.addMessage(data.reply || 'Here is the build.', 'ai')
      this.history.push({ role: 'user', text: message }, { role: 'model', text: data.reply })
      if (data.actions.length) this.preview(data.actions, data.attempts)
    } catch (error) {
      typing.stop()
      if (this.controller !== controller) return // the chat was reset
      if (controller.signal.aborted) this.addMessage('Stopped.', 'system')
      else this.addMessage((error as Error).message, 'system')
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.setBusy(false)
      }
    }
  }

  // Shows what the actions would do to the build as it is now.
  preview(actions: unknown[], attempts = 1) {
    const result = applyActions(this.store.bricks, actions)
    const changes = result.added.length + result.removed.length + result.changed.length
    this.addVerdict(verdictFor(result), attempts)
    if (!changes) return
    this.onBeforePreview()
    const added = new Set(result.added.map((brick) => brick.id))
    const base = result.bricks.filter((brick) => !added.has(brick.id))
    this.pending = { result, revision: this.store.revision, base }
    this.tools.setLocked(true)
    this.view.showProposal(result)
    this.view.reveal([...result.added, ...result.changed])
    this.mover.begin(base, result.added)
    this.refreshBar()
    this.bar.hidden = false
    this.onPreviewChange(true)
    if (result.added.length) this.onHint('Drag the preview to move it · R turns it')
  }

  private refreshBar() {
    if (!this.pending) return
    const { result } = this.pending
    const placing = this.mover.placing
    const parts: string[] = []
    if (result.added.length) parts.push(plural(result.added.length, 'new piece'))
    if (result.changed.length) parts.push(`${result.changed.length} changed`)
    if (result.removed.length) parts.push(`${result.removed.length} removed`)
    const blocked = placing !== null && !placing.fits
    // Only a move can make these worse; a proposal's own problems are already on its card.
    const floating = placing !== null && !blocked && placing.floating > result.loose.length
    this.barCount.textContent = blocked ? "Doesn't fit here. Move it."
      : floating ? `${plural(placing.floating, 'piece')} won't be attached here`
      : parts.join(', ')
    this.bar.classList.toggle('is-blocked', blocked)
    this.bar.classList.toggle('is-warning', floating)
    this.accepting.disabled = blocked
  }

  private closePreview() {
    if (!this.pending) return
    this.pending = null
    this.mover.end()
    this.view.clearProposal()
    this.bar.hidden = true
    this.tools.setLocked(false)
    this.onPreviewChange(false)
  }

  accept() {
    if (!this.pending) return
    const { result, revision, base } = this.pending
    const placing = this.mover.placing
    if (placing && !placing.fits) return
    const bricks = placing ? [...base, ...placing.current] : result.bricks
    this.closePreview()
    if (revision !== this.store.revision) {
      this.addMessage('The build changed, so this preview is out of date. Ask again for a new one.', 'system')
      return
    }
    this.store.commit(bricks, 'chat')
    this.addMessage(`Applied. ${plural(this.store.count, 'piece')} on the plate.`, 'system')
  }

  decline() {
    if (!this.pending) return
    this.closePreview()
    this.addMessage('Discarded.', 'system')
  }

  get isPreviewing() { return this.pending !== null }

  reset() {
    const running = this.controller
    this.controller = null
    running?.abort()
    this.setBusy(false)
    this.closePreview()
    this.history.length = 0
    this.messages.querySelectorAll('.chat-msg, .verify').forEach((el) => el.remove())
    this.welcome.hidden = false
  }
}
