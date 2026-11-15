import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_SCHEMA,
  progressRequest,
} from './claude-text'
import { duration, elapsedText, langOf, stamp, strings } from './i18n'
import type { Lang, Strings } from './i18n'
import {
  addActivity,
  addDeliverable,
  answerLetter,
  answerLine,
  applyInput,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  cellWidth,
  closeSpan,
  detectGitEvents,
  emptyProgress,
  isEmpty,
  isFinished,
  isOverdue,
  isTurnOpen,
  letterOf,
  openQuestions,
  openSpan,
  openStuck,
  overdueTickets,
  parseAnswers,
  percentDone,
  recordAnswer,
  remainingMs,
  restore,
  runStatus,
  sessionsToPrune,
  svgBar,
  svgDivider,
  svgMark,
  textBar,
  truncate,
  waitPolicy,
  workedMs,
} from './logic'
import type {
  Progress,
  ProgressInput,
  Question,
  RunStatus,
  Ticket,
  TicketStatus,
  WaitPolicy,
} from './logic'

const PLUGIN = 'session-progress'
const PANE = 'session-progress'
// Spelled out where a matcher or a registration names them, so that
// `claude plugin validate` reads them off the source.
const TOOL = 'mcp__session-progress__progress'
const SAVE_DELAY_MS = 500
const REDRAW_MS = 30_000
const INDEX_KEY = 'index'
const keyOf = (sessionId: string): string => `session:${sessionId}`

type Tab = 'tickets' | 'deliverables' | 'activity'
type Saved = { savedAt: number; progress: Progress }
type Index = Record<string, number>

const STATUS_COLOR: Record<TicketStatus, string | undefined> = {
  done: 'success',
  working: 'warning',
  blocked: 'error',
  not_started: undefined,
  skipped: undefined,
}
const STATUS_MARK: Record<TicketStatus, string> = {
  done: '✓',
  working: '●',
  blocked: '✗',
  not_started: '○',
  skipped: '–',
}
const RUN_COLOR: Record<RunStatus, string | undefined> = {
  finished: 'success',
  working: 'warning',
  stuck: 'error',
  stale: 'warning',
  idle: undefined,
}

let policy: WaitPolicy = 'work_around'

let progress: Progress = emptyProgress()
let sessionId: string | undefined
// The id a /clear or a resume ended. Nothing is saved under it again.
let endedId: string | undefined
let lang: Lang | undefined
let hasOpened = false
let saveTimer: Timer | undefined
// View state: kept for the process, never saved.
let tab: Tab = 'tickets'
let openTicket: string | undefined

const language = async ($: EngineInterface): Promise<Lang> => {
  if (lang === undefined) await readLanguage($)

  return lang ?? 'en'
}

const readLanguage = async ($: EngineInterface): Promise<void> => {
  try {
    lang = langOf(await $.settings.read({ key: 'language' }))
  } catch {
    lang = lang ?? 'en'
  }
}

const openPane = async ($: EngineInterface): Promise<void> => {
  hasOpened = true
  try {
    await $.ui.open({ id: PANE, title: strings(await language($)).paneTitle })
  } catch {
    // Another plugin holds the id, or a hook refused the open.
  }
}

const save = async ($: EngineInterface, forId?: string): Promise<void> => {
  saveTimer?.cancel()
  saveTimer = undefined

  try {
    const id = forId ?? sessionId ?? (await $.session.id())
    if (forId === undefined && id === endedId) return
    if (forId === undefined) sessionId = id

    const index = ((await $.store.get(INDEX_KEY)) ?? {}) as Index

    if (isEmpty(progress)) {
      if (index[id] === undefined) return
      delete index[id]
      await $.store.delete(keyOf(id))
    } else {
      const savedAt = await $.clock.now()
      const value: Saved = { savedAt, progress }
      await $.store.set(keyOf(id), value)
      index[id] = savedAt
    }
    await $.store.set(INDEX_KEY, index)
  } catch (error) {
    $.ui.log(`${PLUGIN}: save failed: ${String(error)}`, { to: 'debug' })
  }
}

const load = async (
  $: EngineInterface,
  id: string,
): Promise<Progress | undefined> => {
  try {
    const saved = (await $.store.get(keyOf(id))) as Saved | undefined

    return restore(saved?.progress)
  } catch {
    return undefined
  }
}

