// What the person sees, in English and Japanese. Text that Claude reads (the
// tool's description, its results, the /progress request) is not here: it
// stays in English.

import { DAY, HOUR, MINUTE } from './logic'
import type { ActivityKind, RunStatus, TicketStatus } from './logic'

export type Lang = 'en' | 'ja'

/** Claude Code's `language` setting: `japanese`, `日本語` or `ja` gives Japanese. */
export function langOf(setting: unknown): Lang {
  if (typeof setting !== 'string') return 'en'

  const word = setting.trim().toLowerCase()

  return word === 'japanese' || word === '日本語' || word === 'ja' ? 'ja' : 'en'
}

export type Strings = {
  paneTitle: string
  stopWhen: string
  status: Record<RunStatus, string>
  ticketStatus: Record<TicketStatus, string>
  percentDone: (percent: number) => string
  elapsed: (duration: string) => string
  elapsedSince: (duration: string, date: string) => string
  left: (duration: string) => string
  minutes: (m: number) => string
  hoursMinutes: (h: number, m: number) => string
  daysHours: (d: number, h: number) => string
  underMinute: string
  tabTickets: string
  tabDeliverables: string
  tabActivity: string
  noTickets: string
  noDeliverables: string
  noActivity: string
  estimate: (duration: string) => string
  worked: (duration: string) => string
  waitsFor: (what: string) => string
  pastEstimate: string
  back: string
  timeline: string
  questions: string
  timelineCreated: string
  timelineStage: (stage: string) => string
  needsYou: string
  recommended: string
  answered: (answer: string) => string
  stuckPastEstimate: (id: string, title: string) => string
  activity: Record<ActivityKind, (text: string) => string>
  emptyTitle: string
  emptyBody: readonly string[]
  pill: (questions: number, stuck: number) => string
  pillOpen: string
  commandFill: string
  commandUpdate: string
  barAlt: (percent: number) => string
  dividerAlt: string
}

