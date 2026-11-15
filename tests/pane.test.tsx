import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { stamp } from '../hooks/i18n'
import { APPS, MIN, NOON, PANE, PILL, SURFACES, TOOL, world } from './kit'

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const COMPOSER = { kind: 'composer' } as const

const progress = async ($: Engine, input: Record<string, unknown>): Promise<string> => {
  const ran = await $.tool.call({ tool: TOOL, ...input })

  return String(ran.result)
}

const turnStart = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.start({ text: 'go', turnId, ...(agentId === undefined ? {} : { agentId }) })

const turnEnd = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 0,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })

const runCommand = ($: Engine, args = '') =>
  $.command.run({
    command: 'progress',
    args,
    origin: COMPOSER,
    presentation: { isFullscreen: true, columns: 200 },
  })

const SAMPLE = {
  start: { title: 'Ship the importer', doneWhen: 'CI is green on the MR' },
  tickets: [
    { title: 'Parse the feed', estimate: 30, status: 'done' },
    { title: 'Write the mapper', estimate: 60, status: 'working', stage: 'code', progress: 50 },
    { title: 'Open the MR', estimate: 30, waitsFor: 'T02' },
  ],
  ticker: 'Mapping the price fields',
  activity: 'Read the feed spec',
  ask: {
    title: 'Which currency?',
    question: 'The feed has no currency field.',
    options: ['Assume EUR', 'Fail the import'],
    recommend: 'A',
  },
}

test('the pane does not open empty at start, and the first run opens it once', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await turnStart($, 't1')
  expect(w.opens).toHaveLength(0)

  // Activity alone is no run and no ticket.
  await progress($, { ticker: 'Looking around' })
  expect(w.opens).toHaveLength(0)

  await progress($, { start: { title: 'Ship the importer' } })
  expect(w.opens).toEqual([{ id: 'session-progress', title: 'Progress' }])

  await progress($, { tickets: [{ title: 'Parse the feed', estimate: 30 }] })
  await progress($, { ticker: 'Parsing' })
  expect(w.opens).toHaveLength(1)
})

test('the empty pane explains itself, on every surface', async ($, on) => {
  world(on)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'Nothing tracked yet.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /how the session's work is going/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Run \/progress/ })).toBeDefined()
    await ui.unmount()
  }
})

