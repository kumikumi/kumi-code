<!--
  The tab strip at the top of a window. Dragging a tab sideways reorders it here;
  dragging it out of the strip hands the drag to the main process, which moves it
  to another window or a window of its own (see src/main/drag.ts).
-->
<script lang="ts">
  import type { DragHover, TabInfo, WindowState } from '@shared/types'
  import { confirmCloseConversation } from './code/view.svelte'
  import { api } from './state.svelte'

  let { win }: { win: WindowState } = $props()

  /** How far outside the strip the pointer goes before the tab leaves the window. */
  const DETACH_DISTANCE = 28
  const DRAG_THRESHOLD = 4

  interface Drag {
    tabId: string
    pointerId: number
    startX: number
    startY: number
    /** Pointer distance from the tab's left edge. */
    grabX: number
    mode: 'pending' | 'local' | 'detached'
    from: number
    /** Tab edges when the drag started. */
    slots: { left: number; right: number }[]
  }

  let strip: HTMLDivElement
  const tabEls: Record<string, HTMLDivElement> = $state({})
  let drag: Drag | null = null
  let local = $state<{ tabId: string; dx: number; to: number } | null>(null)
  let hover = $state<DragHover | null>(null)

  $effect(() =>
    api.onDragHover((h) => {
      hover = h
    }),
  )

  /** Closes a tab once its code view's unsaved files are saved or dropped. */
  async function close(tab: TabInfo): Promise<void> {
    if (!tab.conversationId || (await confirmCloseConversation(tab.conversationId))) await api.closeTab(tab.id)
  }

  // The main process hit-tests drags against every window's tabs.
  function report(): void {
    const tabs = win.tabs.flatMap((t) => {
      const r = tabEls[t.id]?.getBoundingClientRect()
      return r ? [{ id: t.id, left: r.left, right: r.right }] : []
    })
    api.reportTabStrip({ height: strip.getBoundingClientRect().height, tabs })
  }
  $effect(report)

  function onpointerdown(e: PointerEvent, tab: TabInfo, index: number): void {
    const el = tabEls[tab.id]
    if (e.button !== 0 || !el || (e.target as HTMLElement).closest('.tab-close')) return
    if (tab.id !== win.activeTabId) void api.activateTab(tab.id)
    strip.setPointerCapture(e.pointerId)
    const slots = win.tabs.map((t) => tabEls[t.id]?.getBoundingClientRect() ?? { left: 0, right: 0 })
    drag = { tabId: tab.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, grabX: e.clientX - el.getBoundingClientRect().left, mode: 'pending', from: index, slots }
  }

  function onpointermove(e: PointerEvent): void {
    const d = drag
    if (!d || e.pointerId !== d.pointerId) return
    if (d.mode === 'detached') return api.dragMove()
    const dx = e.clientX - d.startX
    if (d.mode === 'pending' && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
    d.mode = 'local'
    const height = strip.getBoundingClientRect().height
    const outside = e.clientY > height + DETACH_DISTANCE || e.clientY < -DETACH_DISTANCE || e.clientX < 0 || e.clientX > window.innerWidth
    // The only tab of a window drags the whole window, like in Chrome.
    if (outside || win.tabs.length === 1) {
      d.mode = 'detached'
      local = null
      api.dragStart(d.tabId, d.grabX, d.startY)
      return
    }
    local = { tabId: d.tabId, dx, to: targetIndex(d, dx) }
  }

  function finish(e: PointerEvent, cancelled: boolean): void {
    const d = drag
    if (!d || e.pointerId !== d.pointerId) return
    drag = null
    if (d.mode === 'detached') api.dragEnd()
    else if (d.mode === 'local' && !cancelled && local && local.to !== d.from) void api.moveTab(d.tabId, local.to)
    local = null
  }

  function targetIndex(d: Drag, dx: number): number {
    const slot = d.slots[d.from]
    if (!slot) return d.from
    const center = (slot.left + slot.right) / 2 + dx
    return d.slots.filter((s, i) => i !== d.from && (s.left + s.right) / 2 < center).length
  }

  /** While reordering: the dragged tab follows the pointer, the ones it passes slide aside. */
  function offset(index: number, tabId: string): number {
    const slot = drag?.slots[drag.from]
    if (!local || !drag || !slot) return 0
    const width = slot.right - slot.left
    if (tabId === local.tabId) return local.dx
    if (drag.from < local.to && index > drag.from && index <= local.to) return -width
    if (drag.from > local.to && index >= local.to && index < drag.from) return width
    return 0
  }
</script>

<svelte:window onresize={report} />

{#snippet placeholder(title: string)}
  <div class="tab placeholder"><span class="tab-title">{title}</span></div>
{/snippet}

<div
  class="tabstrip"
  role="tablist"
  tabindex="-1"
  bind:this={strip}
  {onpointermove}
  onpointerup={(e) => finish(e, false)}
  onpointercancel={(e) => finish(e, true)}
  onlostpointercapture={(e) => finish(e, false)}
>
  <!-- Behind the tabs: empty strip space moves the window. -->
  <div class="tabstrip-drag"></div>
  {#each win.tabs as tab, index (tab.id)}
    {#if hover?.index === index}{@render placeholder(hover.title)}{/if}
    {@const dx = offset(index, tab.id)}
    <div
      bind:this={tabEls[tab.id]}
      class={['tab', tab.id === win.activeTabId && 'active', local?.tabId === tab.id && 'dragging']}
      data-theme={tab.theme}
      style:transform={dx ? `translateX(${dx}px)` : undefined}
      role="tab"
      tabindex="-1"
      aria-selected={tab.id === win.activeTabId}
      title={tab.title}
      onpointerdown={(e) => onpointerdown(e, tab, index)}
      onauxclick={(e) => e.button === 1 && void close(tab)}
    >
      {#if tab.status === 'running'}<span class="tab-status spinner"></span>
      {:else if tab.status === 'attention'}<span class="tab-status dot attention" title="Waiting for you"></span>
      {:else if tab.status === 'error'}<span class="tab-status dot error" title="Error"></span>{/if}
      <span class="tab-title">{tab.title}</span>
      <button class="tab-close" onclick={() => void close(tab)} aria-label="Close tab">×</button>
    </div>
  {/each}
  {#if hover && hover.index >= win.tabs.length}{@render placeholder(hover.title)}{/if}
  <button class="tab-new" onclick={() => api.newTab()} aria-label="New tab" title="New tab (⌘T)">+</button>
</div>
