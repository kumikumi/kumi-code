<!-- The review a conversation is in: every finding with where it stands, and the one the user looks at with its thread and the actions that move it on. Its left edge resizes it. -->
<script module lang="ts">
  const WIDTH_KEY = 'reviewPanelWidth'
  const DEFAULT_WIDTH = 340
  const MIN_WIDTH = 280
  /** What the transcript keeps at least when the panel widens. */
  const MIN_MAIN = 400

  /** Shared by the review panels of this window, and remembered for the next launch. */
  const size = $state({ width: Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH })

  function setWidth(width: number): void {
    size.width = Math.round(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth - MIN_MAIN)))
  }

  function saveWidth(): void {
    localStorage.setItem(WIDTH_KEY, String(size.width))
  }
</script>

<script lang="ts">
  import { isSettled, relayTarget, statusLabel } from '@shared/review'
  import type { FindingReply, Review, ReviewFinding } from '@shared/types'
  import FindingDetails from './FindingDetails.svelte'
  import Rich from './Rich.svelte'
  import { api } from './state.svelte'
  import { errorMessage } from './util'

  let { review, conversationId, visible, onhide }: { review: Review; conversationId: string; visible: boolean; onhide: () => void } = $props()

  const other = $derived(review.implementerId === conversationId ? { id: review.reviewerId, name: 'Reviewer' } : { id: review.implementerId, name: 'Implementer' })
  /** The finding the user picked, and whether it was settled then. */
  let picked = $state<{ rank: number; settled: boolean } | null>(null)
  // Without a pick: the first finding that can be sent, else the first one still open.
  const shown = $derived(
    review.findings.find((f) => f.rank === picked?.rank) ??
      review.findings.find((f) => relayTarget(f) !== null) ??
      review.findings.find((f) => !isSettled(f.status)),
  )
  const shownRank = $derived(shown?.rank)
  const target = $derived(shown ? relayTarget(shown) : null)
  let note = $state('')
  let error = $state<string | null>(null)
  let sending = $state(false)
  let aside = $state<HTMLElement>()
  /** Where a resize started: the pointer and the panel's width. */
  let resizing = $state<{ x: number; width: number } | null>(null)

  // A picked finding that gets settled hands over to the next one.
  $effect.pre(() => {
    const f = review.findings.find((x) => x.rank === picked?.rank)
    if (picked && f && !picked.settled && isSettled(f.status)) picked = null
  })
  // The note belongs to the finding it was written for. Only the rank counts:
  // every review update brings new copies of the findings.
  $effect.pre(() => {
    void shownRank
    note = ''
    error = null
  })

  function pick(f: ReviewFinding): void {
    picked = { rank: f.rank, settled: isSettled(f.status) }
  }

  function run(p: Promise<unknown>): void {
    error = null
    p.catch((err: unknown) => (error = errorMessage(err)))
  }

  function send(): void {
    if (!shown || !target || sending) return
    // A finding on its way stays the current one until it is settled.
    pick(shown)
    sending = true
    error = null
    api
      .relayFinding(review.id, shown.rank, note)
      .then(
        () => (note = ''),
        (err: unknown) => (error = errorMessage(err)),
      )
      .finally(() => (sending = false))
  }

  function startResize(e: PointerEvent): void {
    if (e.button !== 0 || !aside) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    // The width the panel has, which its max-width may hold below the one set.
    resizing = { x: e.clientX, width: aside.getBoundingClientRect().width }
  }

  function endResize(): void {
    if (!resizing) return
    resizing = null
    saveWidth()
  }

  function resizeByKey(e: KeyboardEvent): void {
    const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0
    if (!step) return
    e.preventDefault()
    setWidth(size.width + step)
    saveWidth()
  }

  function end(): void {
    if (window.confirm('End this review? Its findings and their threads are removed from Kumi Code; both conversations stay.')) run(api.endReview(review.id))
  }

  function action(f: ReviewFinding): string {
    if (f.stalled) return 'Send again'
    if (f.status === 'reopened') return 'Send back to implementer'
    return relayTarget(f) === 'implementer' ? 'Send to implementer' : 'Send to reviewer'
  }

  function who(entry: FindingReply): string {
    switch (entry.outcome) {
      case 'fixed':
        return 'Implementer · fixed'
      case 'no_change_needed':
        return 'Implementer · no change needed'
      case 'accept':
        return 'Reviewer · accepted'
      case 'reopen':
        return 'Reviewer · reopened'
      default:
        return 'Your note'
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (visible && e.metaKey && e.key === 'Enter' && target) {
      e.preventDefault()
      send()
    }
  }}
/>

<aside class="review-panel" style:width="{size.width}px" bind:this={aside}>
  <!-- A focusable separator is a widget, the ARIA window splitter; Svelte counts every separator as static. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class={['review-resize', resizing && 'active']}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the review panel"
    aria-valuenow={size.width}
    tabindex="0"
    title="Drag to resize; double-click for the default width"
    onpointerdown={startResize}
    onpointermove={(e) => resizing && setWidth(resizing.width + resizing.x - e.clientX)}
    onpointerup={endResize}
    onpointercancel={endResize}
    ondblclick={() => (setWidth(DEFAULT_WIDTH), saveWidth())}
    onkeydown={resizeByKey}
  ></div>
  <header class="review-head">
    <span class="review-name">Review</span>
    <span class="muted review-progress">{review.findings.filter((f) => isSettled(f.status)).length} of {review.findings.length} settled</span>
    <span class="spacer"></span>
    <button class="ghost small" title="Go to the {other.name.toLowerCase()}'s conversation" onclick={() => run(api.showConversation(other.id))}>{other.name} ›</button>
    <button class="ghost small" onclick={end}>End</button>
    <button class="ghost small" aria-label="Hide the review" title="Hide" onclick={onhide}>×</button>
  </header>
  <ol class="review-findings">
    {#each review.findings as f (f.rank)}
      {@const current = f.rank === shown?.rank}
      <li class={['review-finding', current && 'current', isSettled(f.status) && 'settled']}>
        <div class="review-row">
          <button class="review-pick" onclick={() => pick(f)}>
            <span class={['finding-dot', f.status, f.stalled && 'stalled']}></span>
            <span class="review-row-text">
              <span class="review-row-title">{f.rank}. {f.title}</span>
              <span class="review-row-status">{statusLabel(f)}</span>
            </span>
          </button>
          {#if f.status === 'closed'}
            <button class="ghost small row-action" title="Reopen this finding" onclick={() => run(api.setFindingClosed(review.id, f.rank, false))}>Reopen</button>
          {:else if !isSettled(f.status)}
            <button class="ghost small row-action" title="Close this finding: nothing more is done about it" onclick={() => run(api.setFindingClosed(review.id, f.rank, true))}>Close</button>
          {/if}
        </div>
        {#if current}
          <div class="review-current">
            <FindingDetails finding={f} />
            {#each f.thread as entry, i (i)}
              <div class="thread-entry {entry.from}">
                <div class="thread-who">{who(entry)}</div>
                <Rich text={entry.text} />
              </div>
            {/each}
            {#if target}
              <textarea class="review-note" rows="2" placeholder="Note for the {target} (optional)" bind:value={note}></textarea>
              <div class="review-actions">
                <button class="primary" disabled={sending} onclick={send}>{action(f)} <span class="kbd">⌘↵</span></button>
              </div>
            {:else if f.status === 'implementing' || f.status === 'verifying'}
              <div class="status-line working">{f.status === 'implementing' ? 'The implementer is on it' : 'The reviewer is checking the answer'}</div>
            {/if}
            {#if error}<div class="notice error">{error}</div>{/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</aside>
