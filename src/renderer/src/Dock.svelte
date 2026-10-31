<!-- The pane beside the transcript, which holds the review panel, the browser or the terminal. Its left edge resizes it; each kind of pane keeps its own width. -->
<script module lang="ts">
  type Kind = 'review' | 'browser' | 'terminal'

  const SIZES: Record<Kind, { key: string; width: number; min: number }> = {
    review: { key: 'reviewPanelWidth', width: 340, min: 280 },
    browser: { key: 'browserPanelWidth', width: 560, min: 320 },
    terminal: { key: 'terminalPanelWidth', width: 560, min: 320 },
  }
  /** What the transcript keeps at least when the pane widens. */
  const MIN_MAIN = 400

  /** Shared by the panes of this window, and remembered for the next launch. */
  const widths = $state<Record<Kind, number>>({
    review: Number(localStorage.getItem(SIZES.review.key)) || SIZES.review.width,
    browser: Number(localStorage.getItem(SIZES.browser.key)) || SIZES.browser.width,
    terminal: Number(localStorage.getItem(SIZES.terminal.key)) || SIZES.terminal.width,
  })

  function setWidth(kind: Kind, width: number): void {
    widths[kind] = Math.round(Math.max(SIZES[kind].min, Math.min(width, window.innerWidth - MIN_MAIN)))
  }

  function saveWidth(kind: Kind): void {
    localStorage.setItem(SIZES[kind].key, String(widths[kind]))
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'

  let { kind, children }: { kind: Kind; children: Snippet } = $props()

  let aside = $state<HTMLElement>()
  /** Where a resize started: the pointer and the pane's width. */
  let resizing = $state<{ x: number; width: number } | null>(null)

  function startResize(e: PointerEvent): void {
    if (e.button !== 0 || !aside) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    // The width the pane has, which its max-width may hold below the one set.
    resizing = { x: e.clientX, width: aside.getBoundingClientRect().width }
  }

  function endResize(): void {
    if (!resizing) return
    resizing = null
    saveWidth(kind)
  }

  function resizeByKey(e: KeyboardEvent): void {
    const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0
    if (!step) return
    e.preventDefault()
    setWidth(kind, widths[kind] + step)
    saveWidth(kind)
  }
</script>

<aside class="dock" style:width="{widths[kind]}px" style:min-width="{SIZES[kind].min}px" bind:this={aside}>
  <!-- A focusable separator is a widget, the ARIA window splitter; Svelte counts every separator as static. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class={['dock-resize', resizing && 'active']}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the pane"
    aria-valuenow={widths[kind]}
    tabindex="0"
    title="Drag to resize; double-click for the default width"
    onpointerdown={startResize}
    onpointermove={(e) => resizing && setWidth(kind, resizing.width + resizing.x - e.clientX)}
    onpointerup={endResize}
    onpointercancel={endResize}
    ondblclick={() => (setWidth(kind, SIZES[kind].width), saveWidth(kind))}
    onkeydown={resizeByKey}
  ></div>
  {@render children()}
</aside>
