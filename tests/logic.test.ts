import { describe, expect, test } from 'claude-code/testing'

import {
  MINUTE,
  activeMs,
  applyInput,
  closeSpan,
  detectGitEvents,
  emptyProgress,
  isOverdue,
  isTurnOpen,
  needsYou,
  normalizeQuestionId,
  openQuestions,
  openSpan,
  openStuck,
  pace,
  parseAnswers,
  percentDone,
  remainingMs,
  restore,
  runStatus,
  segments,
  sessionsToPrune,
  svgBar,
  textBar,
  workedMs,
} from '../hooks/logic'
import type { Progress, ProgressInput } from '../hooks/logic'

const T0 = Date.UTC(2026, 10, 15, 3, 0, 0)
const DAY = 24 * 60 * MINUTE

const apply = (p: Progress, input: ProgressInput, now: number) =>
  applyInput(p, input, now, 'work_around')

const withTickets = (tickets: ProgressInput['tickets'], now = T0): Progress =>
  apply(emptyProgress(), { tickets }, now).progress

const count = (text: string, part: string): number => text.split(part).length - 1

describe('the bar', () => {
  test('segments fill the full width, weighted by estimate', () => {
    const p = withTickets([
      { title: 'a', estimate: 30 },
      { title: 'b', estimate: 60 },
      { title: 'c', estimate: 30 },
    ])

    expect(segments(p.tickets, 40).map(one => one.width)).toEqual([10, 20, 10])

    for (const width of [16, 37, 40, 113]) {
      const widths = segments(p.tickets, width).map(one => one.width)
      expect(widths.reduce((sum, one) => sum + one, 0)).toBe(width)
      expect(widths[1]).toBeGreaterThan(widths[0] ?? 0)

      const bar = textBar(p.tickets, width).map(part => part.text).join('')
      expect([...bar]).toHaveLength(width)
      expect(bar).not.toContain('\n')
    }
  })

  test('a small ticket keeps a cell, and a skipped one gets no segment', () => {
    const p = withTickets([
      { title: 'big', estimate: 600 },
      { title: 'tiny', estimate: 1 },
      { title: 'dropped', estimate: 600, status: 'skipped' },
    ])
    const parts = segments(p.tickets, 20)

    expect(parts.map(one => one.id)).toEqual(['T01', 'T02'])
    expect(parts.map(one => one.width)).toEqual([19, 1])
  })

  test('the text bar fills done work with █ and the rest with ░', () => {
    const p = withTickets([
      { title: 'a', estimate: 10, status: 'done' },
      { title: 'b', estimate: 10, status: 'working', progress: 50 },
      { title: 'c', estimate: 10 },
    ])

    expect(textBar(p.tickets, 30)).toEqual([
      { status: 'done', text: '█'.repeat(10) },
      { status: 'working', text: '█'.repeat(5) + '░'.repeat(5) },
      { status: 'not_started', text: '░'.repeat(10) },
    ])
  })

  test('the SVG bar draws a background for each segment not done, and a fill for done and started work', () => {
    const p = withTickets([
      { title: 'a', estimate: 10, status: 'done' },
      { title: 'b', estimate: 10, status: 'working', progress: 50 },
      { title: 'c', estimate: 10 },
      { title: 'd', estimate: 10, status: 'blocked' },
    ])
    const svg = svgBar(p.tickets, 400)

    expect(svg).toStartWith('<svg ')
    expect(count(svg, 'class="bg"')).toBe(3)
    expect(count(svg, 'class="fill"')).toBe(2)
    expect(svg).toContain('class="fill" data-ticket="T01"')
    expect(svg).toContain('class="fill" data-ticket="T02"')
    expect(svg).not.toContain('class="bg" data-ticket="T01"')
    // done = green, working = amber, blocked = red, not started = gray
    expect(svg).toMatch(/data-ticket="T01"[^>]*fill="#2da44e"/)
    expect(svg).toMatch(/data-ticket="T02"[^>]*fill="#d4a72c"/)
    expect(svg).toMatch(/data-ticket="T03"[^>]*fill="#8c959f"/)
    expect(svg).toMatch(/data-ticket="T04"[^>]*fill="#cf222e"/)
  })
})

