// Code review rules the main process and the renderer share: reading the
// findings of a ReportFindings call, and where a finding goes next.

import type { Finding, FindingStatus, ReviewFinding, ReviewRole } from './types'

/** The findings of a ReportFindings call's input, most severe first. */
export function parseFindings(input: Record<string, unknown>): Finding[] {
  const list = Array.isArray(input.findings) ? (input.findings as Record<string, unknown>[]) : []
  return list.map((f) => {
    const summary = text(f.summary)
    return {
      file: text(f.file),
      line: typeof f.line === 'number' ? f.line : null,
      title: text(f.short_summary) || summary,
      summary,
      failureScenario: text(f.failure_scenario),
      category: text(f.category) || null,
      verdict: f.verdict === 'CONFIRMED' || f.verdict === 'PLAUSIBLE' ? f.verdict : null,
    }
  })
}

/** Nothing is left to do: the reviewer accepted it or the user closed it. */
export function isSettled(status: FindingStatus): boolean {
  return status === 'resolved' || status === 'withdrawn' || status === 'closed'
}

/** The agent the finding can be sent to now, if any: an agent still working on it gets it again only after a turn without an answer. */
export function relayTarget(f: ReviewFinding): ReviewRole | null {
  switch (f.status) {
    case 'open':
    case 'reopened':
      return 'implementer'
    case 'fixed':
    case 'pushed_back':
      return 'reviewer'
    case 'implementing':
      return f.stalled ? 'implementer' : null
    case 'verifying':
      return f.stalled ? 'reviewer' : null
    default:
      return null
  }
}

export function statusLabel(f: ReviewFinding): string {
  switch (f.status) {
    case 'open':
      return 'Open'
    case 'implementing':
      return f.stalled ? 'No answer from the implementer' : 'With the implementer'
    case 'fixed':
      return 'Fixed, not sent to the reviewer'
    case 'pushed_back':
      return 'Pushed back, not sent to the reviewer'
    case 'verifying':
      return f.stalled ? 'No answer from the reviewer' : 'With the reviewer'
    case 'reopened':
      return 'Reopened by the reviewer'
    case 'resolved':
      return 'Fixed and verified'
    case 'withdrawn':
      return 'Withdrawn by the reviewer'
    case 'closed':
      return 'Closed by you'
  }
}

export function location(f: Finding): string {
  return f.line === null ? f.file : `${f.file}:${f.line}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
