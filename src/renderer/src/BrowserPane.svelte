<!-- A conversation's browser: its tabs, the active tab's page drawn from the frames the main process sends, and the user's mouse and keyboard passed back. The page renders at its own viewport; the pane only scales it to fit, so its size changes nothing the page sees. -->
<script lang="ts">
  import type { BrowserAction, BrowserDownload, BrowserInput, BrowserState, Viewport } from '@shared/types'
  import Icon from './Icon.svelte'
  import { api } from './state.svelte'
  import { errorMessage, fileSize } from './util'

  let { conversationId, browser, visible, onhide }: { conversationId: string; browser: BrowserState; visible: boolean; onhide: () => void } = $props()

  const PRESETS = [
    { name: 'Desktop', width: 1280, height: 800 },
    { name: 'Laptop', width: 1440, height: 900 },
    { name: 'Tablet', width: 768, height: 1024 },
    { name: 'Mobile', width: 375, height: 812 },
  ]
  const BUTTONS = ['left', 'middle', 'right'] as const
  /** Mouse moves sent at most this often, in milliseconds. */
  const MOVE_INTERVAL = 16

  const active = $derived(browser.tabs.find((t) => t.id === browser.activeTabId) ?? null)
  const activeUrl = $derived(active?.url ?? '')
  const viewport = $derived(active?.viewport ?? null)
  const preset = $derived(viewport ? (PRESETS.find((p) => p.width === viewport.width && p.height === viewport.height)?.name ?? 'Custom') : 'Desktop')

  let canvas = $state<HTMLCanvasElement>()
  /** The size of the frame drawn: the page's pixels. */
  let frameSize = $state<{ width: number; height: number } | null>(null)
  let url = $state('')
  let editingUrl = $state(false)
  let width = $state('')
  let height = $state('')
  let error = $state<string | null>(null)
  let lastMove = 0

  // The fields follow the tab unless the user is typing in them.
  $effect.pre(() => {
    const current = activeUrl
    if (!editingUrl) url = current === 'about:blank' ? '' : current
  })
  $effect.pre(() => {
    width = String(viewport?.width ?? '')
    height = String(viewport?.height ?? '')
  })

  // Frames come only while the pane shows.
  $effect(() => {
    if (!visible) return
    api.watchBrowser(conversationId, true)
    return () => api.watchBrowser(conversationId, false)
  })
  $effect(() =>
    api.onBrowserFrame((id, tabId, jpeg, w, h) => {
      if (id === conversationId && tabId === browser.activeTabId) draw(jpeg, w, h)
    }),
  )

  // Not passive, so scrolling the page does not also scroll what is around the pane.
  $effect(() => {
    const target = canvas
    if (!target) return
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  })

  let decoding = false
  let next: { jpeg: Uint8Array; width: number; height: number } | null = null

  /** Draws the newest frame; frames that arrive while one decodes are skipped but the last. */
  function draw(jpeg: Uint8Array, w: number, h: number): void {
    next = { jpeg, width: w, height: h }
    if (!decoding) void paint()
  }

  async function paint(): Promise<void> {
    decoding = true
    while (next) {
      const frame = next
      next = null
      const bitmap = await createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
      if (canvas) {
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width
          canvas.height = frame.height
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      }
      bitmap.close()
      frameSize = { width: frame.width, height: frame.height }
    }
    decoding = false
  }

  function act(action: BrowserAction): void {
    error = null
    api.browserAction(conversationId, action).catch((err: unknown) => (error = errorMessage(err)))
  }

  function go(): void {
    const target = url.trim()
    if (!target) return
    editingUrl = false
    ;(document.activeElement as HTMLElement | null)?.blur()
    act({ kind: 'navigate', url: target })
  }

  function setViewport(change: Partial<Viewport>): void {
    if (!active || !viewport) return
    const next = { ...viewport, ...change }
    if (!(next.width >= 200 && next.width <= 4096 && next.height >= 200 && next.height <= 4096)) {
      error = 'Width and height must be between 200 and 4096'
      return
    }
    act({ kind: 'viewport', tabId: active.id, viewport: { ...next, mobile: next.width < 768 } })
  }

  function pickPreset(name: string): void {
    const p = PRESETS.find((x) => x.name === name)
    if (p) setViewport({ width: p.width, height: p.height })
  }

  function modifiersOf(e: MouseEvent | KeyboardEvent): number {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
  }

  /** Where the pointer is on the page, in the page's pixels. */
  function pagePoint(e: MouseEvent): { x: number; y: number } | null {
    if (!canvas || !frameSize) return null
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(((e.clientX - r.left) / r.width) * frameSize.width), y: Math.round(((e.clientY - r.top) / r.height) * frameSize.height) }
  }

  function send(input: BrowserInput): void {
    if (active) api.browserInput(conversationId, active.id, input)
  }

  function mouse(e: MouseEvent, action: 'down' | 'up' | 'move'): void {
    const at = pagePoint(e)
    if (!at) return
    if (action === 'move') {
      if (e.timeStamp - lastMove < MOVE_INTERVAL) return
      lastMove = e.timeStamp
    }
    const button = action === 'move' ? (e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : 'none') : (BUTTONS[e.button] ?? 'left')
    send({ type: 'mouse', action, x: at.x, y: at.y, button, clickCount: action === 'move' ? 0 : e.detail || 1, modifiers: modifiersOf(e) })
  }

  function wheel(e: WheelEvent): void {
    e.preventDefault()
    const at = pagePoint(e)
    if (at) send({ type: 'wheel', x: at.x, y: at.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })
  }

  function downloadStatus(d: BrowserDownload): string {
    if (d.state === 'progressing') return d.totalBytes > 0 ? `${fileSize(d.receivedBytes)} of ${fileSize(d.totalBytes)}` : fileSize(d.receivedBytes)
    if (d.state === 'completed') return fileSize(d.receivedBytes)
    return d.state === 'cancelled' ? 'Cancelled' : 'Failed'
  }

  function key(e: KeyboardEvent, action: 'down' | 'up'): void {
    if (e.isComposing) return
    e.preventDefault()
    send({ type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiersOf(e) })
  }
