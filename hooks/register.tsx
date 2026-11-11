import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Limit, Step, Totals } from '../types'

const PANE = 'usage-stats'
const TITLE = 'Usage'
const ZERO: Totals = { tokens: 0, ms: 0, usd: 0, turns: 0 }

const last = atom({ plugin: 'usage-stats', key: 'last' } as const, ZERO, { shape: 't1' })
const task = atom({ plugin: 'usage-stats', key: 'task' } as const, ZERO, { shape: 't1' })
const project = atom({ plugin: 'usage-stats', key: 'project' } as const, ZERO, { shape: 't1' })
const week = atom({ plugin: 'usage-stats', key: 'week' } as const, ZERO, { shape: 't1' })
const projectName = atom({ plugin: 'usage-stats', key: 'projectName' } as const, '')
const limits = atom({ plugin: 'usage-stats', key: 'limits' } as const, [], { shape: 'l1' })
const plan = atom({ plugin: 'usage-stats', key: 'plan' } as const, [], { shape: 's1' })
// idle (no bar), work (red scanner), wait (red: turn ended, background agents still run),
// done (green), ask (orange: a question waits for the person)
const status = atom({ plugin: 'usage-stats', key: 'status' } as const, 'idle')
// The agents started since the person's last message, in start order.
const agents = atom({ plugin: 'usage-stats', key: 'agents' } as const, [], { shape: 'a1' })

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
// Tools that stop and wait for the person's answer.
const ASK_TOOLS = /^(AskUserQuestion|ExitPlanMode)$/

// Knight Rider scanner, drawn as one SVG the desktop animates itself (SMIL), so no redraw per frame:
// a beveled housing, a recessed slot of LED cells, a light that sweeps both ways with a fading trail,
// bloom between the cells and a glass highlight on top. Solid green when done, breathing amber when asked.
const SCAN_PX = { width: 168, height: 20 }
const TONES = {
  work: { core: '#fff3ea', hot: '#ff2414', deep: '#7a0700', off: '#2a0504' },
  done: { core: '#effff4', hot: '#25e06a', deep: '#0a6a2c', off: '#062612' },
  ask: { core: '#fff7e6', hot: '#ffa20f', deep: '#7d4600', off: '#2b1802' },
}
function scannerSvg(state: string): string {
  const t = TONES[state as keyof typeof TONES] ?? TONES.work
  const W = 336
  const H = 40
  const n = 20
  const x0 = 14
  const x1 = W - 14
  const gap = 2.4
  const cw = (x1 - x0 - gap * (n - 1)) / n
  const cy = 11
  const ch = 18
  const cells = Array.from({ length: n }, (_, i) =>
    `<rect x="${(x0 + i * (cw + gap)).toFixed(2)}" y="${cy}" width="${cw.toFixed(2)}" height="${ch}" rx="2.2"/>`).join('')
  const sweep = (delay: number, opacity: number) =>
    `<g opacity="${opacity}"><ellipse cx="0" cy="${H / 2}" rx="34" ry="15" fill="url(#halo)"/><ellipse cx="0" cy="${H / 2}" rx="11" ry="8" fill="url(#core)"/>` +
    `<animateTransform attributeName="transform" type="translate" values="${x0 + cw / 2};${x1 - cw / 2};${x0 + cw / 2}" keyTimes="0;0.5;1" ` +
    `calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1" dur="1.9s" begin="-${delay}s" repeatCount="indefinite"/></g>`
  const light =
    state === 'work'
      ? [0.32, 0.24, 0.16, 0.08, 0].map((d, i) => sweep(d, [0.12, 0.22, 0.38, 0.6, 1][i] ?? 1)).join('')
      : `<rect x="${x0}" y="${cy}" width="${x1 - x0}" height="${ch}" fill="url(#full)">` +
        (state === 'ask' ? '<animate attributeName="opacity" values="1;0.5;1" dur="1.6s" repeatCount="indefinite"/>' : '') +
        '</rect>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
<linearGradient id="case" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4a52"/><stop offset="0.18" stop-color="#26262b"/><stop offset="0.55" stop-color="#121215"/><stop offset="1" stop-color="#2c2c32"/></linearGradient>
<linearGradient id="bevel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.6"/></linearGradient>
<linearGradient id="slot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="0.5" stop-color="#0a0a0c"/><stop offset="1" stop-color="#18181c"/></linearGradient>
<linearGradient id="off" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.off}"/><stop offset="0.5" stop-color="#050505"/><stop offset="1" stop-color="${t.off}"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${t.hot}"/><stop offset="0.45" stop-color="${t.hot}" stop-opacity="0.75"/><stop offset="1" stop-color="${t.deep}" stop-opacity="0"/></radialGradient>
<radialGradient id="core"><stop offset="0" stop-color="${t.core}"/><stop offset="0.5" stop-color="${t.hot}" stop-opacity="0.9"/><stop offset="1" stop-color="${t.hot}" stop-opacity="0"/></radialGradient>
<linearGradient id="full" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.deep}"/><stop offset="0.35" stop-color="${t.hot}"/><stop offset="0.5" stop-color="${t.core}" stop-opacity="0.85"/><stop offset="0.65" stop-color="${t.hot}"/><stop offset="1" stop-color="${t.deep}"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/><stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<mask id="leds"><rect width="${W}" height="${H}" fill="#000"/><g fill="#fff">${cells}</g></mask>
<clipPath id="inner"><rect x="9" y="7" width="${W - 18}" height="${H - 14}" rx="5"/></clipPath>
<filter id="bloom" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="3.2"/></filter>
<g id="light">${light}</g>
</defs>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="url(#case)" stroke="#000" stroke-width="1.2"/>
<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="9" fill="none" stroke="url(#bevel)" stroke-width="1.4"/>
<rect x="9" y="7" width="${W - 18}" height="${H - 14}" rx="5" fill="url(#slot)" stroke="#000" stroke-opacity="0.9"/>
<g fill="url(#off)">${cells}</g>
<g clip-path="url(#inner)"><g filter="url(#bloom)" opacity="0.7"><use href="#light"/></g></g>
<g mask="url(#leds)"><use href="#light"/></g>
<rect x="10" y="8" width="${W - 20}" height="${(H - 16) / 2}" rx="4" fill="url(#glass)"/>
<rect x="9.5" y="7.5" width="${W - 19}" height="${H - 15}" rx="5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
</svg>`
}

// 'claude-sonnet-5-5' -> 'Sonnet 5.5', 'haiku' -> 'Haiku'; anything else as given.
function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  if (m) return `${cap(m[1] ?? '')} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return /^[a-z]+$/.test(model) ? cap(model) : model
}

