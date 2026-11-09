<!-- Quick open, as VS Code's: files by name (⌘P; `name:line:column` goes to a place), commands after ">" (⇧⌘P), a line of the active editor after ":", or a list to pick from. -->
<script lang="ts">
  import { tick } from 'svelte'
  import { errorMessage } from '../util'
  import FileIcon from './FileIcon.svelte'
  import { fuzzyMatch, matchFiles } from './fuzzy'
  import { basename } from './view.svelte'
  import type { CodeView, PickItem } from './view.svelte'

  let { view, commands, gotoLine, lineCount }: { view: CodeView; commands: PickItem[]; gotoLine: (line: number, column: number) => void; lineCount: () => number } = $props()

  const LIMIT = 100

  interface Item {
    label: string
    labelMatches: number[]
    description: string
    descriptionMatches: number[]
    keys?: string
    file?: string
    run: () => void
  }

  let input = $state<HTMLInputElement>()
  let list = $state<HTMLDivElement>()
  let files = $state.raw<string[] | null>(null)
  let error = $state<string | null>(null)
  let selected = $state(0)

  const text = $derived(view.quick?.text ?? '')
  const mode = $derived(view.quick?.pick ? 'pick' : text.startsWith('>') ? 'commands' : text.startsWith(':') ? 'line' : 'files')

  $effect(() => {
    view.folder.fileList().then(
      (list) => (files = list),
      (err: unknown) => (error = errorMessage(err)),
    )
  })

  $effect(() => {
    void view.quick
    void tick().then(() => input?.focus())
  })

  const relative = (path: string): string => (path.startsWith(`${view.cwd}/`) ? path.slice(view.cwd.length + 1) : path)

  function close(): void {
    view.quick = null
  }

  function fileItem(path: string, labelMatches: number[], descriptionMatches: number[], line: number | undefined, column: number | undefined): Item {
    const slash = path.lastIndexOf('/')
    return {
      label: path.slice(slash + 1),
      labelMatches,
      description: slash > 0 ? path.slice(0, slash) : '',
      descriptionMatches,
      file: path,
      run: () => view.openFile(path.startsWith('/') ? path : `${view.cwd}/${path}`, { focus: true, line, column }),
    }
  }

  function filtered(items: PickItem[], query: string): Item[] {
    return items
      .flatMap((item) => {
        const match = fuzzyMatch(item.label, query)
        return match ? [{ item, match }] : []
      })
      .sort((a, b) => (query ? b.match.score - a.match.score : 0))
      .map(({ item, match }) => ({ label: item.label, labelMatches: match.positions, description: item.description ?? '', descriptionMatches: [], keys: item.keys, run: item.run }))
  }

  const items = $derived.by((): Item[] => {
    if (mode === 'pick') return filtered(view.quick?.pick ?? [], text.trim())
    if (mode === 'commands') return filtered(commands, text.slice(1).trim())
    if (mode === 'line') {
      const [, line = '', column = ''] = /^:\s*(\d*)(?:[:,](\d*))?/.exec(text) ?? []
      const count = lineCount()
      if (!count) return []
      const n = Number(line)
      if (!line) return [{ label: `Type a line number between 1 and ${count} to navigate to.`, labelMatches: [], description: '', descriptionMatches: [], run: () => {} }]
      const target = Math.min(Math.max(n, 1), count)
      return [{ label: `Go to line ${target}${column ? `, character ${column}` : ''}.`, labelMatches: [], description: '', descriptionMatches: [], run: () => gotoLine(target, Number(column) || 1) }]
    }
    const [, query = '', line, column] = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(text.trim()) ?? []
    const at = line ? Number(line) : undefined
    const col = column ? Number(column) : undefined
    if (!query.trim()) return view.recent.slice(0, LIMIT).map((path) => fileItem(relative(path), [], [], at, col))
    return matchFiles(files ?? [], query.trim(), LIMIT).map((m) => fileItem(m.path, m.label, m.description, at, col))
  })

  $effect(() => {
    void items
    selected = 0
  })

  $effect(() => {
    void selected
    void tick().then(() => list?.querySelector('.quick-item.selected')?.scrollIntoView({ block: 'nearest' }))
  })

  function choose(item: Item | undefined): void {
    if (!item) return
    close()
    item.run()
  }

  function keydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) selected = items.length ? (selected + 1) % items.length : 0
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) selected = items.length ? (selected - 1 + items.length) % items.length : 0
    else if (e.key === 'Enter') choose(items[selected])
    else if (e.key === 'Escape') close()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function parts(text: string, matches: number[]): { text: string; match: boolean }[] {
    const set = new Set(matches)
    const out: { text: string; match: boolean }[] = []
    for (let i = 0; i < text.length; i++) {
      const match = set.has(i)
      const last = out.at(-1)
      if (last && last.match === match) last.text += text[i]
      else out.push({ text: text[i] ?? '', match })
    }
    return out
  }
</script>

{#snippet highlighted(text: string, matches: number[])}{#each parts(text, matches) as part, i (i)}{#if part.match}<b>{part.text}</b>{:else}{part.text}{/if}{/each}{/snippet}

<div class="quick-open" role="dialog" aria-label="Quick Open" onfocusout={(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && close()}>
  {#if view.quick}
    <input
      bind:this={input}
      bind:value={view.quick.text}
      placeholder={view.quick.placeholder}
      spellcheck="false"
      aria-label="Quick Open"
      onkeydown={keydown}
    />
  {/if}
  {#if error}<div class="side-error">{error}</div>{/if}
  <div class="quick-list" bind:this={list} role="listbox">
    {#if mode === 'files' && !text.trim() && items.length > 0}<div class="quick-section">recently opened</div>{/if}
    {#each items as item, i (i)}
      <div
        class={['quick-item', i === selected && 'selected']}
        role="option"
        aria-selected={i === selected}
        tabindex="-1"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => choose(item)}
        onmousemove={() => (selected = i)}
        onkeydown={() => {}}
      >
        {#if item.file}<FileIcon name={basename(item.file)} />{/if}
        <span class="quick-label">{@render highlighted(item.label, item.labelMatches)}</span>
        {#if item.description}<span class="quick-description">{@render highlighted(item.description, item.descriptionMatches)}</span>{/if}
        {#if item.keys}<span class="quick-keys">{item.keys}</span>{/if}
      </div>
    {:else}
      {#if mode === 'files' && text.trim() && files}<div class="quick-empty">No matching results</div>
      {:else if mode === 'files' && !files && !error}<div class="quick-empty">Loading files…</div>
      {:else if mode !== 'files' && mode !== 'line'}<div class="quick-empty">No matching {mode === 'commands' ? 'commands' : 'results'}</div>{/if}
    {/each}
  </div>
</div>
