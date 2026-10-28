// How tool calls look: a one-line summary per tool and, expanded, the details
// that matter for that tool (a command and its output, a diff, a file).

import { diffLines } from 'diff'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock } from './markdown'
import { displayPath, str } from './util'

export interface ToolSummary {
  /** The tool as a person would name it. */
  label: string
  /** Its main argument: a command, a path, a pattern. */
  detail: string
}

export function summarizeTool(name: string, input: Record<string, unknown>, cwd: string): ToolSummary {
  const path = (key: string): string => displayPath(str(input[key]), cwd)
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
      return { label: 'Find files', detail: str(input.pattern) + (input.path ? ` in ${path('path')}` : '') }
    case 'Grep':
      return { label: 'Search', detail: str(input.pattern) + (input.path ? ` in ${path('path')}` : '') }
    case 'WebFetch':
      return { label: 'Fetch', detail: str(input.url) }
    case 'WebSearch':
      return { label: 'Web search', detail: str(input.query) }
    case 'Agent':
    case 'Task':
      return { label: str(input.subagent_type) || 'Agent', detail: str(input.description) }
    case 'TodoWrite':
      return { label: 'Update todos', detail: '' }
    case 'TaskCreate':
      return { label: 'Add task', detail: str(input.subject) }
    case 'TaskUpdate':
      return { label: 'Update task', detail: [str(input.taskId), str(input.status)].filter(Boolean).join(' → ') }
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
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { label: `${mcp[1]} › ${mcp[2]}`, detail: firstString(input) }
  return { label: name, detail: firstString(input) }
}

/** The tool's input, rendered for a person: a command, a diff, file content, or JSON. */
export function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }): ReactNode {
  switch (name) {
    case 'Bash':
      return <CodeBlock code={str(input.command)} lang="bash" />
    case 'Edit':
      return <Diff before={str(input.old_string)} after={str(input.new_string)} />
    case 'Write':
      return <CodeBlock code={str(input.content)} lang={langOf(str(input.file_path))} />
    case 'Agent':
    case 'Task':
      return <pre className="tool-text">{str(input.prompt)}</pre>
    case 'TodoWrite':
      return <Todos input={input} />
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
      return null
  }
  return <pre className="tool-text">{JSON.stringify(input, null, 2)}</pre>
}

export function Diff({ before, after }: { before: string; after: string }): ReactNode {
  const parts = useMemo(() => diffLines(before, after), [before, after])
  return (
    <pre className="diff">
      {parts.flatMap((part, i) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <div key={`${i}:${j}`} className={part.added ? 'diff-add' : part.removed ? 'diff-del' : 'diff-ctx'}>
              {part.added ? '+ ' : part.removed ? '- ' : '  '}
              {line}
            </div>
          )),
      )}
    </pre>
  )
}

export function Todos({ input }: { input: Record<string, unknown> }): ReactNode {
  const todos = Array.isArray(input.todos) ? (input.todos as { content?: unknown; status?: unknown }[]) : []
  return (
    <ul className="todos">
      {todos.map((t, i) => (
        <li key={i} className={`todo ${str(t.status)}`}>
          <span className="todo-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : ''}</span>
          {str(t.content)}
        </li>
      ))}
    </ul>
  )
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

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  swift: 'swift',
  kt: 'kotlin',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  sql: 'sql',
}

export function langOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && EXTENSIONS[ext]) ?? ''
}
