// Text that Claude reads: the tool's description and schema, and the
// /progress requests. English only, whatever the `language` setting says.

import { isEmpty, openQuestions, openStuck, percentDone } from './logic'
import type { Progress } from './logic'

export const TOOL_NAME = 'progress'

export const TOOL_DESCRIPTION = [
  'Updates the Progress pane the user sees beside the chat: the goal, the tickets, time left, and what needs the user.',
  'Call it when you start a piece of work that has several steps, and keep it current while you work: when a ticket starts, moves to a new stage or finishes, when you produce a file or link, when you are stuck, and when you need a decision.',
  'Every field is optional. Send only what changed.',
  '- start: begin a run. doneWhen is the stop condition. startedAt fixes the start time (ISO 8601). Leave it out to start now.',
  '- tickets: create or update tickets. Leave id out to create one. Ids (T01, T02, ...) come back in the result. estimate is in minutes of your own working time.',
  '- ticker: one line saying what you are doing right now.',
  '- activity: one line for the log. Commits, pushes and MRs/PRs are logged on their own, so do not repeat them.',
  '- deliverable: a file path or a link the user should see.',
  '- stuck: say what blocks you. unstuck: the S id that is resolved, or true for all.',
  '- ask: a question for the user with 2-4 short options and the letter you recommend. answer: record the user\'s answer.',
  '- pastActivity: milestones that happened before now, each with its real time. An older time can move the run start earlier unless start.startedAt set it.',
  '- finish: the stop condition is met. clear: empty the pane.',
  'TaskCreate, TaskUpdate and TodoWrite calls become tickets on their own. Use tickets here to add an estimate, a stage or progress to them.',
].join('\n')

const text = { type: 'string' }
const ticketRef = {
  type: 'string',
  description: 'A ticket id (T01) or its exact title.',
}

export const TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    start: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The goal, in a few words.' },
        doneWhen: { type: 'string', description: 'The stop condition.' },
        startedAt: {
          type: 'string',
          description: 'ISO 8601. Fixes the run start. pastActivity cannot change it.',
        },
      },
    },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'T01, T02, ... Leave out to create.' },
          title: text,
          estimate: { type: 'number', description: 'Minutes.' },
          status: {
            type: 'string',
            enum: ['not_started', 'working', 'blocked', 'done', 'skipped'],
          },
          stage: { type: 'string', description: 'For example: design, code, test, review.' },
          progress: { type: 'number', minimum: 0, maximum: 100 },
          waitsFor: ticketRef,
          source: { type: 'string', description: 'Where the ticket comes from: an issue, a plan step.' },
        },
      },
    },
    ticker: text,
    activity: {
      anyOf: [
        text,
        { type: 'object', properties: { text, ticket: ticketRef }, required: ['text'] },
      ],
    },
    deliverable: {
      anyOf: [
        text,
        {
          type: 'object',
          properties: { title: text, path: text, url: text, ticket: ticketRef },
        },
      ],
    },
    stuck: {
      anyOf: [
        text,
        { type: 'object', properties: { text, ticket: ticketRef }, required: ['text'] },
      ],
    },
    unstuck: { anyOf: [{ type: 'string', description: 'S1, S2, ...' }, { type: 'boolean' }] },
    ask: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question in a few words.' },
        question: text,
        options: { type: 'array', items: text },
        recommend: { type: 'string', description: 'The letter of the option you recommend: A, B, ...' },
        ticket: ticketRef,
      },
    },
    answer: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Q1, Q2, ...' },
        answer: { type: 'string', description: 'The option letter, or the user\'s words.' },
      },
      required: ['id', 'answer'],
    },
    pastActivity: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text, at: { type: 'string', description: 'ISO 8601.' } },
        required: ['text', 'at'],
      },
    },
    finish: { anyOf: [{ type: 'boolean' }, { type: 'string', description: 'A one-line summary.' }] },
    clear: { type: 'boolean' },
  },
}

const withFocus = (focus: string): string =>
  focus === '' ? '' : `\n\nFocus on: ${focus}`

/** The request `/progress` submits when the pane is empty. */
export function fillRequest(tool: string, focus: string): string {
  return [
    `Fill in the Progress pane with the ${tool} tool.`,
    '',
    'Survey the work first. The survey is read-only: read files, the task list and git, and change nothing.',
    '1. Find the goal and the stop condition of this session\'s work from the conversation, the task list and the plan files.',
    '2. Find what is already done on this branch. Use only the branch\'s own commits: `git log <default>..HEAD`, where <default> is the default branch (main or master). Merged MRs/PRs on the default branch are earlier work. Do not list them, and do not date the run from them.',
    '3. Split the remaining work into tickets with an estimate in minutes of your own working time.',
    '',
    `Then call ${tool} once with: start {title, doneWhen, startedAt}, tickets (done work as done tickets), pastActivity for the branch's milestones with their real times, and ticker.`,
    'Set start.startedAt to the time this run\'s work began, so the older milestones cannot move it.',
    'Ask with `ask` only where a decision is the user\'s to make.',
  ].join('\n') + withFocus(focus)
}

/** The request `/progress` submits when the pane already holds a run or tickets. */
export function updateRequest(
  tool: string,
  p: Progress,
  focus: string,
  now: number,
): string {
  const tickets = p.tickets.map(
    ticket =>
      `- ${ticket.id} [${ticket.status}${ticket.stage === undefined ? '' : `, ${ticket.stage}`}, ${ticket.progress}%, est ${ticket.estimate}m] ${ticket.title}`,
  )
  const questions = openQuestions(p).map(
    question => `- ${question.id} ${question.title}`,
  )
  const stuck = openStuck(p).map(mark => `- ${mark.id} ${mark.text}`)

  return [
    `Bring the Progress pane up to date with the ${tool} tool.`,
    '',
    `The pane now (last update ${new Date(p.updatedAt).toISOString()}, now ${new Date(now).toISOString()}):`,
    `Run: ${p.run?.title ?? '(none)'}${p.run?.doneWhen === undefined ? '' : `. Stop when: ${p.run.doneWhen}`}. ${percentDone(p.tickets)}% done.`,
    'Tickets:',
    ...(tickets.length > 0 ? tickets : ['- (none)']),
    ...(questions.length > 0 ? ['Open questions:', ...questions] : []),
    ...(stuck.length > 0 ? ['Stuck:', ...stuck] : []),
    '',
    'Compare the pane with what happened since that update: the conversation, the task list, and `git log <default>..HEAD` for this branch\'s own commits. This check is read-only.',
    `Then call ${tool} with only what changed: ticket status, stage and progress, new tickets, estimates that turned out wrong, deliverables, the ticker, and answer / unstuck for what is settled. Call finish when the stop condition is met.`,
  ].join('\n') + withFocus(focus)
}

export function progressRequest(
  tool: string,
  p: Progress,
  focus: string,
  now: number,
): string {
  return isEmpty(p) ? fillRequest(tool, focus) : updateRequest(tool, p, focus, now)
}
