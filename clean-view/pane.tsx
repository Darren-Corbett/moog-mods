import type { EngineInterface as Dollar, RenderInput } from 'claude-code'

import * as L from './logic'
import type { Checklist, JobRecord, Mode } from './types'

// Drawing for the progress pane. Everything it shows comes from logic.ts.

export const PANE_ID = 'clean-view-progress'
export const OFF_LINE = 'Clean View is off. Run /clean band to turn it back on.'

export type PaneView = { mode: Mode; checklist: Checklist; history: readonly JobRecord[]; now: number }

const ACCENT = 'claude'
// Rows outside the timeline: header, progress label and bar, active-step detail, gaps.
const FIXED_ROWS = 10

export function drawPane($: Dollar, e: RenderInput<'Pane'>, v: PaneView) {
  const { Box, Text } = $.ui.resolve(e)
  const cols = Math.max(20, e.props?.bodyColumns ?? 60)
  const bodyRows = Math.max(8, e.props?.scroll?.bodyRows ?? 30)
  const line = (s: string) => L.fit(s, cols)
  if (v.mode === 'off') return <Box flexDirection="column"><Text dimColor wrap="truncate-end">{line(OFF_LINE)}</Text></Box>

  const c = L.normalizeChecklist(v.checklist)
  const history = L.normalizeHistory(v.history)
  const isJob = c.phase !== 'idle' && c.startedAt !== null
  const done = c.tasks.filter(t => t.status === 'done').length
  const active = c.tasks.find(t => t.status === 'active')
  const badge = isJob ? L.PHASE_BADGE[c.phase] : ''
  const elapsed = isJob ? L.duration(L.jobMs(c, v.now)) : ''
  const tone = c.phase === 'needs-you' || c.phase === 'stuck' || c.phase === 'error' ? 'warning' : c.phase === 'done' ? 'success' : ACCENT

  // Recent jobs give way first when the pane is short; the timeline keeps at least 3 rows.
  const recentRows = history.length ? history.length + 2 : 0
  const showRecent = bodyRows - FIXED_ROWS - recentRows >= 3
  const room = Math.max(3, bodyRows - FIXED_ROWS - (showRecent ? recentRows : 0))

  const columns = L.timelineColumns(cols)
  const rows = L.timelineRows(c, v.now, columns.bar)
  const shown = L.windowRows(rows, c.tasks.findIndex(t => t.status === 'active'), room)
  const detail = active ? L.touchedLines(active.touched) : null
  const last = c.lastCall

  const timeline = () => {
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const width = Math.max(320, Math.min(900, cols * 8))
      return <Svg source={L.timelineSvg(shown.rows, width)} alt={L.timelineAlt(shown.rows)} />
    }
    return (
      <Box flexDirection="column">
        {shown.rows.map((r, i) => {
          const isActive = r.status === 'active'
          const isDim = !isActive
          return (
            <Box key={`row-${i}`} flexDirection="row">
              <Text color={r.status === 'done' ? 'success' : isActive ? ACCENT : undefined} bold={isActive}>{r.mark} </Text>
              <Text bold={isActive} dimColor={isDim} wrap="truncate-end">{L.fit(r.name, columns.name).padEnd(columns.name)} </Text>
              {columns.bar > 0 && (
                <Text color={isActive ? ACCENT : 'success'} dimColor={r.status === 'done'} wrap="truncate-end">
                  {L.barText(r.cells, isActive).padEnd(columns.bar)} </Text>
              )}
              {r.time && <Text dimColor={isDim} wrap="truncate-end">{L.fit(r.time, columns.time).padEnd(columns.time)}</Text>}
              {r.failures > 0 && <Text color="error" wrap="truncate-end">{L.fit(` ${L.failureText(r.failures)}`, columns.fail)}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold wrap="truncate-end">{L.fit(L.jobTitle(c), Math.max(8, cols - badge.length - elapsed.length - 6))}</Text>
        {badge && <Text color={tone} bold>  {badge}</Text>}
        {elapsed && <Text dimColor>  {elapsed}</Text>}
      </Box>
      {c.phase === 'error' && c.errorText && <Text color="error" wrap="truncate-end">{line(`⚠ ${c.errorText}`)}</Text>}
      {c.phase === 'needs-you' && c.needsYouReason && <Text color="warning" wrap="truncate-end">{line(c.needsYouReason)}</Text>}
      {isJob && c.tasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{done} of {c.tasks.length} steps</Text>
          <Text color={ACCENT}>{L.progressBar(done, c.tasks.length, cols)}</Text>
        </Box>
      )}
      {isJob && c.tasks.length === 0 && (
        <Box marginTop={1}><Text dimColor wrap="truncate-end">{line(`No task list yet · ${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'}`)}</Text></Box>
      )}
      {!isJob && <Text dimColor wrap="truncate-end">{line('Clean View fills this in once Claude starts working.')}</Text>}
      {isJob && c.tasks.length > 0 && <Box marginTop={1} flexDirection="column">
        {timeline()}
        {shown.hidden > 0 && <Text dimColor>+{shown.hidden} more steps</Text>}
      </Box>}
      {isJob && (detail || last) && (
        <Box marginTop={1} flexDirection="column">
          {detail?.edited && <Text color={ACCENT} wrap="truncate-end">{line(detail.edited)}</Text>}
          {detail?.read && <Text dimColor wrap="truncate-end">{line(detail.read)}</Text>}
          {detail?.searches && <Text dimColor wrap="truncate-end">{line(detail.searches)}</Text>}
          {last && <Text dimColor wrap="truncate-end">{line(`Last: ${last.tool}${last.summary ? ` · ${last.summary}` : ''} · ${L.ago(v.now - last.at)}`)}</Text>}
        </Box>
      )}
      {showRecent && history.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Recent jobs</Text>
          {history.map(r => <Text dimColor wrap="truncate-end">{line(L.historyLine(r))}</Text>)}
        </Box>
      )}
    </Box>
  )
}
