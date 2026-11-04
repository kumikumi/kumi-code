<!-- A line icon in the text's color, 16 px unless its container sizes it; the stroke keeps its width at any size. -->
<script module lang="ts">
  const PATHS = {
    globe: 'M14.25 8a6.25 6.25 0 1 1-12.5 0 6.25 6.25 0 1 1 12.5 0M1.75 8h12.5M8 1.75c-1.7 1.7-2.5 3.8-2.5 6.25s.8 4.55 2.5 6.25M8 1.75c1.7 1.7 2.5 3.8 2.5 6.25s-.8 4.55-2.5 6.25',
    terminal: 'M2.5 4l4 4-4 4M8 12.5h5.5',
    back: 'M9.75 3.5 5.25 8l4.5 4.5',
    forward: 'M6.25 3.5 10.75 8l-4.5 4.5',
    reload: 'M13.25 8a5.25 5.25 0 1 1-1.54-3.71M12 1.5v3H9',
    plus: 'M8 3.5v9M3.5 8h9',
    close: 'M4.5 4.5l7 7m0-7-7 7',
    palette: 'M8 1.75C4.55 1.75 1.75 4.45 1.75 7.85c0 3.4 2.8 6.4 6.15 6.4.95 0 1.45-.7 1.25-1.5-.2-.8.15-1.55 1.05-1.55h1.35c1.6 0 2.7-1.25 2.7-2.95 0-3.65-2.8-6.5-6.25-6.5ZM3.9 8.9a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0M4.7 5.6a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0M7.7 4.3a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0M10.6 6a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0',
    fork: 'M5.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0M13.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0M4 4.5v.75C4 6.8 5 7.75 6.5 7.75h3c1.5 0 2.5-.95 2.5-2.5V4.5M8 7.75v3.75',
  }
</script>

<script lang="ts">
  let { name }: { name: keyof typeof PATHS } = $props()
</script>

<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d={PATHS[name]} /></svg>
