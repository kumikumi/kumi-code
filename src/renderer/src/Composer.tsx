// The message box: text, pasted or dropped images, slash command completion,
// and the model, effort and permission mode of the conversation.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react'
import type { CommandOption, ConversationMeta, EffortLevel, ImageData, PermissionMode } from '@shared/types'
import { cx, errorMessage } from './util'

const api = window.kumi

const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function Composer({ meta, visible }: { meta: ConversationMeta; visible: boolean }): ReactNode {
  const [text, setText] = useState(meta.draft)
  const [images, setImages] = useState<ImageData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const draftTimer = useRef<number | null>(null)

  const modelValue = meta.model ?? 'default'
  const model = meta.models.find((m) => m.value === modelValue)
  const modes = useMemo(() => {
    const list: PermissionMode[] = ['default', 'acceptEdits', 'plan']
    if (model?.supportsAutoMode || meta.permissionMode === 'auto') list.push('auto')
    list.push('bypassPermissions')
    return list
  }, [model, meta.permissionMode])

  useEffect(() => {
    if (visible) ref.current?.focus()
  }, [visible])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const suggestions = useMemo(() => {
    const match = /^\/(\S*)$/.exec(text)
    if (!match || dismissedFor === text) return []
    const prefix = (match[1] ?? '').toLowerCase()
    return meta.commands.filter((c) => c.name.toLowerCase().startsWith(prefix)).slice(0, 12)
  }, [text, meta.commands, dismissedFor])

  const updateText = (value: string): void => {
    setText(value)
    setSelected(0)
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => api.setDraft(meta.id, value), 300)
  }

  const run = (p: Promise<unknown>): void => {
    setError(null)
    p.catch((err: unknown) => setError(errorMessage(err)))
  }

  const send = (): void => {
    if (!text.trim() && images.length === 0) return
    run(api.send(meta.id, text.trim(), images))
    setText('')
    setImages([])
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
  }

  const complete = (command: CommandOption): void => {
    updateText(`/${command.name} `)
    ref.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setSelected((selected + step + suggestions.length) % suggestions.length)
        return
      }
      const pick = suggestions[selected]
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && pick && `/${pick.name}` !== text)) {
        e.preventDefault()
        if (pick) complete(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedFor(text)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && meta.status === 'running') {
      e.preventDefault()
      run(api.interrupt(meta.id))
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      // Like Claude Code: Shift+Tab cycles the modes, bypass only by choice.
      const cycle: PermissionMode[] = modes.filter((m) => m !== 'bypassPermissions')
      const next = cycle[(cycle.indexOf(meta.permissionMode) + 1) % cycle.length] ?? 'default'
      run(api.setPermissionMode(meta.id, next))
    }
  }

  const addFiles = (files: FileList | File[]): boolean => {
    const list = [...files].filter((f) => IMAGE_TYPES.has(f.type))
    for (const file of list) {
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result).replace(/^data:[^;]+;base64,/, '')
        setImages((current) => [...current, { mediaType: file.type, data }])
      }
      reader.readAsDataURL(file)
    }
    return list.length > 0
  }

  const onPaste = (e: ClipboardEvent): void => {
    if (addFiles(e.clipboardData.files)) e.preventDefault()
  }

  const onDrop = (e: DragEvent): void => {
    if (addFiles(e.dataTransfer.files)) e.preventDefault()
  }

  const running = meta.status === 'running'
  const effortValue = meta.effort ?? ''

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {suggestions.length > 0 && (
        <ul className="suggestions">
          {suggestions.map((c, i) => (
            <li key={c.name} className={cx(i === selected && 'selected')} onMouseDown={(e) => (e.preventDefault(), complete(c))} onMouseEnter={() => setSelected(i)}>
              <span className="suggestion-name">
                /{c.name}
                {c.argumentHint ? <span className="suggestion-hint"> {c.argumentHint}</span> : null}
              </span>
              <span className="suggestion-description">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((img, i) => (
            <div key={i} className="composer-image">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
              <button onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove image">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={running ? 'Message Claude (queued until the current step ends)…' : 'Message Claude…'}
        onChange={(e) => updateText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="composer-bar">
        <select className={cx('mode', meta.permissionMode)} value={meta.permissionMode} onChange={(e) => run(api.setPermissionMode(meta.id, e.target.value as PermissionMode))} title="Permission mode (⇧⇥)">
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <select value={modelValue} onChange={(e) => run(api.setModel(meta.id, e.target.value === 'default' ? null : e.target.value))} title="Model">
          {meta.models.length === 0 && <option value={modelValue}>{modelValue === 'default' ? 'Default model' : modelValue}</option>}
          {meta.models.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>
              {m.displayName}
            </option>
          ))}
        </select>
        {(model?.efforts.length ?? 0) > 0 && (
          <select value={effortValue} onChange={(e) => run(api.setEffort(meta.id, (e.target.value || null) as EffortLevel | null))} title="Effort">
            <option value="">Default effort</option>
            {model?.efforts.map((level) => (
              <option key={level} value={level}>
                {level} effort
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {error && (
          <span className="composer-error" title={error}>
            {error}
          </span>
        )}
        {meta.contextPercent !== null && <span className="context" title="Context window used by the last request">{meta.contextPercent}% context</span>}
        {running ? (
          <button className="stop" onClick={() => run(api.interrupt(meta.id))} title="Stop (Esc)">
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!text.trim() && images.length === 0} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
