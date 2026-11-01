<!-- A conversation: its transcript, task list, pending requests and the composer, and beside them a pane with the review it is in, its browser or its terminal. -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { modelRow } from '@shared/models'
  import type { BrowserState, TerminalState } from '@shared/types'
  import { parseWrapUp, WRAP_UP_TOOL } from '@shared/wrap-up'
  import BrowserPane from './BrowserPane.svelte'
  import Composer from './Composer.svelte'
  import Icon from './Icon.svelte'
  import Dock from './Dock.svelte'
  import Item from './Item.svelte'
  import NextStep from './NextStep.svelte'
  import Requests from './Requests.svelte'
  import TerminalPane from './TerminalPane.svelte'
  import ReviewPanel from './ReviewPanel.svelte'
  import Todos from './Todos.svelte'
  import { api, app, conversation } from './state.svelte'
  import { duration, errorMessage, tildify } from './util'

  let { id, visible }: { id: string; visible: boolean } = $props()

  /** Within this many pixels of the bottom, the transcript follows new output. */
  const STICK_DISTANCE = 80
  const NO_BROWSER: BrowserState = { tabs: [], activeTabId: null, activity: null, downloads: [] }
  const NO_TERMINALS: TerminalState = { tabs: [], activeTabId: null }

  // A tab's conversation never changes; App keys the component by it.
  // svelte-ignore state_referenced_locally
  const c = conversation(id)
  let scroller = $state<HTMLDivElement>()
  let stick = true
  let renaming = $state<string | null>(null)
  /** A rename or fork that failed. */
  let headerError = $state<string | null>(null)
  /** Ticks while a turn runs, for its elapsed time. */
  let now = $state(Date.now())
  let tasksOpen = $state(true)
  /** What the pane beside the transcript shows; null when it is closed. */
  let pane = $state<'review' | 'browser' | 'terminal' | null>(null)
  let root = $state<HTMLDivElement>()
  let seenReview: string | null = null
  let browserWasOpen = false

  const meta = $derived(c.meta)
  // Rows get the folder as a string of its own: a new meta object (every meta
  // update) with the same folder then leaves them alone.
  const cwd = $derived(meta?.cwd ?? '')
  const tasks = $derived(meta?.tasks ?? [])
  const showTasks = $derived(tasks.some((t) => t.status !== 'completed'))
  // The implementer's review comes first when the conversation is in two.
  const review = $derived(app.reviews.find((r) => r.implementerId === id) ?? app.reviews.find((r) => r.reviewerId === id))
  const reviewId = $derived(review?.id ?? null)
  // The box shows the last wrap_up that worked, until the user's next message.
  const wrapUp = $derived.by(() => {
    for (let i = c.items.length - 1; i >= 0; i--) {
      const item = c.items[i]
      if (item?.kind === 'user') return null
      if (item?.kind === 'tool' && item.name === WRAP_UP_TOOL && item.result && !item.result.isError) return parseWrapUp(item.input)
    }
    return null
  })
  const browser = $derived(c.browser)
  const browserOpen = $derived((browser?.tabs.length ?? 0) > 0)
  const turnStartedAt = $derived(meta?.status === 'running' ? meta.turnStartedAt : null)
  // A copy of the whole conversation would end inside a running turn; "Fork from here" works on finished ones.
  const forkBlocked = $derived(meta?.status === 'running' || meta?.compacting === true)

  $effect(() => {
    if (turnStartedAt === null || !visible) return
    now = Date.now()
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  // The pane opens by itself for a new review, and for the browser's first tab, when it is closed.
  $effect.pre(() => {
    const current = reviewId
    untrack(() => {
      if (current && current !== seenReview && pane === null) pane = 'review'
      if (!current && pane === 'review') pane = browserOpen ? 'browser' : null
    })
    seenReview = current
  })
  $effect.pre(() => {
    const open = browserOpen
    untrack(() => {
      if (open && !browserWasOpen && pane === null) pane = 'browser'
    })
    browserWasOpen = open
  })

  function toggle(which: 'review' | 'browser' | 'terminal'): void {
    pane = pane === which ? null : which
  }

  /** Shows the terminal pane at a tab: the agent opened it for the user, or the user clicked a link to it. */
  function showTerminal(tabId: string): void {
    pane = 'terminal'
    if (c.terminals?.tabs.some((t) => t.id === tabId)) void api.terminalAction(id, { kind: 'select', tabId })
  }

  $effect(() => api.onTerminalShow((conversationId, tabId) => conversationId === id && showTerminal(tabId)))
  $effect(() => {
    const target = root
    if (!target) return
    const onLink = (e: Event): void => showTerminal(String((e as CustomEvent<string>).detail))
    target.addEventListener('terminallink', onLink)
    return () => target.removeEventListener('terminallink', onLink)
  })

  // New output, or coming back into view: follow the bottom unless scrolled up.
  $effect(() => {
    void [c.items, meta, visible]
    if (scroller && stick) scroller.scrollTop = scroller.scrollHeight
  })

  function saveTitle(): void {
    const title = renaming?.trim()
    renaming = null
    if (meta && title && title !== meta.title) api.renameConversation(meta.id, title).catch((err: unknown) => (headerError = errorMessage(err)))
  }

  function fork(): void {
    headerError = null
    api.forkConversation(id, null, null).catch((err: unknown) => (headerError = errorMessage(err)))
  }
</script>

{#if !meta}
  <div class="conversation loading">
    {#if c.error}<div class="notice error">{c.error}</div>{:else}<div class="muted">Loading…</div>{/if}
  </div>
{:else}
  <div class="conversation" bind:this={root}>
    <header class="conversation-header">
      {#if renaming !== null}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          class="rename"
          bind:value={renaming}
          onblur={saveTitle}
          onkeydown={(e) => (e.key === 'Enter' ? saveTitle() : e.key === 'Escape' && (renaming = null))}
        />
      {:else}
        <h1 ondblclick={() => (renaming = meta.title)} title="Double-click to rename">{meta.title}</h1>
      {/if}
      <span class="project-label" title={meta.cwd}>{meta.project ?? 'No project'} <span class="muted">{tildify(meta.cwd)}</span></span>
      {#if headerError}<span class="notice error">{headerError}</span>{/if}
      <div class="pane-toggles">
        {#if meta.hasMessages}
          <button class="ghost icon-button header-fork" aria-label="Fork" data-tip={forkBlocked ? 'Fork once the turn ends' : 'Fork conversation'} disabled={forkBlocked} onclick={fork}>
            <Icon name="fork" />
          </button>
        {/if}
        {#if review}<button class={['ghost small', pane === 'review' && 'pane-on']} onclick={() => toggle('review')}>Review</button>{/if}
        <button class={['ghost icon-button', pane === 'browser' && 'pane-on']} aria-label="Browser" data-tip="Browser" onclick={() => toggle('browser')}>
          <Icon name="globe" />
          {#if browser?.activity}<span class="browser-activity-dot"></span>{/if}
        </button>
        <button class={['ghost icon-button', pane === 'terminal' && 'pane-on']} aria-label="Terminal" data-tip="Terminal" onclick={() => toggle('terminal')}>
          <Icon name="terminal" />
          {#if c.terminals?.tabs.some((t) => t.running)}<span class="terminal-running"></span>{/if}
        </button>
      </div>
    </header>
    <div class="conversation-body">
      <div class="conversation-main">
        <div
          class="transcript"
          bind:this={scroller}
          onscroll={() => scroller && (stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_DISTANCE)}
        >
          <div class="transcript-inner">
            {#if c.items.length === 0 && meta.status !== 'running'}<div class="empty">What should we work on?</div>{/if}
            {#each c.items as item (item.id)}<Item {item} {cwd} conversationId={id} />{/each}
            {#if wrapUp?.ask}<NextStep conversationId={id} {wrapUp} />{/if}
            {#if meta.compacting}<div class="status-line">Compacting conversation…</div>
            {:else if meta.requests.length > 0}<div class="status-line">Waiting for you</div>
            {:else if meta.status === 'running'}<div class="status-line working">
                Working…{#if turnStartedAt !== null && now - turnStartedAt >= 1000}<span class="elapsed">{duration(now - turnStartedAt)}</span>{/if}
              </div>
            {:else if meta.status === 'starting'}<div class="status-line">Starting Claude Code…</div>{/if}
          </div>
        </div>
        <div class="bottom">
          {#if showTasks}
            <div class="tasks">
              <button class="tasks-head" onclick={() => (tasksOpen = !tasksOpen)}>
                <span class="caret">{tasksOpen ? '▾' : '▸'}</span> Tasks {tasks.filter((t) => t.status === 'completed').length}/{tasks.length}
              </button>
              {#if tasksOpen}<Todos items={tasks.map((t) => ({ text: t.status === 'in_progress' ? t.activeForm : t.subject, status: t.status }))} />{/if}
            </div>
          {/if}
          <Requests
            conversationId={meta.id}
            requests={meta.requests}
            cwd={meta.cwd}
            supportsAuto={modelRow(meta.models, meta.model)?.supportsAutoMode === true}
          />
          <Composer {meta} {visible} />
        </div>
      </div>
      {#if pane === 'review' && review}
        <Dock kind="review"><ReviewPanel {review} conversationId={id} {visible} onhide={() => (pane = null)} /></Dock>
      {:else if pane === 'browser'}
        <Dock kind="browser"><BrowserPane conversationId={id} browser={browser ?? NO_BROWSER} {visible} onhide={() => (pane = null)} /></Dock>
      {:else if pane === 'terminal'}
        <Dock kind="terminal"><TerminalPane conversationId={id} terminals={c.terminals ?? NO_TERMINALS} {visible} onhide={() => (pane = null)} /></Dock>
      {/if}
    </div>
  </div>
{/if}