describe('percent', () => {
  test('is estimated minutes done over total, with skipped tickets left out', () => {
    const p = withTickets([
      { title: 'a', estimate: 30, status: 'done' },
      { title: 'b', estimate: 90 },
      { title: 'c', estimate: 500, status: 'skipped' },
    ])

    expect(percentDone(p.tickets)).toBe(25)
  })
})

describe('active time', () => {
  test('spans open and close with turns', () => {
    let spans = openSpan([], T0)
    expect(isTurnOpen(spans)).toBe(true)

    spans = closeSpan(spans, T0 + 5 * MINUTE)
    expect(isTurnOpen(spans)).toBe(false)
    expect(spans).toEqual([{ start: T0, end: T0 + 5 * MINUTE }])

    spans = openSpan(spans, T0 + 60 * MINUTE)
    expect(spans).toHaveLength(2)
    expect(activeMs(spans, 0, T0 + 62 * MINUTE, T0 + 62 * MINUTE)).toBe(7 * MINUTE)
  })

  test('a working ticket past its estimate is stuck', () => {
    const p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    const q = apply(p, { tickets: [{ title: 'a', estimate: 10, status: 'working' }] }, T0)
      .progress
    const ticket = q.tickets[0]!

    expect(isOverdue(ticket, q, T0 + 9 * MINUTE)).toBe(false)
    expect(isOverdue(ticket, q, T0 + 11 * MINUTE)).toBe(true)
    expect(runStatus(q, T0 + 11 * MINUTE)).toBe('stuck')
    expect(needsYou(q, T0 + 11 * MINUTE)).toBe(true)
  })

  test('a ticket that waits for another ticket is not stuck', () => {
    const p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    const q = apply(
      p,
      {
        tickets: [
          { title: 'first', estimate: 60, status: 'working' },
          { title: 'second', estimate: 10, status: 'working', waitsFor: 'T01' },
        ],
      },
      T0,
    ).progress
    const second = q.tickets[1]!

    expect(second.waitsFor).toBe('T01')
    expect(isOverdue(second, q, T0 + 30 * MINUTE)).toBe(false)

    const freed = apply(q, { tickets: [{ id: 'T01', status: 'done' }] }, T0 + 31 * MINUTE)
      .progress
    expect(isOverdue(freed.tickets[1]!, freed, T0 + 32 * MINUTE)).toBe(true)
  })

  test('time between turns does not count: an idle working ticket is not overdue', () => {
    const p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    const q = apply(p, { tickets: [{ title: 'a', estimate: 10, status: 'working' }] }, T0)
      .progress
    q.spans = closeSpan(q.spans, T0 + 5 * MINUTE)

    const later = T0 + 8 * 60 * MINUTE
    expect(workedMs(q.tickets[0]!, q.spans, later)).toBe(5 * MINUTE)
    expect(isOverdue(q.tickets[0]!, q, later)).toBe(false)
    expect(runStatus(q, later)).toBe('stale')
  })

  test('pace and time left count active time only', () => {
    let p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    p = apply(
      p,
      {
        start: { title: 'run' },
        tickets: [
          { title: 'a', estimate: 30, status: 'working' },
          { title: 'b', estimate: 30 },
        ],
      },
      T0,
    ).progress
    // One hour of work, then five hours with nobody at the prompt.
    p.spans = closeSpan(p.spans, T0 + 60 * MINUTE)
    p = apply(p, { tickets: [{ id: 'T01', status: 'done' }] }, T0 + 60 * MINUTE).progress

    const now = T0 + 6 * 60 * MINUTE
    expect(pace(p, now)).toBe(2)
    expect(remainingMs(p, now)).toBe(60 * MINUTE)
  })

  test('data saved before spans existed counts wall time until the next turn starts', () => {
    const old = withTickets([{ title: 'a', estimate: 60, status: 'working' }])
    const saved = JSON.parse(JSON.stringify(old)) as Record<string, unknown>
    delete saved.spans

    const p = restore(saved)!
    expect(p.spans).toEqual([{ start: T0, isLegacy: true }])
    expect(isTurnOpen(p.spans)).toBe(false)
    expect(workedMs(p.tickets[0]!, p.spans, T0 + 20 * MINUTE)).toBe(20 * MINUTE)

    p.spans = openSpan(p.spans, T0 + 30 * MINUTE)
    p.spans = closeSpan(p.spans, T0 + 40 * MINUTE)
    expect(workedMs(p.tickets[0]!, p.spans, T0 + 5 * 60 * MINUTE)).toBe(40 * MINUTE)
  })

  test('a turn left open by a process that ended closes at the last update', () => {
    const p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    const q = apply(p, { tickets: [{ title: 'a' }] }, T0 + 3 * MINUTE).progress

    const back = restore(JSON.parse(JSON.stringify(q)))!
    expect(back.spans).toEqual([{ start: T0, end: T0 + 3 * MINUTE }])
  })
})

