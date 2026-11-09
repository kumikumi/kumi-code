<!-- Thumbnails of images in the transcript. A click shows one over the window at full size; a right-click, on either, offers to copy or save it, and to show the file it was read from. -->
<script lang="ts">
  import type { ImageData } from '@shared/types'
  import { api } from './state.svelte'

  /** path: the file the images were read from; null when they came from none. */
  let { images, path = null }: { images: ImageData[]; path?: string | null } = $props()

  /** The image shown over the window; null when none is. */
  let viewing = $state.raw<ImageData | null>(null)
  /** Its pixel size, once it has loaded. */
  let size = $state<string | null>(null)

  const src = (image: ImageData): string => `data:${image.mediaType};base64,${image.data}`

  async function menu(e: MouseEvent, image: ImageData): Promise<void> {
    e.preventDefault()
    api.imageMenu({ image, png: await clipboardPng(image), path })
  }

  /** The image re-encoded as PNG when the main process cannot read its format for the clipboard. */
  async function clipboardPng(image: ImageData): Promise<string | null> {
    if (image.mediaType === 'image/png' || image.mediaType === 'image/jpeg') return null
    const img = new Image()
    img.src = src(image)
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png').replace(/^data:[^;]+;base64,/, '')
  }
</script>

<div class="images">
  {#each images as image, i (i)}
    <button class="image-thumb" title="View full size" onclick={() => (viewing = image)} oncontextmenu={(e) => menu(e, image)}><img src={src(image)} alt="" /></button>
  {/each}
</div>
{#if viewing}
  {@const image = viewing}
  <dialog class="image-viewer" {@attach (dialog) => dialog.showModal()} onclose={() => ((viewing = null), (size = null))}>
    <button title="Close" onclick={(e) => e.currentTarget.closest('dialog')?.close()} oncontextmenu={(e) => menu(e, image)}>
      <img src={src(image)} alt="" onload={(e) => {
          const img = e.currentTarget as HTMLImageElement
          size = `${img.naturalWidth} × ${img.naturalHeight}`
        }} />
    </button>
    {#if size}<div class="image-size">{size} {image.mediaType.replace('image/', '').toUpperCase()}</div>{/if}
  </dialog>
{/if}
