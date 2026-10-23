export type Mode = 'focus' | 'band' | 'calm' | 'off'

export type TaskStatus = 'done' | 'active' | 'upcoming'

export type Task = {
  id: string
  name: string
  status: TaskStatus
  startedAt: number | null
  endedAt: number | null
  toolCalls: number
  failures: number
  touched: Touched
}

export type Touched = { read: string[]; edited: string[]; searches: string[] }

export type Phase =
  | 'idle'
  | 'working'
  | 'planning'
  | 'needs-you'
  | 'stuck'
  | 'stopped'
  | 'done'
  | 'error'

export type Checklist = {
  title: string
  phase: Phase
  tasks: Task[]
  needsYouReason: string | null
  stuckReason: string | null
  errorText: string | null
  errorType: string | null
  startedAt: number | null
  finishedAt: number | null
  isCollapsed: boolean
  toolCalls: number
  failStreak: number
  lastCall: { tool: string; summary: string; at: number } | null
}

export type JobOutcome = 'done' | 'stopped' | 'stuck' | 'error'

// `startedAt` identifies the job, so a resumed job replaces its own entry.
export type JobRecord = { title: string; outcome: JobOutcome; durationMs: number; steps: number; startedAt: number }

export type Folded = {
  files: string[]
  searches: string[]
  hosts: string[]
  count: number
  beforeEdit: string[]
  ids: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      mode: Mode
      checklist: Checklist
      folded: Folded
      errors: string[]
      now: number
      isUnfolded: boolean
      history: JobRecord[]
      isPaneOpen: boolean
    }
  }
}
