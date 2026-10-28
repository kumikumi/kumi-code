// A window: its tab strip and its tabs. Conversation tabs stay mounted once
// shown, so switching back keeps scroll position and composer state.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ConversationView } from './ConversationView'
import { NewTabPage } from './NewTabPage'
import { conversations, useWindowState } from './state'
import { TabStrip } from './TabStrip'

export function App(): ReactNode {
  const state = useWindowState()
  const [shown, setShown] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!state) return
    const tabIds = new Set(state.tabs.map((t) => t.id))
    setShown((current) => {
      const next = new Set([...current].filter((id) => tabIds.has(id)))
      next.add(state.activeTabId)
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next
    })
    conversations.retain(new Set(state.tabs.flatMap((t) => (t.conversationId ? [t.conversationId] : []))))
    const active = state.tabs.find((t) => t.id === state.activeTabId)
    document.title = active?.title ?? 'Kumi Code'
  }, [state])

  if (!state) return null
  return (
    <div className="window">
      <TabStrip state={state} />
      <div className="tab-content">
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeTabId
          if (!active && !(tab.conversationId && shown.has(tab.id))) return null
          return (
            <div key={`${tab.id}:${tab.conversationId ?? 'new'}`} className="tab-pane" hidden={!active}>
              {tab.conversationId ? <ConversationView conversationId={tab.conversationId} visible={active} /> : <NewTabPage tabId={tab.id} visible={active} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
