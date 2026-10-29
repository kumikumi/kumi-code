<!-- What the agent is waiting on: permission for a tool, answers to its questions, or approval of a plan. -->
<script lang="ts">
  import type { PendingRequest, RequestResponse } from '@shared/types'
  import Rich from './Rich.svelte'
  import ToolInput from './ToolInput.svelte'
  import { api } from './state.svelte'
  import { summarizeTool } from './tools'
  import { errorMessage } from './util'

  let { conversationId, requests, cwd, supportsAuto }: { conversationId: string; requests: PendingRequest[]; cwd: string; supportsAuto: boolean } = $props()

  const request = $derived(requests[0])
  let note = $state('')
  let error = $state<string | null>(null)
  /** Per question: the picked option labels and the typed answer. */
  let picked = $state<string[][]>([])
  let other = $state<string[]>([])

  // A new request starts with an empty form.
  $effect.pre(() => {
    void request?.id
    note = ''
    picked = []
    other = []
  })

  const answers = $derived(
    request?.kind === 'question' ? request.questions.map((_, i) => [...(picked[i] ?? []), ...(other[i]?.trim() ? [other[i].trim()] : [])].join(', ')) : [],
  )

  function respond(response: RequestResponse): void {
    if (!request) return
    error = null
    api.respond(conversationId, request.id, response).catch((err: unknown) => (error = errorMessage(err)))
  }

  function pick(i: number, label: string, multi: boolean): void {
    const current = picked[i] ?? []
    picked[i] = multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label]
    if (!multi) other[i] = ''
  }
</script>

{#if request}
  <div class="requests">
    {#if requests.length > 1}<div class="requests-count">{requests.length} requests waiting</div>{/if}
    {#if request.kind === 'permission'}
      {@const { label, detail } = summarizeTool(request.toolName, request.input, cwd)}
      <div class="request permission">
        <div class="request-title">{request.title ?? `Allow ${label}?`}</div>
        {#if request.description}<div class="request-sub">{request.description}</div>
        {:else if !request.title && detail}<div class="request-sub mono">{detail}</div>{/if}
        <div class="request-body"><ToolInput name={request.toolName} input={request.input} /></div>
        {#if request.reason}<div class="request-sub">{request.reason}</div>{/if}
        {#if request.blockedPath}<div class="request-sub">Outside the allowed folders: {request.blockedPath}</div>{/if}
        <div class="request-actions">
          <!-- svelte-ignore a11y_autofocus -->
          <button class="primary" autofocus onclick={() => respond({ kind: 'permission', allow: true, always: false })}>Allow</button>
          {#if request.canAlwaysAllow}
            <button onclick={() => respond({ kind: 'permission', allow: true, always: true })}>Always allow</button>
          {/if}
          <input
            class="grow"
            placeholder="Or tell Claude what to do instead"
            bind:value={note}
            onkeydown={(e) => e.key === 'Enter' && note.trim() && respond({ kind: 'permission', allow: false, message: note })}
          />
          <button onclick={() => respond({ kind: 'permission', allow: false, message: note })}>{note.trim() ? 'Deny with note' : 'Deny'}</button>
        </div>
      </div>
    {:else if request.kind === 'question'}
      <div class="request question">
        {#each request.questions as q, i (i)}
          <div class="question-block">
            {#if q.header}<span class="chip">{q.header}</span>{/if}
            <div class="request-title">{q.question}</div>
            <div class="options">
              {#each q.options as o (o.label)}
                <label class="option">
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name="q{i}" checked={picked[i]?.includes(o.label) ?? false} onchange={() => pick(i, o.label, q.multiSelect)} />
                  <span>
                    <span class="option-label">{o.label}</span>
                    {#if o.description}<span class="option-description">{o.description}</span>{/if}
                  </span>
                </label>
              {/each}
              <input
                placeholder="Other…"
                bind:value={other[i]}
                oninput={() => {
                  if (!q.multiSelect && other[i]) picked[i] = []
                }}
              />
            </div>
          </div>
        {/each}
        <div class="request-actions">
          <button
            class="primary"
            disabled={answers.some((a) => !a)}
            onclick={() => request.kind === 'question' && respond({ kind: 'question', answers: Object.fromEntries(request.questions.map((q, i) => [q.question, answers[i] ?? ''])) })}
          >
            Answer
          </button>
          <button onclick={() => respond({ kind: 'question', dismissed: true })}>Skip</button>
        </div>
      </div>
    {:else}
      <div class="request plan">
        <div class="request-title">Ready to code? Here is the plan:</div>
        <div class="plan-body">
          {#if request.plan}<Rich text={request.plan} />{:else}<div class="muted">The plan is in the conversation above.</div>{/if}
        </div>
        <div class="request-actions">
          <button class="primary" onclick={() => respond({ kind: 'plan', approve: true, mode: 'acceptEdits' })}>Approve, accept edits</button>
          {#if supportsAuto}<button onclick={() => respond({ kind: 'plan', approve: true, mode: 'auto' })}>Approve, auto mode</button>{/if}
          <button onclick={() => respond({ kind: 'plan', approve: true, mode: 'default' })}>Approve, ask for edits</button>
        </div>
        <div class="request-actions">
          <input class="grow" placeholder="Or tell Claude what to change" bind:value={note} />
          <button onclick={() => respond({ kind: 'plan', approve: false, feedback: note })}>Keep planning</button>
        </div>
      </div>
    {/if}
    {#if error}<div class="notice error">{error}</div>{/if}
  </div>
{/if}
