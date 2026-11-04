<!-- The header's palette button and its menu of color themes. Pointing at a theme previews it on the conversation; clicking one picks it. -->
<script lang="ts">
  import { THEMES } from '@shared/themes'
  import type { ThemeId } from '@shared/themes'
  import Icon from './Icon.svelte'
  import { api } from './state.svelte'
  import { errorMessage } from './util'

  let { conversationId, theme, onpreview, onerror }: { conversationId: string; theme: ThemeId; onpreview: (theme: ThemeId | null) => void; onerror: (message: string) => void } = $props()

  let menu = $state<HTMLDivElement>()
  // Each conversation's button anchors its own menu; the id makes the anchor name unique.
  const anchor = $derived(`--theme-${conversationId}`)

  function pick(id: ThemeId): void {
    menu?.hidePopover()
    if (id !== theme) api.setTheme(conversationId, id).catch((err: unknown) => onerror(errorMessage(err)))
  }
</script>

<button
  class="ghost icon-button"
  style:anchor-name={anchor}
  popovertarget="theme-menu-{conversationId}"
  aria-label="Color theme"
  data-tip="Color theme"
>
  <Icon name="palette" />
</button>
<div
  class="theme-menu"
  id="theme-menu-{conversationId}"
  popover
  bind:this={menu}
  style:position-anchor={anchor}
  ontoggle={(e) => e.newState === 'closed' && onpreview(null)}
>
  <div class="theme-grid" role="group" aria-label="Color themes" onpointerleave={() => onpreview(null)}>
    {#each THEMES as t (t.id)}
      <button class="theme-option" aria-pressed={t.id === theme} onpointerenter={() => onpreview(t.id)} onclick={() => pick(t.id)}>
        <span class="theme-sample" data-theme={t.id}></span>
        <span class="theme-name">{t.name}</span>
      </button>
    {/each}
  </div>
</div>
