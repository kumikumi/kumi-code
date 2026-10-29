<!-- Findings a reviewer reported with ReportFindings, most severe first, and the start of a review loop with the conversation that wrote the code. -->
<script lang="ts">
  import { isSettled, location, parseFindings, statusLabel } from '@shared/review'
  import type { ConversationSummary, TranscriptItem } from '@shared/types'
  import FindingDetails from './FindingDetails.svelte'
  import { api, app } from './state.svelte'
  import { errorMessage, shortTime } from './util'

  let { tool, conversationId, cwd }: { tool: Extract<TranscriptItem, { kind: 'tool' }>; conversationId: string; cwd: string } = $props()

  const findings = $derived(parseFindings(tool.input))
  const level = $derived(typeof tool.input.level === 'string' ? tool.input.level : null)
  const review = $derived(app.reviews.find((r) => r.id === tool.id))
  const reported = $derived(tool.partialInput === null && tool.result !== null && !tool.result.isError)
  let expanded = $state<number | null>(null)
  /** Conversations that may have written the code, while the user picks one. */
  let candidates = $state<ConversationSummary[] | null>(null)
  let error = $state<string | null>(null)

  async function pick(): Promise<void> {
    error = null
    try {
      const others = (await api.listConversations(false)).filter((c) => c.id !== conversationId)
      // The implementer usually works in the same folder.
      candidates = [...others.filter((c) => c.cwd === cwd), ...others.filter((c) => c.cwd !== cwd)].slice(0, 12)
    } catch (err) {
      error = errorMessage(err)
    }
  }

  function start(implementerId: string): void {
    error = null
    candidates = null
    api.startReview(conversationId, tool.id, implementerId).catch((err: unknown) => (error = errorMessage(err)))
  }
</script>

<div class="item findings">
  <div class="findings-head">
    <span class="tool-state {tool.result === null ? 'running' : tool.result.isError ? 'error' : 'done'}"></span>
    <span class="tool-label">Review findings</span>
    <span class="muted">
      {tool.partialInput !== null ? 'Reporting…' : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`}{level ? ` · ${level} effort` : ''}
    </span>
    {#if review}
      <span class="findings-progress">{review.findings.filter((f) => isSettled(f.status)).length} of {review.findings.length} settled</span>
    {/if}
  </div>
  {#if tool.partialInput === null}
    {#if findings.length === 0}<div class="muted findings-empty">No findings.</div>{/if}
    <ol class="finding-list">
      {#each findings as f, i (i)}
        {@const state = review?.findings[i]}
        <li>
          <button class="finding-line" onclick={() => (expanded = expanded === i ? null : i)}>
            <span class="finding-rank">{i + 1}</span>
            {#if state}<span class={['finding-dot', state.status, state.stalled && 'stalled']} title={statusLabel(state)}></span>{/if}
            <span class="finding-title">{f.title}</span>
            <span class="finding-where">{location(f)}</span>
          </button>
          {#if expanded === i}<FindingDetails finding={f} where={false} />{/if}
        </li>
      {/each}
    </ol>
    {#if tool.result?.isError}<div class="tool-error-line">{tool.result.text.trim().split('\n')[0]?.slice(0, 200)}</div>{/if}
    {#if reported && !review && findings.length > 0}
      <div class="findings-foot">
        {#if candidates === null}
          <button onclick={pick}>Start review loop…</button>
          <span class="muted">Relay these findings to the conversation that wrote the code.</span>
        {:else}
          <div class="findings-pick">
            <div class="muted">Which conversation wrote the code?</div>
            {#each candidates as c (c.id)}
              <button class="pick-row" onclick={() => start(c.id)}>
                <span class="conversation-title">{c.title}</span>
                <span class="muted">{c.cwd === cwd ? 'This folder' : (c.project ?? c.cwd)} · {shortTime(c.lastActive)}</span>
              </button>
            {:else}
              <div class="muted">No other conversations.</div>
            {/each}
            <button class="ghost small" onclick={() => (candidates = null)}>Cancel</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if error}<div class="notice error">{error}</div>{/if}
  {/if}
</div>
