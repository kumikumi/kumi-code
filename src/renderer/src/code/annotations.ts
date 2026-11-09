// An editor's annotations of a file in a git repository: VS Code's quick diff in the gutter (lines
// added, modified and deleted since the index, unsaved edits included) and GitLens's blame at the
// end of the cursor's line, with the whole commit message on hover. A diff's sides are blamed
// as what each shows, and get no gutter marks: the diff shows the changes.

import type * as Monaco from 'monaco-editor'
import { UNCOMMITTED } from '@shared/code'
import type { Blame, BlameCommit } from '@shared/code'
import { api } from '../state.svelte'
import { fullTime, relativeTime } from '../util'
import { lineChanges } from './changes'
import type { MonacoApi } from './monaco'

/** The file the editor shows, in its repository. */
export interface Target {
  root: string
  /** Repository-relative. */
  path: string
  /** The revision the editor shows; null when it shows text on top of HEAD (the file's, or the index's). */
  rev: string | null
  /** Mark the text's changes since the index in the gutter. */
  gutter: boolean
}

/** VS Code's editorGutter colors (Dark Modern), for the overview ruler; the gutter's are in code.css. */
const RULER = { added: '#2ea043', modified: '#0078d4', deleted: '#f85149' }
/** After an edit, the gutter waits this long and the blame this long, in milliseconds. */
const DIFF_DELAY = 100
const BLAME_DELAY = 500

/** The command a hover's links run: `[annotator id, hash]` opens that line's change. */
const OPEN_COMMAND = 'kumi.openBlamedChange'
/** Every annotator of the window, by id, for the command to find; the command is the window's. */
const annotators = new Map<number, Annotations>()
let nextId = 1
let commandRegistered = false

export class Annotations {
  private readonly gutter: Monaco.editor.IEditorDecorationsCollection
  private readonly blameLine: Monaco.editor.IEditorDecorationsCollection
  private readonly listeners: Monaco.IDisposable[]
  private readonly id = nextId++
  private target: Target | null = null
  private head: string | null = null
  /** The blame shows here: the editor, or the side of a diff, the user works in. */
  private shown = true
  /** The index's text of the file; null when the index does not have it. */
  private original: string | null = null
  private blame: { model: Monaco.editor.ITextModel; version: number; data: Blame } | null = null
  /** Whole commit messages, by hash. */
  private readonly messages = new Map<string, string>()
  /** Counts files (and HEADs) annotated, so answers about an earlier one are dropped. */
  private file = 0
  private reads = 0
  private diffTimer: ReturnType<typeof setTimeout> | undefined
  private blameTimer: ReturnType<typeof setTimeout> | undefined

  /** `open` shows a blamed line's change, from the hover's link: in its commit, or the uncommitted one (hash UNCOMMITTED). */
  constructor(
    private readonly monaco: MonacoApi,
    private readonly editor: Monaco.editor.ICodeEditor,
    private readonly open: (target: Target, hash: string, commit: BlameCommit) => void,
  ) {
    this.gutter = editor.createDecorationsCollection()
    this.blameLine = editor.createDecorationsCollection()
    annotators.set(this.id, this)
    if (!commandRegistered) {
      commandRegistered = true
      monaco.editor.registerCommand(OPEN_COMMAND, (_accessor, id: number, hash: string) => annotators.get(id)?.openChange(hash))
    }
    this.listeners = [
      editor.onDidChangeModelContent(() => {
        clearTimeout(this.diffTimer)
        this.diffTimer = setTimeout(() => this.drawGutter(), DIFF_DELAY)
        clearTimeout(this.blameTimer)
        this.blameTimer = setTimeout(() => void this.runBlame(), BLAME_DELAY)
        this.showBlame()
      }),
      editor.onDidChangeCursorPosition(() => this.showBlame()),
    ]
  }

  dispose(): void {
    annotators.delete(this.id)
    clearTimeout(this.diffTimer)
    clearTimeout(this.blameTimer)
    for (const l of this.listeners) l.dispose()
  }

  setShown(shown: boolean): void {
    this.shown = shown
    this.showBlame()
  }

  /**
   * The editor shows `target` (null: nothing to annotate) in a repository at `head`. The index is
   * read again each time, as staging changes it; the file is blamed again when it or HEAD changed.
   */
  async update(target: Target | null, head: string | null): Promise<void> {
    const t = this.target
    const same = !!target && !!t && target.root === t.root && target.path === t.path && target.rev === t.rev && target.gutter === t.gutter && head === this.head
    this.target = target
    this.head = head
    if (!same) {
      this.file++
      this.blame = null
      this.blameLine.clear()
      if (target) void this.runBlame()
    }
    const read = ++this.reads
    if (!target?.gutter) {
      this.original = null
      this.gutter.clear()
      return
    }
    const content = await api.readSource({ kind: 'git', root: target.root, rev: '', path: target.path }).catch(() => null)
    if (read !== this.reads) return
    this.original = content?.kind === 'text' ? content.text : null
    this.drawGutter()
  }

