<!-- The Explorer: the conversation's folder as a tree, with git's marks on changed files and the folders holding them. A click opens a file in a preview tab, a double click keeps it; new files, folders, renames and the Trash are a right-click away. -->
<script module lang="ts">
  import type { GitLetter } from '@shared/code'

  /** Which of a folder's changes colors it: the one ranked highest. */
  const RANK: Record<GitLetter, number> = { '!': 6, M: 5, T: 5, D: 4, A: 3, R: 3, C: 3, U: 2 }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import type { DirEntry } from '@shared/code'
  import Icon from '../Icon.svelte'
  import { api } from '../state.svelte'
  import { errorMessage } from '../util'
  import FileIcon from './FileIcon.svelte'
  import { basename, dirname } from './view.svelte'
  import type { CodeView } from './view.svelte'

  let { view }: { view: CodeView } = $props()

  /** A new file or folder being named, in `dir`; or an entry being renamed. */
  let editing = $state<{ kind: 'new'; dir: string; isDir: boolean; name: string } | { kind: 'rename'; path: string; name: string } | null>(null)
  let error = $state<string | null>(null)
  let tree = $state<HTMLDivElement>()

  const status = $derived(view.folder.status)
  const marks = $derived.by(() => {
    const files = new Map<string, GitLetter>()
    const dirs = new Map<string, GitLetter>()
    if (!status) return { files, dirs }
    for (const c of status.staged) files.set(`${status.root}/${c.path}`, c.letter)
    for (const c of status.unstaged) files.set(`${status.root}/${c.path}`, c.letter)
    for (const c of status.conflicts) files.set(`${status.root}/${c.path}`, '!')
    for (const [path, letter] of files) {
      for (let dir = dirname(path); dir.length >= status.root.length && dir !== '/'; dir = dirname(dir)) {
        const was = dirs.get(dir)
        if (was && RANK[was] >= RANK[letter]) break
        dirs.set(dir, letter)
      }
    }
    return { files, dirs }
  })

  interface Row {
    entry: DirEntry
    depth: number
  }
  const rows = $derived.by(() => {
    const out: Row[] = []
    const walk = (dir: string, depth: number): void => {
      for (const entry of view.children.get(dir) ?? []) {
        out.push({ entry, depth })
        if (entry.dir && view.expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(view.cwd, 0)
    return out
  })
  /** Where a new entry's name field goes: after the last row inside its folder, one level in. */
  const newAt = $derived.by(() => {
    if (editing?.kind !== 'new' || editing.dir === view.cwd) return null
    const dir = editing.dir
    const at = rows.findIndex((r) => r.entry.path === dir)
    let end = at + 1
    while (end < rows.length && (rows[end]?.entry.path.startsWith(`${dir}/`) ?? false)) end++
    return { index: end - 1, depth: (rows[at]?.depth ?? 0) + 1 }
  })

  $effect(() => {
    if (!view.children.has(view.cwd)) void view.loadDir(view.cwd)
  })

  // The selected row stays in sight, as when the active editor's file is revealed.
  $effect(() => {
    const path = view.selected
    void rows
    void tick().then(() => tree?.querySelector(`[data-path="${CSS.escape(path ?? '')}"]`)?.scrollIntoView({ block: 'nearest' }))
  })

  function click(e: MouseEvent, entry: DirEntry): void {
    view.selected = entry.path
    if (entry.dir) view.toggleDir(entry.path)
    else view.openFile(entry.path, { preview: e.detail < 2, focus: e.detail >= 2 })
  }

  /** The folder a new entry goes in: the selected folder, the selected file's, or the root. */
  function targetDir(): string {
    const selected = rows.find((r) => r.entry.path === view.selected)?.entry
    if (!selected) return view.cwd
    return selected.dir ? selected.path : dirname(selected.path)
  }

  function startNew(isDir: boolean, dir = targetDir()): void {
    error = null
    if (dir !== view.cwd && !view.expanded.has(dir)) view.toggleDir(dir)
    editing = { kind: 'new', dir, isDir, name: '' }
  }

  function startRename(path: string): void {
    error = null
    editing = { kind: 'rename', path, name: basename(path) }
  }

  async function commit(): Promise<void> {
    const edit = editing
    if (!edit) return
    const name = edit.name.trim().replace(/^\/+|\/+$/g, '')
    if (!name || (edit.kind === 'rename' && name === basename(edit.path))) {
      editing = null
      return
    }
    try {
      if (edit.kind === 'new') {
        const path = `${edit.dir}/${name}`
        await api.createFile(path, edit.isDir)
        editing = null
        await view.loadDir(dirname(path))
        view.selected = path
        if (!edit.isDir) view.openFile(path, { focus: true })
      } else {
        const to = `${dirname(edit.path)}/${name}`
        await api.renamePath(edit.path, to)
        editing = null
        await view.loadDir(dirname(to))
        view.selected = to
        // A tab of the renamed file opens the file under its new name.
        const tab = view.fileTabId(edit.path)
        if (view.tabs.some((t) => t.id === tab) && (await view.closeTab(tab))) view.openFile(to)
      }
    } catch (err) {
      error = errorMessage(err)
    }
  }

  function editKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editing = null
      error = null
      tree?.focus()
    }
  }

  async function trash(path: string): Promise<void> {
    try {
      if (await api.trashPath(path)) await view.loadDir(dirname(path))
    } catch (err) {
      error = errorMessage(err)
    }
  }

  async function menu(e: MouseEvent, entry: DirEntry | null): Promise<void> {
    e.preventDefault()
    if (entry) view.selected = entry.path
    const path = entry?.path ?? view.cwd
    const relativePath = path === view.cwd ? '.' : path.slice(view.cwd.length + 1)
    const picked = await api.showMenu([
      { id: 'newFile', label: 'New File…' },
      { id: 'newFolder', label: 'New Folder…' },
      { id: '', label: '', separator: true },
      { id: 'reveal', label: 'Reveal in Finder', accelerator: 'Alt+CmdOrCtrl+R' },
      { id: 'copyPath', label: 'Copy Path', accelerator: 'Alt+CmdOrCtrl+C' },
      { id: 'copyRelative', label: 'Copy Relative Path', accelerator: 'Shift+Alt+CmdOrCtrl+C' },
      ...(entry
        ? [
            { id: '', label: '', separator: true },
            { id: 'rename', label: 'Rename…', accelerator: 'F2' },
            { id: 'delete', label: 'Delete', accelerator: 'CmdOrCtrl+Backspace' },
          ]
        : []),
    ])
    const dir = entry ? (entry.dir ? entry.path : dirname(entry.path)) : view.cwd
    if (picked === 'newFile') startNew(false, dir)
    else if (picked === 'newFolder') startNew(true, dir)
    else if (picked === 'reveal') api.revealPath(path)
    else if (picked === 'copyPath') void navigator.clipboard.writeText(path)
    else if (picked === 'copyRelative') void navigator.clipboard.writeText(relativePath)
    else if (picked === 'rename' && entry) startRename(entry.path)
    else if (picked === 'delete' && entry) void trash(entry.path)
  }

  function keydown(e: KeyboardEvent): void {
    if (editing) return
    const at = rows.findIndex((r) => r.entry.path === view.selected)
    const row = rows[at]
    const select = (r: Row | undefined): void => {
      if (r) view.selected = r.entry.path
    }
    if (e.key === 'ArrowDown') select(rows[Math.min(at + 1, rows.length - 1)])
    else if (e.key === 'ArrowUp') select(rows[Math.max(at - 1, 0)])
    else if (e.key === 'ArrowRight' && row?.entry.dir) {
      if (view.expanded.has(row.entry.path)) select(rows[at + 1]?.depth === row.depth + 1 ? rows[at + 1] : undefined)
      else view.toggleDir(row.entry.path)
    } else if (e.key === 'ArrowLeft' && row) {
      if (row.entry.dir && view.expanded.has(row.entry.path)) view.toggleDir(row.entry.path)
      else select(rows.find((r) => r.entry.path === dirname(row.entry.path)))
    } else if (e.key === 'Enter' && row) {
      if (row.entry.dir) view.toggleDir(row.entry.path)
      else view.openFile(row.entry.path, { focus: true })
    } else if (e.key === ' ' && row && !row.entry.dir) view.openFile(row.entry.path, { preview: true })
    else if (e.key === 'F2' && row) startRename(row.entry.path)
    else if (e.key === 'Backspace' && e.metaKey && row) void trash(row.entry.path)
    else if (e.key === 'r' && e.metaKey && e.altKey && row) api.revealPath(row.entry.path)
    else return
    e.preventDefault()
  }

  function indent(depth: number): string {
    return `${8 + depth * 8}px`
  }
</script>

{#snippet nameField(depth: number, isDir: boolean)}
  <div class="tree-row editing" style:padding-left={indent(depth)}>
    <span class="tree-twistie">{#if isDir}<Icon name="chevronRight" />{/if}</span>
    {#if !isDir && editing}<FileIcon name={editing.name} />{/if}
    {#if editing}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="tree-input" autofocus bind:value={editing.name} onkeydown={editKey} onblur={() => void commit()} spellcheck="false" />
    {/if}
  </div>
{/snippet}

<div class="side-pane explorer">
  <div class="side-head">
    <span class="side-title" title={view.cwd}>{basename(view.cwd)}</span>
    <span class="spacer"></span>
    <button class="ghost icon-button" aria-label="New File" title="New File…" onclick={() => startNew(false)}><Icon name="newFile" /></button>
    <button class="ghost icon-button" aria-label="New Folder" title="New Folder…" onclick={() => startNew(true)}><Icon name="newFolder" /></button>
    <button class="ghost icon-button" aria-label="Refresh Explorer" title="Refresh Explorer" onclick={() => [...view.children.keys()].forEach((d) => void view.loadDir(d))}><Icon name="reload" /></button>
    <button class="ghost icon-button" aria-label="Collapse Folders" title="Collapse Folders in Explorer" onclick={() => view.collapseAll()}><Icon name="collapse" /></button>
  </div>
  {#if error || view.explorerError}<div class="side-error">{error ?? view.explorerError}</div>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="tree" role="tree" tabindex="0" bind:this={tree} onkeydown={keydown} oncontextmenu={(e) => e.target === tree && void menu(e, null)}>
    {#if editing?.kind === 'new' && editing.dir === view.cwd}{@render nameField(0, editing.isDir)}{/if}
    {#each rows as row, i (row.entry.path)}
      {@const entry = row.entry}
      {@const mark = entry.dir ? marks.dirs.get(entry.path) : marks.files.get(entry.path)}
      {#if editing?.kind === 'rename' && editing.path === entry.path}
        {@render nameField(row.depth, entry.dir)}
      {:else}
        <div
          class={['tree-row', entry.ignored && 'ignored', view.selected === entry.path && 'selected', mark && `git-${mark === '!' ? 'conflict' : mark}`]}
          role="treeitem"
          aria-selected={view.selected === entry.path}
          aria-expanded={entry.dir ? view.expanded.has(entry.path) : undefined}
          tabindex="-1"
          data-path={entry.path}
          style:padding-left={indent(row.depth)}
          title={entry.path.slice(view.cwd.length + 1)}
          onclick={(e) => click(e, entry)}
          oncontextmenu={(e) => void menu(e, entry)}
          onkeydown={() => {}}
        >
          <span class="tree-twistie">{#if entry.dir}<Icon name={view.expanded.has(entry.path) ? 'chevronDown' : 'chevronRight'} />{/if}</span>
          {#if !entry.dir}<FileIcon name={entry.name} />{/if}
          <span class="tree-name">{entry.name}</span>
          {#if mark}<span class="git-letter">{entry.dir ? '•' : mark}</span>{/if}
        </div>
      {/if}
      {#if i === newAt?.index && editing?.kind === 'new'}{@render nameField(newAt.depth, editing.isDir)}{/if}
    {/each}
  </div>
</div>
