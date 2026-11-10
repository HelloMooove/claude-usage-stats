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

test('the band and the spinner show the percent of the task list done', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-10T12:00:00Z') }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'Spinner' ? `Working${(e.props as { suffix: string }).suffix}` : 'engine'}</Text>
  })
  const spinner = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ plugin: 'usage-stats', surface, component: 'Spinner', requestId: 'main',
      props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } })
    const text = (await ui.find({ type: 'Text' }))?.text ?? ''
    await ui.unmount()
    return text
  }

  await $.turn.start({ text: 'build it', turnId: 't1' })
  expect(await spinner('desktop')).toBe('Working…') // no task list: the app's own suffix
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'Read code', status: 'in_progress' },
    { content: 'Write code', status: 'pending' },
    { content: 'Test', status: 'pending' },
    { content: 'Ship', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  // Step 1 of 4 done, step 2 running: 37%.
  await $.turn.start({ text: '', turnId: 't2' }) // a continuation keeps the list

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'usage-stats', surface, component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } as never })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => t.includes('37%'))).toBe(true)
    await band.unmount()
    expect(await spinner(surface)).toBe('Working · 37%')
  }
})

test('the scanner: red sweep while working, green when finished, amber when a question waits', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-10T12:00:00Z') }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-stats', surface: 'desktop', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } as never })
    const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return { svg, texts }
  }
  const complete = () => $.turn.complete({ answer: '', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect((await band()).svg).toBe('') // idle: no bar
  await $.turn.start({ text: 'go', turnId: 't1' })
  let b = await band()
  expect(b.svg).toContain('#ff2414')
  expect(b.svg).toContain('animateTransform') // the sweep
  expect(b.texts).toEqual([]) // no list yet: no percent

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } as never)
  expect((await band()).texts).toContain('50%')

  await complete()
  b = await band()
  expect(b.svg).toContain('#25e06a')
  expect(b.svg).not.toContain('animate')
  expect(b.texts).toContain('100%')

  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Ship it?' } as never)
  await complete()
  b = await band()
  expect(b.svg).toContain('#ffa20f')
  expect(b.svg).toContain('attributeName="opacity"') // breathing
})

test('the pane lists the agents of the task with the model they run on and their effort', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: '/p' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-10T12:00:00Z') }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  let n = 0
  const models: Record<string, string> = { 'Find auth code': 'claude-haiku-5-5', 'Write tests': 'claude-sonnet-5-5' }
  on('agent.spawn', (_, e) => ({ model: models[e.description] ?? 'claude-opus-5-5', agentId: `a${++n}` }))
  const spawn = (description: string) =>
    $.agent.spawn({ prompt: 'p', description, subagentType: 'general-purpose', provider: 'core', parentModel: 'claude-fable-5-2', background: true, fork: false } as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Agent', description: 'Find auth code', prompt: 'p', effort: 'high' } as never)
  await spawn('Find auth code')
  await spawn('Write tests') // no effort asked: the default applies
  await $.turn.complete({ answer: '', durationMs: 40_000, isAborted: false, turnId: 'x1', reason: 'answer', agentId: 'a1',
    usage: { model: 'm', input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })

  const ui = await $.ui.mount({ plugin: 'usage-stats', surface: 'desktop', component: 'Pane', requestId: 'usage-stats',
    props: { title: 'Usage', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  expect(texts).toContain('Agents')
  expect(texts).toContain('✓ Find auth code     Haiku 5.5 · high  120.0k · 40s')
  expect(texts).toContain('● Write tests        Sonnet 5.5 · default')

  // The person's next message starts a fresh list.
  await $.turn.start({ text: 'next', turnId: 't2' })
  const again = await $.ui.mount({ plugin: 'usage-stats', surface: 'desktop', component: 'Pane', requestId: 'usage-stats',
    props: { title: 'Usage', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect((await again.findAll({ type: 'Text' })).map(t => t.text)).not.toContain('Agents')
  await again.unmount()
})
