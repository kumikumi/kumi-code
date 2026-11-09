<!-- Source Control, after VS Code's: the branch with what it can pull and push, the commit message and button, the staged, unstaged and conflicted files with their actions, and below them the commit graph. Where VS Code syncs, this pulls or pushes, and says which. -->
<script lang="ts">
  import { tick } from 'svelte'
  import type { GitChange, GitOp, MenuItem } from '@shared/code'
  import Icon from '../Icon.svelte'
  import { api } from '../state.svelte'
  import FileIcon from './FileIcon.svelte'
  import ScmGraph from './ScmGraph.svelte'
  import { basename, dirname } from './view.svelte'
  import type { CodeView } from './view.svelte'

  let { view }: { view: CodeView } = $props()

  type Group = 'conflicts' | 'staged' | 'unstaged'
  const GROUPS: { id: Group; title: string }[] = [
    { id: 'conflicts', title: 'Merge Changes' },
    { id: 'staged', title: 'Staged Changes' },
    { id: 'unstaged', title: 'Changes' },
  ]

  let collapsed = $state<Record<string, boolean>>({})
  let graphHeight = $state(Number(localStorage.getItem('codeGraphHeight')) || 260)
  let resizing: { y: number; height: number } | null = null
  let message = $state<HTMLTextAreaElement>()
  let pane = $state<HTMLDivElement>()

  const status = $derived(view.folder.status)
  const changeCount = $derived(status ? status.conflicts.length + status.staged.length + status.unstaged.length : 0)
  /**
   * With nothing to commit, the button pulls or pushes instead: pull while the branch is behind
   * (until then a push is refused), push while it is ahead, and push a branch with no upstream yet
   * to the remote, which then tracks it.
   */
  const action = $derived.by((): 'commit' | 'pull' | 'push' | 'publish' => {
    if (!status || changeCount > 0 || !status.head) return 'commit'
    if (status.branch && !status.upstream) return status.remote ? 'publish' : 'commit'
    if (status.behind > 0) return 'pull'
    return status.ahead > 0 ? 'push' : 'commit'
  })
  const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`

  // A commit to reveal is in the graph, so the graph shows.
  $effect(() => {
    if (view.graphReveal) collapsed.graph = false
  })

  // The row of the tab shown stays in sight when another tab shows.
  $effect(() => {
    void view.activeId
    void tick().then(() => pane?.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' }))
  })

  // The message field grows with what is typed, up to ten lines.
  $effect(() => {
    void view.commitMessage
    if (!message) return
    message.style.height = 'auto'
    message.style.height = `${Math.min(message.scrollHeight, 10 * 18 + 10)}px`
  })

  const run = (op: GitOp): Promise<boolean> => view.runGit(op)
  const commit = (amend = false, push = false): Promise<void> => view.commit(amend, push)

  async function primary(): Promise<void> {
    if (action === 'pull') await run({ kind: 'pull' })
    else if (action === 'push' || action === 'publish') await run({ kind: 'push' })
    else await commit()
  }

  async function commitMenu(): Promise<void> {
    const picked = await api.showMenu([
      { id: 'commit', label: 'Commit' },
      { id: 'amend', label: 'Commit (Amend)' },
      { id: 'push', label: 'Commit & Push' },
    ])
    if (picked === 'commit') await commit()
    else if (picked === 'amend') await commit(true)
    else if (picked === 'push') await commit(false, true)
  }

  async function moreMenu(): Promise<void> {
    const items: MenuItem[] = [
      { id: 'pull', label: 'Pull', enabled: !!status?.upstream },
      { id: 'push', label: 'Push', enabled: !!status?.branch && !!(status.upstream || status.remote) },
      { id: 'fetch', label: 'Fetch', enabled: !!status?.remote },
      { id: '', label: '', separator: true },
      { id: 'amend', label: 'Commit (Amend)', enabled: !!status?.head },
      { id: 'checkout', label: 'Checkout to…' },
      { id: '', label: '', separator: true },
      { id: 'stageAll', label: 'Stage All Changes', enabled: !!status?.unstaged.length },
      { id: 'unstageAll', label: 'Unstage All Changes', enabled: !!status?.staged.length },
      { id: 'discardAll', label: 'Discard All Changes', enabled: !!status?.unstaged.length },
    ]
    const picked = await api.showMenu(items)
    if (!status) return
    if (picked === 'pull' || picked === 'push' || picked === 'fetch') await run({ kind: picked })
    else if (picked === 'amend') await commit(true)
    else if (picked === 'checkout') await view.checkout()
    else if (picked === 'stageAll') await run({ kind: 'stage', changes: status.unstaged })
    else if (picked === 'unstageAll') await run({ kind: 'unstage', changes: status.staged })
    else if (picked === 'discardAll') await run({ kind: 'discard', changes: status.unstaged })
  }

  function open(e: MouseEvent, change: GitChange, group: Group): void {
    if (status) view.openChange(change, group, status.root, { preview: e.detail < 2, focus: e.detail >= 2 })
  }

  async function rowMenu(e: MouseEvent, change: GitChange, group: Group): Promise<void> {
    e.preventDefault()
    if (!status) return
    const path = `${status.root}/${change.path}`
    const picked = await api.showMenu([
      { id: 'changes', label: 'Open Changes', enabled: group !== 'conflicts' && change.letter !== 'U' },
      { id: 'file', label: 'Open File', enabled: change.letter !== 'D' || group === 'staged' },
      { id: '', label: '', separator: true },
      group === 'staged' ? { id: 'unstage', label: 'Unstage Changes' } : { id: 'stage', label: 'Stage Changes' },
      { id: 'discard', label: 'Discard Changes', enabled: group === 'unstaged' },
      { id: '', label: '', separator: true },
      { id: 'reveal', label: 'Reveal in Finder' },
      { id: 'copy', label: 'Copy Path' },
    ])
    if (picked === 'changes') view.openChange(change, group, status.root)
    else if (picked === 'file') view.openFile(path)
    else if (picked === 'stage') await run({ kind: 'stage', changes: [change] })
    else if (picked === 'unstage') await run({ kind: 'unstage', changes: [change] })
    else if (picked === 'discard') await run({ kind: 'discard', changes: [change] })
    else if (picked === 'reveal') api.revealPath(path)
    else if (picked === 'copy') void navigator.clipboard.writeText(path)
  }

  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizing = { y: e.clientY, height: graphHeight }
  }

  function moveResize(e: PointerEvent): void {
    if (resizing) graphHeight = Math.max(80, Math.min(window.innerHeight - 200, resizing.height + resizing.y - e.clientY))
  }

  function endResize(): void {
    if (!resizing) return
    resizing = null
    localStorage.setItem('codeGraphHeight', String(graphHeight))
  }
</script>

{#snippet changeRow(change: GitChange, group: Group)}
  {@const name = basename(change.path)}
  {@const dir = change.path.includes('/') ? dirname(change.path) : ''}
  {@const shown = !!status && view.activeId === view.changeTabId(change, group, status.root)}
  <div
    class={['tree-row scm-row', `git-${change.letter === '!' ? 'conflict' : change.letter}`, change.letter === 'D' && 'deleted', shown && 'selected']}
    role="treeitem"
    aria-selected={shown}
    tabindex="-1"
    title={`${change.origPath ? `${change.origPath} → ` : ''}${change.path}`}
    onclick={(e) => open(e, change, group)}
    oncontextmenu={(e) => void rowMenu(e, change, group)}
    onkeydown={() => {}}
  >
    <FileIcon {name} />
    <span class="tree-name">{name}</span>
    <span class="tree-description">{dir}</span>
    <span class="row-buttons">
      {#if change.letter !== 'D' || group === 'staged'}
        <button class="ghost icon-button" aria-label="Open File" title="Open File" onclick={(e) => (e.stopPropagation(), status && view.openFile(`${status.root}/${change.path}`))}><Icon name="file" /></button>
      {/if}
      {#if group === 'unstaged'}
        <button class="ghost icon-button" aria-label="Discard Changes" title="Discard Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'discard', changes: [change] }))}><Icon name="discard" /></button>
      {/if}
      {#if group === 'staged'}
        <button class="ghost icon-button" aria-label="Unstage Changes" title="Unstage Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'unstage', changes: [change] }))}><Icon name="minus" /></button>
      {:else}
        <button class="ghost icon-button" aria-label="Stage Changes" title="Stage Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'stage', changes: [change] }))}><Icon name="plus" /></button>
      {/if}
    </span>
    <span class="git-letter">{change.letter}</span>
  </div>
{/snippet}

<div class="side-pane scm-pane" bind:this={pane}>
  <div class="side-head scm-head">
    {#if status}
      <span class="scm-branch" title={status.upstream ? `${status.branch} tracks ${status.upstream}` : status.branch ? `${status.branch} has no upstream branch` : 'HEAD is detached'}>
        <Icon name="branch" /><span>{status.branch ?? `${status.head?.slice(0, 7) ?? 'HEAD'} (detached)`}</span>
      </span>
      {#if status.behind > 0}
        <button class="scm-pill" title={`Pull ${commits(status.behind)} from ${status.upstream} (counted at the last fetch)`} disabled={view.gitBusy > 0} onclick={() => void run({ kind: 'pull' })}>
          <Icon name="arrowDown" />{status.behind}
        </button>
      {/if}
      {#if status.ahead > 0}
        <button class="scm-pill" title={`Push ${commits(status.ahead)} to ${status.upstream}`} disabled={view.gitBusy > 0} onclick={() => void run({ kind: 'push' })}>
          <Icon name="arrowUp" />{status.ahead}
        </button>
      {/if}
    {:else}
      <span class="side-title">Source Control</span>
    {/if}
    <span class="spacer"></span>
    {#if status}
      <button class="ghost icon-button" aria-label="Refresh" title="Refresh" onclick={() => void view.folder.refresh()}><Icon name="reload" /></button>
      <button class="ghost icon-button" aria-label="More Actions" title="More Actions…" onclick={() => void moreMenu()}><Icon name="more" /></button>
    {/if}
  </div>
  {#if view.gitBusy > 0}<div class="side-progress"></div>{/if}
  {#if view.gitError}<div class="side-error">{view.gitError}</div>{/if}
  {#if status === null}
    <div class="side-empty">
      <p>The folder currently open doesn't have a git repository. You can initialize a repository which will enable source control features powered by git.</p>
      <button class="primary" onclick={() => void run({ kind: 'init' })}>Initialize Repository</button>
    </div>
  {:else if status}
    <div class="scm-sections">
      <section class={['scm-section', 'scm-changes', collapsed.changes && 'collapsed']}>
        <button class="section-head" onclick={() => (collapsed.changes = !collapsed.changes)}>
          <Icon name={collapsed.changes ? 'chevronRight' : 'chevronDown'} /><span>Changes</span>
        </button>
        {#if !collapsed.changes}
          <div class="scm-body">
            <div class="commit-box">
              <textarea
                bind:this={message}
                bind:value={view.commitMessage}
                rows="1"
                spellcheck="false"
                placeholder={`Message (⌘Enter to commit on "${status.branch ?? 'HEAD'}")`}
                onkeydown={(e) => e.key === 'Enter' && e.metaKey && (e.preventDefault(), void commit())}
              ></textarea>
              <div class="commit-button">
                <button
                  class="primary"
                  disabled={view.gitBusy > 0}
                  title={action === 'pull' ? `git pull from ${status.upstream}` : action === 'push' ? `git push to ${status.upstream}` : action === 'publish' ? `git push -u ${status.remote} ${status.branch}` : 'git commit'}
                  onclick={() => void primary()}
                >
                  {#if action === 'pull'}<Icon name="arrowDown" /> Pull {commits(status.behind)}
                  {:else if action === 'push'}<Icon name="arrowUp" /> Push {commits(status.ahead)}
                  {:else if action === 'publish'}<Icon name="arrowUp" /> Push {status.branch} to {status.remote}
                  {:else}<Icon name="check" /> Commit{/if}
                </button>
                {#if action === 'commit'}
                  <button class="primary commit-more" aria-label="Commit Options" title="Commit Options" disabled={view.gitBusy > 0} onclick={() => void commitMenu()}><Icon name="chevronDown" /></button>
                {/if}
              </div>
            </div>
            {#each GROUPS as group (group.id)}
              {@const changes = status[group.id]}
              {#if changes.length > 0}
                <div class="tree" role="tree">
                  <div class="tree-row scm-group" role="treeitem" aria-selected="false" aria-expanded={!collapsed[group.id]} tabindex="-1" onclick={() => (collapsed[group.id] = !collapsed[group.id])} onkeydown={() => {}}>
                    <span class="tree-twistie"><Icon name={collapsed[group.id] ? 'chevronRight' : 'chevronDown'} /></span>
                    <span class="tree-name">{group.title}</span>
                    <span class="row-buttons">
                      {#if group.id === 'unstaged'}
                        <button class="ghost icon-button" aria-label="Discard All Changes" title="Discard All Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'discard', changes }))}><Icon name="discard" /></button>
                      {/if}
                      {#if group.id === 'staged'}
                        <button class="ghost icon-button" aria-label="Unstage All Changes" title="Unstage All Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'unstage', changes }))}><Icon name="minus" /></button>
                      {:else}
                        <button class="ghost icon-button" aria-label="Stage All Changes" title="Stage All Changes" onclick={(e) => (e.stopPropagation(), void run({ kind: 'stage', changes }))}><Icon name="plus" /></button>
                      {/if}
                    </span>
                    <span class="scm-count">{changes.length}</span>
                  </div>
                  {#if !collapsed[group.id]}
                    {#each changes as change (change.path)}{@render changeRow(change, group.id)}{/each}
                  {/if}
                </div>
              {/if}
            {/each}
            {#if status.count > changeCount}<div class="side-note">Showing {changeCount} of {status.count} changes.</div>{/if}
          </div>
        {/if}
      </section>
      <section class={['scm-section', 'scm-graph', collapsed.graph && 'collapsed']} style:flex-basis={collapsed.graph || collapsed.changes ? undefined : `${graphHeight}px`}>
        {#if !collapsed.graph && !collapsed.changes}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="scm-sash" onpointerdown={startResize} onpointermove={moveResize} onpointerup={endResize} onpointercancel={endResize}></div>
        {/if}
        <button class="section-head" onclick={() => (collapsed.graph = !collapsed.graph)}>
          <Icon name={collapsed.graph ? 'chevronRight' : 'chevronDown'} /><span>Graph</span>
        </button>
        {#if !collapsed.graph}<ScmGraph {view} {status} onerror={(m) => (view.gitError = m)} />{/if}
      </section>
    </div>
  {/if}
</div>
