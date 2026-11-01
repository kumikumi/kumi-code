<!-- A conversation's Terminal panel: its shell tabs, and the active one in a terminal the user types in. A tab starts from a snapshot of its screen and continues with the output after it; the shell takes the pane's size. A tab the agent types in says so. -->
<script lang="ts">
  import { FitAddon } from '@xterm/addon-fit'
  import { Terminal } from '@xterm/xterm'
  import '@xterm/xterm/css/xterm.css'
  import type { TerminalAction, TerminalState } from '@shared/types'
  import { api } from './state.svelte'
  import { errorMessage } from './util'

  let { conversationId, terminals, visible, onhide }: { conversationId: string; terminals: TerminalState; visible: boolean; onhide: () => void } = $props()

  const activeId = $derived(terminals.activeTabId)
  const activeTab = $derived(terminals.tabs.find((t) => t.id === activeId))
  let host = $state<HTMLDivElement>()
  let error = $state<string | null>(null)
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  /** The tab the terminal shows, and the last output chunk it has. */
  let shown: string | null = null
  let lastSeq = 0
  /** Output that arrived while the snapshot loaded. */
  let pending: { data: string; seq: number }[] | null = null

  function act(action: TerminalAction): void {
    error = null
    api.terminalAction(conversationId, action).catch((err: unknown) => (error = errorMessage(err)))
  }

  // Output comes only while the pane shows.
  $effect(() => {
    if (!visible) return
    api.watchTerminals(conversationId, true)
    return () => api.watchTerminals(conversationId, false)
  })

  $effect(() =>
    api.onTerminalOutput((id, tabId, data, seq) => {
      if (id !== conversationId || tabId !== shown) return
      if (pending) pending.push({ data, seq })
      else if (seq > lastSeq) {
        term?.write(data)
        lastSeq = seq
      }
    }),
  )

  // The terminal, once: it follows the active tab and the pane's size.
  $effect(() => {
    if (!host) return
    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#15171c', foreground: '#d9dce1', cursor: '#d97757', selectionBackground: '#3a4150' },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host)
    t.onData((data) => shown && api.terminalInput(conversationId, shown, data))
    term = t
    fit = f
    const observer = new ResizeObserver(() => resize())
    observer.observe(host)
    return () => {
      observer.disconnect()
      t.dispose()
      term = null
      fit = null
      shown = null
    }
  })

  // A new active tab: its screen from a snapshot, then its output after it.
  $effect(() => {
    const id = activeId
    if (!term || id === shown) return
    shown = id
    term.reset()
    if (!id) return
    pending = []
    api.terminalSnapshot(conversationId, id).then(
      (snapshot) => {
        if (shown !== id || !term) return
        term.write(snapshot.data)
        lastSeq = snapshot.seq
        for (const chunk of pending ?? []) {
          if (chunk.seq > lastSeq) {
            term.write(chunk.data)
            lastSeq = chunk.seq
          }
        }
        pending = null
        resize()
        if (visible) term.focus()
      },
      (err: unknown) => {
        pending = null
        error = errorMessage(err)
      },
    )
  })

  function resize(): void {
    if (!term || !fit || !host?.offsetWidth) return
    fit.fit()
    if (shown) api.terminalResize(conversationId, shown, term.cols, term.rows)
  }
</script>

<div class="terminal-pane">
  <div class="browser-tabs">
    {#each terminals.tabs as tab (tab.id)}
      <div class={['browser-tab', tab.id === activeId && 'active']}>
        <button
          class="browser-tab-title"
          title="{tab.cwd}{tab.openedBy === 'agent' ? ' (opened by Claude)' : ''}{tab.agentTyping ? ' — Claude is typing' : ''}"
          onclick={() => act({ kind: 'select', tabId: tab.id })}
        >
          {#if tab.agentTyping}<span class="terminal-typing"></span>{:else if tab.running}<span class="terminal-running"></span>{/if}{tab.title}{tab.exited ? ' (exited)' : ''}
        </button>
        <button class="browser-tab-close" aria-label="Close tab" title="Close tab" onclick={() => act({ kind: 'close', tabId: tab.id })}>×</button>
      </div>
    {/each}
    <button class="ghost small" aria-label="New tab" title="New shell" onclick={() => act({ kind: 'open' })}>+</button>
    <span class="spacer"></span>
    <button class="ghost small" aria-label="Hide the terminal" title="Hide" onclick={onhide}>×</button>
  </div>
  {#if error}<div class="notice error browser-error">{error}</div>{/if}
  <div class="terminal-view" hidden={!activeId}>
    <div class="terminal-host" bind:this={host}></div>
    <!-- Over the terminal, so it does not change the shell's size. -->
    {#if activeTab?.agentTyping}<div class="terminal-typing-badge">Claude is typing</div>{/if}
  </div>
  {#if !activeId}
    <div class="browser-empty">
      No shell is open.
      <div><button onclick={() => act({ kind: 'open' })}>Open a shell</button></div>
    </div>
  {/if}
</div>