const running = (list: AgentRow[]) => list.some(a => a.state === 'run')

// Percent of the task list done (a running step counts half); null without a list.
// While agents still run nothing is finished, so it stops at 99.
function planPct(steps: Step[], busy = false): number | null {
  if (!steps.length) return null
  const done = steps.filter(s => s.status === 'completed').length
  const active = steps.some(s => s.status === 'in_progress') ? 0.5 : 0
  const pct = Math.floor(Math.min(1, (done + active) / steps.length) * 100)
  return busy ? Math.min(pct, 99) : pct
}

// Mirrors the desktop task list tool: a full `items` list, or `advance`, `done` (1-based) and `start` on the current one.
function applyPlan(steps: Step[], input: Record<string, unknown>): Step[] {
  if (Array.isArray(input.items)) {
    return input.items.map(s => ({ content: String(s?.content ?? ''), status: String(s?.status ?? 'pending') }))
  }
  const next = steps.map(s => ({ ...s }))
  const set = (i: number, status: string) => {
    const s = next[i]
    if (s) s.status = status
  }
  if (input.advance === true) {
    set(next.findIndex(s => s.status === 'in_progress'), 'completed')
    set(next.findIndex(s => s.status === 'pending'), 'in_progress')
  }
  if (Array.isArray(input.done)) for (const n of input.done) set(Number(n) - 1, 'completed')
  if (typeof input.start === 'number') set(input.start - 1, 'in_progress')
  return next
}

// Ledger in $.store (shared by every session that loads this mod):
//   l:<sessionId>:<YYYY-MM-DD> -> Entry   (each session writes only its own keys, so no write races)
//   c:<sessionId>              -> last session cost seen, to turn the running total into deltas
type Entry = Totals & { project: string; day: string }

const DAY = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const plus = (a: Totals, b: Partial<Totals>): Totals => ({
  tokens: a.tokens + (b.tokens ?? 0),
  ms: a.ms + (b.ms ?? 0),
  usd: a.usd + (b.usd ?? 0),
  turns: a.turns + (b.turns ?? 0),
})

