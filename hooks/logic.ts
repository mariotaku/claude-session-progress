// Pure logic of the Progress pane: the data model, the tool's updates, the
// time math and the bar geometry. No `$`, no JSX, no translated text.

export type TicketStatus =
  | 'not_started'
  | 'working'
  | 'blocked'
  | 'done'
  | 'skipped'

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'not_started',
  'working',
  'blocked',
  'done',
  'skipped',
]

export type TimelineKind = 'created' | 'status' | 'stage'

export type TimelineEntry = {
  at: number
  kind: TimelineKind
  /** A status for `created` and `status`, the stage's name for `stage`. */
  value: string
}

export type Ticket = {
  id: string
  title: string
  /** Minutes. */
  estimate: number
  status: TicketStatus
  stage?: string
  /** 0-100. */
  progress: number
  /** A ticket id, or free text. */
  waitsFor?: string
  /** Where the ticket came from: `task:<id>`, `todo`, or what Claude gave. */
  source?: string
  createdAt: number
  updatedAt: number
  /** Active milliseconds of the closed `working` periods. */
  workedMs: number
  /** Start of the open `working` period. */
  workingSince?: number
  doneAt?: number
  timeline: TimelineEntry[]
}

export type Question = {
  id: string
  title: string
  question: string
  options: string[]
  /** The recommended option's letter (`A`), or free text. */
  recommend?: string
  ticket?: string
  askedAt: number
  answer?: string
  answeredAt?: number
}

export type StuckMark = {
  id: string
  text: string
  ticket?: string
  at: number
  resolvedAt?: number
}

export type ActivityKind = 'note' | 'past' | 'commit' | 'push' | 'mr' | 'pr'

export type Activity = {
  at: number
  kind: ActivityKind
  text: string
  ticket?: string
}

export type Deliverable = {
  title: string
  path?: string
  url?: string
  ticket?: string
  at: number
}

/** One main-agent turn, `turn.start` to `turn.complete`. */
export type Span = {
  start: number
  end?: number
  /**
   * Stands for the wall time of data saved before spans existed. It stays
   * open until the next turn starts.
   */
  isLegacy?: true
}

export type Run = {
  title: string
  doneWhen?: string
  startedAt: number
  /** True once `start.startedAt` set the start: `pastActivity` leaves it. */
  isStartPinned: boolean
  finishedAt?: number
  summary?: string
}