const en: Strings = {
  paneTitle: 'Progress',
  stopWhen: 'Stop when:',
  status: {
    working: 'working',
    idle: 'idle',
    stuck: 'stuck',
    stale: 'possibly stale',
    finished: 'finished',
  },
  ticketStatus: {
    not_started: 'not started',
    working: 'working',
    blocked: 'blocked',
    done: 'done',
    skipped: 'skipped',
  },
  percentDone: percent => `${percent}% done`,
  elapsed: duration => `${duration} elapsed`,
  elapsedSince: (duration, date) => `${duration} since ${date}`,
  left: duration => `~${duration} left`,
  minutes: m => `${m}m`,
  hoursMinutes: (h, m) => (m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`),
  daysHours: (d, h) => (h === 0 ? `${d}d` : `${d}d${h}h`),
  underMinute: '<1m',
  tabTickets: 'Tickets',
  tabDeliverables: 'Deliverables',
  tabActivity: 'Activity',
  noTickets: 'No tickets yet.',
  noDeliverables: 'No deliverables yet.',
  noActivity: 'No activity yet.',
  estimate: duration => `est ${duration}`,
  worked: duration => `worked ${duration}`,
  waitsFor: what => `waits for ${what}`,
  pastEstimate: 'past estimate',
  back: 'Back',
  timeline: 'Timeline',
  questions: 'Questions',
  timelineCreated: 'created',
  timelineStage: stage => `stage: ${stage}`,
  needsYou: 'Needs you',
  recommended: 'recommended',
  answered: answer => `answered: ${answer}`,
  stuckPastEstimate: (id, title) => `${id} is past its estimate: ${title}`,
  activity: {
    note: text => text,
    past: text => text,
    commit: text => `Commit: ${text}`,
    push: text => (text === '' ? 'Pushed' : `Pushed ${text}`),
    mr: text => `MR opened: ${text}`,
    pr: text => `PR opened: ${text}`,
  },
  emptyTitle: 'Nothing tracked yet.',
  emptyBody: [
    'This pane shows how the session\'s work is going: the goal, the tickets, the time left, and the questions that wait for you.',
    'Run /progress to have Claude survey the work and fill it in.',
    'Claude also fills it in while it works. Its task list becomes tickets on its own.',
  ],
  pill: (questions, stuck) => {
    const parts: string[] = []
    if (questions > 0) {
      parts.push(`${questions} question${questions === 1 ? '' : 's'} waiting`)
    }
    if (stuck > 0) parts.push(`${stuck} stuck`)

    return `Progress: ${parts.join(' · ')}`
  },
  pillOpen: 'Open',
  commandFill: 'Progress pane opened. Asking Claude to survey the work and fill it in.',
  commandUpdate: 'Progress pane opened. Asking Claude to bring it up to date.',
  barAlt: percent => `Progress bar: ${percent}% done`,
  dividerAlt: 'Divider',
}

const ja: Strings = {
  paneTitle: '進捗',
  stopWhen: '完了条件:',
  status: {
    working: '作業中',
    idle: '待機中',
    stuck: '停滞',
    stale: '更新が止まっている可能性',
    finished: '完了',
  },
  ticketStatus: {
    not_started: '未着手',
    working: '作業中',
    blocked: 'ブロック',
    done: '完了',
    skipped: 'スキップ',
  },
  percentDone: percent => `${percent}% 完了`,
  elapsed: duration => `経過 ${duration}`,
  elapsedSince: (duration, date) => `経過 ${duration}（${date} から）`,
  left: duration => `残り約${duration}`,
  minutes: m => `${m}分`,
  hoursMinutes: (h, m) => (m === 0 ? `${h}時間` : `${h}時間${m}分`),
  daysHours: (d, h) => (h === 0 ? `${d}日` : `${d}日${h}時間`),
  underMinute: '1分未満',
  tabTickets: 'チケット',
  tabDeliverables: '成果物',
  tabActivity: '履歴',
  noTickets: 'チケットはまだありません。',
  noDeliverables: '成果物はまだありません。',
  noActivity: '履歴はまだありません。',
  estimate: duration => `見積 ${duration}`,
  worked: duration => `作業 ${duration}`,
  waitsFor: what => `${what} 待ち`,
  pastEstimate: '見積超過',
  back: '戻る',
  timeline: 'タイムライン',
  questions: '質問',
  timelineCreated: '作成',
  timelineStage: stage => `段階: ${stage}`,
  needsYou: '要対応',
  recommended: '推奨',
  answered: answer => `回答済み: ${answer}`,
  stuckPastEstimate: (id, title) => `${id} が見積を超過: ${title}`,
  activity: {
    note: text => text,
    past: text => text,
    commit: text => `コミット: ${text}`,
    push: text => (text === '' ? 'プッシュ' : `プッシュ: ${text}`),
    mr: text => `MR 作成: ${text}`,
    pr: text => `PR 作成: ${text}`,
  },
  emptyTitle: 'まだ何も記録されていません。',
  emptyBody: [
    'このペインはセッションの作業状況を表示します。目標、チケット、残り時間、あなたの回答を待つ質問が並びます。',
    '/progress を実行すると、Claude が作業を調べて記入します。',
    'Claude は作業中にも記入します。タスクリストは自動でチケットになります。',
  ],
  pill: (questions, stuck) => {
    const parts: string[] = []
    if (questions > 0) parts.push(`質問 ${questions} 件が回答待ち`)
    if (stuck > 0) parts.push(`停滞 ${stuck} 件`)

    return `進捗: ${parts.join(' · ')}`
  },
  pillOpen: '開く',
  commandFill: '進捗ペインを開きました。Claude に作業の調査と記入を依頼します。',
  commandUpdate: '進捗ペインを開きました。Claude に最新化を依頼します。',
  barAlt: percent => `進捗バー: ${percent}% 完了`,
  dividerAlt: '区切り線',
}

const TABLES: Record<Lang, Strings> = { en, ja }

export const strings = (lang: Lang): Strings => TABLES[lang]

/** A length of time: `25m`, `2h05m`, `4d10h`. Never a clock time. */
export function duration(ms: number, t: Strings): string {
  const safe = Math.max(0, ms)
  if (safe < MINUTE) return t.underMinute
  if (safe < HOUR) return t.minutes(Math.floor(safe / MINUTE))
  if (safe < DAY) {
    return t.hoursMinutes(
      Math.floor(safe / HOUR),
      Math.floor((safe % HOUR) / MINUTE),
    )
  }

  return t.daysHours(Math.floor(safe / DAY), Math.floor((safe % DAY) / HOUR))
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `11/06`, in local time. */
export function monthDay(ms: number): string {
  const date = new Date(ms)

  return `${two(date.getMonth() + 1)}/${two(date.getDate())}`
}

/** `14:05`, in local time. */
export function clockTime(ms: number): string {
  const date = new Date(ms)

  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** An activity entry's time: `14:05` for today, `11/06 14:05` for another day. */
export function stamp(ms: number, now: number): string {
  return monthDay(ms) === monthDay(now) && Math.abs(now - ms) < DAY
    ? clockTime(ms)
    : `${monthDay(ms)} ${clockTime(ms)}`
}

/** Calendar time since the start. Past a day it also says since when: `4d10h since 11/06`. */
export function elapsedText(
  startedAt: number,
  until: number,
  t: Strings,
): string {
  const ms = Math.max(0, until - startedAt)
  const length = duration(ms, t)

  return ms > DAY ? t.elapsedSince(length, monthDay(startedAt)) : t.elapsed(length)
}
