<!-- What a reviewer said about a finding: where it is, its kind, how sure the reviewer is, the defect and how it fails. -->
<script lang="ts">
  import { location } from '@shared/review'
  import type { Finding } from '@shared/types'

  /** where: show the location; the caller may show it already. */
  let { finding, where = true }: { finding: Finding; where?: boolean } = $props()
</script>

<div class="finding-details">
  <div class="finding-meta">
    {#if where}<span class="mono">{location(finding)}</span>{/if}
    {#if finding.category}<span class="chip">{finding.category}</span>{/if}
    {#if finding.verdict}<span class={['chip', finding.verdict === 'PLAUSIBLE' && 'plausible']}>{finding.verdict.toLowerCase()}</span>{/if}
  </div>
  {#if finding.summary !== finding.title || !finding.failureScenario}<p>{finding.summary}</p>{/if}
  {#if finding.failureScenario}<p><span class="finding-label">Fails when</span> {finding.failureScenario}</p>{/if}
</div>
