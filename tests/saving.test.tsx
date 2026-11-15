import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { emptyProgress } from '../hooks/logic'
import type { Progress } from '../hooks/logic'
import { MIN, NOON, PANE, TOOL, savedFor, world } from './kit'

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const DAY = 24 * 60 * MIN

const progress = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...input })

const turnStart = ($: Engine, turnId: string) => $.turn.start({ text: 'go', turnId })

const titleOf = (saved: unknown): string | undefined =>
  (saved as { progress?: Progress } | undefined)?.progress?.run?.title

const shows = async ($: Engine, text: string): Promise<boolean> => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()

  return found !== undefined
}

const stored = (title: string, savedAt: number): { savedAt: number; progress: Progress } => ({
  savedAt,
  progress: {
    ...emptyProgress(),
    run: { title, startedAt: savedAt - 10 * MIN, isStartPinned: false },
    updatedAt: savedAt,
  },
})

test('a change is saved 0.5 s later, under the session id', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await progress($, { start: { title: 'Ship the importer' } })

  await w.clock.advance(499)
  expect(savedFor(w, 's1')).toBeUndefined()
  await w.clock.advance(1)
  expect(titleOf(savedFor(w, 's1'))).toBe('Ship the importer')
  expect(w.store.get('index')).toEqual({ s1: NOON + 500 })

  // The view state (the open tab or ticket) is not saved.
  expect(JSON.stringify(savedFor(w, 's1'))).not.toMatch(/"tab"|"openTicket"|"view"/)
})

test('the data is saved when the session ends, and comes back after a restart', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await progress($, {
    start: { title: 'Ship the importer' },
    tickets: [{ title: 'Parse the feed', estimate: 30 }],
  })
  expect(savedFor(w, 's1')).toBeUndefined()

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(titleOf(savedFor(w, 's1'))).toBe('Ship the importer')

  // A new process reads the store: what it shows is what the store holds.
  const saved = savedFor(w, 's1') as { progress: Progress }
  saved.progress.run!.title = 'Ship the importer (restored)'
  w.opens.length = 0
  await $.session.start(START)

  expect(await shows($, 'Ship the importer (restored)')).toBe(true)
  // A restored run opens the pane.
  expect(w.opens).toHaveLength(1)
})

test('a start with saved data for another session shows nothing of it', async ($, on) => {
  const w = world(on, {
    sessionId: 'fork',
    store: { 'session:s1': stored('The parent session', NOON - MIN), index: { s1: NOON - MIN } },
  })
  await $.session.start(START)

  expect(await shows($, 'Nothing tracked yet.')).toBe(true)
  expect(w.opens).toHaveLength(0)
})

test('a resume in the same process loads that session at the next turn', async ($, on) => {
  const w = world(on, {
    store: { 'session:s2': stored('The resumed run', NOON - MIN), index: { s2: NOON - MIN } },
  })
  await $.session.start(START)
  await turnStart($, 't1')
  await progress($, { start: { title: 'The first run' } })
  expect(w.opens).toHaveLength(1)

  w.sessionId = 's2'
  await turnStart($, 't2')

  expect(await shows($, 'The resumed run')).toBe(true)
  expect(titleOf(savedFor(w, 's1'))).toBe('The first run')
  expect(w.opens).toHaveLength(2)

  await progress($, { ticker: 'On it' })
  await w.clock.advance(500)
  expect(titleOf(savedFor(w, 's2'))).toBe('The resumed run')
  expect(titleOf(savedFor(w, 's1'))).toBe('The first run')
})

test('/clear empties the pane at once and keeps the old session\'s saved data', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await turnStart($, 't1')
  await progress($, { start: { title: 'Before the clear' } })

  // The 0.5 s save is still pending when the /clear arrives.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(titleOf(savedFor(w, 's1'))).toBe('Before the clear')
  expect(await shows($, 'Nothing tracked yet.')).toBe(true)

  // Neither a late save nor the 30 s tick touches the ended session: its
  // data stays saved, and it does not come back into the pane.
  await w.clock.advance(60_000)
  await $.tool.call({ tool: TOOL, ticker: 'Still here' })
  await w.clock.advance(500)
  expect(titleOf(savedFor(w, 's1'))).toBe('Before the clear')
  expect(await shows($, 'Nothing tracked yet.')).toBe(true)

  // The process goes on under a new id. No session.start fires.
  w.sessionId = 's2'
  w.opens.length = 0
  await turnStart($, 't2')
  expect(await shows($, 'Nothing tracked yet.')).toBe(true)
  expect(w.opens).toHaveLength(0)

  await progress($, { start: { title: 'After the clear' } })
  expect(w.opens).toHaveLength(1)
  await w.clock.advance(500)
  expect(titleOf(savedFor(w, 's2'))).toBe('After the clear')
  expect(titleOf(savedFor(w, 's1'))).toBe('Before the clear')
})

test('the clear field of the tool deletes the saved data', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await progress($, { start: { title: 'Run' } })
  await w.clock.advance(500)
  expect(savedFor(w, 's1')).toBeDefined()

  await progress($, { clear: true })
  await w.clock.advance(500)
  expect(savedFor(w, 's1')).toBeUndefined()
  expect(w.store.get('index')).toEqual({})
  expect(await shows($, 'Nothing tracked yet.')).toBe(true)
})

test('the 20 newest sessions of the last 30 days are kept', async ($, on) => {
  const store: Record<string, unknown> = {}
  const index: Record<string, number> = {}
  for (let n = 0; n < 24; n += 1) {
    index[`old${n}`] = NOON - (n + 1) * 60 * MIN
    store[`session:old${n}`] = stored(`Run ${n}`, NOON - (n + 1) * 60 * MIN)
  }
  index.ancient = NOON - 31 * DAY
  store['session:ancient'] = stored('Ancient', NOON - 31 * DAY)
  store.index = index

  const w = world(on, { store })
  await $.session.start(START)
  await w.clock.settle()

  const kept = Object.keys(w.store.get('index') as Record<string, number>)
  expect(kept).toHaveLength(20)
  expect(kept).toContain('old0')
  expect(kept).not.toContain('old20')
  expect(kept).not.toContain('ancient')
  expect(w.store.has('session:ancient')).toBe(false)
  expect(w.store.has('session:old23')).toBe(false)
  expect(w.store.has('session:old19')).toBe(true)
})

test('data saved before spans existed counts wall time until the next turn starts', async ($, on) => {
  const saved = stored('An old run', NOON - 20 * MIN) as { savedAt: number; progress: Partial<Progress> }
  saved.progress.tickets = [
    {
      id: 'T01',
      title: 'Write the mapper',
      estimate: 10,
      status: 'working',
      progress: 0,
      createdAt: NOON - 20 * MIN,
      updatedAt: NOON - 20 * MIN,
      workedMs: 0,
      timeline: [],
    },
  ]
  delete saved.progress.spans

  const w = world(on, { store: { 'session:s1': saved, index: { s1: NOON - 20 * MIN } } })
  await $.session.start(START)

  // Twenty minutes of wall time against a ten-minute estimate.
  expect(await shows($, 'T01 is past its estimate: Write the mapper')).toBe(true)

  // From the next turn on, only turns count.
  await turnStart($, 't1')
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.advance(3 * 60 * MIN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ticket:T01' })
  expect(await ui.find({ type: 'Text', text: /worked 20m$/ })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.unmount()
})
