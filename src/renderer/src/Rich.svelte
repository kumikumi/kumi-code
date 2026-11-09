<!-- Markdown (`text`) or a code block (`code`), highlighted, and its references to the folder's files linked, once it stops changing. -->
<script lang="ts">
  import { getContext } from 'svelte'
  import { FILES } from './code/filerefs'
  import type { FileContext } from './code/filerefs'
  import { codeBlockHtml, highlightBlocks, linkFileRefs, markdownHtml, onRichClick } from './markdown'

  let { text, code, lang = '', streaming = false }: { text?: string; code?: string; lang?: string; streaming?: boolean } = $props()
  let el: HTMLDivElement
  const html = $derived(code === undefined ? markdownHtml(text ?? '') : codeBlockHtml(code, lang))
  /** The conversation's folder, when there is one, whose files inline code may name. */
  const files = getContext<FileContext | undefined>(FILES)

  $effect(() => {
    if (!html || streaming) return
    highlightBlocks(el)
    if (code === undefined && files) void linkFileRefs(el, files)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class={code === undefined ? 'markdown' : 'code'} bind:this={el} onclick={onRichClick}>{@html html}</div>
