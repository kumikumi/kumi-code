<!-- The source control graph, as VS Code draws it: HEAD's history and its upstream's, each commit on a lane, branches curving off and back. A commit opens to the files it changed, and a file to its diff. -->
<script module lang="ts">
  /** VS Code's scmGraph.foreground1–5. */
  const LANE_COLORS = ['#ffb000', '#dc267f', '#994f00', '#40b0a6', '#b66dff']
  const LANE = 11
  const ROW = 22
  const MID = ROW / 2
  const PAGE = 100
  /** How far back the graph looks for a commit to reveal. */
  const MAX_REVEAL = 6400

  const x = (lane: number): number => lane * LANE + LANE / 2 + 3
  const color = (i: number): string => LANE_COLORS[i % LANE_COLORS.length] ?? '#888'

  function edgePath(from: number, to: number, y1: number, y2: number): string {
    if (from === to) return `M${x(from)} ${y1}V${y2}`
    const bend = (y2 - y1) / 2
    return `M${x(from)} ${y1}C${x(from)} ${y1 + bend} ${x(to)} ${y2 - bend} ${x(to)} ${y2}`
  }

  interface Ref {
    name: string
    kind: 'head' | 'branch' | 'remote' | 'tag'
  }

  function refsOf(refs: string[]): Ref[] {
    return refs.flatMap((r): Ref[] => {
      if (r === 'HEAD') return []
      const head = r.startsWith('HEAD -> ')
      const full = head ? r.slice(8) : r
      if (full.startsWith('refs/heads/')) return [{ name: full.slice(11), kind: head ? 'head' : 'branch' }]
      if (full.startsWith('refs/remotes/')) return full.endsWith('/HEAD') ? [] : [{ name: full.slice(13), kind: 'remote' }]
      if (full.startsWith('tag: refs/tags/')) return [{ name: full.slice(15), kind: 'tag' }]
      return [{ name: full, kind: 'branch' }]
    })
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import type { GitCommit, GitStatus } from '@shared/code'
  import Icon from '../Icon.svelte'
  import { api } from '../state.svelte'
  import { errorMessage, fullTime } from '../util'
  import FileIcon from './FileIcon.svelte'
  import { layoutGraph } from './graph'
  import { basename, dirname } from './view.svelte'
  import type { CodeView } from './view.svelte'

  let { view, status, onerror }: { view: CodeView; status: GitStatus; onerror: (message: string) => void } = $props()

  let commits = $state.raw<GitCommit[]>([])
  /** How many commits `commits` was asked for. */
  let loadedCount = $state(0)
  let graph = $state<HTMLDivElement>()
  const changes = $derived(view.graphOpen)

  const rows = $derived(layoutGraph(commits))
  /** What moves the graph: a new HEAD, upstream or branch, or more commits asked for. */
  const key = $derived(`${status.head}\0${status.upstream}\0${status.branch}\0${status.ahead}\0${status.behind}\0${view.graphCount}`)

  $effect(() => {
    void key
    const count = view.graphCount
    let stale = false
    api.gitLog(view.cwd, count).then(
      (list) => {
        if (stale) return
        commits = list
        loadedCount = count
      },
      (err: unknown) => onerror(errorMessage(err)),
    )
    return () => (stale = true)
  })

  // A commit to reveal: more history until the graph has it, then its files (the one shown
  // highlighted) in sight.
  $effect(() => {
    const hash = view.graphReveal
    if (!hash || loadedCount !== view.graphCount) return
    if (!commits.some((c) => c.hash === hash)) {
      if (commits.length >= loadedCount && view.graphCount < MAX_REVEAL) view.graphCount = Math.min(view.graphCount * 2, MAX_REVEAL)
      else view.graphReveal = null
      return
    }
    if (!changes.get(hash)) return
    view.graphReveal = null
    void tick().then(() => (graph?.querySelector('.graph-file.selected') ?? graph?.querySelector(`[data-hash="${hash}"]`))?.scrollIntoView({ block: 'center' }))
  })
</script>

<div class="graph" bind:this={graph}>
  {#each rows as row (row.commit.hash)}
    {@const commit = row.commit}
    {@const refs = refsOf(commit.refs)}
    {@const files = changes.get(commit.hash)}
    {@const open = changes.has(commit.hash)}
    {@const isHead = commit.hash === status.head}
    <div
      class={['graph-row', open && 'open']}
      data-hash={commit.hash}
      role="treeitem"
      aria-selected="false"
      aria-expanded={open}
      tabindex="-1"
      title={`${commit.hash.slice(0, 7)} · ${commit.author} · ${fullTime(commit.date)}\n\n${commit.subject}`}
      onclick={() => view.toggleCommit(commit.hash)}
      onkeydown={() => {}}
    >
      <svg class="graph-lanes" width={row.width * LANE + 6} height={ROW} aria-hidden="true">
        {#each row.top as edge, i (i)}<path d={edgePath(edge.from, edge.to, 0, MID)} stroke={color(edge.color)} />{/each}
        {#each row.bottom as edge, i (i)}<path d={edgePath(edge.from, edge.to, MID, ROW)} stroke={color(edge.color)} />{/each}
        {#if isHead}
          <circle cx={x(row.lane)} cy={MID} r="5" class="graph-node-ring" stroke={color(row.color)} />
          <circle cx={x(row.lane)} cy={MID} r="2.5" fill={color(row.color)} />
        {:else if commit.parents.length > 1}
          <circle cx={x(row.lane)} cy={MID} r="3.5" class="graph-node-ring" stroke={color(row.color)} />
        {:else}
          <circle cx={x(row.lane)} cy={MID} r="3.5" fill={color(row.color)} />
        {/if}
      </svg>
      <span class="graph-subject">{commit.subject}<span class="graph-author">{commit.author}</span></span>
      {#each refs as ref (ref.kind + ref.name)}
        <span class={['graph-ref', ref.kind]} title={ref.name}>{#if ref.kind === 'head' || ref.kind === 'branch'}<Icon name="branch" />{/if}<span>{ref.name}</span></span>
      {/each}
    </div>
    {#if open}
      {@const lanes = [...new Map(row.bottom.map((e) => [e.to, e.color]))]}
      {#each files ?? [] as change (change.path)}
        {@const shown = view.activeId === view.commitTabId(commit.hash, change, status.root)}
        <div
          class={['tree-row', 'graph-file', `git-${change.letter}`, change.letter === 'D' && 'deleted', shown && 'selected']}
          role="treeitem"
          aria-selected={shown}
          tabindex="-1"
          title={change.path}
          onclick={(e) => view.openCommitChange(commit, change, status.root, { preview: e.detail < 2, focus: e.detail >= 2 })}
          onkeydown={() => {}}
        >
          <svg class="graph-lanes" width={row.width * LANE + 6} height={ROW} aria-hidden="true">
            {#each lanes as [lane, c] (lane)}<path d={edgePath(lane, lane, 0, ROW)} stroke={color(c)} />{/each}
          </svg>
          <FileIcon name={basename(change.path)} />
          <span class="tree-name">{basename(change.path)}</span>
          <span class="tree-description">{change.path.includes('/') ? dirname(change.path) : ''}</span>
          <span class="git-letter">{change.letter}</span>
        </div>
      {/each}
      {#if files === null}<div class="side-note graph-loading">Loading…</div>{/if}
    {/if}
  {/each}
  {#if commits.length >= view.graphCount}
    <button class="ghost small graph-more" onclick={() => (view.graphCount += PAGE)}>Load more commits</button>
  {/if}
</div>
