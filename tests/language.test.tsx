import { expect, test } from 'claude-code/testing'

import { JAPANESE, PANE, PILL, SURFACES, TOOL, world } from './kit'

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const COMMAND = {
  command: 'progress',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

test('with "japanese", the pane, the pill and the log are in Japanese, and the text Claude reads stays in English', async ($, on) => {
  const w = world(on, { language: 'japanese' })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const empty = await $.ui.mount({ ...PANE, surface })
    expect(await empty.find({ type: 'Text', text: 'まだ何も記録されていません。' })).toBeDefined()
    await empty.unmount()
  }

  const first = await $.command.run(COMMAND)
  expect(first.text).toMatch(JAPANESE)
  await w.clock.advance(1)
  expect(w.prompts[0]).toContain('Fill in the Progress pane')
  expect(w.prompts[0]).not.toMatch(JAPANESE)
  expect(w.opens[0]?.title).toBe('進捗')

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call({
    tool: TOOL,
    start: { title: 'Importer', doneWhen: 'CI is green' },
    tickets: [{ title: 'Mapper', estimate: 60, status: 'working', stage: 'code', progress: 50 }],
    ask: { title: 'Currency?', options: ['EUR', 'Fail'], recommend: 'A' },
    stuck: 'No access',
  })
  expect(String(ran.result)).toContain('Question Q1 is shown to the user')
  expect(String(ran.result)).toContain('is work_around:')
  expect(String(ran.result)).not.toMatch(JAPANESE)

  w.bash['git commit -m x'] = '[main 1a2b3c4] Add mapper'
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: '完了条件: CI is green' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '停滞' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 50% 完了' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^· 残り約\d+分$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '作業中 · code · 50% · 見積 1時間' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '要対応' })).toBeDefined()
    expect((await ui.find({ key: 'answer:Q1:A' }))?.props.label).toBe('A — EUR (推奨)')
    expect((await ui.find({ key: 'tab:tickets' }))?.text).toBe('チケット 1')

    await ui.press({ key: 'tab:activity' })
    expect(await ui.find({ type: 'Text', text: 'コミット: 1a2b3c4 Add mapper' })).toBeDefined()
    await ui.press({ key: 'tab:tickets' })
    await ui.unmount()
  }

  const pill = await $.ui.mount({ ...PILL, surface: 'terminal' })
  expect(await pill.find({ type: 'Text', text: '進捗: 質問 1 件が回答待ち · 停滞 1 件' })).toBeDefined()
  expect((await pill.find({ key: 'open' }))?.props.label).toBe('開く')
  await pill.unmount()

  // The tool's own description is what Claude reads.
  expect(w.tools).toHaveLength(1)
  expect(w.tools[0]?.description).not.toMatch(JAPANESE)

  const second = await $.command.run(COMMAND)
  expect(second.text).toMatch(JAPANESE)
  await w.clock.advance(1)
  expect(w.prompts[1]).toContain('Bring the Progress pane up to date')
  expect(w.prompts[1]).not.toMatch(JAPANESE)
})

test('日本語 and ja give Japanese; anything else gives English', async ($, on) => {
  const w = world(on, { language: '日本語' })
  await $.session.start(START)
  const japanese = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await japanese.find({ type: 'Text', text: 'まだ何も記録されていません。' })).toBeDefined()
  await japanese.unmount()

  // The setting is read again when a turn starts.
  w.language = 'french'
  await $.turn.start({ text: 'go', turnId: 't1' })
  const english = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await english.find({ type: 'Text', text: 'Nothing tracked yet.' })).toBeDefined()
  await english.unmount()

  w.language = 'ja'
  await $.turn.start({ text: 'go', turnId: 't2' })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: 'まだ何も記録されていません。' })).toBeDefined()
  await again.unmount()
})