describe('questions and stuck marks', () => {
  test('answers parse from the prompt', () => {
    expect(parseAnswers('Q1: A — use the cache')).toEqual([
      { id: 'Q1', answer: 'A — use the cache' },
    ])
    expect(parseAnswers('ok\nQ-2: b\n- q 3：C\nnot Q4 here')).toEqual([
      { id: 'Q2', answer: 'b' },
      { id: 'Q3', answer: 'C' },
    ])
    expect(parseAnswers('The Q1 results look fine')).toEqual([])
    expect(normalizeQuestionId('Q-1')).toBe('Q1')
    expect(normalizeQuestionId('q_01')).toBe('Q1')
  })

  test('a tool answer with id "Q-1" answers Q1, and the pane stops asking', () => {
    const asked = apply(
      emptyProgress(),
      {
        start: { title: 'run' },
        ask: { title: 'Cache?', question: 'Which cache?', options: ['Redis', 'None'], recommend: 'A' },
      },
      T0,
    )
    expect(asked.lines.join('\n')).toContain('Question Q1')
    expect(openQuestions(asked.progress)).toHaveLength(1)

    const answered = apply(asked.progress, { answer: { id: 'Q-1', answer: 'A' } }, T0 + 1)
    expect(openQuestions(answered.progress)).toHaveLength(0)
    expect(answered.progress.questions[0]?.answer).toBe('A — Redis')
    expect(needsYou(answered.progress, T0 + 1)).toBe(false)
  })

  test('ids are given out and returned in the result', () => {
    const applied = apply(
      emptyProgress(),
      {
        tickets: [{ title: 'one' }, { title: 'two' }],
        ask: { title: 'q', options: ['x', 'y'] },
        stuck: 'no access',
      },
      T0,
    )
    const text = applied.lines.join('\n')

    expect(text).toContain('T01 (new) "one"')
    expect(text).toContain('T02 (new) "two"')
    expect(text).toContain('Q1')
    expect(text).toContain('S1')
  })

  test('the result tells Claude which wait setting applies', () => {
    const input: ProgressInput = { ask: { title: 'q', options: ['x', 'y'] } }

    expect(applyInput(emptyProgress(), input, T0, 'stop').lines.join('\n')).toContain('is stop:')
    expect(applyInput(emptyProgress(), input, T0, 'work_around').lines.join('\n')).toContain(
      'is work_around:',
    )
    expect(applyInput(emptyProgress(), input, T0, 'keep_building').lines.join('\n')).toContain(
      'is keep_building:',
    )
  })

  test('after finish there are no open questions and no stuck marks', () => {
    const p = emptyProgress()
    p.spans = openSpan(p.spans, T0)
    const busy = apply(
      p,
      {
        start: { title: 'run' },
        tickets: [{ title: 'a', estimate: 1, status: 'working' }],
        ask: { title: 'q', options: ['x', 'y'] },
        stuck: 'no access',
      },
      T0,
    ).progress
    const late = T0 + 30 * MINUTE
    expect(runStatus(busy, late)).toBe('stuck')

    const done = apply(busy, { finish: true }, late).progress
    expect(runStatus(done, late)).toBe('finished')
    expect(openQuestions(done)).toHaveLength(0)
    expect(openStuck(done)).toHaveLength(0)
    expect(needsYou(done, late + DAY)).toBe(false)
  })

  test('possibly stale: open tickets, no turn, no update for 15 minutes', () => {
    const p = withTickets([{ title: 'a', estimate: 60 }])

    expect(runStatus(p, T0 + 14 * MINUTE)).toBe('idle')
    expect(runStatus(p, T0 + 15 * MINUTE)).toBe('stale')

    p.spans = openSpan(p.spans, T0 + 20 * MINUTE)
    expect(runStatus(p, T0 + 50 * MINUTE)).toBe('working')
  })
})

