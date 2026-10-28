// The tab strip at the top of a window. Dragging a tab sideways reorders it
// here; dragging it out of the strip hands the drag to the main process, which
// moves it to another window or a window of its own (see src/main/drag.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { DragHover, TabInfo, WindowState } from '@shared/types'
import { cx } from './util'

const api = window.kumi

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

export function TabStrip({ state }: { state: WindowState }): ReactNode {
  const stripRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const drag = useRef<Drag | null>(null)
  const [local, setLocal] = useState<{ tabId: string; dx: number; to: number } | null>(null)
  const [hover, setHover] = useState<DragHover | null>(null)

  useEffect(() => api.onDragHover(setHover), [])

  // The main process hit-tests drags against every window's tabs.
  useLayoutEffect(() => {
    const report = (): void => {
      const strip = stripRef.current
      if (!strip) return
      const tabs = state.tabs.flatMap((t) => {
        const el = tabRefs.current.get(t.id)
        if (!el) return []
        const r = el.getBoundingClientRect()
        return [{ id: t.id, left: r.left, right: r.right }]
      })
      api.reportTabStrip({ height: strip.getBoundingClientRect().height, tabs })
    }
    report()
    window.addEventListener('resize', report)
    return () => window.removeEventListener('resize', report)
  }, [state.tabs])

  const onPointerDown = (e: ReactPointerEvent, tab: TabInfo, index: number): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return
    const el = tabRefs.current.get(tab.id)
    const strip = stripRef.current
    if (!el || !strip) return
    if (tab.id !== state.activeTabId) void api.activateTab(tab.id)
    strip.setPointerCapture(e.pointerId)
    const slots = state.tabs.map((t) => {
      const r = tabRefs.current.get(t.id)?.getBoundingClientRect()
      return { left: r?.left ?? 0, right: r?.right ?? 0 }
    })
    drag.current = { tabId: tab.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, grabX: e.clientX - el.getBoundingClientRect().left, mode: 'pending', from: index, slots }
  }

  const onPointerMove = (e: ReactPointerEvent): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (d.mode === 'detached') {
      api.dragMove()
      return
    }
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'pending') {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      d.mode = 'local'
    }
    const stripHeight = stripRef.current?.getBoundingClientRect().height ?? 38
    const outside = e.clientY > stripHeight + DETACH_DISTANCE || e.clientY < -DETACH_DISTANCE || e.clientX < 0 || e.clientX > window.innerWidth
    // The only tab of a window drags the whole window, like in Chrome.
    if (outside || state.tabs.length === 1) {
      d.mode = 'detached'
      setLocal(null)
      api.dragStart(d.tabId, d.grabX, d.startY)
      return
    }
    setLocal({ tabId: d.tabId, dx, to: targetIndex(d, dx) })
  }

  const finish = (e: ReactPointerEvent, cancelled: boolean): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    if (d.mode === 'detached') api.dragEnd()
    else if (d.mode === 'local' && !cancelled) {
      const to = targetIndex(d, e.clientX - d.startX)
      if (to !== d.from) void api.moveTab(d.tabId, to)
    }
    setLocal(null)
  }

  const tabs: ReactNode[] = state.tabs.map((tab, index) => {
    let offset = 0
    if (local) {
      const d = drag.current
      const width = d ? (d.slots[d.from]?.right ?? 0) - (d.slots[d.from]?.left ?? 0) : 0
      if (tab.id === local.tabId) offset = local.dx
      else if (d && d.from < local.to && index > d.from && index <= local.to) offset = -width
      else if (d && d.from > local.to && index >= local.to && index < d.from) offset = width
    }
    return (
      <div
        key={tab.id}
        ref={(el) => {
          if (el) tabRefs.current.set(tab.id, el)
          else tabRefs.current.delete(tab.id)
        }}
        className={cx('tab', tab.id === state.activeTabId && 'active', local?.tabId === tab.id && 'dragging')}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={(e) => onPointerDown(e, tab, index)}
        onAuxClick={(e) => {
          if (e.button === 1) void api.closeTab(tab.id)
        }}
        title={tab.title}
      >
        <TabStatusIcon status={tab.status} />
        <span className="tab-title">{tab.title}</span>
        <button className="tab-close" onClick={() => void api.closeTab(tab.id)} aria-label="Close tab">
          ×
        </button>
      </div>
    )
  })
  if (hover) {
    tabs.splice(
      Math.min(hover.index, tabs.length),
      0,
      <div key="drop-placeholder" className="tab placeholder">
        <span className="tab-title">{hover.title}</span>
      </div>,
    )
  }

  return (
    <div
      className="tabstrip"
      ref={stripRef}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onLostPointerCapture={(e) => finish(e, false)}
    >
      {/* Behind the tabs: empty strip space moves the window. */}
      <div className="tabstrip-drag" />
      {tabs}
      <button className="tab-new" onClick={() => void api.newTab()} aria-label="New tab" title="New tab (⌘T)">
        +
      </button>
    </div>
  )
}

function targetIndex(d: Drag, dx: number): number {
  const slot = d.slots[d.from]
  if (!slot) return d.from
  const center = (slot.left + slot.right) / 2 + dx
  let to = 0
  d.slots.forEach((s, i) => {
    if (i !== d.from && (s.left + s.right) / 2 < center) to++
  })
  return to
}

function TabStatusIcon({ status }: { status: TabInfo['status'] }): ReactNode {
  if (status === 'running') return <span className="tab-status spinner" />
  if (status === 'attention') return <span className="tab-status dot attention" title="Waiting for you" />
  if (status === 'error') return <span className="tab-status dot error" title="Error" />
  return null
}
