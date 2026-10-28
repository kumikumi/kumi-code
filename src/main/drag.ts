// Dragging a tab out of its tab strip. The renderer handles reordering within a
// strip on its own; once the pointer leaves the strip it hands the drag to the
// main process, which works in screen coordinates across all windows.
//
// The tab gets a window that follows the cursor: a new one, or its own window
// when it was the only tab there. Over another window's tab strip, that window
// shows where the tab would land and the dragged window hides; dropping there
// moves the tab. Dropping anywhere else leaves the dragged window where it is.

import { screen } from 'electron'
import type { Point } from 'electron'
import type { DragHover, TabStripGeometry } from '@shared/types'
import type { Win, Workspace } from './workspace'

/** Where tabs start in a tab strip, right of the window controls. Matches the renderer. */
const STRIP_INSET = 78
const DEFAULT_STRIP_HEIGHT = 38

interface DragState {
  tabId: string
  title: string
  /** The window the drag started in: it receives the pointer events until the drag ends. */
  source: Win
  dragged: Win
  /** Cursor position within the dragged window. */
  grab: Point
  target: { entry: Win; index: number } | null
}

export class TabDrag {
  private state: DragState | null = null

  constructor(private readonly workspace: Workspace) {}

  start(source: Win, tabId: string, grabX: number, grabY: number): void {
    if (this.state) this.end()
    const tab = source.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const title = this.workspace.windowState(source).tabs.find((t) => t.id === tabId)?.title ?? ''
    const cursor = screen.getCursorScreenPoint()
    if (source.tabs.length === 1) {
      const bounds = source.win.getBounds()
      this.state = { tabId, title, source, dragged: source, grab: { x: cursor.x - bounds.x, y: cursor.y - bounds.y }, target: null }
      return
    }
    const size = source.win.getBounds()
    const grab = { x: STRIP_INSET + grabX, y: grabY }
    this.workspace.takeTab(source, tabId)
    const dragged = this.workspace.createWindow([tab], tab.id, { x: cursor.x - grab.x, y: cursor.y - grab.y, width: size.width, height: size.height }, false)
    dragged.win.once('ready-to-show', () => {
      if (dragged.win.isDestroyed() || dragged.win.isVisible()) return
      // Mid-drag the window must not take focus: the source window holds the pointer.
      if (this.state?.dragged === dragged) dragged.win.showInactive()
      else dragged.win.show()
    })
    this.state = { tabId, title, source, dragged, grab, target: null }
  }

  move(): void {
    const state = this.state
    if (!state || state.dragged.win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    state.dragged.win.setPosition(Math.round(cursor.x - state.grab.x), Math.round(cursor.y - state.grab.y))
    const target = this.hitTest(cursor, state.dragged)
    const previous = state.target
    if (previous && (!target || previous.entry !== target.entry)) this.workspace.sendHover(previous.entry, null)
    if (target && (!previous || previous.entry !== target.entry || previous.index !== target.index)) {
      const hover: DragHover = { index: target.index, title: state.title }
      this.workspace.sendHover(target.entry, hover)
    }
    // A fully transparent window gets no mouse events, so the window that holds
    // the pointer only fades.
    if (Boolean(target) !== Boolean(previous)) state.dragged.win.setOpacity(target ? (state.dragged === state.source ? 0.35 : 0) : 1)
    state.target = target
  }

  end(): void {
    const state = this.state
    if (!state) return
    this.move()
    this.state = null
    const { dragged, target } = state
    if (dragged.win.isDestroyed()) return
    if (target) {
      this.workspace.sendHover(target.entry, null)
      const tab = dragged.tabs.find((t) => t.id === state.tabId)
      if (tab) {
        dragged.tabs = dragged.tabs.filter((t) => t !== tab)
        this.workspace.insertTab(target.entry, tab, target.index)
      }
      if (dragged.tabs.length === 0) this.workspace.closeEmptied(dragged)
      target.entry.win.focus()
      return
    }
    dragged.win.setOpacity(1)
    if (!dragged.win.isVisible()) dragged.win.show()
    dragged.win.focus()
  }

  /** The window whose tab strip is under the cursor, other than the dragged one. */
  private hitTest(cursor: Point, dragged: Win): { entry: Win; index: number } | null {
    for (const entry of this.workspace.allWindows()) {
      if (entry === dragged || entry.win.isDestroyed() || !entry.win.isVisible() || entry.win.isMinimized()) continue
      const bounds = entry.win.getContentBounds()
      const strip: TabStripGeometry = entry.strip ?? { height: DEFAULT_STRIP_HEIGHT, tabs: [] }
      const x = cursor.x - bounds.x
      const y = cursor.y - bounds.y
      if (x < 0 || x > bounds.width || y < 0 || y > strip.height) continue
      return { entry, index: insertionIndex(strip, x) }
    }
    return null
  }
}

/** Index a tab dropped at `x` takes: after every tab whose middle is left of it. */
export function insertionIndex(strip: TabStripGeometry, x: number): number {
  return strip.tabs.filter((t) => (t.left + t.right) / 2 < x).length
}
