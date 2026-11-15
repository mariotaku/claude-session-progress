import { expect, test } from 'claude-code/testing'

import { TOOL_DESCRIPTION, fillRequest } from '../hooks/claude-text'
import { duration, elapsedText, langOf, strings } from '../hooks/i18n'

const JAPANESE = /[぀-ヿ一-鿿]/
const MIN = 60_000

test('the language setting picks the language', () => {
  for (const setting of ['japanese', 'Japanese', '日本語', 'ja', ' JA ']) {
    expect(langOf(setting), setting).toBe('ja')
  }
  for (const setting of ['english', 'french', 'jp', '', undefined, null, 7]) {
    expect(langOf(setting), String(setting)).toBe('en')
  }
})

test('durations read as a length of time, never a clock time', () => {
  const en = strings('en')
  const ja = strings('ja')

  expect(duration(20_000, en)).toBe('<1m')
  expect(duration(25 * MIN, en)).toBe('25m')
  expect(duration(125 * MIN, en)).toBe('2h05m')
  expect(duration(120 * MIN, en)).toBe('2h')
  expect(en.left(duration(25 * MIN, en))).toBe('~25m left')
  expect(ja.left(duration(25 * MIN, ja))).toBe('残り約25分')
  expect(en.left(duration(125 * MIN, en))).not.toContain(':')
})

test('elapsed time past a day says since when', () => {
  const start = new Date(2026, 10, 6, 9, 0).getTime()
  const now = new Date(2026, 10, 10, 19, 0).getTime()

  expect(elapsedText(start, now, strings('en'))).toBe('4d10h since 11/06')
  expect(elapsedText(start, now, strings('ja'))).toBe('経過 4日10時間（11/06 から）')
  expect(elapsedText(now - 90 * MIN, now, strings('en'))).toBe('1h30m elapsed')
})

test('every English string has a Japanese one, and Claude-facing text stays English', () => {
  const en = strings('en')
  const ja = strings('ja')

  expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort())
  expect(ja.needsYou).toMatch(JAPANESE)
  expect(ja.status.stale).toMatch(JAPANESE)
  expect(ja.activity.commit('x')).toMatch(JAPANESE)
  expect(ja.pill(1, 1)).toMatch(JAPANESE)
  expect(ja.emptyBody.join('')).toMatch(JAPANESE)

  expect(TOOL_DESCRIPTION).not.toMatch(JAPANESE)
  expect(fillRequest('mcp__session-progress__progress', '')).not.toMatch(JAPANESE)
})
