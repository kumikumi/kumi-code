<!-- The message box: text, pasted or dropped images, slash command completion, and the conversation's model, effort and permission mode. -->
<script lang="ts">
  import { modelChoices, modelRow } from '@shared/models'
  import type { CommandOption, ConversationMeta, EffortLevel, ImageData, PermissionMode } from '@shared/types'
  import { api } from './state.svelte'
  import { errorMessage } from './util'

  let { meta, visible }: { meta: ConversationMeta; visible: boolean } = $props()

  const MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Ask before edits',
    acceptEdits: 'Accept edits',
    plan: 'Plan mode',
    auto: 'Auto mode',
    bypassPermissions: 'Bypass permissions',
  }
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

  // The draft is only read when the composer is created.
  // svelte-ignore state_referenced_locally
  let text = $state(meta.draft)
  let images = $state.raw<ImageData[]>([])
  let error = $state<string | null>(null)
  let selected = $state(0)
  let dismissedFor = $state<string | null>(null)
  let box: HTMLTextAreaElement

  const model = $derived(modelRow(meta.models, meta.model))
  // Without an effort of its own the conversation runs at the model's default.
  const effort = $derived.by(() => {
    const level = meta.effort ?? meta.defaultEffort
    return level && model?.efforts.includes(level) ? level : null
  })
  const modes = $derived<PermissionMode[]>([
    'default',
    'acceptEdits',
    'plan',
    ...(model?.supportsAutoMode || meta.permissionMode === 'auto' ? (['auto'] as const) : []),
    'bypassPermissions',
  ])
  const suggestions = $derived.by(() => {
    const prefix = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase()
    if (prefix === undefined || dismissedFor === text) return []
    return meta.commands.filter((c) => c.name.toLowerCase().startsWith(prefix)).slice(0, 12)
  })
  const running = $derived(meta.status === 'running')

  $effect(() => {
    if (visible) box.focus()
  })
  $effect(() => {
    void text
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`
  })
  // Every change goes to the main process at once, so a tab moved to another
  // window, whose composer starts from the main process's copy, loses nothing.
  // svelte-ignore state_referenced_locally
  const conversationId = meta.id
  $effect(() => api.setDraft(conversationId, text))

  function run(p: Promise<unknown>): void {
    error = null
    p.catch((err: unknown) => (error = errorMessage(err)))
  }

  function send(): void {
    if (!text.trim() && images.length === 0) return
    run(api.send(meta.id, text.trim(), images))
    text = ''
    images = []
  }

  function complete(command: CommandOption): void {
    text = `/${command.name} `
    box.focus()
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    const pick = suggestions[selected]
    if (pick && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
    } else if (pick && ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && `/${pick.name}` !== text))) {
      e.preventDefault()
      complete(pick)
    } else if (pick && e.key === 'Escape') {
      e.preventDefault()
      dismissedFor = text
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
      // ⌘↵ is the review panel's.
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && running) {
      e.preventDefault()
      run(api.interrupt(meta.id))
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      // Like Claude Code: Shift+Tab cycles the modes, bypass only by choice.
      const cycle: PermissionMode[] = modes.filter((m) => m !== 'bypassPermissions')
      run(api.setPermissionMode(meta.id, cycle[(cycle.indexOf(meta.permissionMode) + 1) % cycle.length] ?? 'default'))
    }
  }

  /** Adds the image files among `files`, in place of the browser's own paste or drop. */
  function addImages(files: FileList | undefined | null, e: Event): void {
    const list = [...(files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type))
    if (list.length > 0) e.preventDefault()
    for (const file of list) {
      const reader = new FileReader()
      reader.onload = () => (images = [...images, { mediaType: file.type, data: String(reader.result).replace(/^data:[^;]+;base64,/, '') }])
      reader.readAsDataURL(file)
    }
  }
</script>

<div class="composer" role="group" ondragover={(e) => e.preventDefault()} ondrop={(e) => addImages(e.dataTransfer?.files, e)}>
  {#if suggestions.length > 0}
    <ul class="suggestions">
      {#each suggestions as c, i (c.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_mouse_events_have_key_events -->
        <li class={{ selected: i === selected }} onmousedown={(e) => (e.preventDefault(), complete(c))} onmouseenter={() => (selected = i)}>
          <span class="suggestion-name">/{c.name}{#if c.argumentHint}<span class="suggestion-hint"> {c.argumentHint}</span>{/if}</span>
          <span class="suggestion-description">{c.description}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if images.length > 0}
    <div class="composer-images">
      {#each images as img, i (i)}
        <div class="composer-image">
          <img src="data:{img.mediaType};base64,{img.data}" alt="" />
          <button onclick={() => (images = images.filter((_, j) => j !== i))} aria-label="Remove image">×</button>
        </div>
      {/each}
    </div>
  {/if}
  <textarea
    bind:this={box}
    bind:value={() => text, (value) => ((text = value), (selected = 0))}
    rows="1"
    placeholder={running ? 'Message Claude (queued until the current step ends)…' : 'Message Claude…'}
    {onkeydown}
    onpaste={(e) => addImages(e.clipboardData?.files, e)}
  ></textarea>
  <div class="composer-bar">
    <select class="mode {meta.permissionMode}" value={meta.permissionMode} onchange={(e) => run(api.setPermissionMode(meta.id, e.currentTarget.value as PermissionMode))} title="Permission mode (⇧⇥)">
      {#each modes as m (m)}<option value={m}>{MODE_LABELS[m]}</option>{/each}
    </select>
    <select value={model?.value ?? meta.model ?? ''} onchange={(e) => run(api.setModel(meta.id, e.currentTarget.value))} title="Model">
      {#each modelChoices(meta.models) as m (m.value)}<option value={m.value} title={m.description}>{m.displayName}</option>{/each}
      {#if meta.models.length === 0}<option value={meta.model ?? ''}>{meta.model ?? 'Model'}</option>{/if}
    </select>
    {#if model && model.efforts.length > 0}
      <select value={effort ?? ''} onchange={(e) => run(api.setEffort(meta.id, e.currentTarget.value as EffortLevel))} title="Effort">
        {#if !effort}<option value="" disabled hidden>Effort</option>{/if}
        {#each model.efforts as level (level)}<option value={level}>{level} effort</option>{/each}
      </select>
    {/if}
    <span class="spacer"></span>
    {#if error}<span class="composer-error" title={error}>{error}</span>{/if}
    {#if meta.contextPercent !== null}<span class="context" title="Context window used by the last request">{meta.contextPercent}% context</span>{/if}
    {#if running}
      <button class="stop" onclick={() => run(api.interrupt(meta.id))} title="Stop (Esc)">Stop</button>
    {:else}
      <button class="primary" disabled={!text.trim() && images.length === 0} onclick={send}>Send</button>
    {/if}
  </div>
</div>
