import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type { BrowserState, ConversationMeta, DragHover, KumiApi, Review, TerminalState, TranscriptItem, UsageWindow, WindowState } from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: KumiApi = {
  getWindowState: () => ipcRenderer.invoke(IPC.getWindowState),
  newTab: () => ipcRenderer.invoke(IPC.newTab),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.closeTab, tabId),
  activateTab: (tabId) => ipcRenderer.invoke(IPC.activateTab, tabId),
  moveTab: (tabId, index) => ipcRenderer.invoke(IPC.moveTab, tabId, index),
  startConversation: (tabId, cwd) => ipcRenderer.invoke(IPC.startConversation, tabId, cwd),
  openConversation: (tabId, conversationId) => ipcRenderer.invoke(IPC.openConversation, tabId, conversationId),
  reportTabStrip: (geometry) => ipcRenderer.send(IPC.reportTabStrip, geometry),
  dragStart: (tabId, grabX, grabY) => ipcRenderer.send(IPC.dragStart, tabId, grabX, grabY),
  dragMove: () => ipcRenderer.send(IPC.dragMove),
  dragEnd: () => ipcRenderer.send(IPC.dragEnd),
  getAuthStatus: () => ipcRenderer.invoke(IPC.getAuthStatus),
  getUsage: () => ipcRenderer.invoke(IPC.getUsage),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  listConversations: (all) => ipcRenderer.invoke(IPC.listConversations, all),
  listRecentProjects: () => ipcRenderer.invoke(IPC.listRecentProjects),
  renameConversation: (id, title) => ipcRenderer.invoke(IPC.renameConversation, id, title),
  deleteConversation: (id) => ipcRenderer.invoke(IPC.deleteConversation, id),
  getConversation: (id) => ipcRenderer.invoke(IPC.getConversation, id),
  send: (id, text, images) => ipcRenderer.invoke(IPC.send, id, text, images),
  interrupt: (id) => ipcRenderer.invoke(IPC.interrupt, id),
  respond: (id, requestId, response) => ipcRenderer.invoke(IPC.respond, id, requestId, response),
  setModel: (id, model) => ipcRenderer.invoke(IPC.setModel, id, model),
  setEffort: (id, effort) => ipcRenderer.invoke(IPC.setEffort, id, effort),
  setPermissionMode: (id, mode) => ipcRenderer.invoke(IPC.setPermissionMode, id, mode),
  setDraft: (id, draft) => ipcRenderer.send(IPC.setDraft, id, draft),
  showConversation: (id) => ipcRenderer.invoke(IPC.showConversation, id),
  listReviews: () => ipcRenderer.invoke(IPC.listReviews),
  startReview: (reviewerId, toolUseId, implementerId) => ipcRenderer.invoke(IPC.startReview, reviewerId, toolUseId, implementerId),
  relayFinding: (reviewId, rank, note) => ipcRenderer.invoke(IPC.relayFinding, reviewId, rank, note),
  setFindingClosed: (reviewId, rank, closed) => ipcRenderer.invoke(IPC.setFindingClosed, reviewId, rank, closed),
  endReview: (reviewId) => ipcRenderer.invoke(IPC.endReview, reviewId),
  getBrowser: (id) => ipcRenderer.invoke(IPC.getBrowser, id),
  browserAction: (id, action) => ipcRenderer.invoke(IPC.browserAction, id, action),
  browserInput: (id, tabId, input) => ipcRenderer.send(IPC.browserInput, id, tabId, input),
  watchBrowser: (id, watching) => ipcRenderer.send(IPC.watchBrowser, id, watching),
  getTerminals: (id) => ipcRenderer.invoke(IPC.getTerminals, id),
  terminalAction: (id, action) => ipcRenderer.invoke(IPC.terminalAction, id, action),
  terminalSnapshot: (id, tabId) => ipcRenderer.invoke(IPC.terminalSnapshot, id, tabId),
  terminalInput: (id, tabId, data) => ipcRenderer.send(IPC.terminalInput, id, tabId, data),
  terminalResize: (id, tabId, cols, rows) => ipcRenderer.send(IPC.terminalResize, id, tabId, cols, rows),
  watchTerminals: (id, watching) => ipcRenderer.send(IPC.watchTerminals, id, watching),
  onWindowState: (cb) => on<[WindowState]>(IPC.evWindowState, cb),
  onConversationMeta: (cb) => on<[string, ConversationMeta, number]>(IPC.evConversationMeta, cb),
  onConversationItems: (cb) => on<[string, TranscriptItem[], number]>(IPC.evConversationItems, cb),
  onUsage: (cb) => on<[UsageWindow]>(IPC.evUsage, cb),
  onDragHover: (cb) => on<[DragHover | null]>(IPC.evDragHover, cb),
  onConversationsChanged: (cb) => on<[]>(IPC.evConversationsChanged, cb),
  onReviews: (cb) => on<[Review[]]>(IPC.evReviews, cb),
  onBrowser: (cb) => on<[string, BrowserState]>(IPC.evBrowser, cb),
  onBrowserFrame: (cb) => on<[string, string, Uint8Array, number, number]>(IPC.evBrowserFrame, cb),
  onTerminals: (cb) => on<[string, TerminalState]>(IPC.evTerminals, cb),
  onTerminalOutput: (cb) => on<[string, string, string, number]>(IPC.evTerminalOutput, cb),
  onTerminalShow: (cb) => on<[string, string]>(IPC.evTerminalShow, cb),
}

contextBridge.exposeInMainWorld('kumi', api)
