// The world beneath the mod for a test: a clock, a store, a session id, the
// settings, and a record of what the mod opened, registered and submitted.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

export const PLUGIN = 'session-progress'
export const TOOL = 'mcp__session-progress__progress'
export const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
export const APPS = ['desktop', 'vscode', 'mobile'] as const
export const JAPANESE = /[぀-ヿ一-鿿]/

/** 2026-11-15 12:00 local time. */
export const NOON = new Date(2026, 10, 15, 12, 0, 0).getTime()
export const MIN = 60_000

export const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'session-progress',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const PILL = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

export type World = {
  clock: MockClock
  store: Map<string, unknown>
  sessionId: string
  language: string | undefined
  draft: string
  opens: { id: string; title?: string }[]
  prompts: string[]
  tools: { name: string; description: string }[]
  /** What a Bash command prints, by the command's text. */
  bash: Record<string, string>
}

export type WorldOptions = {
  now?: number
  sessionId?: string
  language?: string
  store?: Record<string, unknown>
}

const copy = <V>(value: V): V =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as V)

export function world(on: On, options: WorldOptions = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: options.now ?? NOON }),
    store: new Map(Object.entries(copy(options.store ?? {}))),
    sessionId: options.sessionId ?? 's1',
    language: options.language,
    draft: '',
    opens: [],
    prompts: [],
    tools: [],
    bash: {},
  }
  let tasks = 0

  on('store.get', (_, e) => ({ value: copy(w.store.get(e.key)) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, copy(e.value))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.id', () => ({ value: w.sessionId }))
  on('settings.read', () => ({
    value: w.language === undefined ? {} : { language: w.language },
  }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    w.tools.push({ name: e.name, description: e.description })

    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('ui.open', (_, e) => {
    w.opens.push({ id: e.id, title: e.title })

    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    w.prompts.push(e.text)

    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', (_, e) => {
    w.draft = e.mode === 'append' ? w.draft + e.text : e.text

    return { isFilled: true }
  })
  on('tool.call', (_, e) => {
    const input = e as Record<string, unknown>

    if (e.tool === 'Bash') {
      return {
        result: {
          stdout: w.bash[String(input.command)] ?? '',
          stderr: '',
          interrupted: false,
        },
      }
    }
    if (e.tool === 'TaskCreate') {
      tasks += 1

      return { result: { task: { id: String(tasks), subject: input.subject } } }
    }

    return { result: {} }
  })

  return w
}

/** What the mod saved for a session, as the store holds it. */
export function savedFor(w: World, sessionId: string): unknown {
  return w.store.get(`session:${sessionId}`)
}