test('end to end: the pane shows the run, tickets, questions and activity, and an answer is recorded', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await turnStart($, 't1')

  const result = await progress($, SAMPLE)
  expect(result).toContain('T01 (new) "Parse the feed" done')
  expect(result).toContain('T03 (new) "Open the MR" not_started')
  expect(result).toContain('Question Q1')
  expect(result).toContain('is work_around:')

  await w.clock.advance(10 * MIN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Run header: (30 + 60 × 50%) of 120 minutes.
    expect(await ui.find({ type: 'Text', text: 'Ship the importer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stop when: CI is green on the MR' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'working' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '50% done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '10m elapsed' })).toBeDefined()
    const left = await ui.find({ type: 'Text', text: / left$/ })
    expect(left?.text).toMatch(/^· ~\d+m left$/)
    expect(await ui.find({ type: 'Text', text: '▸ Mapping the price fields' })).toBeDefined()

    // Tickets.
    expect((await ui.find({ key: 'ticket:T01' }))?.text).toContain('T01 Parse the feed')
    expect(await ui.find({ type: 'Text', text: 'working · code · 50% · est 1h' })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: 'not started · est 30m · waits for T02' }),
    ).toBeDefined()

    // Needs you.
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Q1 Which currency?' })).toBeDefined()
    expect((await ui.find({ key: 'answer:Q1:A' }))?.props.label).toBe(
      'A — Assume EUR (recommended)',
    )
    expect((await ui.find({ key: 'answer:Q1:B' }))?.props.label).toBe('B — Fail the import')

    // Activity, behind key 3.
    expect((await ui.find({ key: 'tab:activity' }))?.props.hotkey).toBe('3')
    await ui.press({ key: 'tab:activity' })
    expect(await ui.find({ type: 'Text', text: 'Read the feed spec' })).toBeDefined()
    expect(await ui.find({ key: 'ticket:T01' })).toBeUndefined()
    await ui.press({ key: 'tab:tickets' })
    await ui.unmount()
  }

  // Picking an option puts the answer into the prompt.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'answer:Q1:A' })
  expect(w.draft).toBe('Q1: A — Assume EUR')

  const pill = await $.ui.mount({ ...PILL, surface: 'terminal' })
  expect(await pill.find({ type: 'Text', text: 'Progress: 1 question waiting' })).toBeDefined()

  // The person sends it, written their own way.
  await $.prompt.submit({ text: 'Q-1: A — Assume EUR', wait: false, origin: COMPOSER })
  expect(await ui.find({ key: 'answer:Q1:A' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()

  await pill.redraw()
  expect(await pill.find({ type: 'Text', text: /Progress:/ })).toBeUndefined()
  expect(await pill.keepsBeneath()).toBe(true)
  await pill.unmount()

  // The answer stays on the ticket-less question's record.
  const result2 = await progress($, { ticker: 'Using EUR' })
  expect(result2).not.toContain('Open question')
  await ui.unmount()
})

test('clicking a ticket shows its timeline, questions, deliverables and activity', async ($, on) => {
  world(on)
  await $.session.start(START)
  await turnStart($, 't1')
  await progress($, {
    start: { title: 'Run' },
    tickets: [{ title: 'Write the mapper', estimate: 60, status: 'working', stage: 'code' }],
  })
  await progress($, {
    activity: { text: 'Mapped prices', ticket: 'T01' },
    deliverable: { title: 'Mapper', path: 'src/mapper.ts', ticket: 'T01' },
    ask: { title: 'Round up?', options: ['Yes', 'No'], ticket: 'T01' },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'ticket:T01' })

    expect(await ui.find({ type: 'Text', text: 'Timeline' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'stage: code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Q1 Round up? (T01)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/mapper.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Mapped prices' })).toBeDefined()
    expect(await ui.find({ key: 'tab:tickets' })).toBeUndefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'tab:tickets' })).toBeDefined()
    await ui.unmount()
  }
})

test('the open tab is remembered', async ($, on) => {
  world(on)
  await $.session.start(START)
  await progress($, { start: { title: 'Run' }, deliverable: 'https://example.com/report' })

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await first.find({ key: 'tab:deliverables' }))?.props.hotkey).toBe('2')
  await first.press({ key: 'tab:deliverables' })
  expect(await first.find({ type: 'Link' })).toBeDefined()
  await first.unmount()

  const second = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await second.find({ type: 'Link' }))?.props.href).toBe('https://example.com/report')
  await second.unmount()
})

