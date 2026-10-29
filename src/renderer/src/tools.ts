// How tool calls are named: a one-line summary per tool.

import { diffLines } from 'diff'
import { displayPath, str } from './util'

export interface ToolSummary {
  /** The tool as a person would name it. */
  label: string
  /** Its main argument: a command, a path, a pattern. */
  detail: string
}

export function summarizeTool(name: string, input: Record<string, unknown>, cwd: string): ToolSummary {
  const path = (key: string): string => displayPath(str(input[key]), cwd)
  const where = (): string => (input.path ? ` in ${path('path')}` : '')
  switch (name) {
    case 'Bash':
      return { label: 'Bash', detail: str(input.description) || str(input.command) }
    case 'Read':
      return { label: 'Read', detail: path('file_path') }
    case 'Write':
      return { label: 'Write', detail: path('file_path') }
    case 'Edit': {
      const { added, removed } = lineCounts(str(input.old_string), str(input.new_string))
      return { label: 'Edit', detail: `${path('file_path')}  +${added} −${removed}` }
    }
    case 'NotebookEdit':
      return { label: 'Edit notebook', detail: path('notebook_path') }
    case 'Glob':
      return { label: 'Find files', detail: str(input.pattern) + where() }
    case 'Grep':
      return { label: 'Search', detail: str(input.pattern) + where() }
    case 'WebFetch':
      return { label: 'Fetch', detail: str(input.url) }
    case 'WebSearch':
      return { label: 'Web search', detail: str(input.query) }
    case 'Agent':
    case 'Task':
      return { label: str(input.subagent_type) || 'Agent', detail: str(input.description) }
    case 'TodoWrite':
      return { label: 'Update todos', detail: '' }
    case 'Skill':
      return { label: 'Skill', detail: str(input.skill) || str(input.command) }
    case 'ToolSearch':
      return { label: 'Load tools', detail: str(input.query) }
    case 'EnterPlanMode':
      return { label: 'Enter plan mode', detail: '' }
    case 'ExitPlanMode':
      return { label: 'Present plan', detail: '' }
    case 'AskUserQuestion':
      return { label: 'Ask', detail: '' }
    case 'ReportFindings':
      return { label: 'Review findings', detail: Array.isArray(input.findings) ? String(input.findings.length) : '' }
    case 'mcp__kumi__respond_to_finding':
      return { label: 'Answer finding', detail: `${String(input.finding)} · ${input.outcome === 'fixed' ? 'fixed' : 'no change needed'}` }
    case 'mcp__kumi__resolve_finding':
      return { label: 'Resolve finding', detail: `${String(input.finding)} · ${input.verdict === 'accept' ? 'accepted' : 'reopened'}` }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return { label: mcp ? `${mcp[1]} › ${mcp[2]}` : name, detail: firstString(input) }
}

function lineCounts(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0
    else if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}

function firstString(input: Record<string, unknown>): string {
  for (const value of Object.values(input)) if (typeof value === 'string' && value.length < 200) return value
  return ''
}

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', json: 'json',
  md: 'markdown', py: 'python', rs: 'rust', go: 'go', rb: 'ruby', sh: 'bash', zsh: 'bash', css: 'css', html: 'html',
  svelte: 'svelte', yml: 'yaml', yaml: 'yaml', toml: 'toml', swift: 'swift', kt: 'kotlin', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', sql: 'sql',
}

export function langOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && LANGS[ext]) ?? ''
}