  private drawGutter(): void {
    const model = this.editor.getModel()
    if (!model || this.original === null || !this.target?.gutter) {
      this.gutter.clear()
      return
    }
    const lines = model.getLineCount()
    const Range = this.monaco.Range
    this.gutter.set(
      lineChanges(this.original, model.getValue()).map((c) => {
        // A deletion's mark sits between lines: under the line before it, or over the first.
        const line = c.kind === 'deleted' ? Math.min(Math.max(c.start, 1), lines) : c.start
        return {
          range: new Range(line, 1, c.kind === 'deleted' ? line : c.end, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: c.kind === 'deleted' && c.start === 0 ? 'dirty-deleted top' : `dirty-${c.kind}`,
            overviewRuler: { color: RULER[c.kind], position: this.monaco.editor.OverviewRulerLane.Left },
          },
        }
      }),
    )
  }

  /** Blames the editor's text as it is now, unsaved edits included. */
  private async runBlame(): Promise<void> {
    const target = this.target
    const model = this.editor.getModel()
    if (!target || !model) return
    const file = this.file
    const version = model.getAlternativeVersionId()
    const data = await api.blame(target.root, target.path, target.rev ? null : model.getValue(), target.rev).catch((err: unknown) => {
      console.error('git blame failed', err)
      return null
    })
    // A newer edit has its own blame on the way.
    if (file !== this.file || model.isDisposed() || model.getAlternativeVersionId() !== version) return
    this.blame = data ? { model, version, data } : null
    this.showBlame()
  }

  /** A hover's link: the change that last touched a line of the text blamed. */
  private openChange(hash: string): void {
    const commit = this.blame?.data.commits[hash]
    if (commit && this.target) this.open(this.target, hash, commit)
  }

  /** A line's commit, when the editor's text is the text blamed. */
  private blamed(line: number): { hash: string; commit: BlameCommit } | null {
    const model = this.editor.getModel()
    const blame = this.blame
    // While the text differs from what was blamed, its lines' commits are unknown.
    if (!model || !blame || blame.model !== model || blame.version !== model.getAlternativeVersionId()) return null
    const hash = blame.data.lines[line - 1]
    const commit = hash ? blame.data.commits[hash] : undefined
    return hash && commit ? { hash, commit } : null
  }

  /** GitLens's current line blame: who, when and the commit's subject, after the cursor's line. */
  private showBlame(): void {
    const model = this.editor.getModel()
    const position = this.editor.getPosition()
    const blame = this.blame
    const blamed = position && this.shown ? this.blamed(position.lineNumber) : null
    if (!model || !position || !blame || !blamed) {
      this.blameLine.clear()
      return
    }
    const { hash, commit } = blamed
    const uncommitted = hash === UNCOMMITTED
    const who = uncommitted || commit.email === blame.data.you ? 'You' : commit.author
    const text = `${who}, ${relativeTime(commit.date)} • ${uncommitted ? 'Uncommitted changes' : commit.summary}`
    const line = position.lineNumber
    const end = model.getLineMaxColumn(line)
    this.blameLine.set([
      {
        range: new this.monaco.Range(line, end, line, end),
        // Injected text on an empty range shows only with showIfCollapsed.
        options: { after: { content: text, inlineClassName: 'blame-inline' }, showIfCollapsed: true, hoverMessage: this.hover(hash, commit, uncommitted) },
      },
    ])
    const target = this.target
    if (!uncommitted && !this.messages.has(hash) && target) {
      this.messages.set(hash, commit.summary)
      api.commitMessage(target.root, hash).then(
        (message) => {
          this.messages.set(hash, message)
          this.showBlame()
        },
        (err: unknown) => console.error('git log failed', err),
      )
    }
  }

  /**
   * As GitLens's hover: the author, when (relative and in full), the whole message, and the short
   * hash, a link to the file as the commit changed it; for an uncommitted line, a link to its changes.
   */
  private hover(hash: string, commit: BlameCommit, uncommitted: boolean): Monaco.IMarkdownString {
    const link = (text: string, title: string): string => `[${text}](command:${OPEN_COMMAND}?${encodeURIComponent(JSON.stringify([this.id, hash]))} "${title}")`
    // Trusted to run only that command.
    const isTrusted = { enabledCommands: [OPEN_COMMAND] }
    if (uncommitted) return { value: `**You** · Uncommitted changes\n\n${link('Open Changes', 'Open the changes')}`, isTrusted }
    const message = this.messages.get(hash) ?? commit.summary
    const paragraphs = message.split(/\n\s*\n/).map(escapeMarkdown)
    const header = `**${escapeMarkdown(commit.author)}** · ${relativeTime(commit.date)} (${escapeMarkdown(fullTime(commit.date))})`
    return { value: [header, ...paragraphs, link(`\`${hash.slice(0, 7)}\``, 'Open the file as this commit changed it')].join('\n\n'), isTrusted }
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&')
}