test('the terminal draws the bar, divider and marks as text; the apps draw them as Svg', async ($, on) => {
  world(on)
  await $.session.start(START)
  await progress($, SAMPLE)

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  const cells = (await terminal.findAll({ type: 'Text', text: /^[█░]+$/ }))
    .map(one => one.text)
    .join('')
  // One line, as wide as the body: 30 + 60 + 30 minutes over 40 cells.
  expect(cells).toBe('█'.repeat(10) + '█'.repeat(10) + '░'.repeat(10) + '░'.repeat(10))
  expect((await terminal.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(40))
  await terminal.unmount()

  for (const surface of APPS) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await ui.findAll({ type: 'Svg' })
    const marks = all.filter(one => String(one.props.source).includes('class="mark '))
    const drawn = all.filter(one => !marks.includes(one))

    expect(drawn).toHaveLength(2)
    expect(marks.map(one => one.props.alt)).toEqual(['done', 'working', 'not started'])
    expect((await ui.find({ key: 'ticket:T01' }))?.text).toBe('T01 Parse the feed')
    expect(await ui.find({ type: 'Text', text: /^[✓●✗○–]$/ })).toBeUndefined()
    expect(String(drawn[0]?.props.source)).toContain('class="fill" data-ticket="T01"')
    expect(String(drawn[0]?.props.source)).toContain('class="bg" data-ticket="T03"')
    expect(drawn[0]?.props.alt).toBe('Progress bar: 50% done')
    expect(await ui.find({ type: 'Text', text: /[█░─]{3,}/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('/progress opens the pane and submits the right request', async ($, on) => {
  const w = world(on)
  await $.session.start(START)

  // Empty pane: a read-only survey of the branch's own commits.
  const first = await runCommand($, 'the importer only')
  expect(first.text).toContain('Progress pane opened')
  expect(w.opens).toHaveLength(1)
  // Submitted from a timer, not from inside the command's own hook.
  expect(w.prompts).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain(`Fill in the Progress pane with the ${TOOL} tool.`)
  expect(w.prompts[0]).toContain('read-only')
  expect(w.prompts[0]).toContain('git log <default>..HEAD')
  expect(w.prompts[0]).toContain('Merged MRs/PRs on the default branch are earlier work')
  expect(w.prompts[0]).toContain('Focus on: the importer only')

  // Past milestones keep their times.
  const at = NOON - 3 * 60 * MIN
  await progress($, {
    start: { title: 'Ship the importer', startedAt: new Date(at).toISOString() },
    tickets: [{ title: 'Parse the feed', estimate: 30, status: 'done' }],
    pastActivity: [{ text: 'Parser merged into the branch', at: new Date(at + 20 * MIN).toISOString() }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:activity' })
  expect(await ui.find({ type: 'Text', text: 'Parser merged into the branch' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: stamp(at + 20 * MIN, NOON) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3h elapsed' })).toBeDefined()
  await ui.press({ key: 'tab:tickets' })
  await ui.unmount()

  // A filled pane: compare it with what happened since.
  const second = await runCommand($)
  expect(second.text).toContain('bring it up to date')
  await w.clock.advance(1)
  expect(w.prompts).toHaveLength(2)
  expect(w.prompts[1]).toContain('Bring the Progress pane up to date')
  expect(w.prompts[1]).toContain('Compare the pane with what happened since')
  expect(w.prompts[1]).toContain('- T01 [done, 100%, est 30m] Parse the feed')
  expect(w.prompts[1]).not.toContain('Fill in the Progress pane')
})

test('a milestone that moves the run start is reported, and start.startedAt fixes the start', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const old = new Date(NOON - 3 * 24 * 60 * MIN).toISOString()

  await progress($, { start: { title: 'Run' } })
  const moved = await progress($, { pastActivity: [{ text: 'Old MR merged', at: old }] })
  expect(moved).toContain('the run start moved earlier')
  expect(moved).toContain(old)

  const fixed = await progress($, { start: { startedAt: new Date(NOON - 30 * MIN).toISOString() } })
  expect(fixed).toContain('fixed by start.startedAt')
  const kept = await progress($, { pastActivity: [{ text: 'Older MR merged', at: old }] })
  expect(kept).toContain('did not move it')

  await w.clock.advance(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '30m elapsed' })).toBeDefined()
  await ui.unmount()
})

test('elapsed time past a day says since when', async ($, on) => {
  const now = new Date(2026, 10, 10, 19, 0).getTime()
  world(on, { now })
  await $.session.start(START)
  await progress($, {
    start: { title: 'Long run', startedAt: new Date(2026, 10, 6, 9, 0).toISOString() },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '4d10h since 11/06' })).toBeDefined()
  await ui.unmount()
})

test('main-agent turns are the work spans: waiting for the person does not run down the clock', async ($, on) => {
  const w = world(on)
  await $.session.start(START)

  await turnStart($, 't1')
  await progress($, {
    start: { title: 'Run' },
    tickets: [{ title: 'Write the mapper', estimate: 10, status: 'working' }],
  })
  await w.clock.advance(4 * MIN)
  // A subagent's turn ends: the main turn is still open.
  await turnStart($, 'a1', 'agent-1')
  await turnEnd($, 'a1', 'agent-1')
  await w.clock.advance(1 * MIN)
  await turnEnd($, 't1')

  // Eight hours at the prompt with nobody there.
  await w.clock.advance(8 * 60 * MIN)
  const idle = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: 'possibly stale' })).toBeDefined()
  expect(await idle.find({ type: 'Text', text: /past estimate/ })).toBeUndefined()
  expect(await idle.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
  await idle.press({ key: 'ticket:T01' })
  expect(await idle.find({ type: 'Text', text: /worked 5m$/ })).toBeDefined()
  await idle.press({ key: 'back' })
  await idle.unmount()

  // Back at work: six more active minutes take it past the estimate.
  await turnStart($, 't2')
  await w.clock.advance(6 * MIN)
  const busy = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await busy.find({ type: 'Text', text: 'stuck' })).toBeDefined()
  expect(
    await busy.find({ type: 'Text', text: 'T01 is past its estimate: Write the mapper' }),
  ).toBeDefined()
  const pill = await $.ui.mount({ ...PILL, surface: 'terminal' })
  expect(await pill.find({ type: 'Text', text: 'Progress: 1 stuck' })).toBeDefined()
  await pill.unmount()

  // After finish: no stuck marks, no pill.
  await progress($, { finish: 'Done.' })
  expect(await busy.find({ type: 'Text', text: 'finished' })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
  await busy.unmount()
})

test('TaskCreate, TaskUpdate and TodoWrite calls become tickets', async ($, on) => {
  const w = world(on)
  await $.session.start(START)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Parse the feed', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the mapper', description: 'd' })
  expect(w.opens).toHaveLength(1)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Open the MR', status: 'pending', activeForm: 'Opening the MR' }],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'ticket:T01' }))?.text).toContain('✓ T01 Parse the feed')
  expect((await ui.find({ key: 'ticket:T02' }))?.text).toContain('● T02 Write the mapper')
  expect((await ui.find({ key: 'ticket:T03' }))?.text).toContain('○ T03 Open the MR')
  await ui.unmount()

  // The tool adds an estimate to a task's ticket by its title.
  const result = await $.tool.call({
    tool: TOOL,
    tickets: [{ title: 'Write the mapper', estimate: 45 }],
  })
  expect(String(result.result)).toContain('T02 "Write the mapper" working')
})

test('commits, pushes and MRs are logged on their own', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await progress($, { start: { title: 'Run' } })

  w.bash['git commit -m "Add mapper"'] = '[feat/importer 1a2b3c4] Add mapper\n 2 files changed'
  w.bash['git push -u origin feat/importer'] = ' * [new branch]      feat/importer -> feat/importer'
  w.bash['glab mr create --fill'] = 'https://gitlab.example.com/a/b/-/merge_requests/7'
  w.bash['ls'] = 'git commit'
  for (const command of Object.keys(w.bash)) await $.tool.call({ tool: 'Bash', command })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:activity' })
  expect(await ui.find({ type: 'Text', text: 'Commit: 1a2b3c4 Add mapper' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pushed feat/importer' })).toBeDefined()
  expect(
    await ui.find({
      type: 'Text',
      text: 'MR opened: https://gitlab.example.com/a/b/-/merge_requests/7',
    }),
  ).toBeDefined()
  expect((await ui.find({ key: 'tab:activity' }))?.text).toBe('Activity 3')
  await ui.press({ key: 'tab:tickets' })
  await ui.unmount()
})

test('the tool result names the wait setting the person chose', { options: { whileQuestionWaits: 'stop' } }, async ($, on) => {
  world(on)
  await $.session.start(START)

  const result = await progress($, { ask: { title: 'Which?', options: ['a', 'b'] } })
  expect(result).toContain('is stop: end your turn now')
})
