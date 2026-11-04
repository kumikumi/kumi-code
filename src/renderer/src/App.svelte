<!-- A window: its tab strip and its tabs. Conversation tabs stay mounted once shown, so switching back keeps scroll position and composer state. -->
<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { DEFAULT_THEME } from '@shared/themes'
  import Conversation from './Conversation.svelte'
  import NewTabPage from './NewTabPage.svelte'
  import { app, retain } from './state.svelte'
  import TabStrip from './TabStrip.svelte'

  const shown = new SvelteSet<string>()

  $effect(() => {
    const w = app.window
    if (!w) return
    shown.add(w.activeTabId)
    retain(new Set(w.tabs.flatMap((t) => (t.conversationId ? [t.conversationId] : []))))
    document.title = w.tabs.find((t) => t.id === w.activeTabId)?.title ?? 'Kumi Code'
  })
</script>

{#if app.window}
  {@const w = app.window}
  <div class="window" data-theme={w.tabs.find((t) => t.id === w.activeTabId)?.theme ?? DEFAULT_THEME}>
    <TabStrip win={w} />
    <div class="tab-content">
      {#each w.tabs as tab (`${tab.id}:${tab.conversationId ?? 'new'}`)}
        {@const active = tab.id === w.activeTabId}
        {#if active || (tab.conversationId && shown.has(tab.id))}
          <div class="tab-pane" hidden={!active}>
            {#if tab.conversationId}
              <Conversation id={tab.conversationId} theme={tab.theme} visible={active} />
            {:else}
              <NewTabPage tabId={tab.id} visible={active} />
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}
