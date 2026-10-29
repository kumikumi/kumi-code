<!-- A review finding, or an agent's answer to one, that Kumi Code relayed to this conversation's agent. -->
<script lang="ts">
  import { location } from '@shared/review'
  import type { RelayMessage } from '@shared/types'
  import FindingDetails from './FindingDetails.svelte'
  import Rich from './Rich.svelte'

  let { relay, queued }: { relay: RelayMessage; queued: boolean } = $props()

  // A finding sent for the first time is the message itself, so it starts open.
  // svelte-ignore state_referenced_locally
  let open = $state(relay.to === 'implementer' && relay.reply === null)

  const heading = $derived.by(() => {
    const which = `finding ${relay.rank} of ${relay.of}`
    if (relay.to === 'implementer') return relay.reply ? `The reviewer reopened ${which}` : `From the reviewer: ${which}`
    return `The implementer's answer to ${which}: ${relay.reply?.outcome === 'fixed' ? 'fixed' : 'no change needed'}`
  })
</script>

<div class={['item relay', queued && 'queued']}>
  <button class="relay-head" onclick={() => (open = !open)}>
    <span class="caret">{open ? '▾' : '▸'}</span>
    <span class="relay-heading">{heading}</span>
  </button>
  <div class="relay-title">{relay.finding.title} <span class="mono muted">{location(relay.finding)}</span></div>
  {#if open}<FindingDetails finding={relay.finding} where={false} />{/if}
  {#if relay.reply}<div class="relay-reply"><Rich text={relay.reply.text} /></div>{/if}
  {#if relay.note}<div class="relay-note"><span class="finding-label">Your note</span> {relay.note}</div>{/if}
  {#if queued}<div class="queued-label">Queued</div>{/if}
</div>
