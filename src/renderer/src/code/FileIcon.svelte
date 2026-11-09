<!-- A file's icon: a page in its language's color, after the colors of VS Code's Seti icons. -->
<script module lang="ts">
  const BLUE = '#519aba'
  const YELLOW = '#cbcb41'
  const ORANGE = '#e37933'
  const RED = '#cc3e44'
  const GREEN = '#8dc149'
  const PURPLE = '#a074c4'
  const PINK = '#f55385'
  const GREY = '#6d8086'

  const BY_EXTENSION: Record<string, string> = {
    ts: BLUE, mts: BLUE, cts: BLUE, tsx: BLUE, js: YELLOW, mjs: YELLOW, cjs: YELLOW, jsx: YELLOW, json: YELLOW, jsonc: YELLOW,
    css: BLUE, less: BLUE, scss: PINK, sass: PINK, html: ORANGE, htm: ORANGE, svelte: RED, vue: GREEN, astro: ORANGE,
    md: BLUE, mdx: BLUE, py: BLUE, go: BLUE, rs: GREY, java: RED, kt: PURPLE, swift: ORANGE, rb: RED, php: PURPLE,
    c: BLUE, h: PURPLE, cc: BLUE, cpp: BLUE, hpp: PURPLE, cs: BLUE, sh: GREEN, bash: GREEN, zsh: GREEN, fish: GREEN,
    yml: PURPLE, yaml: PURPLE, toml: GREY, xml: ORANGE, svg: PURPLE, png: PURPLE, jpg: PURPLE, jpeg: PURPLE, gif: PURPLE,
    webp: PURPLE, ico: PURPLE, icns: PURPLE, lock: GREY, txt: GREY, log: GREY, sql: PINK, graphql: PINK, lua: BLUE,
    dart: BLUE, ex: PURPLE, exs: PURPLE, scala: RED, zig: ORANGE, env: YELLOW,
  }

  export function fileColor(name: string): string {
    if (name.startsWith('.') && !name.slice(1).includes('.')) return GREY
    const dot = name.lastIndexOf('.')
    return (dot >= 0 && BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || 'var(--muted)'
  }
</script>

<script lang="ts">
  let { name }: { name: string } = $props()
</script>

<svg class="icon file-icon" viewBox="0 0 16 16" aria-hidden="true" style:color={fileColor(name)}><path d="M3.75 1.75h5.5l3 3v9.5h-8.5zM9.25 1.75v3h3" /></svg>
