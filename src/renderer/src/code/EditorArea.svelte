<!-- The code view's editor: its tabs, and the active tab in Monaco, as a file or as a diff. Tabs reorder by dragging within the strip; they do not leave it. -->
<script lang="ts">
  import type * as Monaco from 'monaco-editor'
  import { UNCOMMITTED } from '@shared/code'
  import type { BlameCommit, Source } from '@shared/code'
  import { onMount } from 'svelte'
  import type { ThemeId } from '@shared/themes'
  import Icon from '../Icon.svelte'
  import { api } from '../state.svelte'
  import { errorMessage, fileSize } from '../util'
  import { Annotations } from './annotations'
  import type { Target } from './annotations'
  import { deletedDocs, dirtyDocs, sourceKey } from './docs.svelte'
  import type { Opened } from './docs.svelte'
  import FileIcon from './FileIcon.svelte'
  import { applyTheme, EDITOR_FONT, loadMonaco } from './monaco'
  import type { MonacoApi } from './monaco'
  import { basename, dirname } from './view.svelte'
  import type { CodeView, EditorTab } from './view.svelte'

  let { view, theme, visible }: { view: CodeView; theme: ThemeId; visible: boolean } = $props()

  const OPTIONS: Monaco.editor.IEditorOptions = {
    fontFamily: EDITOR_FONT,
    fontSize: 12.5,
    lineHeight: 19,
    automaticLayout: true,
    minimap: { enabled: false },
    fixedOverflowWidgets: true,
    stickyScroll: { enabled: true },
    bracketPairColorization: { enabled: true },
    renderWhitespace: 'selection',
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
    padding: { top: 6 },
  }

  let root = $state<HTMLDivElement>()
  let codeHost = $state<HTMLDivElement>()
  let diffHost = $state<HTMLDivElement>()
  let strip = $state<HTMLDivElement>()
  let monaco = $state<MonacoApi | null>(null)
  let editor: Monaco.editor.IStandaloneCodeEditor | null = null
  let diff: Monaco.editor.IStandaloneDiffEditor | null = null
  /** The diff editor's view model, which the editor leaves to its maker to dispose. */
  let diffModel: Monaco.editor.IDiffEditorViewModel | null = null
  /** The code editor's, and the diff's sides'. */
  let annotations: { code: Annotations; original: Annotations; modified: Annotations } | null = null
  /** What the editor shows: a tab in the code or diff editor, or a tab with no text (an image, a binary file). */
  let shown = $state<{ tabId: string; kind: 'code' | 'diff' } | { tabId: string; kind: 'other'; content: Exclude<Opened, { kind: 'doc' }> } | null>(null)
  let error = $state<string | null>(null)
  let cursor = $state<{ line: number; column: number; selected: number } | null>(null)
  /** The tabs whose models the code and diff editors hold. */
  let codeTab: string | null = null
  let diffTab: string | null = null
  let showSeq = 0
  /** Closed tabs an editor still shows, until another tab shows: their models wait to be disposed. */
  let retiring: { tabId: string; done: () => void }[] = []
  const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | Monaco.editor.IDiffEditorViewState | null>()
  let drag: { id: string; x: number; moved: boolean } | null = null

  const active = $derived(view.activeTab)
  const label = (tab: EditorTab): string => (tab.detail ? `${tab.title} (${tab.detail})` : tab.title)
  /** Labels more than one tab has; those tabs also show their folder. */
  const sameLabels = $derived.by(() => {
    const seen = new Map<string, number>()
    for (const tab of view.tabs) seen.set(label(tab), (seen.get(label(tab)) ?? 0) + 1)
    return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name))
  })

  onMount(() => {
    let disposed = false
    loadMonaco().then(
      (m) => {
        if (disposed || !codeHost || !diffHost) return
        editor = m.editor.create(codeHost, { ...OPTIONS, model: null })
        diff = m.editor.createDiffEditor(diffHost, { ...OPTIONS, originalEditable: false, renderMarginRevertIcon: true, ignoreTrimWhitespace: true })
        const track = (ed: Monaco.editor.ICodeEditor): void => {
          ed.onDidChangeCursorSelection((e) => {
            const s = e.selection
            const model = ed.getModel()
            cursor = { line: s.positionLineNumber, column: s.positionColumn, selected: model ? model.getValueInRange(s).length : 0 }
          })
        }
        track(editor)
        track(diff.getModifiedEditor())
        const open = (target: Target, hash: string, commit: BlameCommit): void => void openBlamed(target, hash, commit)
        const sides = { code: new Annotations(m, editor, open), original: new Annotations(m, diff.getOriginalEditor(), open), modified: new Annotations(m, diff.getModifiedEditor(), open) }
        // A diff's blame shows on the side the user works in: the right one until the left is clicked.
        sides.original.setShown(false)
        diff.getOriginalEditor().onDidFocusEditorText(() => (sides.original.setShown(true), sides.modified.setShown(false)))
        diff.getModifiedEditor().onDidFocusEditorText(() => (sides.modified.setShown(true), sides.original.setShown(false)))
        annotations = sides
        monaco = m
      },
      (err: unknown) => (error = `The editor failed to load: ${errorMessage(err)}`),
    )
    view.beforeRelease = (tabId) => {
      // A tab opened again starts afresh, as a new one: a diff at its first change.
      viewStates.delete(tabId)
      if (codeTab !== tabId && diffTab !== tabId) return
      // Emptying the editor now would show it blank until the next tab is read.
      return new Promise<void>((done) => {
        retiring.push({ tabId, done })
        if (shown?.tabId !== tabId) retire()
      })
    }
    return () => {
      disposed = true
      view.beforeRelease = null
      for (const r of retiring) r.done()
      retiring = []
      for (const a of Object.values(annotations ?? {})) a.dispose()
      editor?.dispose()
      diff?.setModel(null)
      diffModel?.dispose()
      diff?.dispose()
    }
  })

  $effect(() => {
    if (monaco && visible && view.open && root) applyTheme(monaco, root, theme)
  })

  $effect(() => {
    const tab = active
    if (monaco) void show(tab)
  })

  /**
   * What an editor shows of the repository, to annotate: a file in it (with its changes in the
   * gutter when `gutter`), the index's version, or a revision's.
   */
  function targetOf(source: Source | null, gutter: boolean): Target | null {
    const root = view.folder.status?.root
    if (!source || !root) return null
    if (source.kind === 'git') return { root: source.root, path: source.path, rev: source.rev || null, gutter: false }
    return source.path.startsWith(`${root}/`) ? { root, path: source.path.slice(root.length + 1), rev: null, gutter } : null
  }

  const shownTab = $derived(shown ? view.tabs.find((t) => t.id === shown?.tabId) : undefined)
  const targets = $derived({
    code: shown?.kind === 'code' && shownTab ? targetOf(shownTab.modified, true) : null,
    original: shown?.kind === 'diff' && shownTab ? targetOf(shownTab.original, false) : null,
    modified: shown?.kind === 'diff' && shownTab ? targetOf(shownTab.modified, false) : null,
  })

  // Every status the folder reports may come with a new index or HEAD.
  $effect(() => {
    const now = targets
    const head = view.folder.status?.head ?? null
    if (!monaco || !annotations) return
    void annotations.code.update(now.code, head)
    void annotations.original.update(now.original, head)
    void annotations.modified.update(now.modified, head)
  })

  // A preview tab whose file gets edited is kept, as in VS Code.
  $effect(() => {
    for (const tab of view.tabs) if (tab.preview && dirtyDocs.has(sourceKey(tab.modified))) view.pin(tab.id)
  })

  $effect(() => {
    const reveal = view.reveal
    if (reveal && shown?.tabId === reveal.tabId && shown.kind !== 'other' && monaco) {
      const ed = target()
      if (!ed) return
      const range = new monaco.Range(reveal.line, reveal.column, reveal.line, reveal.column + reveal.length)
      ed.setSelection(range)
      ed.revealRangeInCenterIfOutsideViewport(range)
      view.reveal = null
    }
  })

  $effect(() => {
    if (view.focusEditor && shown) target()?.focus()
  })

  // A change opened (from the side pane, a blame) shows at its first change, as in VS Code, also when
  // its tab was open; switching back to a tab finds it where it was left.
  $effect(() => {
    if (!view.revealChange || view.revealChange !== shown?.tabId) return
    if (shown.kind === 'diff') revealFirstChange()
    view.revealChange = null
  })

  /** The editor the user types in: the code editor, or the diff's right side. */
  function target(): Monaco.editor.ICodeEditor | null {
    if (shown?.kind === 'code') return editor
    if (shown?.kind === 'diff') return diff?.getModifiedEditor() ?? null
    return null
  }

  /**
   * Monaco's revealFirstDiff without its wait for the diff, which is known: the cursor on the first
   * change, centred, at once.
   */
  function revealFirstChange(): void {
    const first = diff?.getLineChanges()?.[0]
    const modified = diff?.getModifiedEditor()
    if (!diff || !modified || !monaco) return
    if (!first) {
      diff.revealFirstDiff()
      return
    }
    // A deletion has no lines on the right: it lies after its start line.
    const start = Math.max(1, first.modifiedStartLineNumber)
    const end = Math.max(start, first.modifiedEndLineNumber)
    modified.setPosition({ lineNumber: start, column: 1 })
    modified.revealRangeInCenter(new monaco.Range(start, 1, end, 1), monaco.editor.ScrollType.Immediate)
  }

  /** Keeps where the shown tab is; a closed one has none to keep. */
  function saveViewState(): void {
    if (!shown || !view.tabs.some((t) => t.id === shown?.tabId)) return
    if (shown.kind === 'code' && editor && codeTab === shown.tabId) viewStates.set(shown.tabId, editor.saveViewState())
    else if (shown.kind === 'diff' && diff && diffTab === shown.tabId) viewStates.set(shown.tabId, diff.saveViewState())
  }

  /** Lets go of closed tabs' models that the editor shown no longer needs, so they can be disposed. */
  function retire(): void {
    const closed = new Set(retiring.map((r) => r.tabId))
    if (diffTab && closed.has(diffTab) && (shown?.kind !== 'diff' || shown.tabId !== diffTab)) {
      diff?.setModel(null)
      diffModel?.dispose()
      diffModel = null
      diffTab = null
    }
    if (codeTab && closed.has(codeTab) && (shown?.kind !== 'code' || shown.tabId !== codeTab)) {
      editor?.setModel(null)
      codeTab = null
    }
    retiring = retiring.filter((r) => {
      const held = r.tabId === diffTab || r.tabId === codeTab
      if (!held) r.done()
      return held
    })
  }

  async function show(tab: EditorTab | null): Promise<void> {
    if (shown?.tabId === tab?.id && shown) return
    const seq = ++showSeq
    saveViewState()
    if (!tab) {
      shown = null
      cursor = null
      retire()
      return
    }
    const loaded = view.content(tab.id)
    if (!loaded || !editor || !diff) return
    let modified: Opened
    let original: Opened | null
    try {
      ;[modified, original] = await Promise.all([loaded.modified, loaded.original])
      error = null
    } catch (err) {
      if (seq === showSeq) error = errorMessage(err)
      return
    }
    if (seq !== showSeq || !view.tabs.some((t) => t.id === tab.id)) return
    const readOnly = tab.modified.kind !== 'file'
    if (tab.kind === 'diff' && original?.kind === 'doc' && modified.kind === 'doc') {
      // As VS Code's diff editor: the diff is computed before it replaces what shows, so it opens
      // already at its place rather than at the top for a frame.
      const next = diff.createViewModel({ original: original.doc.model, modified: modified.doc.model })
      await next.waitForDiff()
      if (seq !== showSeq || !view.tabs.some((t) => t.id === tab.id)) {
        next.dispose()
        return
      }
      saveViewState()
      diff.setModel(next)
      diffModel?.dispose()
      diffModel = next
      diff.getModifiedEditor().updateOptions({ readOnly })
      diffTab = tab.id
      const state = viewStates.get(tab.id)
      // Opened from a change, or never shown: at its first change; switched back to: where it was left.
      if (view.revealChange === tab.id || !state) {
        revealFirstChange()
        view.revealChange = null
      } else diff.restoreViewState(state as Monaco.editor.IDiffEditorViewState)
      // Drawn now rather than in the next frame, which would first show the editor empty.
      diff.getOriginalEditor().render(true)
      diff.getModifiedEditor().render(true)
      shown = { tabId: tab.id, kind: 'diff' }
    } else if (modified.kind === 'doc') {
      editor.setModel(modified.doc.model)
      editor.updateOptions({ readOnly })
      codeTab = tab.id
      const state = viewStates.get(tab.id)
      if (state) editor.restoreViewState(state as Monaco.editor.ICodeEditorViewState)
      shown = { tabId: tab.id, kind: 'code' }
    } else shown = { tabId: tab.id, kind: 'other', content: modified }
    const ed = target()
    const position = ed?.getPosition()
    cursor = position ? { line: position.lineNumber, column: position.column, selected: 0 } : null
    retire()
  }

  /**
   * A blame hover's link: the file as the line's commit changed it, as the graph opens it; for an
   * uncommitted line, the file's unstaged changes, else its staged ones.
   */
  async function openBlamed(target: Target, hash: string, commit: BlameCommit): Promise<void> {
    if (hash === UNCOMMITTED) {
      const status = view.folder.status
      const unstaged = status?.unstaged.find((c) => c.path === target.path)
      const staged = status?.staged.find((c) => c.path === target.path)
      if (unstaged) view.openChange(unstaged, 'unstaged', target.root, { preview: true })
      else if (staged) view.openChange(staged, 'staged', target.root, { preview: true })
      // Where the change is listed, highlighted.
      if (unstaged || staged) view.showSide('scm')
      return
    }
    try {
      const path = commit.filename || target.path
      const change = (await api.commitChanges(view.cwd, hash)).find((c) => c.path === path) ?? { path, origPath: null, letter: 'M' as const }
      // The first parent, as the graph compares with; a root commit's files are added, so need none.
      view.openCommitChange({ hash, parents: [`${hash}^`], author: commit.author, date: commit.date, subject: commit.summary, refs: [] }, change, target.root, { preview: true })
      view.revealCommit(hash)
    } catch (err) {
      error = errorMessage(err)
    }
  }

  /** The selected text, for seeding a search; empty when it spans lines. */
  export function selectionText(): string {
    const ed = target()
    const selection = ed?.getSelection()
    const text = selection && !selection.isEmpty() ? (ed?.getModel()?.getValueInRange(selection) ?? '') : ''
    return text.includes('\n') ? '' : text
  }

  export function gotoLine(line: number, column = 1): void {
    const ed = target()
    if (!ed || !monaco) return
    ed.setPosition({ lineNumber: line, column })
    ed.revealPositionInCenter({ lineNumber: line, column })
    ed.focus()
  }

  export function lineCount(): number {
    return target()?.getModel()?.getLineCount() ?? 0
  }

  function isDirty(tab: EditorTab): boolean {
    return tab.modified.kind === 'file' && dirtyDocs.has(sourceKey(tab.modified))
  }

  function onTabDown(e: PointerEvent, tab: EditorTab): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.editor-tab-close')) return
    view.activate(tab.id)
    strip?.setPointerCapture(e.pointerId)
    drag = { id: tab.id, x: e.clientX, moved: false }
  }

  function onStripMove(e: PointerEvent): void {
    if (!drag || !strip) return
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 4) return
    drag.moved = true
    const tabs = [...strip.querySelectorAll<HTMLElement>('.editor-tab')]
    const over = tabs.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX < r.right
    })
    const to = over === -1 ? (e.clientX < (tabs[0]?.getBoundingClientRect().left ?? 0) ? 0 : tabs.length - 1) : over
    view.moveTab(drag.id, to)
  }

  function onStripUp(): void {
    drag = null
  }

  async function tabMenu(e: MouseEvent, tab: EditorTab): Promise<void> {
    e.preventDefault()
    const index = view.tabs.findIndex((t) => t.id === tab.id)
    const relative = tab.path.startsWith(`${view.cwd}/`) ? tab.path.slice(view.cwd.length + 1) : tab.path
    const picked = await api.showMenu([
      { id: 'close', label: 'Close', accelerator: 'CmdOrCtrl+W' },
      { id: 'others', label: 'Close Others', enabled: view.tabs.length > 1 },
      { id: 'right', label: 'Close to the Right', enabled: index < view.tabs.length - 1 },
      { id: 'saved', label: 'Close Saved' },
      { id: 'all', label: 'Close All' },
      { id: '', label: '', separator: true },
      { id: 'copyPath', label: 'Copy Path' },
      { id: 'copyRelative', label: 'Copy Relative Path' },
      { id: 'reveal', label: 'Reveal in Finder' },
      ...(tab.kind === 'diff' ? [{ id: 'openFile', label: 'Open File' }] : []),
      ...(tab.preview ? [{ id: '', label: '', separator: true }, { id: 'keep', label: 'Keep Open' }] : []),
    ])
    const ids = (list: EditorTab[]): string[] => list.map((t) => t.id)
    if (picked === 'close') void view.closeTab(tab.id)
    else if (picked === 'others') void view.closeTabs(ids(view.tabs.filter((t) => t.id !== tab.id)))
    else if (picked === 'right') void view.closeTabs(ids(view.tabs.slice(index + 1)))
    else if (picked === 'saved') void view.closeTabs(ids(view.tabs.filter((t) => !isDirty(t))))
    else if (picked === 'all') void view.closeTabs(ids(view.tabs))
    else if (picked === 'copyPath') void navigator.clipboard.writeText(tab.path)
    else if (picked === 'copyRelative') void navigator.clipboard.writeText(relative)
    else if (picked === 'reveal') api.revealPath(tab.path)
    else if (picked === 'openFile') view.openFile(tab.path)
    else if (picked === 'keep') view.pin(tab.id)
  }

  function crumbs(tab: EditorTab): string[] {
    const relative = tab.path.startsWith(`${view.cwd}/`) ? tab.path.slice(view.cwd.length + 1) : tab.path
    return relative.split('/').filter(Boolean)
  }