async function record($: EngineInterface, delta: Partial<Totals>) {
  const id = await $.session.id()
  const root = await $.session.root()
  const day = dayOf(await $.clock.now())
  const key = `l:${id}:${day}`
  const old = ((await $.store.get(key)) as Entry | undefined) ?? { ...ZERO, project: root, day }
  await $.store.set(key, { ...plus(old, delta), project: root, day })
}

// ponytail: reads every ledger key on each refresh; fine for thousands of entries, add per-day rollups if it gets slow
async function refresh($: EngineInterface) {
  const id = await $.session.id()
  const root = await $.session.root()
  const weekStart = dayOf((await $.clock.now()) - 6 * DAY)
  let t = ZERO
  let p = ZERO
  let w = ZERO
  for (const key of await $.store.keys()) {
    if (!key.startsWith('l:')) continue
    const e = (await $.store.get(key)) as Entry | undefined
    if (!e) continue
    if (key.startsWith(`l:${id}:`)) t = plus(t, e)
    if (e.project === root) p = plus(p, e)
    if (e.day >= weekStart) w = plus(w, e)
  }
  await update($, task, () => t)
  await update($, project, () => p)
  await update($, week, () => w)
  await update($, projectName, () => root.split(/[\\/]/).filter(Boolean).pop() ?? root)
}

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}
const fmtUsd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
const fmtLeft = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const left = Date.parse(iso) - now
  if (!(left > 0)) return ''
  const h = Math.floor(left / 3_600_000)
  return h >= 24 ? ` · resets ${Math.floor(h / 24)}d ${h % 24}h` : ` · resets ${h}h ${Math.floor((left % 3_600_000) / 60_000)}m`
}
const LIMIT_NAMES: Record<string, string> = {
  seven_day: 'Weekly',
  five_hour: '5-hour',
  spend_limit: 'Spend',
}

