<!-- One transcript item: a message with when it was sent, thinking, a tool call with its result, a notice, or the end of a turn with how long it took. Review findings and relayed review messages get cards of their own. -->
<script lang="ts">
  import type { TranscriptItem } from '@shared/types'
  import { WRAP_UP_TOOL } from '@shared/wrap-up'
  import FindingsCard from './FindingsCard.svelte'
  import Icon from './Icon.svelte'
  import Item from './Item.svelte'
  import RelayCard from './RelayCard.svelte'
  import Rich from './Rich.svelte'
  import Todos from './Todos.svelte'
  import ToolInput from './ToolInput.svelte'
  import { api, app } from './state.svelte'
  import { summarizeTool } from './tools'
  import { duration, errorMessage, fullTime, messageTime, str } from './util'

  let { item, cwd, conversationId }: { item: TranscriptItem; cwd: string; conversationId: string } = $props()

  /** Long tool output is cut to this many characters until expanded. */
  const PREVIEW = 4000
  /** Task list tools show in the task list above the composer, and wrap_up in the next-step box, not here. */
  const HIDDEN_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', WRAP_UP_TOOL]

  let open = $state(false)
  let full = $state(false)
  let error = $state<string | null>(null)

  function act(p: Promise<unknown>): void {
    error = null
    p.catch((err: unknown) => (error = errorMessage(err)))
  }

  const tool = $derived(item.kind === 'tool' ? item : null)
  const summary = $derived(tool && summarizeTool(tool.name, tool.input, cwd))
  const isAgent = $derived(tool?.name === 'Agent' || tool?.name === 'Task')
  const toolState = $derived(!tool?.result ? 'running' : tool.result.isError ? 'error' : 'done')
  const lastChild = $derived(tool?.children.findLast((c) => c.kind === 'tool'))
</script>

{#snippet sent(at: number | null)}
  {#if at !== null}<time class="message-time" datetime={new Date(at).toISOString()} title="Sent {fullTime(at)}">{messageTime(at, app.today)}</time>{/if}
{/snippet}

{#if item.kind === 'user' && item.relay}
  <RelayCard relay={item.relay} queued={item.queued} />
  {@render sent(item.at)}
{:else if item.kind === 'user'}
  <div class={['item user', item.queued && 'queued']}>
    {#if item.images.length > 0}
      <div class="images">
        {#each item.images as img, i (i)}<img src="data:{img.mediaType};base64,{img.data}" alt="" />{/each}
      </div>
    {/if}
    {#if item.text}<div class="user-text">{item.text}</div>{/if}
    {#if item.queued}<div class="queued-label">Queued</div>{/if}
  </div>
  {@render sent(item.at)}
{:else if item.kind === 'turn'}
  <div class="item turn-end">
    {#if error}<span class="turn-error">{error}</span>{/if}
    <button class="ghost small turn-fork" title="A new conversation with everything up to here" onclick={() => act(api.forkConversation(conversationId, item.messageId, null))}>
      <Icon name="fork" />Fork from here
    </button>
    <time datetime={new Date(item.finishedAt).toISOString()} title={`Started ${fullTime(item.startedAt)}\nFinished ${fullTime(item.finishedAt)}`}>
      Worked for {duration(item.finishedAt - item.startedAt)}<span class="turn-dot">·</span>{messageTime(item.finishedAt, app.today)}
    </time>
  </div>
{:else if item.kind === 'fork'}
  <div class="item divider fork-divider">
    <span>
      <Icon name="fork" />Forked from
      <button class="fork-source" title="Show that conversation" onclick={() => act(api.showConversation(item.fromId))}>{item.fromTitle}</button>
      {#if error}<span class="turn-error">{error}</span>{/if}
    </span>
  </div>
{:else if item.kind === 'text'}
  <div class="item text"><Rich text={item.text} streaming={item.streaming} /></div>
{:else if item.kind === 'thinking' && (item.text.trim() || item.streaming)}
  <div class="item thinking">
    <button class="thinking-toggle" onclick={() => (open = !open)}>
      <span class="caret">{open ? '▾' : '▸'}</span>
      {item.streaming ? 'Thinking…' : 'Thought'}
    </button>
    {#if open}<div class="thinking-text">{item.text}</div>{/if}
  </div>
{:else if tool?.name === 'ReportFindings'}
  <FindingsCard {tool} {cwd} {conversationId} />
{:else if tool?.name === 'TodoWrite'}
  <div class="item tool todo-card">
    <div class="tool-head static"><span class="tool-label">Todos</span></div>
    <Todos items={(Array.isArray(tool.input.todos) ? tool.input.todos : []).map((t) => ({ text: str(t.content), status: str(t.status) }))} />
  </div>
{:else if tool && summary && !(HIDDEN_TOOLS.includes(tool.name) && !tool.result?.isError)}
  <div class="item tool {toolState}">
    <button class="tool-head" onclick={() => (open = !open)}>
      <span class="tool-state {toolState}"></span>
      <span class="tool-label">{summary.label}</span>
      <span class="tool-detail">{summary.detail}</span>
      {#if isAgent && tool.children.length > 0}
        <span class="tool-count">{tool.children.filter((c) => c.kind === 'tool').length} tool uses</span>
      {/if}
    </button>
    {#if isAgent && !open && !tool.result && lastChild?.kind === 'tool'}
      {@const last = summarizeTool(lastChild.name, lastChild.input, cwd)}
      <div class="agent-activity">{last.label} {last.detail}</div>
    {/if}
    {#if open}
      <div class="tool-body">
        {#if tool.partialInput !== null}
          <pre class="tool-text">{tool.partialInput}</pre>
        {:else}
          <ToolInput name={tool.name} input={tool.input} />
        {/if}
        {#if isAgent && tool.children.length > 0}
          <div class="agent-children">
            {#each tool.children as child (child.id)}<Item item={child} {cwd} {conversationId} />{/each}
          </div>
        {/if}
        {#if tool.result && isAgent}
          <Rich text={tool.result.text} />
        {:else if tool.result}
          {@const { text, images, isError } = tool.result}
          <div class={['tool-output', isError && 'error']}>
            {#if !text && images === 0}<div class="tool-empty">(no output)</div>{/if}
            {#if text}<pre class="tool-text">{full || text.length <= PREVIEW ? text : `${text.slice(0, PREVIEW)}…`}</pre>{/if}
            {#if !full && text.length > PREVIEW}
              <button class="ghost small" onclick={() => (full = true)}>Show all {text.length.toLocaleString()} characters</button>
            {/if}
            {#if images > 0}<div class="tool-empty">{images === 1 ? '1 image' : `${images} images`}</div>{/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if !open && tool.result?.isError}
      <div class="tool-error-line">{tool.result.text.trim().split('\n')[0]?.slice(0, 200)}</div>
    {/if}
  </div>
{:else if item.kind === 'compact'}
  <div class="item divider">
    <span>
      Conversation compacted{#if item.trigger}
        ({item.trigger}{item.preTokens ? `, ${Math.round(item.preTokens / 1000)}k tokens before` : ''}){/if}
    </span>
  </div>
{:else if item.kind === 'command_output'}
  <pre class="item command-output">{item.text}</pre>
{:else if item.kind === 'notice'}
  <div class="item notice {item.level}">{item.text}</div>
{/if}
