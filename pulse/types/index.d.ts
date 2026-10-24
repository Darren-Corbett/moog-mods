export type Phase = 'idle' | 'working' | 'needs-you' | 'stuck' | 'done' | 'stopped'

export type Job = {
  title: string
  phase: Phase
  startedAt: number | null
  finishedAt: number | null
  failStreak: number
}

export type StepStatus = 'done' | 'active' | 'upcoming'

export type Step = {
  id: string
  name: string
  status: StepStatus
  startedAt: number | null
  endedAt: number | null
  calls: number
}

export type Kind = 'read' | 'search' | 'edit' | 'run' | 'fail'

// One time bucket of tool calls; `at` is the bucket's start in ms.
export type Bucket = {
  at: number
  read: number
  search: number
  edit: number
  run: number
  fail: number
  files: string[]
}

// A column's `span` is how many ms it covers; BUCKET_MS when absent.
export type Pinned = { kind: 'column'; at: number; span?: number } | { kind: 'step'; id: string } | null

export type LastCall = { tool: string; summary: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    pulse: {
      job: Job
      steps: Step[]
      buckets: Bucket[]
      pinned: Pinned
      isPaneOpen: boolean
      lastCall: LastCall | null
      clientFault: string | null
      width: number
      mouse: boolean
      mouseDebug: boolean
    }
  }
}