export const register: Register = on => {
  // Tokens and turns of the main turn plus any subagents since the last main turn ended.
  let pending: Totals = ZERO
  let askAfter = false
  // Efforts the Agent calls asked for, by description, until their spawn picks them up.
  const efforts = new Map<string, string[]>()

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn the person started gets a fresh task list; a continuation keeps it.
      if (e.text) {
        await update($, plan, () => [])
        await update($, agents, () => [])
      }
      await update($, status, () => 'work')
    }
    return next(e)
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    await update($, plan, steps => applyPlan(steps ?? [], input))
    return next(e)
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    await update($, plan, steps => (steps ?? []).map(s => ({ ...s, status: 'completed' })))
    // A wrap-up that asks something leaves the turn waiting on the person.
    if ((e as unknown as { ask?: string }).ask) askAfter = true
    return next(e)
  })

  on('tool.call', { tool: ASK_TOOLS }, async ($, e, next) => {
    await update($, status, () => 'ask')
    try {
      return await next(e)
    } finally {
      await update($, status, s => (s === 'ask' ? 'work' : s))
    }
  })

  // The desktop never raises the hint line under the prompt; these two are the spots it draws.
  // Band above the prompt, while a turn runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Reads neither clock nor elapsed time, so it redraws only when the state or the list changes.
    const [raw, steps, ags] = await Promise.all([read($, status), read($, plan), read($, agents)])
    if (raw === 'idle') return next(e)
    // 'wait': the main turn ended but background agents still run; drawn as work.
    const state = raw === 'wait' ? 'work' : raw
    const pct = state === 'done' ? 100 : planPct(steps, running(ags))
    const label = pct === null ? '' : `${pct}%`
    if (e.surface === 'terminal') {
      // ponytail: the terminal has no Svg; a plain colored bar there
      const { Text } = $.ui.resolve(e)
      const color = state === 'done' ? '#25e06a' : state === 'ask' ? '#ffa20f' : '#ff2414'
      return <Text><Text color={color}>{'▬'.repeat(12)}</Text>{label ? ` ${label}` : ''}</Text>
    }
    const { Box, Svg, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="scanner" source={scannerSvg(state)} alt={`Status: ${state}`} isInteractive width={SCAN_PX.width} height={SCAN_PX.height} />
        {label ? <Text bold>{label}</Text> : null}
      </Box>
    )
  })

  // The working spinner row: the percent done after the app's own words.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const [state, steps, ags] = await Promise.all([read($, status), read($, plan), read($, agents)])
    const pct = state === 'idle' ? null : planPct(steps, running(ags))
    return pct === null ? next(e) : next({ ...e, props: { ...e.props, suffix: ` · ${pct}%` } })
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-stats', description: 'Show the usage stats pane' })
    void $.ui.open({ id: PANE, title: TITLE, columns: 30, rows: 7 })
    void refresh($)
    // Other sessions add to project and week totals; pick those up now and then.
    $.clock.every(60_000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'usage-stats' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE, columns: 30, rows: 7 })
    return { text: 'Usage stats pane opened.' }
  })

  // The Agent call carries the effort asked for; the spawn below carries the model it really runs on.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as { description?: string; effort?: string | number }
    if (input.description && input.effort !== undefined) {
      const list = efforts.get(input.description) ?? []
      list.push(String(input.effort))
      efforts.set(input.description, list)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      const effort = e.fork ? 'fork' : efforts.get(e.description)?.shift() ?? 'default'
      const row: AgentRow = { id: r.agentId, name: e.description || e.subagentType, model: modelName(r.model), effort, state: 'run', tokens: 0, ms: 0 }
      await update($, agents, list => [...(list ?? []).filter(a => a.id !== row.id), row])
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const tokens = u
      ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      : 0
    const isMain = e.agentId === undefined
    // Subagents run inside the main turn, so only the main loop's wall clock counts as time.
    const delta: Partial<Totals> = isMain ? { tokens, ms: e.durationMs, turns: 1 } : { tokens }
    pending = plus(pending, delta)
    if (!isMain) {
      const id = e.agentId
      await update($, agents, list =>
        (list ?? []).map(a => (a.id === id ? { ...a, state: 'done', tokens: a.tokens + tokens, ms: a.ms + e.durationMs } : a)))
      // The main turn ended while this agent ran: green once the last one is back.
      if (!running(await read($, agents))) await update($, status, s => (s === 'wait' ? 'done' : s))
    }
    if (isMain) {
      // Background agents still running: the task is not finished, keep the red sweep.
      const end = e.isAborted ? 'idle' : askAfter ? 'ask' : running(await read($, agents)) ? 'wait' : 'done'
      await update($, status, () => end)
      askAfter = false
      const done = pending
      pending = ZERO
      await update($, last, () => done)
    }
    await record($, delta)
    await refresh($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length) await update($, limits, () => e.rateLimits.map(r => ({ ...r })))
    if (e.cost) {
      const id = await $.session.id()
      const seen = Number((await $.store.get(`c:${id}`)) ?? 0)
      // A lower total means the host restarted its count (new process): count it all as new.
      const usd = e.cost.usd >= seen ? e.cost.usd - seen : e.cost.usd
      await $.store.set(`c:${id}`, e.cost.usd)
      if (usd > 0) {
        await record($, { usd })
        await update($, last, l => plus(l ?? ZERO, { usd }))
        await refresh($)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const [l, t, p, w, name, lim, ags] = await Promise.all([
      read($, last),
      read($, task),
      read($, project),
      read($, week),
      read($, projectName),
      read($, limits),
      read($, agents),
    ])
    // One line per total: label, est. API cost, then tokens and time dimmed.
    const row = (label: string, v: Totals) => (
      <Text>
        <Text bold>{label.padEnd(8)}</Text>
        {fmtUsd(v.usd).padStart(6)}
        <Text dimColor>
          {'  '}
          {fmtTokens(v.tokens)} · {fmtTime(v.ms)}
        </Text>
      </Text>
    )
    return (
      <Box flexDirection="column">
        {lim.map((r: Limit) => (
          <Text>
            <Text bold>{LIMIT_NAMES[r.kind] ?? r.kind}</Text> {r.percentUsed}%
            <Text dimColor>{fmtLeft(r.resetsAt, now)}</Text>
          </Text>
        ))}
        {row('Week', w)}
        {row('Project', p)}
        {row('Task', t)}
        {row('Last', l)}
        <Text dimColor>est. API cost{name ? ` · ${name}` : ''}</Text>
        {ags.length ? (
          <Box marginTop={1}>
            <Text bold>Agents</Text>
          </Box>
        ) : null}
        {ags.map((a: AgentRow) => (
          <Text>
            <Text color={a.state === 'run' ? '#ff2414' : '#25e06a'}>{a.state === 'run' ? '●' : '✓'}</Text>{' '}
            {a.name.length > 18 ? a.name.slice(0, 17) + '…' : a.name.padEnd(18)}{' '}
            <Text bold>{a.model}</Text> · {a.effort}
            {a.state === 'done' ? <Text dimColor>{'  '}{fmtTokens(a.tokens)} · {fmtTime(a.ms)}</Text> : null}
          </Text>
        ))}
      </Box>
    )
  })
}