export type Progress = {
  run?: Run
  tickets: Ticket[]
  questions: Question[]
  stuck: StuckMark[]
  activity: Activity[]
  deliverables: Deliverable[]
  ticker?: string
  spans: Span[]
  updatedAt: number
  nextTicket: number
  nextQuestion: number
  nextStuck: number
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const STALE_AFTER_MS = 15 * MINUTE
export const DEFAULT_ESTIMATE = 15
export const MAX_ACTIVITY = 300
export const MAX_SPANS = 2000

export function emptyProgress(): Progress {
  return {
    tickets: [],
    questions: [],
    stuck: [],
    activity: [],
    deliverables: [],
    spans: [],
    updatedAt: 0,
    nextTicket: 1,
    nextQuestion: 1,
    nextStuck: 1,
  }
}

export function isEmpty(p: Progress): boolean {
  return p.run === undefined && p.tickets.length === 0
}

// ---------------------------------------------------------------------------
// Spans: active time
// ---------------------------------------------------------------------------

/** Opens a span at `now`. A span still open (a legacy one, or a turn that never completed) closes first. */
export function openSpan(spans: Span[], now: number): Span[] {
  const closed = closeSpan(spans, now)

  return [...closed, { start: now }].slice(-MAX_SPANS)
}

export function closeSpan(spans: Span[], now: number): Span[] {
  return spans.map(span =>
    span.end === undefined ? { ...span, end: Math.max(span.start, now) } : span,
  )
}

/** True while a main-agent turn runs. A legacy span is not a turn. */
export function isTurnOpen(spans: readonly Span[]): boolean {
  return spans.some(span => span.end === undefined && span.isLegacy !== true)
}

/** Active milliseconds between `from` and `to`. An open span runs to `now`. */
export function activeMs(
  spans: readonly Span[],
  from: number,
  to: number,
  now: number,
): number {
  let total = 0

  for (const span of spans) {
    const start = Math.max(span.start, from)
    const end = Math.min(span.end ?? now, to)

    if (end > start) total += end - start
  }

  return total
}

// ---------------------------------------------------------------------------
// Tickets: percent, worked time, stuck, pace
// ---------------------------------------------------------------------------

const weightOf = (ticket: Ticket): number => Math.max(0, ticket.estimate)

/** The share of a ticket that is done, 0 to 1. */
export function doneShare(ticket: Ticket): number {
  if (ticket.status === 'done') return 1
  if (ticket.status === 'not_started') return 0

  return clamp(ticket.progress, 0, 100) / 100
}

export function counted(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter(ticket => ticket.status !== 'skipped')
}

export function totalMinutes(tickets: readonly Ticket[]): number {
  return counted(tickets).reduce((sum, ticket) => sum + weightOf(ticket), 0)
}

/** Estimated minutes done. A started ticket counts by its progress. */
export function doneMinutes(tickets: readonly Ticket[]): number {
  return counted(tickets).reduce(
    (sum, ticket) => sum + weightOf(ticket) * doneShare(ticket),
    0,
  )
}

/** Estimated minutes done ÷ total estimated minutes, 0-100. Skipped tickets are left out. */
export function percentDone(tickets: readonly Ticket[]): number {
  const total = totalMinutes(tickets)

  if (total === 0) {
    const all = counted(tickets)
    if (all.length === 0) return 0

    return Math.round(
      (all.filter(ticket => ticket.status === 'done').length / all.length) * 100,
    )
  }

  return Math.round((doneMinutes(tickets) / total) * 100)
}

/** Active milliseconds a ticket spent in `working`. */
export function workedMs(
  ticket: Ticket,
  spans: readonly Span[],
  now: number,
): number {
  const open =
    ticket.workingSince === undefined
      ? 0
      : activeMs(spans, ticket.workingSince, now, now)

  return ticket.workedMs + open
}

/** True while the ticket waits for another ticket that is still open, or for something that is no ticket. */
export function isWaiting(ticket: Ticket, tickets: readonly Ticket[]): boolean {
  if (ticket.waitsFor === undefined || ticket.waitsFor === '') return false

  const other = findTicket(tickets, ticket.waitsFor)
  if (other === undefined) return true

  return other.status !== 'done' && other.status !== 'skipped'
}

/** A working ticket past its estimate in active time. A waiting ticket is not overdue. */
export function isOverdue(
  ticket: Ticket,
  p: Pick<Progress, 'tickets' | 'spans'>,
  now: number,
): boolean {
  if (ticket.status !== 'working' || ticket.estimate <= 0) return false
  if (isWaiting(ticket, p.tickets)) return false

  return workedMs(ticket, p.spans, now) > ticket.estimate * MINUTE
}

/** Active milliseconds of the run so far. */
export function runActiveMs(p: Progress, now: number): number {
  const from = p.run?.startedAt ?? 0
  const to = p.run?.finishedAt ?? now

  return activeMs(p.spans, from, to, now)
}

/**
 * Active milliseconds spent for each estimated millisecond done. 1 before
 * anything is done; held between 0.2 and 5.
 */
export function pace(p: Progress, now: number): number {
  const done = doneMinutes(p.tickets) * MINUTE
  const active = runActiveMs(p, now)

  if (done <= 0 || active <= 0) return 1

  return clamp(active / done, 0.2, 5)
}

/** Active milliseconds left, or undefined with no estimate to go by. */
export function remainingMs(p: Progress, now: number): number | undefined {
  const total = totalMinutes(p.tickets)
  if (total === 0 || p.run?.finishedAt !== undefined) return undefined

  const left = Math.max(0, total - doneMinutes(p.tickets)) * MINUTE

  return Math.round(left * pace(p, now))
}

export function elapsedMs(p: Progress, now: number): number {
  if (p.run === undefined) return 0

  return Math.max(0, (p.run.finishedAt ?? now) - p.run.startedAt)
}

// ---------------------------------------------------------------------------
// The run's status and what needs the person
// ---------------------------------------------------------------------------

export type RunStatus = 'finished' | 'stuck' | 'working' | 'stale' | 'idle'

export function isFinished(p: Progress): boolean {
  return p.run?.finishedAt !== undefined
}

/** Questions with no answer. None after `finish`. */
export function openQuestions(p: Progress): Question[] {
  if (isFinished(p)) return []

  return p.questions.filter(question => question.answer === undefined)
}

/** Stuck marks not yet resolved. None after `finish`. */
export function openStuck(p: Progress): StuckMark[] {
  if (isFinished(p)) return []

  return p.stuck.filter(mark => mark.resolvedAt === undefined)
}

/** Tickets past their estimate. None after `finish`. */
export function overdueTickets(p: Progress, now: number): Ticket[] {
  if (isFinished(p)) return []

  return p.tickets.filter(ticket => isOverdue(ticket, p, now))
}

export function hasOpenTickets(p: Progress): boolean {
  return p.tickets.some(
    ticket => ticket.status !== 'done' && ticket.status !== 'skipped',
  )
}

/** The last update or the end of the last turn, whichever is later. */
export function lastSeenAt(p: Progress): number {
  return p.spans.reduce(
    (latest, span) => Math.max(latest, span.end ?? 0),
    p.updatedAt,
  )
}

/** Open tickets, no turn running, and nothing heard for 15 minutes. */
export function isStale(p: Progress, now: number): boolean {
  return (
    !isFinished(p) &&
    hasOpenTickets(p) &&
    !isTurnOpen(p.spans) &&
    now - lastSeenAt(p) >= STALE_AFTER_MS
  )
}

export function runStatus(p: Progress, now: number): RunStatus {
  if (isFinished(p)) return 'finished'
  if (openStuck(p).length > 0 || overdueTickets(p, now).length > 0) {
    return 'stuck'
  }
  if (isTurnOpen(p.spans)) return 'working'
  if (isStale(p, now)) return 'stale'

  return 'idle'
}

export function needsYou(p: Progress, now: number): boolean {
  return (
    openQuestions(p).length > 0 ||
    openStuck(p).length > 0 ||
    overdueTickets(p, now).length > 0
  )
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** `T1`, `t-01`, `T01` → `T01`. */
export function normalizeTicketId(raw: string): string | undefined {
  const found = /^\s*t[-_\s]*0*(\d+)\s*$/i.exec(raw)

  return found?.[1] === undefined ? undefined : ticketId(Number(found[1]))
}

/** `Q-1`, `q 01`, `Q1` → `Q1`. */
export function normalizeQuestionId(raw: string): string | undefined {
  const found = /^\s*q[-_\s]*0*(\d+)\s*$/i.exec(raw)

  return found?.[1] === undefined ? undefined : `Q${Number(found[1])}`
}

export function normalizeStuckId(raw: string): string | undefined {
  const found = /^\s*s[-_\s]*0*(\d+)\s*$/i.exec(raw)

  return found?.[1] === undefined ? undefined : `S${Number(found[1])}`
}

const ticketId = (n: number): string => `T${String(n).padStart(2, '0')}`

export function findTicket(
  tickets: readonly Ticket[],
  ref: string,
): Ticket | undefined {
  const id = normalizeTicketId(ref)
  if (id !== undefined) {
    const byId = tickets.find(ticket => ticket.id === id)
    if (byId !== undefined) return byId
  }

  const title = ref.trim().toLowerCase()

  return tickets.find(ticket => ticket.title.trim().toLowerCase() === title)
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type ParsedAnswer = { id: string; answer: string }

/**
 * Reads `Q1: A — text` lines out of a prompt. `Q-1`, `q1` and a full-width
 * colon are read the same way.
 */
export function parseAnswers(text: string): ParsedAnswer[] {
  const found: ParsedAnswer[] = []
  const line = /^\s*(?:[-*>]\s*)?(q[-_ ]?\d+)\s*[:：=]\s*(.+?)\s*$/gim

  for (const match of text.matchAll(line)) {
    const id = normalizeQuestionId(match[1] ?? '')
    const answer = match[2] ?? ''

    if (id !== undefined && answer !== '') found.push({ id, answer })
  }

  return found
}

/** The option letter an answer starts with (`A — yes`, `b`, `C.`), or undefined. */
export function answerLetter(answer: string): string | undefined {
  const found = /^\s*([A-Za-z])(?:\s*$|\s*[—–\-.):]|\s+—)/.exec(answer)

  return found?.[1]?.toUpperCase()
}

export const letterOf = (index: number): string =>
  String.fromCharCode('A'.charCodeAt(0) + index)

/** `Q1: A — <option>`: what a picked option puts into the prompt. */
export function answerLine(question: Question, index: number): string {
  return `${question.id}: ${letterOf(index)} — ${question.options[index] ?? ''}`
}

/** Records an answer on an open question. Returns the question, or undefined when none is open under the id. */
export function recordAnswer(
  p: Progress,
  rawId: string,
  answer: string,
  now: number,
): Question | undefined {
  const id = normalizeQuestionId(rawId)
  const question = p.questions.find(one => one.id === id)

  if (question === undefined || question.answer !== undefined) return undefined

  const letter = answerLetter(answer)
  const index = letter === undefined ? -1 : letter.charCodeAt(0) - 65
  const option = question.options[index]
  const isBare = answer.trim().length === 1

  question.answer =
    isBare && letter !== undefined && option !== undefined
      ? `${letter} — ${option}`
      : answer.trim()
  question.answeredAt = now
  p.updatedAt = now

  return question
}

// ---------------------------------------------------------------------------
// The tool's update
// ---------------------------------------------------------------------------

export type TicketInput = {
  id?: string
  title?: string
  estimate?: number
  status?: string
  stage?: string
  progress?: number
  waitsFor?: string
  source?: string
}

export type ProgressInput = {
  start?: { title?: string; doneWhen?: string; startedAt?: string | number }
  tickets?: TicketInput[]
  ticker?: string
  activity?: string | { text?: string; ticket?: string }
  deliverable?:
    | string
    | { title?: string; path?: string; url?: string; ticket?: string }
  stuck?: string | { text?: string; ticket?: string }
  unstuck?: string | boolean
  ask?: {
    title?: string
    question?: string
    options?: string[]
    recommend?: string
    ticket?: string
  }
  answer?: { id?: string; answer?: string }
  pastActivity?: { text?: string; at?: string | number }[]
  finish?: boolean | string
  clear?: boolean
}

export type WaitPolicy = 'stop' | 'work_around' | 'keep_building'

export function waitPolicy(value: unknown): WaitPolicy {
  return value === 'stop' || value === 'keep_building' ? value : 'work_around'
}

const POLICY_TEXT: Record<WaitPolicy, string> = {
  stop: 'stop: end your turn now and wait for the answer. Do not start other work.',
  work_around:
    'work_around: keep working on tickets that do not depend on the answer. Do not guess the answer, and stop when only dependent work is left.',
  keep_building:
    'keep_building: go on with your recommended option, mark the work as provisional, and be ready to redo it when the answer comes.',
}

export type Applied = {
  progress: Progress
  /** English: Claude reads it as the tool's result. */
  lines: string[]
  wasCleared: boolean
}

/** A time Claude gave: epoch milliseconds, epoch seconds, or a date string. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && asNumber > 0) return parseTime(asNumber)

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }

  return undefined
}

const iso = (ms: number): string => new Date(ms).toISOString()

function toStatus(value: unknown): TicketStatus | undefined {
  if (typeof value !== 'string') return undefined

  const word = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const alias: Record<string, TicketStatus> = {
    pending: 'not_started',
    todo: 'not_started',
    in_progress: 'working',
    started: 'working',
    completed: 'done',
    complete: 'done',
    deleted: 'skipped',
    cancelled: 'skipped',
    canceled: 'skipped',
  }

  return TICKET_STATUSES.find(status => status === word) ?? alias[word]
}

function setStatus(
  ticket: Ticket,
  status: TicketStatus,
  spans: readonly Span[],
  now: number,
): void {
  if (ticket.status === status) return

  if (ticket.status === 'working' && ticket.workingSince !== undefined) {
    ticket.workedMs += activeMs(spans, ticket.workingSince, now, now)
    ticket.workingSince = undefined
  }
  if (status === 'working') ticket.workingSince = now
  if (status === 'done') {
    ticket.doneAt = now
    ticket.progress = 100
  } else {
    ticket.doneAt = undefined
  }

  ticket.status = status
  ticket.timeline.push({ at: now, kind: 'status', value: status })
}

/**
 * Creates or updates one ticket. A ticket is found by id, then by `source`,
 * then by title. Returns the ticket and whether it is new.
 */
export function upsertTicket(
  p: Progress,
  input: TicketInput,
  now: number,
): { ticket: Ticket; isNew: boolean } | undefined {
  const byId =
    input.id === undefined ? undefined : findTicket(p.tickets, input.id)
  const bySource =
    input.source === undefined
      ? undefined
      : p.tickets.find(ticket => ticket.source === input.source)
  const byTitle =
    input.title === undefined ? undefined : findTicket(p.tickets, input.title)
  let ticket = byId ?? bySource ?? byTitle
  const isNew = ticket === undefined

  if (ticket === undefined) {
    const title = input.title?.trim()
    if (title === undefined || title === '') return undefined

    ticket = {
      id: ticketId(p.nextTicket),
      title,
      estimate: DEFAULT_ESTIMATE,
      status: 'not_started',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      workedMs: 0,
      timeline: [{ at: now, kind: 'created', value: 'not_started' }],
    }
    p.nextTicket += 1
    p.tickets.push(ticket)
  }

  if (input.title !== undefined && input.title.trim() !== '') {
    ticket.title = input.title.trim()
  }
  if (typeof input.estimate === 'number' && input.estimate >= 0) {
    ticket.estimate = input.estimate
  }
  if (input.source !== undefined) ticket.source = input.source
  if (input.waitsFor !== undefined) {
    const other = findTicket(p.tickets, input.waitsFor)
    const text = other?.id ?? input.waitsFor.trim()
    ticket.waitsFor = text === '' ? undefined : text
  }
  if (input.stage !== undefined && input.stage !== ticket.stage) {
    ticket.stage = input.stage === '' ? undefined : input.stage
    if (ticket.stage !== undefined) {
      ticket.timeline.push({ at: now, kind: 'stage', value: ticket.stage })
    }
  }
  if (typeof input.progress === 'number') {
    ticket.progress = clamp(Math.round(input.progress), 0, 100)
  }

  const status = toStatus(input.status)
  if (status !== undefined) setStatus(ticket, status, p.spans, now)

  ticket.timeline = ticket.timeline.slice(-50)
  ticket.updatedAt = now
  p.updatedAt = now

  return { ticket, isNew }
}

export function addActivity(p: Progress, entry: Activity): void {
  p.activity.push(entry)
  p.activity.sort((a, b) => a.at - b.at)
  p.activity = p.activity.slice(-MAX_ACTIVITY)
}

function ticketRef(p: Progress, ref: string | undefined): string | undefined {
  return ref === undefined ? undefined : findTicket(p.tickets, ref)?.id
}

/** Applies one `progress` tool call. The input is not trusted to fit its schema. */
export function applyInput(
  before: Progress,
  input: ProgressInput,
  now: number,
  policy: WaitPolicy,
): Applied {
  if (input.clear === true) {
    return {
      progress: emptyProgress(),
      lines: ['Cleared. The pane is empty.'],
      wasCleared: true,
    }
  }

  const p: Progress = JSON.parse(JSON.stringify(before)) as Progress
  const lines: string[] = []

  if (input.start !== undefined) {
    const startedAt = parseTime(input.start.startedAt)
    const isRestart = p.run === undefined || p.run.finishedAt !== undefined

    if (p.run === undefined || isRestart) {
      p.run = {
        title: input.start.title?.trim() || p.run?.title || 'Untitled run',
        doneWhen: input.start.doneWhen ?? p.run?.doneWhen,
        startedAt: startedAt ?? now,
        isStartPinned: startedAt !== undefined,
      }
    } else {
      if (input.start.title?.trim()) p.run.title = input.start.title.trim()
      if (input.start.doneWhen !== undefined) {
        p.run.doneWhen = input.start.doneWhen
      }
      if (startedAt !== undefined) {
        p.run.startedAt = startedAt
        p.run.isStartPinned = true
      }
    }
    if (input.start.startedAt !== undefined && startedAt === undefined) {
      lines.push(
        `start.startedAt "${String(input.start.startedAt)}" is no time I can read. Send ISO 8601.`,
      )
    }
    lines.push(
      `Run "${p.run.title}" starts at ${iso(p.run.startedAt)}${p.run.isStartPinned ? ' (fixed by start.startedAt)' : ''}.`,
    )
  }

  if (Array.isArray(input.tickets)) {
    const done: string[] = []
    for (const one of input.tickets) {
      const result = upsertTicket(p, one ?? {}, now)
      if (result === undefined) {
        lines.push(
          `A ticket with no id I know and no title was ignored: ${JSON.stringify(one)}`,
        )
        continue
      }
      const { ticket, isNew } = result
      done.push(
        `${ticket.id}${isNew ? ' (new)' : ''} "${ticket.title}" ${ticket.status}`,
      )
    }
    if (done.length > 0) lines.push(`Tickets: ${done.join('; ')}.`)
  }

  if (typeof input.ticker === 'string') {
    p.ticker = input.ticker.trim() === '' ? undefined : input.ticker.trim()
  }

  if (input.activity !== undefined) {
    const entry =
      typeof input.activity === 'string'
        ? { text: input.activity }
        : input.activity
    if (entry.text !== undefined && entry.text.trim() !== '') {
      addActivity(p, {
        at: now,
        kind: 'note',
        text: entry.text.trim(),
        ticket: ticketRef(p, entry.ticket),
      })
    }
  }

  if (input.deliverable !== undefined) {
    const given =
      typeof input.deliverable === 'string'
        ? /^https?:\/\//.test(input.deliverable)
          ? { url: input.deliverable }
          : { path: input.deliverable }
        : input.deliverable
    const title = given.title ?? given.path ?? given.url
    if (title !== undefined && title !== '') {
      addDeliverable(p, {
        title,
        path: given.path,
        url: given.url,
        ticket: ticketRef(p, given.ticket),
        at: now,
      })
      lines.push(`Deliverable "${title}" listed.`)
    }
  }

  if (input.stuck !== undefined) {
    const given = typeof input.stuck === 'string' ? { text: input.stuck } : input.stuck
    if (given.text !== undefined && given.text.trim() !== '') {
      const id = `S${p.nextStuck}`
      p.nextStuck += 1
      p.stuck.push({
        id,
        text: given.text.trim(),
        ticket: ticketRef(p, given.ticket),
        at: now,
      })
      lines.push(`Stuck mark ${id} is shown to the user under "Needs you".`)
    }
  }

  if (input.unstuck !== undefined && input.unstuck !== false) {
    const id =
      typeof input.unstuck === 'string'
        ? normalizeStuckId(input.unstuck)
        : undefined
    const cleared: string[] = []
    for (const mark of p.stuck) {
      if (mark.resolvedAt !== undefined) continue
      if (id !== undefined && mark.id !== id) continue
      mark.resolvedAt = now
      cleared.push(mark.id)
    }
    lines.push(
      cleared.length > 0
        ? `Unstuck: ${cleared.join(', ')}.`
        : 'No open stuck mark matched unstuck.',
    )
  }

  if (input.ask !== undefined) {
    const question = input.ask.question?.trim() ?? ''
    const title = input.ask.title?.trim() || question
    if (title !== '') {
      const id = `Q${p.nextQuestion}`
      p.nextQuestion += 1
      p.questions.push({
        id,
        title,
        question,
        options: (input.ask.options ?? []).filter(
          option => typeof option === 'string' && option.trim() !== '',
        ),
        recommend: input.ask.recommend,
        ticket: ticketRef(p, input.ask.ticket),
        askedAt: now,
      })
      lines.push(
        `Question ${id} is shown to the user. Their answer arrives in a prompt as "${id}: <letter> — <option>". Record it with answer {id: "${id}", answer}.`,
      )
    }
  }

  if (input.answer !== undefined) {
    const answered = recordAnswer(
      p,
      input.answer.id ?? '',
      input.answer.answer ?? '',
      now,
    )
    lines.push(
      answered === undefined
        ? `No open question matches "${input.answer.id ?? ''}".`
        : `${answered.id} answered: ${answered.answer ?? ''}.`,
    )
  }

  if (Array.isArray(input.pastActivity)) {
    let earliest: number | undefined
    let kept = 0
    for (const one of input.pastActivity) {
      const at = parseTime(one?.at)
      const text = one?.text?.trim() ?? ''
      if (at === undefined || text === '') {
        lines.push(`A pastActivity entry was ignored: ${JSON.stringify(one)}`)
        continue
      }
      addActivity(p, { at, kind: 'past', text })
      kept += 1
      earliest = earliest === undefined ? at : Math.min(earliest, at)
    }
    if (kept > 0) lines.push(`${kept} past milestone(s) logged at their own times.`)

    if (p.run !== undefined && earliest !== undefined && earliest < p.run.startedAt) {
      if (p.run.isStartPinned) {
        lines.push(
          `The run start stays at ${iso(p.run.startedAt)} (fixed by start.startedAt). A milestone at ${iso(earliest)} is older and did not move it.`,
        )
      } else {
        lines.push(
          `NOTE: the run start moved earlier, from ${iso(p.run.startedAt)} to ${iso(earliest)}, because a past milestone is older. If that milestone is earlier work and not part of this run, send start {startedAt} with the right time. That fixes the start.`,
        )
        p.run.startedAt = earliest
      }
    }
  }

  if (input.finish !== undefined && input.finish !== false) {
    if (p.run === undefined) {
      p.run = { title: 'Untitled run', startedAt: now, isStartPinned: false }
    }
    p.run.finishedAt = now
    if (typeof input.finish === 'string' && input.finish.trim() !== '') {
      p.run.summary = input.finish.trim()
    }
    p.ticker = undefined
    lines.push('Run finished. Open questions and stuck marks are no longer shown.')
  }

  p.updatedAt = now

  const open = openQuestions(p)
  if (open.length > 0) {
    lines.push(
      `Open question(s): ${open.map(question => question.id).join(', ')}. The user's setting "While a question waits" is ${POLICY_TEXT[policy]}`,
    )
  }

  const late = overdueTickets(p, now)
  if (late.length > 0) {
    lines.push(
      `Past estimate: ${late.map(ticket => ticket.id).join(', ')}. Raise the estimate, or report with stuck what blocks it.`,
    )
  }

  if (lines.length === 0) lines.push('Recorded.')

  return { progress: p, lines, wasCleared: false }
}

export function addDeliverable(p: Progress, entry: Deliverable): void {
  const key = entry.url ?? entry.path ?? entry.title
  const isListed = p.deliverables.some(
    one => (one.url ?? one.path ?? one.title) === key,
  )

  if (!isListed) p.deliverables.push(entry)
  p.deliverables = p.deliverables.slice(-100)
}

// ---------------------------------------------------------------------------
// Task tools → tickets
// ---------------------------------------------------------------------------

export function applyTaskCreate(
  p: Progress,
  task: { id?: string; subject?: string },
  now: number,
): Ticket | undefined {
  if (task.subject === undefined || task.subject.trim() === '') return undefined

  return upsertTicket(
    p,
    {
      title: task.subject,
      source: task.id === undefined ? undefined : `task:${task.id}`,
    },
    now,
  )?.ticket
}

export function applyTaskUpdate(
  p: Progress,
  update: { taskId?: string; subject?: string; status?: string },
  now: number,
): Ticket | undefined {
  if (update.taskId === undefined) return undefined

  const source = `task:${update.taskId}`
  const isKnown = p.tickets.some(ticket => ticket.source === source)
  if (!isKnown && update.subject === undefined) return undefined

  return upsertTicket(
    p,
    { source, title: update.subject, status: update.status },
    now,
  )?.ticket
}

/** The todo list as written whole: a todo left out of it is skipped unless done. */
export function applyTodoWrite(
  p: Progress,
  todos: readonly { content?: string; status?: string }[],
  now: number,
): void {
  const seen = new Set<string>()

  for (const todo of todos) {
    if (todo.content === undefined || todo.content.trim() === '') continue

    const result = upsertTicket(
      p,
      { title: todo.content, status: todo.status },
      now,
    )
    if (result === undefined) continue
    if (result.isNew) result.ticket.source = 'todo'
    seen.add(result.ticket.id)
  }

  for (const ticket of p.tickets) {
    const isDropped = ticket.source === 'todo' && !seen.has(ticket.id)
    if (isDropped && ticket.status !== 'done' && ticket.status !== 'skipped') {
      setStatus(ticket, 'skipped', p.spans, now)
      ticket.updatedAt = now
    }
  }
  p.updatedAt = now
}

// ---------------------------------------------------------------------------
// Git and MR/PR commands → activity
// ---------------------------------------------------------------------------

export type GitEvent = {
  kind: 'commit' | 'push' | 'mr' | 'pr'
  /** The commit subject, the pushed ref, or the MR/PR address. */
  text: string
  url?: string
}

/** Reads commits, pushes and new MRs/PRs out of a Bash command that ran without error. */
export function detectGitEvents(command: string, output: string): GitEvent[] {
  const events: GitEvent[] = []
  const url = /https?:\/\/[^\s'"<>)]+/.exec(output)?.[0]

  if (/(^|[\s;&|(])git\s+(?:-\S+\s+(?:\S+\s+)?)*commit(\s|$)/.test(command)) {
    const heads = [...output.matchAll(/^\[([^\]\n]+?)\s+([0-9a-f]{7,40})\]\s+(.*)$/gm)]
    for (const head of heads) {
      events.push({
        kind: 'commit',
        text: `${head[2]?.slice(0, 7) ?? ''} ${head[3] ?? ''}`.trim(),
      })
    }
  }

  if (/(^|[\s;&|(])git\s+(?:-\S+\s+(?:\S+\s+)?)*push(\s|$)/.test(command)) {
    const isRejected = /\[rejected\]|\berror: failed to push\b/.test(output)
    if (!isRejected) {
      const ref = /^\s*(?:\*|[+ ]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+.*?->\s+(\S+)/m.exec(
        output,
      )?.[1]
      const isCurrent = /Everything up-to-date/.test(output)
      if (!isCurrent) events.push({ kind: 'push', text: ref ?? '' })
    }
  }

  if (/(^|[\s;&|(])glab\s+mr\s+create(\s|$)/.test(command) && url !== undefined) {
    events.push({ kind: 'mr', text: url, url })
  }
  if (/(^|[\s;&|(])gh\s+pr\s+create(\s|$)/.test(command) && url !== undefined) {
    events.push({ kind: 'pr', text: url, url })
  }

  return events
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

export type Segment = {
  id: string
  status: TicketStatus
  /** Cells (terminal) or units (SVG) across. */
  width: number
  /** 0 to 1: the part drawn as done. */
  filled: number
}

/**
 * One segment per counted ticket, sized by estimate. The widths are whole
 * and add up to `width`. Each ticket gets a cell while there is room.
 */
export function segments(tickets: readonly Ticket[], width: number): Segment[] {
  const list = counted(tickets)
  const room = Math.max(0, Math.floor(width))
  if (list.length === 0 || room === 0) return []

  const weights = list.map(ticket => Math.max(weightOf(ticket), 1))
  const hasFloor = room >= list.length
  const floor = hasFloor ? 1 : 0
  const spare = room - floor * list.length
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const exact = weights.map(weight => (weight / total) * spare)
  const widths = exact.map(share => Math.floor(share) + floor)
  let left = room - widths.reduce((sum, one) => sum + one, 0)
  const order = exact
    .map((share, index) => ({ index, rest: share - Math.floor(share) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index)

  for (const { index } of order) {
    if (left <= 0) break
    widths[index] = (widths[index] ?? 0) + 1
    left -= 1
  }

  return list.map((ticket, index) => ({
    id: ticket.id,
    status: ticket.status,
    width: widths[index] ?? 0,
    filled: doneShare(ticket),
  }))
}

export type BarRun = { status: TicketStatus; text: string }

/** The bar as text: `█` for the done part of a segment, `░` for the rest. Exactly `width` cells. */
export function textBar(tickets: readonly Ticket[], width: number): BarRun[] {
  return segments(tickets, width)
    .filter(segment => segment.width > 0)
    .map(segment => {
      const full =
        segment.status === 'done'
          ? segment.width
          : Math.min(segment.width, Math.round(segment.width * segment.filled))

      return {
        status: segment.status,
        text: '█'.repeat(full) + '░'.repeat(segment.width - full),
      }
    })
}

export const BAR_COLORS: Record<TicketStatus, string> = {
  done: '#2da44e',
  working: '#d4a72c',
  blocked: '#cf222e',
  not_started: '#8c959f',
  skipped: '#8c959f',
}

const SVG_GAP = 2

/**
 * The bar as an SVG document `width` pixels across. A segment that is not
 * done gets a `bg` rect. Done and started work gets a `fill` rect.
 */
export function svgBar(
  tickets: readonly Ticket[],
  width: number,
  height = 8,
): string {
  const rects: string[] = []
  let x = 0

  for (const segment of segments(tickets, width)) {
    const w = Math.max(0, segment.width - SVG_GAP)
    const color = BAR_COLORS[segment.status]
    const filled = segment.status === 'done' ? w : Math.round(w * segment.filled)

    if (segment.status !== 'done') {
      rects.push(
        `<rect class="bg" data-ticket="${segment.id}" x="${x}" y="0" width="${w}" height="${height}" rx="2" fill="${color}" fill-opacity="0.28"/>`,
      )
    }
    if (filled > 0) {
      rects.push(
        `<rect class="fill" data-ticket="${segment.id}" x="${x}" y="0" width="${filled}" height="${height}" rx="2" fill="${color}"/>`,
      )
    }
    x += segment.width
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects.join('')}</svg>`
}

export function svgDivider(width: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1" viewBox="0 0 ${width} 1" preserveAspectRatio="none"><rect x="0" y="0" width="${width}" height="1" fill="#8c959f" fill-opacity="0.5"/></svg>`
}

// ---------------------------------------------------------------------------
// Saved data
// ---------------------------------------------------------------------------

export const KEEP_SESSIONS = 20
export const KEEP_DAYS = 30

/**
 * Reads saved data back into the current shape. Data saved before spans
 * existed gets one legacy span from its start, which counts wall time until
 * the next turn starts. A turn left open by a process that ended closes at
 * the last update.
 */
export function restore(saved: unknown): Progress | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined

  const raw = saved as Partial<Progress>
  const p: Progress = { ...emptyProgress(), ...raw }

  p.tickets = (Array.isArray(raw.tickets) ? raw.tickets : []).map(ticket => ({
    ...ticket,
    progress: ticket.progress ?? 0,
    workedMs: ticket.workedMs ?? 0,
    timeline: ticket.timeline ?? [],
    estimate: ticket.estimate ?? DEFAULT_ESTIMATE,
    createdAt: ticket.createdAt ?? p.updatedAt,
    updatedAt: ticket.updatedAt ?? p.updatedAt,
  }))
  p.questions = Array.isArray(raw.questions) ? raw.questions : []
  p.stuck = Array.isArray(raw.stuck) ? raw.stuck : []
  p.activity = Array.isArray(raw.activity) ? raw.activity : []
  p.deliverables = Array.isArray(raw.deliverables) ? raw.deliverables : []

  if (Array.isArray(raw.spans)) {
    p.spans = raw.spans.map(span =>
      span.end === undefined && span.isLegacy !== true
        ? { ...span, end: Math.max(span.start, p.updatedAt) }
        : span,
    )
  } else {
    const starts = [
      p.run?.startedAt,
      ...p.tickets.map(ticket => ticket.createdAt),
    ].filter((at): at is number => typeof at === 'number')
    p.spans =
      starts.length === 0 || isFinished(p)
        ? []
        : [{ start: Math.min(...starts), isLegacy: true }]
  }

  for (const ticket of p.tickets) {
    if (ticket.status === 'working' && ticket.workingSince === undefined) {
      ticket.workingSince = ticket.updatedAt
    }
  }
  if (p.run !== undefined) p.run.isStartPinned = p.run.isStartPinned === true

  p.nextTicket = Math.max(p.nextTicket, p.tickets.length + 1)
  p.nextQuestion = Math.max(p.nextQuestion, p.questions.length + 1)
  p.nextStuck = Math.max(p.nextStuck, p.stuck.length + 1)

  return p
}

/** The session ids to delete: all but the `KEEP_SESSIONS` newest of the last `KEEP_DAYS` days. */
export function sessionsToPrune(
  index: Readonly<Record<string, number>>,
  now: number,
): string[] {
  const cutoff = now - KEEP_DAYS * DAY
  const newest = Object.entries(index).sort((a, b) => b[1] - a[1])

  return newest
    .filter(([, savedAt], place) => place >= KEEP_SESSIONS || savedAt < cutoff)
    .map(([id]) => id)
}

// ---------------------------------------------------------------------------
// Text width
// ---------------------------------------------------------------------------

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

/** Terminal cells a string takes: 2 for East Asian wide characters. */
export function cellWidth(text: string): number {
  let cells = 0
  for (const char of text) cells += isWide(char.codePointAt(0) ?? 0) ? 2 : 1

  return cells
}

/** Cuts a string to `cells` terminal cells, ending in `…` when cut. */
export function truncate(text: string, cells: number): string {
  if (cellWidth(text) <= cells) return text
  if (cells <= 1) return cells === 1 ? '…' : ''

  let out = ''
  let used = 0
  for (const char of text) {
    const next = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + next > cells - 1) break
    out += char
    used += next
  }

  return `${out}…`
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
