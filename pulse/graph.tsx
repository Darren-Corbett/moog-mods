import type { ClientModule, ClientSurface } from 'claude-code'

import * as L from './logic'

// The animated graph: a Client surface module. It keeps eased heights, hover and
// the keyboard's column in its own state, and posts clicks to the hooks module.
// All the shaping lives in logic.ts; this file only wires input and draws runs.

type State = L.Frame & { clock: { stop: (() => void) | null }; pointer: L.PointerSlot }
type Surface = ClientSurface<State>

// Never wider or taller than the region the hooks module asked for.
function measure(s: Surface, f: L.Frame) {
  const { columns, rows } = f.props
  return L.layout(s.columns > 0 ? Math.min(s.columns, columns) : columns, s.rows > 0 ? Math.min(s.rows, rows) : rows, f.props.steps.length)
}

function startClock(s: Surface, clock: State['clock']) {
  if (clock.stop) return
  clock.stop = s.every(L.FRAME_MS, () => {
    const now = s.state
    if (!now) return
    const l = measure(s, now)
    const next = L.advance(now, l)
    if (L.isSettled(next, l)) {
      clock.stop?.()
      clock.stop = null
    }
    s.setState({ ...next, clock, pointer: now.pointer })
  })
}

function onPointer(s: Surface, e: L.PointerInput) {
  const f = s.state
  if (!f) return
  const l = measure(s, f)
  const out = L.pointerOutcome(f, l, e)
  if (out.pin) s.post({ type: 'pin', pin: out.pin })
  if (out.resize) s.post({ type: 'resize', by: out.resize })
  // Letting go drops the listener; the redraw below sets a fresh one.
  if (out.release) L.releasePointer(f.pointer)
  const probe = f.props.debug ? { x: e.x, y: e.y, target: L.targetAt(f, l, e.x, e.y) } : f.probe
  if (out.release || probe !== f.probe || !L.sameHover(out.hover, f.hover)) s.setState({ ...f, hover: out.hover, probe })
}

function listen(s: Surface) {
  s.onKey(e => {
    const f = s.state
    if (!f) return
    const l = measure(s, f)
    const last = l.visible - 1
    if (e.key === 'left' || e.key === 'right') {
      const from = f.selected ?? last
      const selected = Math.max(0, Math.min(last, from + (e.key === 'left' ? -1 : 1)))
      s.setState({ ...f, selected, hover: null })
    } else if (e.key === 'return') {
      const col = L.visibleColumns(f, l)[f.selected ?? last]
      if (col) s.post({ type: 'pin', pin: { kind: 'column', at: col.at, span: L.columnWindow(f, l).span } })
    } else if (e.key === '-' || e.key === '+' || e.key === '=') {
      s.post({ type: 'resize', by: e.key === '-' ? -1 : 1 })
    }
  })
}

const Graph: ClientModule = (raw, surface) => {
  const s = surface as Surface
  const props = raw as unknown as L.GraphProps
  const { Box, Text } = s.elements
  let f = s.state

  if (f === undefined) {
    // First call: set up input and the frame clock once, then draw from a fresh frame.
    const clock: State['clock'] = { stop: null }
    const pointer: L.PointerSlot = { clear: null }
    listen(s)
    s.post({ type: 'ready' })
    f = { ...L.newFrame(props), clock, pointer }
    if (!L.isSettled(f, measure(s, f))) startClock(s, clock)
    s.setState(f as State)
  } else if (f.props !== props) {
    f = { ...L.withProps(f, props), clock: f.clock, pointer: f.pointer }
    if (!L.isSettled(f, measure(s, f))) startClock(s, f.clock)
    s.setState(f as State)
  }
  // With the mouse off no pointer listener is set at all.
  L.syncPointer(s.onPointer, f.pointer, f.props.mouse, (e: L.PointerInput) => onPointer(s, e))

  const l = measure(s, f)
  const now = L.frameNow(f)
  const head = L.headerParts(f.props.job, now)
  const header = L.headerText(head, l.columns)
  const phase = f.props.job.phase
  const isPulseDim = phase === 'working' && Math.floor(f.tick / 5) % 2 === 1
  const pinned = f.props.pinned
  const cols = L.visibleColumns(f, l)
  const { span } = L.columnWindow(f, l)
  const highlightAt = pinned?.kind === 'column' ? pinned.at : f.hover?.kind === 'column' ? f.hover.at : f.selected !== null ? cols[f.selected]?.at : undefined
  const highlight = highlightAt === undefined ? null : cols.findIndex(b => b.at <= highlightAt && highlightAt < b.at + span)
  const stepHighlight = pinned?.kind === 'step' ? pinned.id : f.hover?.kind === 'step' ? f.hover.id : null
  const detail = L.detailLine(f, l)
  const label = L.stepLabel(f.props.steps)
  const rate = L.legendRate(l.columns, L.callsPerMinute(f.props.buckets, L.jobNow(f.props.job, now)))
  const runs = (list: L.Run[]) => list.map(r => <Text color={r.color} dimColor={r.isDim} inverse={r.isInverse}>{r.text}</Text>)

  return (
    <Box flexDirection="column" width={l.columns}>
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          {header.lead && <Text bold>{header.lead}</Text>}
          <Text color={L.PHASE_TONE[phase]} dimColor={isPulseDim}>●</Text>
          <Text color={l.hasLegend ? L.PHASE_TONE[phase] : undefined}>{header.tail}</Text>
        </Box>
        <Text dimColor>{L.CONTROLS.narrower} {L.CONTROLS.wider}</Text>
      </Box>
      {Array.from({ length: l.waveRows }, (_, row) => (
        <Box key={`wave-${row}`} flexDirection="row">{runs(L.waveRow(f, l, row, highlight))}</Box>
      ))}
      {f.props.steps.length > 0 ? (
        <Box key="steps" flexDirection="row">
          {runs(L.stepRuns(f, l, stepHighlight))}
          <Text dimColor wrap="truncate-end">{L.fit(`  ${label}`, l.columns - l.barWidth)}</Text>
        </Box>
      ) : (
        <Box key="steps"><Text dimColor wrap="truncate-end">{L.fit(head.elapsed ? `no task list · ${head.elapsed}` : 'waiting for a job', l.columns)}</Text></Box>
      )}
      {l.hasLegend && (
        <Box key="legend" flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            {L.KINDS.map((k, i) => (
              <Text>{i > 0 ? ' ' : ''}<Text color={L.KIND_COLOR[k]}>■</Text> {k}</Text>
            ))}
          </Box>
          {rate && <Text dimColor>{rate}</Text>}
        </Box>
      )}
      <Box key="rule"><Text dimColor>{'─'.repeat(l.columns)}</Text></Box>
      <Box key="detail">
        <Text wrap="truncate-end" bold={detail.isPinned}>
          {detail.isPinned ? '◆ ' : '▸ '}{L.fit(detail.text, l.columns - 2)}
        </Text>
      </Box>
    </Box>
  )
}

export default Graph
