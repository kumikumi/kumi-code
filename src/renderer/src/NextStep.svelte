<!-- The next-step box: the recap and question of the agent's last wrap_up, and buttons whose click sends the answer as the user's message. -->
<script lang="ts">
  import type { WrapUp } from '@shared/wrap-up'
  import { api } from './state.svelte'
  import { errorMessage } from './util'

  let { conversationId, wrapUp }: { conversationId: string; wrapUp: WrapUp } = $props()

  let sending = $state(false)
  let error = $state<string | null>(null)

  function answer(message: string): void {
    sending = true
    error = null
    api.send(conversationId, message, []).then(
      () => (sending = false),
      (err: unknown) => {
        sending = false
        error = errorMessage(err)
      },
    )
  }
</script>

<div class="next-step">
  <div class="next-step-recap">{wrapUp.recap}</div>
  {#if wrapUp.ask}<div class="next-step-ask">{wrapUp.ask}</div>{/if}
  {#if wrapUp.buttons.length > 0}
    <div class="next-step-actions">
      {#each wrapUp.buttons as button, i (i)}
        <button class={i === 0 ? 'primary' : ''} disabled={sending} title={button.message} onclick={() => answer(button.message)}>{button.label}</button>
      {/each}
    </div>
  {/if}
  {#if error}<div class="notice error">{error}</div>{/if}
</div>
