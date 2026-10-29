<!-- A conversation: its transcript, task list, pending requests and the composer. -->
<script lang="ts">
  import Composer from './Composer.svelte'
  import Item from './Item.svelte'
  import Requests from './Requests.svelte'
  import Todos from './Todos.svelte'
  import { api, conversation } from './state.svelte'
  import { errorMessage, tildify } from './util'

  let { id, visible }: { id: string; visible: boolean } = $props()

  /** Within this many pixels of the bottom, the transcript follows new output. */
  const STICK_DISTANCE = 80

  // A tab's conversation never changes; App keys the component by it.
  // svelte-ignore state_referenced_locally
  const c = conversation(id)
  let scroller = $state<HTMLDivElement>()
  let stick = true
  let renaming = $state<string | null>(null)
  let renameError = $state<string | null>(null)
  let tasksOpen = $state(true)

  const meta = $derived(c.meta)
  // Rows get the folder as a string of its own: a new meta object (every meta
  // update) with the same folder then leaves them alone.
  const cwd = $derived(meta?.cwd ?? '')
  const tasks = $derived(meta?.tasks ?? [])
  const showTasks = $derived(tasks.some((t) => t.status !== 'completed'))

  // New output, or coming back into view: follow the bottom unless scrolled up.
  $effect(() => {
    void [c.items, meta, visible]
    if (scroller && stick) scroller.scrollTop = scroller.scrollHeight
  })

  function saveTitle(): void {
    const title = renaming?.trim()
    renaming = null
    if (meta && title && title !== meta.title) api.renameConversation(meta.id, title).catch((err: unknown) => (renameError = errorMessage(err)))
  }
</script>

{#if !meta}
  <div class="conversation loading">
    {#if c.error}<div class="notice error">{c.error}</div>{:else}<div class="muted">Loading…</div>{/if}
  </div>
{:else}
  <div class="conversation">
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
      {#if renameError}<span class="notice error">{renameError}</span>{/if}
    </header>
    <div
      class="transcript"
      bind:this={scroller}
      onscroll={() => scroller && (stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_DISTANCE)}
    >
      <div class="transcript-inner">
        {#if c.items.length === 0 && meta.status !== 'running'}<div class="empty">What should we work on?</div>{/if}
        {#each c.items as item (item.id)}<Item {item} {cwd} />{/each}
        {#if meta.compacting}<div class="status-line">Compacting conversation…</div>
        {:else if meta.requests.length > 0}<div class="status-line">Waiting for you</div>
        {:else if meta.status === 'running'}<div class="status-line working">Working…</div>
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
        supportsAuto={meta.models.find((m) => m.value === (meta.model ?? 'default'))?.supportsAutoMode === true}
      />
      <Composer {meta} {visible} />
    </div>
  </div>
{/if}