const prune = async ($: EngineInterface): Promise<void> => {
  try {
    const index = ((await $.store.get(INDEX_KEY)) ?? {}) as Index
    const old = sessionsToPrune(index, await $.clock.now()).filter(
      id => id !== sessionId,
    )
    if (old.length === 0) return

    for (const id of old) {
      delete index[id]
      await $.store.delete(keyOf(id))
    }
    await $.store.set(INDEX_KEY, index)
  } catch {
    // The next start prunes.
  }
}

/** After each change: draw again, save in 0.5 s, and open the pane the first time there is something to show. */
const changed = ($: EngineInterface): void => {
  if (!hasOpened && !isEmpty(progress)) void openPane($)

  $.ui.invalidate('ui.render')
  saveTimer?.cancel()
  saveTimer = $.clock.after(SAVE_DELAY_MS, () => {
    void save($)
  })
}

/** Loads the session's data when `$.session.id()` is not the id held: a start, a resume in the same process, or the session after a /clear. */
const syncSession = async ($: EngineInterface): Promise<void> => {
  const id = await $.session.id()
  if (id === sessionId || id === endedId) return

  if (sessionId !== undefined) await save($, sessionId)
  sessionId = id
  endedId = undefined
  progress = (await load($, id)) ?? emptyProgress()
  openTicket = undefined
  hasOpened = false
  if (!isEmpty(progress)) void openPane($)
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  policy = waitPolicy(options.whileQuestionWaits)
  progress = emptyProgress()
  sessionId = undefined
  endedId = undefined
  lang = undefined
  hasOpened = false
  saveTimer = undefined
  tab = 'tickets'
  openTicket = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description:
        'Open the Progress pane and have Claude fill it in or bring it up to date',
      argumentHint: '[focus]',
    })
    await $.tool.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })

    await readLanguage($)
    sessionId = undefined
    try {
      await syncSession($)
    } catch {
      // No session id yet: the first turn's start loads.
    }
    $.clock.every(REDRAW_MS, () => {
      void syncSession($).catch(() => undefined)
      $.ui.invalidate('ui.render')
    })
    void prune($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await save($, e.sessionId)

    if (e.reason === 'clear' || e.reason === 'resume') {
      endedId = e.sessionId
      sessionId = undefined
      progress = emptyProgress()
      openTicket = undefined
      hasOpened = false
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await syncSession($)
    await readLanguage($)
    const now = await $.clock.now()
    progress.spans = isEmpty(progress)
      ? [{ start: now }]
      : openSpan(progress.spans, now)
    if (!isEmpty(progress)) changed($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    progress.spans = closeSpan(progress.spans, await $.clock.now())
    if (!isEmpty(progress)) changed($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const answers = parseAnswers(e.text)
    if (answers.length > 0) {
      const now = await $.clock.now()
      const recorded = answers.filter(
        one => recordAnswer(progress, one.id, one.answer, now) !== undefined,
      )
      if (recorded.length > 0) changed($)
    }

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const t = strings(await language($))
    const wasEmpty = isEmpty(progress)
    const text = progressRequest(TOOL, progress, e.args.trim(), await $.clock.now())

    await openPane($)
    // A command's own hook cannot await a prompt it submits: the prompt
    // waits for the command to end. The timer submits it after the hook.
    $.clock.after(1, () => {
      void $.prompt.submit({ text })
    })

    return { text: wasEmpty ? t.commandFill : t.commandUpdate }
  })

  on('tool.call', { tool: 'mcp__session-progress__progress' }, async ($, e) => {
    const now = await $.clock.now()
    const wasTurnOpen = isTurnOpen(progress.spans)
    const applied = applyInput(progress, e as ProgressInput, now, policy)

    progress = applied.progress
    if (applied.wasCleared) {
      openTicket = undefined
      if (wasTurnOpen) progress.spans = [{ start: now }]
    }
    changed($)

    return { result: applied.lines.join('\n') }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (tool === TOOL || ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    const input = e as Record<string, unknown>
    const record = (ran.result ?? {}) as Record<string, unknown>
    const now = await $.clock.now()

    if (tool === 'Bash') {
      const output = [record.stdout, record.stderr, ran.text]
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
      const events = detectGitEvents(String(input.command ?? ''), output)
      for (const event of events) {
        addActivity(progress, { at: now, kind: event.kind, text: event.text })
        if (event.url !== undefined) {
          addDeliverable(progress, {
            title: event.kind === 'mr' ? 'MR' : 'PR',
            url: event.url,
            at: now,
          })
        }
      }
      if (events.length > 0) {
        progress.updatedAt = now
        changed($)
      }
    } else if (tool === 'TaskCreate') {
      const task = (record.task ?? {}) as { id?: string; subject?: string }
      const subject = task.subject ?? (input.subject as string | undefined)
      if (applyTaskCreate(progress, { id: task.id, subject }, now)) changed($)
    } else if (tool === 'TaskUpdate') {
      const update = input as { taskId?: string; subject?: string; status?: string }
      if (applyTaskUpdate(progress, update, now)) changed($)
    } else if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      applyTodoWrite(progress, input.todos as { content?: string; status?: string }[], now)
      changed($)
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const questions = openQuestions(progress).length
    const stuck = openStuck(progress).length + overdueTickets(progress, now).length
    if (e.props.hasSurvey || (questions === 0 && stuck === 0)) return next(e)

    const t = strings(await language($))
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color="warning">{t.pill(questions, stuck)}</Text>
        <Button key="open" label={t.pillOpen} onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = strings(await language($))
    const now = await $.clock.now()
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Text } = table
    const columns = Math.max(16, Math.floor(e.props.bodyColumns))
    const pixels = Math.min(1600, Math.max(160, columns * 8))
    // By surface, not by whether the table has an Svg: the terminal's table
    // holds a stand-in that draws nothing.
    const isTerminal = e.surface === 'terminal'
    const Svg = (table as { Svg?: typeof table.Text }).Svg as unknown as (props: {
      source: string
      alt: string
    }) => ReturnType<typeof Text>

    const redraw = (): void => $.ui.invalidate('ui.render')
    const length = (ms: number): string => duration(ms, t)

    if (isEmpty(progress)) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>{t.emptyTitle}</Text>
          {t.emptyBody.map(line => (
            <Text dimColor wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      )
    }

    const percent = percentDone(progress.tickets)
    const status = runStatus(progress, now)
    const left = remainingMs(progress, now)
    const run = progress.run

    const bar = isTerminal ? (
      <Box flexDirection="row" flexWrap="nowrap" height={1} overflow="hidden">
        {progress.tickets.length === 0 ? (
          <Text dimColor wrap="truncate">
            {'░'.repeat(columns)}
          </Text>
        ) : (
          textBar(progress.tickets, columns).map(part => (
            <Text
              color={STATUS_COLOR[part.status]}
              dimColor={part.status === 'not_started'}
              wrap="truncate"
            >
              {part.text}
            </Text>
          ))
        )}
      </Box>
    ) : (
      <Svg source={svgBar(progress.tickets, pixels)} alt={t.barAlt(percent)} />
    )

    const header = (
      <Box flexDirection="column">
        {run !== undefined && (
          <Text bold wrap="wrap">
            {run.title}
          </Text>
        )}
        {run?.doneWhen !== undefined && run.doneWhen !== '' && (
          <Text dimColor wrap="wrap">
            {t.stopWhen} {run.doneWhen}
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold color={RUN_COLOR[status]}>
            {t.status[status]}
          </Text>
          <Text>· {t.percentDone(percent)}</Text>
          {run !== undefined && (
            <Text dimColor>
              · {elapsedText(run.startedAt, run.finishedAt ?? now, t)}
            </Text>
          )}
          {left !== undefined && <Text>· {t.left(length(left))}</Text>}
        </Box>
      </Box>
    )

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          {header}
          {bar}
        </Box>
      )
    }

    const divider = isTerminal ? (
      <Text dimColor wrap="truncate">
        {'─'.repeat(columns)}
      </Text>
    ) : (
      <Svg source={svgDivider(pixels)} alt={t.dividerAlt} />
    )

    const ticketLine = (ticket: Ticket): string => {
      const parts = [t.ticketStatus[ticket.status]]
      if (ticket.stage !== undefined) parts.push(ticket.stage)
      if (ticket.status !== 'not_started' && ticket.status !== 'skipped') {
        parts.push(`${ticket.progress}%`)
      }
      parts.push(t.estimate(length(ticket.estimate * 60_000)))
      if (ticket.waitsFor !== undefined) parts.push(t.waitsFor(ticket.waitsFor))
      if (!isFinished(progress) && isOverdue(ticket, progress, now)) {
        parts.push(`⚠ ${t.pastEstimate}`)
      }

      return parts.join(' · ')
    }

    const stampOf = (at: number): string => stamp(at, now)

    const activityRows = (ticket?: string) => {
      const list = progress.activity
        .filter(entry => ticket === undefined || entry.ticket === ticket)
        .slice(-60)
        .reverse()

      return list.length === 0 ? (
        <Text dimColor>{t.noActivity}</Text>
      ) : (
        list.map(entry => (
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>{stampOf(entry.at)}</Text>
            <Text wrap="wrap">
              {t.activity[entry.kind](entry.text)}
              {ticket === undefined && entry.ticket !== undefined
                ? ` (${entry.ticket})`
                : ''}
            </Text>
          </Box>
        ))
      )
    }

    const deliverableRows = (ticket?: string) => {
      const list = progress.deliverables.filter(
        entry => ticket === undefined || entry.ticket === ticket,
      )

      return list.length === 0 ? (
        <Text dimColor>{t.noDeliverables}</Text>
      ) : (
        list.map(entry => (
          <Box flexDirection="column">
            <Text wrap="wrap">
              {entry.title}
              {ticket === undefined && entry.ticket !== undefined
                ? ` (${entry.ticket})`
                : ''}
            </Text>
            {entry.url !== undefined && <Link href={entry.url} label={entry.url} />}
            {entry.path !== undefined && entry.path !== entry.title && (
              <Text dimColor wrap="truncate-start">
                {entry.path}
              </Text>
            )}
          </Box>
        ))
      )
    }

    const isRecommended = (question: Question, index: number): boolean => {
      const recommend = question.recommend?.trim()
      if (recommend === undefined || recommend === '') return false
      if (recommend === question.options[index]) return true

      return answerLetter(recommend) === letterOf(index)
    }

    const pick = async (question: Question, index: number): Promise<void> => {
      const line = answerLine(question, index)
      const box = await $.prompt.read()
      const isBlank = box.text.trim() === ''

      await $.prompt.fill(
        isBlank
          ? { text: line, mode: 'replace' }
          : { text: `${box.text.endsWith('\n') ? '' : '\n'}${line}`, mode: 'append' },
      )
    }

    const questionBlock = (question: Question) => (
      <Box flexDirection="column">
        <Text bold wrap="wrap">
          {question.id} {question.title}
          {question.ticket !== undefined ? ` (${question.ticket})` : ''}
        </Text>
        {question.question !== '' && question.question !== question.title && (
          <Text wrap="wrap">{question.question}</Text>
        )}
        {question.answer !== undefined ? (
          <Text dimColor wrap="wrap">
            {t.answered(question.answer)}
          </Text>
        ) : (
          question.options.map((option, index) => (
            <Button
              key={`answer:${question.id}:${letterOf(index)}`}
              label={`${letterOf(index)} — ${option}${isRecommended(question, index) ? ` (${t.recommended})` : ''}`}
              variant={isRecommended(question, index) ? 'primary' : 'secondary'}
              onPress={() => void pick(question, index)}
            />
          ))
        )}
      </Box>
    )

    const shown = progress.tickets.find(ticket => ticket.id === openTicket)

    const detail = (ticket: Ticket) => {
      const questions = progress.questions.filter(one => one.ticket === ticket.id)

      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="column">
            <Button
              key="back"
              plain
              hotkey="b"
              label={`← ${t.back}`}
              onPress={() => {
                openTicket = undefined
                redraw()
              }}
            />
            <Text bold wrap="wrap">
              {ticket.id} {ticket.title}
            </Text>
            <Text dimColor wrap="wrap">
              {ticketLine(ticket)} · {t.worked(length(workedMs(ticket, progress.spans, now)))}
            </Text>
            {ticket.source !== undefined && (
              <Text dimColor wrap="truncate-end">
                {ticket.source}
              </Text>
            )}
          </Box>
          <Box flexDirection="column">
            <Text bold>{t.timeline}</Text>
            {ticket.timeline.map(entry => (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>{stampOf(entry.at)}</Text>
                <Text wrap="wrap">
                  {entry.kind === 'created'
                    ? t.timelineCreated
                    : entry.kind === 'stage'
                      ? t.timelineStage(entry.value)
                      : (t.ticketStatus[entry.value as TicketStatus] ?? entry.value)}
                </Text>
              </Box>
            ))}
          </Box>
          {questions.length > 0 && (
            <Box flexDirection="column">
              <Text bold>{t.questions}</Text>
              {questions.map(questionBlock)}
            </Box>
          )}
          <Box flexDirection="column">
            <Text bold>{t.tabDeliverables}</Text>
            {deliverableRows(ticket.id)}
          </Box>
          <Box flexDirection="column">
            <Text bold>{t.tabActivity}</Text>
            {activityRows(ticket.id)}
          </Box>
        </Box>
      )
    }

    const tabs: readonly { id: Tab; label: string; hotkey: string }[] = [
      { id: 'tickets', label: `${t.tabTickets} ${progress.tickets.length}`, hotkey: '1' },
      {
        id: 'deliverables',
        label: `${t.tabDeliverables} ${progress.deliverables.length}`,
        hotkey: '2',
      },
      { id: 'activity', label: `${t.tabActivity} ${progress.activity.length}`, hotkey: '3' },
    ]

    const titleRoom = Math.max(8, columns - 8)
    const body =
      shown !== undefined ? (
        detail(shown)
      ) : (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {tabs.map(one => (
              <Button
                key={`tab:${one.id}`}
                plain
                hotkey={one.hotkey}
                onPress={() => {
                  tab = one.id
                  redraw()
                }}
              >
                <Text bold={tab === one.id} underline={tab === one.id} dimColor={tab !== one.id}>
                  {one.label}
                </Text>
              </Button>
            ))}
          </Box>
          {tab === 'tickets' && (
            <Box flexDirection="column">
              {progress.tickets.length === 0 && <Text dimColor>{t.noTickets}</Text>}
              {progress.tickets.map(ticket => (
                <Box flexDirection="column">
                  {isTerminal ? (
                    <Button
                      key={`ticket:${ticket.id}`}
                      plain
                      onPress={() => {
                        openTicket = ticket.id
                        redraw()
                      }}
                    >
                      <Text color={STATUS_COLOR[ticket.status]}>
                        {STATUS_MARK[ticket.status]}
                      </Text>
                      {` ${ticket.id} ${truncate(ticket.title, titleRoom - cellWidth(ticket.id))}`}
                    </Button>
                  ) : (
                    // A Button holds only text, so the icon sits beside it.
                    <Box flexDirection="row" alignItems="center" columnGap={1}>
                      <Svg
                        source={svgMark(ticket.status)}
                        alt={t.ticketStatus[ticket.status]}
                      />
                      <Button
                        key={`ticket:${ticket.id}`}
                        plain
                        onPress={() => {
                          openTicket = ticket.id
                          redraw()
                        }}
                      >
                        {`${ticket.id} ${ticket.title}`}
                      </Button>
                    </Box>
                  )}
                  <Text dimColor wrap="truncate-end">
                    {`  ${ticketLine(ticket)}`}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {tab === 'deliverables' && (
            <Box flexDirection="column">{deliverableRows()}</Box>
          )}
          {tab === 'activity' && <Box flexDirection="column">{activityRows()}</Box>}
        </Box>
      )

    const marks = openStuck(progress)
    const late = overdueTickets(progress, now)
    const questions = openQuestions(progress)
    const needs = marks.length + late.length + questions.length > 0 && (
      <Box flexDirection="column" rowGap={1}>
        <Text bold color="warning">
          {t.needsYou}
        </Text>
        {(marks.length > 0 || late.length > 0) && (
          <Box flexDirection="column">
            {marks.map(mark => (
              <Text color="error" wrap="wrap">
                {mark.id} {mark.text}
                {mark.ticket !== undefined ? ` (${mark.ticket})` : ''}
              </Text>
            ))}
            {late.map(ticket => (
              <Text color="error" wrap="wrap">
                {t.stuckPastEstimate(ticket.id, ticket.title)}
              </Text>
            ))}
          </Box>
        )}
        {questions.map(questionBlock)}
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          {header}
          {bar}
          {progress.ticker !== undefined && !isFinished(progress) && (
            <Text wrap="truncate-end">▸ {progress.ticker}</Text>
          )}
          {run?.summary !== undefined && <Text wrap="wrap">{run.summary}</Text>}
        </Box>
        {divider}
        {body}
        {needs}
      </Box>
    )
  })
}
