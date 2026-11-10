import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-stats',
  component: 'Pane',
  requestId: 'usage-stats',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a turn and its cost land in task, project and week', async ($, on) => {
  const store = new Map<string, unknown>([
    // Another session of the same project, today, and an old session of another project.
    ['l:other:2026-11-10', { project: '/p', day: '2026-11-10', tokens: 1000, ms: 60_000, usd: 1, turns: 1 }],
    ['l:old:2026-01-01', { project: '/q', day: '2026-01-01', tokens: 5, ms: 5, usd: 5, turns: 1 }],
  ])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: '/p' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-10T12:00:00Z') }))
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.turn.complete({
    answer: 'hi',
    durationMs: 90_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { model: 'm', input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 700, cache_creation_input_tokens: 0 },
  })
  await $.session.measure({ context: { contextWindow: 200_000 } as never, rateLimits: [{ kind: 'seven_day', percentUsed: 42 }], cost: { usd: 0.5 }, changed: ['cost'] })
  // The same running total measured again adds nothing.
  await $.session.measure({ context: { contextWindow: 200_000 } as never, rateLimits: [], cost: { usd: 0.5 }, changed: ['cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Weekly/ }))?.text).toContain('42%')
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // One line each, in order: week, project, task, last turn.
    const rows = texts.filter(t => /^(Week|Project|Task|Last) +\$/.test(t))
    expect(rows).toEqual([
      'Week     $1.50  2.0k · 2m 30s',
      'Project  $1.50  2.0k · 2m 30s',
      'Task     $0.50  1.0k · 1m 30s',
      'Last     $0.50  1.0k · 1m 30s',
    ])
    expect(texts).toContain('est. API cost · p')
    await ui.unmount()
  }
})

test('the band above the prompt and the spinner show task list progress', async ($, on) => {
  let now = Date.parse('2026-11-10T12:00:00Z')
  on('clock.now', () => ({ value: now }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'Spinner' ? `Working${(e.props as { suffix: string }).suffix}` : 'engine'}</Text>
  })

  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'Read code', status: 'in_progress' },
    { content: 'Write code', status: 'pending' },
    { content: 'Test', status: 'pending' },
    { content: 'Ship', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  now += 60_000
  // Step 1 of 4 done, step 2 running: 37%, and 60s for 37.5% leaves ~1m 40s.
  await $.turn.start({ text: '', turnId: 't2' }) // a continuation keeps the list and the clock
  const want = '37% · step 2/4: Write code · 1m 0s · ~1m 40s left'

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'usage-stats', surface, component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } as never })
    expect((await band.find({ type: 'Text' }))?.text ?? '').toContain(want)
    await band.unmount()
    const spin = await $.ui.mount({ plugin: 'usage-stats', surface, component: 'Spinner', requestId: 'main',
      props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } })
    expect((await spin.find({ type: 'Text' }))?.text ?? '').toContain(`Working · ██`)
    await spin.unmount()
  }
})