describe('the run start', () => {
  test('a milestone that moves the run start is reported', () => {
    const started = apply(emptyProgress(), { start: { title: 'run' } }, T0).progress
    const old = new Date(T0 - 3 * DAY).toISOString()
    const moved = apply(started, { pastActivity: [{ text: 'first commit', at: old }] }, T0)

    expect(moved.progress.run?.startedAt).toBe(T0 - 3 * DAY)
    expect(moved.lines.join('\n')).toContain('the run start moved earlier')
    expect(moved.lines.join('\n')).toContain(old)
    expect(moved.progress.activity[0]).toMatchObject({ at: T0 - 3 * DAY, text: 'first commit' })
  })

  test('start.startedAt fixes the start: pastActivity cannot change it', () => {
    const at = new Date(T0 - 60 * MINUTE).toISOString()
    const old = new Date(T0 - 3 * DAY).toISOString()
    const applied = apply(
      emptyProgress(),
      { start: { title: 'run', startedAt: at }, pastActivity: [{ text: 'older work', at: old }] },
      T0,
    )

    expect(applied.progress.run?.startedAt).toBe(T0 - 60 * MINUTE)
    expect(applied.lines.join('\n')).toContain('did not move it')
    expect(applied.lines.join('\n')).not.toContain('moved earlier')

    const again = apply(applied.progress, { pastActivity: [{ text: 'older', at: old }] }, T0)
    expect(again.progress.run?.startedAt).toBe(T0 - 60 * MINUTE)

    const fixed = apply(
      apply(emptyProgress(), { start: { title: 'run' } }, T0).progress,
      { pastActivity: [{ text: 'older', at: old }] },
      T0,
    ).progress
    const corrected = apply(fixed, { start: { startedAt: at } }, T0).progress
    expect(corrected.run?.startedAt).toBe(T0 - 60 * MINUTE)
    expect(corrected.run?.isStartPinned).toBe(true)
  })
})

describe('git and saved sessions', () => {
  test('commits, pushes and new MRs/PRs are read from Bash commands', () => {
    expect(
      detectGitEvents('git commit -m "Add bar"', '[main 1a2b3c4] Add bar\n 1 file changed'),
    ).toEqual([{ kind: 'commit', text: '1a2b3c4 Add bar' }])
    expect(
      detectGitEvents('git add . && git -C repo commit -qm x', '[feat/x 9f8e7d6a] x'),
    ).toEqual([{ kind: 'commit', text: '9f8e7d6 x' }])
    expect(
      detectGitEvents('git push -u origin feat/x', ' * [new branch]      feat/x -> feat/x'),
    ).toEqual([{ kind: 'push', text: 'feat/x' }])
    expect(detectGitEvents('git push', 'Everything up-to-date')).toEqual([])
    expect(
      detectGitEvents('glab mr create --fill', 'https://gitlab.com/a/b/-/merge_requests/7\n'),
    ).toEqual([
      {
        kind: 'mr',
        text: 'https://gitlab.com/a/b/-/merge_requests/7',
        url: 'https://gitlab.com/a/b/-/merge_requests/7',
      },
    ])
    expect(
      detectGitEvents('gh pr create --fill', 'https://github.com/a/b/pull/3')[0]?.kind,
    ).toBe('pr')
    expect(detectGitEvents('git status', 'nothing to commit')).toEqual([])
    expect(detectGitEvents('echo git commit', '')).toEqual([])
  })

  test('the 20 newest sessions of the last 30 days are kept', () => {
    const index: Record<string, number> = { ancient: T0 - 31 * DAY }
    for (let n = 0; n < 25; n += 1) index[`s${n}`] = T0 - n * MINUTE

    const pruned = sessionsToPrune(index, T0)
    expect(pruned).toContain('ancient')
    expect(pruned).toHaveLength(6)
    expect(pruned).toContain('s24')
    expect(pruned).not.toContain('s19')
  })
})
