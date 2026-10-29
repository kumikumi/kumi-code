<!-- One transcript item: a message, thinking, a tool call with its result, or a notice. -->
<script lang="ts">
  import type { TranscriptItem } from '@shared/types'
  import Item from './Item.svelte'
  import Rich from './Rich.svelte'
  import Todos from './Todos.svelte'
  import ToolInput from './ToolInput.svelte'
  import { summarizeTool } from './tools'
  import { str } from './util'

  let { item, cwd }: { item: TranscriptItem; cwd: string } = $props()

  /** Long tool output is cut to this many characters until expanded. */
  const PREVIEW = 4000
  /** Task list tools show in the task list above the composer, not here. */
  const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']

  let open = $state(false)
  let full = $state(false)

  const tool = $derived(item.kind === 'tool' ? item : null)
  const summary = $derived(tool && summarizeTool(tool.name, tool.input, cwd))
  const isAgent = $derived(tool?.name === 'Agent' || tool?.name === 'Task')
  const toolState = $derived(!tool?.result ? 'running' : tool.result.isError ? 'error' : 'done')
  const lastChild = $derived(tool?.children.findLast((c) => c.kind === 'tool'))
</script>

{#if item.kind === 'user'}
  <div class={['item user', item.queued && 'queued']}>
    {#if item.images.length > 0}
      <div class="images">
        {#each item.images as img, i (i)}<img src="data:{img.mediaType};base64,{img.data}" alt="" />{/each}
      </div>
    {/if}
    {#if item.text}<div class="user-text">{item.text}</div>{/if}
    {#if item.queued}<div class="queued-label">Queued</div>{/if}
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
{:else if tool?.name === 'TodoWrite'}
  <div class="item tool todo-card">
    <div class="tool-head static"><span class="tool-label">Todos</span></div>
    <Todos items={(Array.isArray(tool.input.todos) ? tool.input.todos : []).map((t) => ({ text: str(t.content), status: str(t.status) }))} />
  </div>
{:else if tool && summary && !(TASK_TOOLS.includes(tool.name) && !tool.result?.isError)}
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
            {#each tool.children as child (child.id)}<Item item={child} {cwd} />{/each}
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
