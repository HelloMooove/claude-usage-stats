import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Step, Totals } from '../types'

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
const turnStart = atom({ plugin: 'usage-stats', key: 'turnStart' } as const, 0)
const nowAtom = atom({ plugin: 'usage-stats', key: 'now' } as const, 0)

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

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

// ponytail: ETA assumes every step takes as long as the average finished one; the model's steps vary a lot
function progressLine(steps: Step[], elapsedMs: number): string {
  const total = steps.length
  if (!total) return `Working · ${fmtTime(elapsedMs)}`
  const done = steps.filter(s => s.status === 'completed').length
  const activeIdx = steps.findIndex(s => s.status === 'in_progress')
  const frac = Math.min(1, (done + (activeIdx >= 0 ? 0.5 : 0)) / total)
  const width = 10
  const filled = Math.round(frac * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const stepNo = activeIdx >= 0 ? activeIdx + 1 : Math.min(done + 1, total)
  const name = steps[stepNo - 1]?.content ?? ''
  const eta = done > 0 && frac < 1 ? ` · ~${fmtTime((elapsedMs * (1 - frac)) / frac)} left` : ''
  return `${bar} ${Math.floor(frac * 100)}% · step ${stepNo}/${total}: ${name.length > 32 ? name.slice(0, 31) + '…' : name} · ${fmtTime(elapsedMs)}${eta}`
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

// The live line while a turn runs; '' when idle (nowAtom is zeroed at the main turn's end).
async function liveLine($: EngineInterface): Promise<string> {
  const [steps, start, now] = await Promise.all([read($, plan), read($, turnStart), read($, nowAtom)])
  return start && now ? progressLine(steps, Math.max(0, now - start)) : ''
}

export const register: Register = on => {
  // Tokens and turns of the main turn plus any subagents since the last main turn ended.
  let pending: Totals = ZERO
  let ticker: { cancel: () => void } | undefined

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      // A turn the person started gets a fresh task list and clock; a continuation keeps both.
      if (e.text) {
        await update($, plan, () => [])
        await update($, turnStart, () => now)
      } else {
        await update($, turnStart, t => t || now)
      }
      await update($, nowAtom, () => now)
      ticker?.cancel()
      ticker = $.clock.every(1000, async () => {
        const t = await $.clock.now()
        await update($, nowAtom, () => t)
      })
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
    return next(e)
  })

  // The desktop never raises the hint line under the prompt; these two are the spots it draws.
  // Band above the prompt, while a turn runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const line = await liveLine($)
    if (!line) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text>{line}</Text>
  })

  // The working spinner row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const line = await liveLine($)
    return line ? next({ ...e, props: { ...e.props, suffix: ` · ${line}` } }) : next(e)
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

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const tokens = u
      ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      : 0
    const isMain = e.agentId === undefined
    // Subagents run inside the main turn, so only the main loop's wall clock counts as time.
    const delta: Partial<Totals> = isMain ? { tokens, ms: e.durationMs, turns: 1 } : { tokens }
    pending = plus(pending, delta)
    if (isMain) {
      ticker?.cancel()
      ticker = undefined
      await update($, nowAtom, () => 0)
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
    const [l, t, p, w, name, lim] = await Promise.all([
      read($, last),
      read($, task),
      read($, project),
      read($, week),
      read($, projectName),
      read($, limits),
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
      </Box>
    )
  })
}
