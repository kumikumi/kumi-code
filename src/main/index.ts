import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { getAuthStatus } from '../core/auth'
import { listConversations, recentProjects } from '../core/sessions'
import { Store } from '../core/store'
import { IPC } from '@shared/types'
import type { EffortLevel, ImageData, PermissionMode, RequestResponse, TabStripGeometry } from '@shared/types'
import { TabDrag } from './drag'
import { Workspace } from './workspace'

// A separate state directory, for running a second instance in development.
if (process.env.KUMI_USER_DATA) app.setPath('userData', process.env.KUMI_USER_DATA)

app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const store = new Store(join(dataDir, 'state.json'))
  const scratchRoot = join(dataDir, 'scratch')
  const workspace = new Workspace({
    store,
    scratchRoot,
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(import.meta.dirname, '../renderer/index.html'),
  })
  const drag = new TabDrag(workspace)
  const win = (e: IpcMainInvokeEvent | IpcMainEvent) => workspace.winOf(BrowserWindow.fromWebContents(e.sender))

  ipcMain.handle(IPC.getWindowState, (e) => workspace.windowState(win(e)))
  ipcMain.handle(IPC.newTab, (e) => workspace.newTab(win(e)))
  ipcMain.handle(IPC.closeTab, (e, tabId: string) => workspace.closeTab(win(e), tabId))
  ipcMain.handle(IPC.activateTab, (e, tabId: string) => workspace.activateTab(win(e), tabId))
  ipcMain.handle(IPC.moveTab, (e, tabId: string, index: number) => workspace.moveTab(win(e), tabId, index))
  ipcMain.handle(IPC.startConversation, (e, tabId: string, cwd: string | null) => workspace.startConversation(win(e), tabId, cwd))
  ipcMain.handle(IPC.openConversation, async (e, tabId: string, conversationId: string) => {
    const summary = (await listConversations(store.get(), scratchRoot, true)).find((c) => c.id === conversationId)
    if (!summary) throw new Error(`No session ${conversationId}`)
    workspace.openConversation(win(e), tabId, conversationId, summary.cwd)
  })
  ipcMain.on(IPC.reportTabStrip, (e, geometry: TabStripGeometry) => workspace.setStrip(win(e), geometry))
  ipcMain.on(IPC.dragStart, (e, tabId: string, grabX: number, grabY: number) => drag.start(win(e), tabId, grabX, grabY))
  ipcMain.on(IPC.dragMove, () => drag.move())
  ipcMain.on(IPC.dragEnd, () => drag.end())

  ipcMain.handle(IPC.getAuthStatus, () => getAuthStatus())
  ipcMain.handle(IPC.getUsage, () => workspace.currentUsage)
  ipcMain.handle(IPC.pickFolder, async (e) => {
    const res = await dialog.showOpenDialog(win(e).win, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.listConversations, (_e, all: boolean) => listConversations(store.get(), scratchRoot, all))
  ipcMain.handle(IPC.listRecentProjects, () => recentProjects(store.get(), scratchRoot))
  ipcMain.handle(IPC.renameConversation, (_e, id: string, title: string) => workspace.renameConversation(id, title))
  ipcMain.handle(IPC.deleteConversation, (_e, id: string) => workspace.deleteConversation(id))

  ipcMain.handle(IPC.getConversation, (_e, id: string) => workspace.snapshot(id))
  ipcMain.handle(IPC.send, (_e, id: string, text: string, images: ImageData[]) => workspace.conversation(id).send(text, images))
  ipcMain.handle(IPC.interrupt, (_e, id: string) => workspace.conversation(id).interrupt())
  ipcMain.handle(IPC.respond, (_e, id: string, requestId: string, response: RequestResponse) => workspace.conversation(id).respond(requestId, response))
  ipcMain.handle(IPC.setModel, (_e, id: string, model: string | null) => workspace.conversation(id).setModel(model))
  ipcMain.handle(IPC.setEffort, (_e, id: string, effort: EffortLevel | null) => workspace.conversation(id).setEffort(effort))
  ipcMain.handle(IPC.setPermissionMode, (_e, id: string, mode: PermissionMode) => workspace.conversation(id).setPermissionMode(mode))
  ipcMain.on(IPC.setDraft, (_e, id: string, draft: string) => workspace.conversation(id).setDraft(draft))
  ipcMain.handle(IPC.showConversation, (e, id: string) => workspace.showConversation(win(e), id))

  ipcMain.handle(IPC.listReviews, () => workspace.reviewList())
  ipcMain.handle(IPC.startReview, (_e, reviewerId: string, toolUseId: string, implementerId: string) => workspace.startReview(reviewerId, toolUseId, implementerId))
  ipcMain.handle(IPC.relayFinding, (e, reviewId: string, rank: number, note: string) => workspace.relayFinding(win(e), reviewId, rank, note))
  ipcMain.handle(IPC.setFindingClosed, (_e, reviewId: string, rank: number, closed: boolean) => workspace.setFindingClosed(reviewId, rank, closed))
  ipcMain.handle(IPC.endReview, (_e, reviewId: string) => workspace.endReview(reviewId))

  Menu.setApplicationMenu(buildMenu(workspace))
  workspace.restore()

  app.on('activate', () => {
    if (workspace.allWindows().length === 0) workspace.newWindow()
  })
  app.on('before-quit', () => workspace.beginQuit())
})

app.on('window-all-closed', () => {
  app.quit()
})

function buildMenu(workspace: Workspace): Menu {
  const inFocused = (fn: (entry: NonNullable<ReturnType<Workspace['focused']>>) => void) => () => {
    const entry = workspace.focused()
    if (entry) fn(entry)
  }
  const tabItems: MenuItemConstructorOptions[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    label: `Tab ${n}`,
    accelerator: `CmdOrCtrl+${n}`,
    visible: false,
    click: inFocused((entry) => workspace.activateIndex(entry, n - 1)),
  }))
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => (workspace.focused() ? workspace.newTab(workspace.focused()!) : workspace.newWindow()) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => workspace.newWindow() },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: inFocused((entry) => workspace.reopenClosedTab(entry)) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inFocused((entry) => workspace.closeTab(entry, entry.activeTabId)) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inFocused((entry) => entry.win.close()) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: inFocused((entry) => workspace.cycleTab(entry, 1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inFocused((entry) => workspace.cycleTab(entry, -1)) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', visible: false, click: inFocused((entry) => workspace.cycleTab(entry, 1)) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', visible: false, click: inFocused((entry) => workspace.cycleTab(entry, -1)) },
        ...tabItems,
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: inFocused((entry) => workspace.activateIndex(entry, -1)) },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