</script>

<div class="browser-pane">
  <div class="browser-tabs">
    {#each browser.tabs as tab (tab.id)}
      <div class={['browser-tab', tab.id === browser.activeTabId && 'active']}>
        <button class="browser-tab-title" title={tab.url} onclick={() => act({ kind: 'select', tabId: tab.id })}>
          {#if tab.loading}<span class="browser-loading"></span>{/if}{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}
        </button>
        <button class="browser-tab-close" aria-label="Close tab" title="Close tab" onclick={() => act({ kind: 'close', tabId: tab.id })}><Icon name="close" /></button>
      </div>
    {/each}
    <button class="ghost icon-button" aria-label="New tab" title="New tab" onclick={() => act({ kind: 'newTab' })}><Icon name="plus" /></button>
    <span class="spacer"></span>
    <button class="ghost icon-button" aria-label="Hide the browser" title="Hide" onclick={onhide}><Icon name="close" /></button>
  </div>
  <div class="browser-bar">
    <button class="ghost icon-button" aria-label="Back" title="Back" disabled={!active?.canGoBack} onclick={() => active && act({ kind: 'back', tabId: active.id })}>
      <Icon name="back" />
    </button>
    <button class="ghost icon-button" aria-label="Forward" title="Forward" disabled={!active?.canGoForward} onclick={() => active && act({ kind: 'forward', tabId: active.id })}>
      <Icon name="forward" />
    </button>
    <button class="ghost icon-button" aria-label="Reload" title="Reload" disabled={!active} onclick={() => active && act({ kind: 'reload', tabId: active.id })}>
      <Icon name="reload" />
    </button>
    <input
      class="browser-url grow"
      placeholder="Enter a URL"
      spellcheck="false"
      bind:value={url}
      onfocus={() => (editingUrl = true)}
      onblur={() => (editingUrl = false)}
      onkeydown={(e) => {
        if (e.key === 'Enter') go()
        else if (e.key === 'Escape') {
          url = activeUrl === 'about:blank' ? '' : activeUrl
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
    />
  </div>
  {#if active && viewport}
    <div class="browser-bar browser-viewport">
      <select title="Viewport: the size the page lays out at" value={preset} onchange={(e) => pickPreset(e.currentTarget.value)}>
        {#each PRESETS as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
        <option value="Custom" disabled>Custom</option>
      </select>
      <input class="viewport-size" type="number" aria-label="Viewport width" bind:value={width} onkeydown={(e) => e.key === 'Enter' && setViewport({ width: Number(width) })} onblur={() => Number(width) !== viewport.width && setViewport({ width: Number(width) })} />
      <span class="muted">×</span>
      <input class="viewport-size" type="number" aria-label="Viewport height" bind:value={height} onkeydown={(e) => e.key === 'Enter' && setViewport({ height: Number(height) })} onblur={() => Number(height) !== viewport.height && setViewport({ height: Number(height) })} />
      <select title="Color scheme the page sees" value={viewport.colorScheme ?? ''} onchange={(e) => setViewport({ colorScheme: (e.currentTarget.value || null) as Viewport['colorScheme'] })}>
        <option value="">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <span class="spacer"></span>
      <button class="ghost small" title="Open DevTools for this tab" onclick={() => act({ kind: 'devtools', tabId: active.id })}>DevTools</button>
    </div>
  {/if}
  {#if browser.activity}<div class="browser-activity"><span class="browser-activity-dot"></span>{browser.activity}</div>{/if}
  {#if error}<div class="notice error browser-error">{error}</div>{/if}
  <div class="browser-view">
    {#if active}
      <!-- The canvas is the page: it takes the user's mouse and keyboard and passes them on. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <canvas
        bind:this={canvas}
        aria-label="The page"
        tabindex="0"
        onpointerdown={(e) => {
          canvas?.focus()
          canvas?.setPointerCapture(e.pointerId)
        }}
        onmousedown={(e) => mouse(e, 'down')}
        onmouseup={(e) => mouse(e, 'up')}
        onmousemove={(e) => mouse(e, 'move')}
        onkeydown={(e) => key(e, 'down')}
        onkeyup={(e) => key(e, 'up')}
        oncontextmenu={(e) => e.preventDefault()}
      ></canvas>
    {:else}
      <div class="browser-empty">
        <div class="browser-empty-title">No page open</div>
        <div>Enter a URL above, or let Claude open one.</div>
      </div>
    {/if}
  </div>
  {#if browser.downloads.length > 0}
    <div class="browser-downloads" aria-label="Downloads">
      {#each browser.downloads as download (download.id)}
        <div class="browser-download">
          <span class="browser-download-name" title={download.path}>{download.name}</span>
          <span class="browser-download-status">{downloadStatus(download)}</span>
          <span class="spacer"></span>
          {#if download.state === 'progressing'}
            <button class="ghost small" onclick={() => act({ kind: 'cancelDownload', downloadId: download.id })}>Cancel</button>
          {:else}
            {#if download.state === 'completed'}
              <button class="ghost small" onclick={() => act({ kind: 'showDownload', downloadId: download.id })}>Show in Finder</button>
            {/if}
            <button class="ghost icon-button" aria-label="Remove from the list" title="Remove from the list" onclick={() => act({ kind: 'removeDownload', downloadId: download.id })}><Icon name="close" /></button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
