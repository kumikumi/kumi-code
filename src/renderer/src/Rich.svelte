<!-- Markdown (`text`) or a code block (`code`), highlighted once it stops changing. -->
<script lang="ts">
  import { codeBlockHtml, highlightBlocks, markdownHtml, onRichClick } from './markdown'

  let { text, code, lang = '', streaming = false }: { text?: string; code?: string; lang?: string; streaming?: boolean } = $props()
  let el: HTMLDivElement
  const html = $derived(code === undefined ? markdownHtml(text ?? '') : codeBlockHtml(code, lang))

  $effect(() => {
    if (html && !streaming) highlightBlocks(el)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class={code === undefined ? 'markdown' : 'code'} bind:this={el} onclick={onRichClick}>{@html html}</div>
