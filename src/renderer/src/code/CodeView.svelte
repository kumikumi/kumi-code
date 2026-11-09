<!-- The code view, left of the transcript: the side pane, whose tabs pick Explorer, Search or Source Control, and the editor, with VS Code's quick open over them. Its shortcuts work while the conversation shows, and open it when it is closed. Its right edge resizes it, as does the edge between the side pane and the editor. -->
<script module lang="ts">
  /** What the transcript keeps at least. */
  const MIN_MAIN = 360
  const MIN_WIDTH = 360
  const MIN_SIDE = 170

  /** Shared by the code views of this window, and remembered for the next launch. */
  const sizes = $state({
    width: Number(localStorage.getItem('codeViewWidth')) || 0,
    side: Number(localStorage.getItem('codeSideWidth')) || 260,
  })
</script>

<script lang="ts">
  import { flushSync } from 'svelte'
  import type { ThemeId } from '@shared/themes'
  import Icon from '../Icon.svelte'
  import { api, app } from '../state.svelte'
  import EditorArea from './EditorArea.svelte'
  import Explorer from './Explorer.svelte'
  import QuickOpen from './QuickOpen.svelte'
  import ScmPane from './ScmPane.svelte'
  import SearchPane from './SearchPane.svelte'
  import type { CodeView, PickItem, SidePane } from './view.svelte'
  import './code.css'

  let { view, theme, visible }: { view: CodeView; theme: ThemeId; visible: boolean } = $props()

  let editorArea = $state<ReturnType<typeof EditorArea>>()
  let aside = $state<HTMLElement>()
  let resizing = $state<{ kind: 'view' | 'side'; x: number; size: number } | null>(null)
  let tabStrip = $state<HTMLDivElement>()
  /** Tabs shown without their names, for want of room. */
  let unnamed = $state<SidePane[]>([])

  /** By default 60 % of the window, which leaves the editor room beside the side pane. */
  const width = $derived(sizes.width || Math.max(560, Math.round(window.innerWidth * 0.6)))
  const status = $derived(view.folder.status)
  const count = $derived(status?.count ?? 0)

  const PANES: { id: SidePane; label: string; icon: 'files' | 'search' | 'branch'; keys: string }[] = [
    { id: 'explorer', label: 'Explorer', icon: 'files', keys: '⇧⌘E' },
    { id: 'search', label: 'Search', icon: 'search', keys: '⇧⌘F' },
    { id: 'scm', label: 'Source Control', icon: 'branch', keys: '⌃⇧G' },
  ]

  /**
   * Names every side tab that fits: while the strip overflows, the inactive tabs lose their names
   * from the right, and the active one last.
   */
  function fitTabs(): void {
    const strip = tabStrip
    if (!strip) return
    unnamed = []
    flushSync()
    const order = [...PANES.map((p) => p.id).filter((id) => id !== view.side).reverse(), view.side]
    for (const id of order) {
      if (strip.scrollWidth <= strip.clientWidth) return
      unnamed = [...unnamed, id]
      flushSync()
    }
  }

  $effect(() => {
    const strip = tabStrip
    if (!strip) return
    const observer = new ResizeObserver(() => fitTabs())
    observer.observe(strip)
    return () => observer.disconnect()
  })

  // Another active tab, or a count of another width, needs other room.
  $effect(() => {
    void [view.side, count]
    const frame = requestAnimationFrame(fitTabs)
    return () => cancelAnimationFrame(frame)
  })

  async function closeConversation(): Promise<void> {
    const tab = app.window?.tabs.find((t) => t.conversationId === view.conversationId)
    if (tab && (await view.confirmClose())) await api.closeTab(tab.id)
  }

  function closeActive(): void {
    if (view.activeId) void view.closeTab(view.activeId)
  }

  const commands: PickItem[] = [
    { label: 'File: Save', keys: '⌘S', run: () => void view.save() },
    { label: 'File: Save All', keys: '⌥⌘S', run: () => void view.saveAll() },
    { label: 'View: Close Editor', keys: '⌘W', run: closeActive },
    { label: 'View: Close All Editors', run: () => void view.closeTabs(view.tabs.map((t) => t.id)) },
    { label: 'View: Show Explorer', keys: '⇧⌘E', run: () => view.showSide('explorer') },
    { label: 'View: Show Search', keys: '⇧⌘F', run: () => view.showSide('search') },
    { label: 'View: Show Source Control', keys: '⌃⇧G', run: () => view.showSide('scm') },
    { label: 'View: Toggle Primary Side Bar Visibility', keys: '⌘B', run: () => (view.sideVisible = !view.sideVisible) },
    { label: 'View: Close Code View', run: () => (view.open = false) },
    { label: 'Go to File…', keys: '⌘P', run: () => view.showQuickOpen() },
    { label: 'Go to Line/Column…', keys: '⌃G', run: () => view.showQuickOpen(':') },
    { label: 'Git: Commit', run: () => void view.commit() },
    { label: 'Git: Commit (Amend)', run: () => void view.commit(true) },
    { label: 'Git: Commit & Push', run: () => void view.commit(false, true) },
    { label: 'Git: Stage All Changes', run: () => status && void view.runGit({ kind: 'stage', changes: status.unstaged }) },
    { label: 'Git: Unstage All Changes', run: () => status && void view.runGit({ kind: 'unstage', changes: status.staged }) },
    { label: 'Git: Discard All Changes', run: () => status && void view.runGit({ kind: 'discard', changes: status.unstaged }) },
    { label: 'Git: Pull', run: () => void view.runGit({ kind: 'pull' }) },
    { label: 'Git: Push', run: () => void view.runGit({ kind: 'push' }) },
    { label: 'Git: Fetch', run: () => void view.runGit({ kind: 'fetch' }) },
    { label: 'Git: Checkout to…', run: () => void view.checkout() },
    { label: 'Git: Refresh', run: () => void view.folder.refresh() },
    { label: 'Git: Initialize Repository', run: () => void view.runGit({ kind: 'init' }) },
  ]

  /**
   * VS Code's shortcuts. ⌘P, ⇧⌘P and the side panes' work anywhere in the conversation; saving,
   * closing an editor and the side bar's only inside the code view. In the capture phase, so
   * they win over the editor's and the transcript's own keys.
   */
  function onKey(e: KeyboardEvent): void {
    if (!visible || e.defaultPrevented) return
    const key = e.key.toLowerCase()
    const cmd = e.metaKey && !e.ctrlKey
    const inside = !!aside && view.open && aside.contains(document.activeElement)
    let run: (() => void) | null = null
    if (cmd && !e.altKey && key === 'p') run = () => view.showQuickOpen(e.shiftKey ? '>' : '')
    else if (cmd && e.shiftKey && !e.altKey && key === 'f') run = () => {
      const selected = view.mounted ? (editorArea?.selectionText() ?? '') : ''
      if (selected) view.query.pattern = selected
      view.showSide('search')
      if (selected) void view.runSearch()
    }
    else if (cmd && e.shiftKey && !e.altKey && key === 'e') run = () => view.showSide('explorer')
    else if (e.ctrlKey && e.shiftKey && !e.metaKey && key === 'g') run = () => view.showSide('scm')
    else if (inside && cmd && !e.shiftKey && key === 's') run = () => void (e.altKey ? view.saveAll() : view.save())
    else if (inside && cmd && !e.shiftKey && !e.altKey && key === 'w' && view.activeId) run = closeActive
    // ⌘W elsewhere closes the conversation's tab, which closes the editor's files too.
    else if (cmd && !e.shiftKey && !e.altKey && key === 'w' && view.hasUnsaved()) run = () => void closeConversation()
    else if (inside && cmd && !e.shiftKey && !e.altKey && key === 'b') run = () => (view.sideVisible = !view.sideVisible)
    else if (inside && e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'g') run = () => view.showQuickOpen(':')
    if (!run) return
    e.preventDefault()
    e.stopPropagation()
    run()
  }

  $effect(() => {
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  function startResize(e: PointerEvent, kind: 'view' | 'side'): void {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizing = { kind, x: e.clientX, size: kind === 'view' ? (aside?.getBoundingClientRect().width ?? width) : sizes.side }
  }

  function moveResize(e: PointerEvent): void {
    if (!resizing) return
    const size = resizing.size + e.clientX - resizing.x
    if (resizing.kind === 'view') sizes.width = Math.round(Math.max(MIN_WIDTH, Math.min(size, window.innerWidth - MIN_MAIN)))
    else sizes.side = Math.round(Math.max(MIN_SIDE, Math.min(size, (aside?.getBoundingClientRect().width ?? width) - 240)))
  }

  function endResize(): void {
    if (!resizing) return
    localStorage.setItem(resizing.kind === 'view' ? 'codeViewWidth' : 'codeSideWidth', String(resizing.kind === 'view' ? sizes.width : sizes.side))
    resizing = null
  }
</script>

{#if view.mounted}
  <aside class="code-view" hidden={!view.open} style:width="{width}px" bind:this={aside}>
    {#if view.sideVisible}
      <div class="side" style:width="{sizes.side}px">
        <div class="side-tabs" role="tablist" aria-label="Side pane" bind:this={tabStrip}>
          {#each PANES as pane (pane.id)}
            <button
              class={['side-tab', view.side === pane.id && 'active', unnamed.includes(pane.id) && 'unnamed']}
              role="tab"
              aria-selected={view.side === pane.id}
              title="{pane.label} ({pane.keys})"
              onclick={() => view.showSide(pane.id)}
            >
              <Icon name={pane.icon} /><span class="side-tab-label">{pane.label}</span>
              {#if pane.id === 'scm' && count > 0}<span class="side-tab-count">{count > 9999 ? '10K+' : count}</span>{/if}
            </button>
          {/each}
        </div>
        {#if view.side === 'explorer'}<Explorer {view} />
        {:else if view.side === 'search'}<SearchPane {view} />
        {:else}<ScmPane {view} />{/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class={['code-sash', resizing?.kind === 'side' && 'active']}
        onpointerdown={(e) => startResize(e, 'side')}
        onpointermove={moveResize}
        onpointerup={endResize}
        onpointercancel={endResize}
      ></div>
    {/if}
    <EditorArea bind:this={editorArea} {view} {theme} {visible} />
    {#if view.quick}<QuickOpen {view} {commands} gotoLine={(line, column) => editorArea?.gotoLine(line, column)} lineCount={() => editorArea?.lineCount() ?? 0} />{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class={['code-resize', resizing?.kind === 'view' && 'active']}
      title="Drag to resize; double-click for the default width"
      onpointerdown={(e) => startResize(e, 'view')}
      onpointermove={moveResize}
      onpointerup={endResize}
      onpointercancel={endResize}
      ondblclick={() => (sizes.width = 0, localStorage.removeItem('codeViewWidth'))}
    ></div>
  </aside>
{/if}