</script>

<div class="editor-area" bind:this={root}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="editor-tabs"
    bind:this={strip}
    onpointermove={onStripMove}
    onpointerup={onStripUp}
    onpointercancel={onStripUp}
    onwheel={(e) => strip && Math.abs(e.deltaY) > Math.abs(e.deltaX) && (strip.scrollLeft += e.deltaY)}
  >
    {#if !view.sideVisible}
      <button class="ghost icon-button side-show" aria-label="Show Side Bar" title="Show Side Bar (⌘B)" onclick={() => (view.sideVisible = true)}><Icon name="sidebar" /></button>
    {/if}
    {#each view.tabs as tab (tab.id)}
      {@const dirty = isDirty(tab)}
      {@const deleted = tab.modified.kind === 'file' && deletedDocs.has(sourceKey(tab.modified))}
      <div
        class={['editor-tab', tab.id === view.activeId && 'active', tab.preview && 'preview', dirty && 'dirty', deleted && 'deleted']}
        role="tab"
        tabindex="-1"
        aria-selected={tab.id === view.activeId}
        title={`${tab.path}${tab.detail ? ` (${tab.detail})` : ''}${deleted ? ' (deleted)' : ''}`}
        onpointerdown={(e) => onTabDown(e, tab)}
        onauxclick={(e) => e.button === 1 && void view.closeTab(tab.id)}
        ondblclick={() => view.pin(tab.id)}
        oncontextmenu={(e) => void tabMenu(e, tab)}
        onkeydown={() => {}}
      >
        <FileIcon name={tab.title} />
        <span class="editor-tab-title">{label(tab)}</span>
        {#if sameLabels.has(label(tab))}<span class="editor-tab-folder">{basename(dirname(tab.path))}</span>{/if}
        <button class="editor-tab-close" aria-label="Close" title="Close (⌘W)" onclick={() => void view.closeTab(tab.id)}>
          <Icon name="close" />
        </button>
      </div>
    {/each}
  </div>
  {#if active}
    <div class="editor-crumbs">
      {#each crumbs(active) as crumb, i (i)}{#if i > 0}<Icon name="chevronRight" />{/if}<span>{crumb}</span>{/each}
      {#if active.detail}<span class="editor-crumbs-detail">{active.detail}</span>{/if}
      <span class="spacer"></span>
      {#if cursor && shown?.kind !== 'other'}
        <span class="editor-position">Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>
      {/if}
    </div>
  {/if}
  {#if error}<div class="side-error">{error}</div>{/if}
  <div class="editor-body">
    <!-- Inert while hidden: laid out, but out of reach of the pointer and the keyboard. -->
    <div class="editor-host" bind:this={codeHost} hidden={shown?.kind !== 'code'} inert={shown?.kind !== 'code'}></div>
    <div class="editor-host" bind:this={diffHost} hidden={shown?.kind !== 'diff'} inert={shown?.kind !== 'diff'}></div>
    {#if shown?.kind === 'other'}
      {@const content = shown.content}
      <div class="editor-other">
        {#if content.kind === 'image'}
          <img src={`data:${content.mediaType};base64,${content.data}`} alt={active?.title ?? ''} />
          <div class="editor-note">{fileSize(content.size)}</div>
        {:else if content.kind === 'binary'}
          <div class="editor-note">The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.</div>
        {:else if content.kind === 'tooLarge'}
          <div class="editor-note">The file is not displayed in the text editor because it is very large ({fileSize(content.size)}).</div>
        {:else}
          <div class="editor-note">The file does not exist.</div>
        {/if}
      </div>
    {:else if !active}
      <div class="editor-watermark">
        <dl>
          <dt>Show All Commands</dt><dd><kbd>⇧</kbd><kbd>⌘</kbd><kbd>P</kbd></dd>
          <dt>Go to File</dt><dd><kbd>⌘</kbd><kbd>P</kbd></dd>
          <dt>Find in Files</dt><dd><kbd>⇧</kbd><kbd>⌘</kbd><kbd>F</kbd></dd>
          <dt>Show Explorer</dt><dd><kbd>⇧</kbd><kbd>⌘</kbd><kbd>E</kbd></dd>
          <dt>Open Source Control</dt><dd><kbd>⌃</kbd><kbd>⇧</kbd><kbd>G</kbd></dd>
        </dl>
      </div>
    {/if}
  </div>
</div>
