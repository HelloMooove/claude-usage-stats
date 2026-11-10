export type Totals = { tokens: number; ms: number; usd: number; turns: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Step = { content: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      last: Shaped<Totals>
      task: Shaped<Totals>
      project: Shaped<Totals>
      week: Shaped<Totals>
      projectName: string
      limits: Shaped<Limit[]>
      plan: Shaped<Step[]>
      turnStart: number
      now: number
      status: string
    }
  }
}
