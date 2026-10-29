// The browser tools' helper inside a page: an accessibility-style tree of the page
// whose elements get references (ref_1, ref_2, ...), search over that tree, where to
// click an element, form input, and the page's text. It runs in an isolated world, so
// the page cannot see or change it; references last until the page navigates.

/** The isolated world the helper lives in. */
export const HELPER_WORLD = 1001

/** Defines `window.__kumi` in the world, once per page. */
export const HELPER_SOURCE = String.raw`(() => {
if (window.__kumi) return
const refs = new Map()
const ids = new WeakMap()
let next = 1
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE'])
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'clickable'])
// Roles whose name is their text: the text below them is not listed again.
const NAMED_BY_CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'clickable', 'cell', 'columnheader', 'rowheader', 'paragraph', 'listitem', 'switch', 'label', 'legend', 'caption'])

const clean = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
const quote = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function refOf(el) {
  let ref = ids.get(el)
  if (!ref) {
    ref = 'ref_' + next++
    ids.set(el, ref)
    refs.set(ref, new WeakRef(el))
  }
  return ref
}

function byRef(ref) {
  const el = refs.get(ref) && refs.get(ref).deref()
  if (!el || !el.isConnected) throw new Error('No element ' + ref + ' on the page. Read the page again for fresh references.')
  return el
}

function shown(el) {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  return true
}

function headingLevel(el) {
  const m = /^H([1-6])$/.exec(el.tagName)
  return m ? Number(m[1]) : Number(el.getAttribute('aria-level')) || 0
}

function role(el) {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.trim().split(/\s+/)[0]
  switch (el.tagName.toUpperCase()) {
    case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null
    case 'BUTTON': case 'SUMMARY': return 'button'
    case 'INPUT': {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'hidden') return null
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (el.hasAttribute('list')) return 'combobox'
      return 'textbox'
    }
    case 'TEXTAREA': return 'textbox'
    case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    case 'OPTION': return 'option'
    case 'IMG': return el.getAttribute('alt') === '' ? null : 'img'
    case 'SVG': return el.getAttribute('aria-label') ? 'img' : null
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading'
    case 'NAV': return 'navigation'
    case 'MAIN': return 'main'
    case 'HEADER': return el.closest('article, section, aside, main, nav') ? null : 'banner'
    case 'FOOTER': return el.closest('article, section, aside, main, nav') ? null : 'contentinfo'
    case 'ASIDE': return 'complementary'
    case 'FORM': return 'form'
    case 'SECTION': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null
    case 'ARTICLE': return 'article'
    case 'UL': case 'OL': return 'list'
    case 'LI': return 'listitem'
    case 'TABLE': return 'table'
    case 'TR': return 'row'
    case 'TH': return 'columnheader'
    case 'TD': return 'cell'
    case 'DIALOG': return 'dialog'
    case 'DETAILS': case 'FIELDSET': return 'group'
    case 'LEGEND': return 'legend'
    case 'LABEL': return 'label'
    case 'P': return 'paragraph'
    case 'IFRAME': return 'iframe'
    case 'VIDEO': return 'video'
    case 'AUDIO': return 'audio'
    case 'PROGRESS': return 'progressbar'
    case 'CANVAS': return 'canvas'
  }
  if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox'
  if (el.hasAttribute('onclick')) return 'clickable'
  if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return 'clickable'
  // A pointer cursor that starts at this element, not one it inherits.
  if (getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')) return 'clickable'
  return null
}

function labelText(el) {
  if (el.id) {
    const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    if (label) return label.innerText
  }
  const wrap = el.closest('label')
  return wrap ? wrap.innerText : ''
}

function nameOf(el, r) {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return clean(aria, 150)
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const text = by.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? t.innerText : '' }).join(' ')
    if (text.trim()) return clean(text, 150)
  }
  const tag = el.tagName
  if (tag === 'IMG' || tag === 'AREA') return clean(el.getAttribute('alt') || el.getAttribute('title'), 150)
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) return clean(el.value || labelText(el), 150)
    return clean(labelText(el) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'), 150)
  }
  if (NAMED_BY_CONTENT.has(r)) return clean(el.innerText || el.textContent, r === 'paragraph' ? 300 : 150)
  return clean(el.getAttribute('title'), 150)
}

function extras(el, r) {
  const out = []
  if (r === 'heading') out.push('level=' + headingLevel(el))
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (r === 'checkbox' || r === 'radio') out.push(el.checked ? 'checked' : 'unchecked')
    else if (type !== 'submit' && type !== 'button' && type !== 'reset') {
      if (type && type !== 'text' && type !== 'search') out.push('type=' + type)
      if (el.value) out.push('value=' + quote(type === 'password' ? '••••' : clean(el.value, 100)))
    }
  } else if (tag === 'SELECT') {
    const selected = [...el.selectedOptions].map((o) => clean(o.text, 60))
    if (selected.length) out.push('value=' + quote(selected.join(', ')))
  } else if (r === 'textbox' && el.isContentEditable) {
    const text = clean(el.innerText, 100)
    if (text) out.push('value=' + quote(text))
  }
  if (r === 'link') {
    const href = el.getAttribute('href')
    if (href && !href.startsWith('javascript:')) out.push('href=' + quote(clean(href, 120)))
  }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
  for (const state of ['expanded', 'selected', 'pressed']) {
    const v = el.getAttribute('aria-' + state)
    if (v === 'true' || v === 'false') out.push(state + '=' + v)
  }
  if (r === 'checkbox' || r === 'switch') {
    const v = el.getAttribute('aria-checked')
    if (v && tag !== 'INPUT') out.push(v === 'true' ? 'checked' : 'unchecked')
  }
  return out.length ? ' ' + out.join(' ') : ''
}

function childrenOf(el) {
  if (el.tagName === 'SLOT') return el.assignedNodes({ flatten: true })
  if (el.shadowRoot) return [...el.shadowRoot.childNodes]
  if (el.tagName === 'IFRAME') return []
  return [...el.childNodes]
}

function tree(opts) {
  const root = opts.refId ? byRef(opts.refId) : document.body || document.documentElement
  const interactiveOnly = opts.filter === 'interactive'
  const lines = []
  let length = 0
  let truncated = false
  const push = (depth, text) => {
    if (truncated) return
    const line = '  '.repeat(depth) + text
    if (length + line.length + 1 > opts.maxChars) { truncated = true; return }
    lines.push(line)
    length += line.length + 1
  }
  const walk = (node, depth, textCovered, parent) => {
    if (truncated) return
    if (node.nodeType === Node.TEXT_NODE) {
      if (interactiveOnly || textCovered || depth > opts.depth) return
      const text = clean(node.textContent, 300)
      if (text) push(depth, '- text ' + quote(text) + (parent ? ' [' + refOf(parent) + ']' : ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node
    if (SKIP.has(el.tagName.toUpperCase()) || !shown(el)) return
    const r = role(el)
    let childDepth = depth
    let covered = textCovered
    if (r && (!interactiveOnly || INTERACTIVE.has(r))) {
      if (depth > opts.depth) return
      const name = nameOf(el, r)
      push(depth, '- ' + r + (name ? ' ' + quote(name) : '') + extras(el, r) + ' [' + refOf(el) + ']')
      childDepth = depth + (interactiveOnly ? 0 : 1)
      if (name && NAMED_BY_CONTENT.has(r)) covered = true
      if (r === 'combobox' || r === 'listbox' || r === 'textbox' || r === 'img') return
    }
    for (const child of childrenOf(el)) walk(child, childDepth, covered, el)
  }
  walk(root, 0, false, null)
  if (!lines.length) lines.push(interactiveOnly ? '(no interactive elements)' : '(empty page)')
  return { text: lines.join('\n'), truncated }
}

function find(query) {
  const q = String(query).toLowerCase()
  const { text } = tree({ filter: 'all', depth: 1000, maxChars: 2000000, refId: null })
  return text.split('\n').map((l) => l.trim()).filter((l) => / \[ref_\d+\]$/.test(l) && l.toLowerCase().includes(q)).slice(0, 20)
}

function inView(r) {
  return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
}

/** Where to click the element, in the viewport's pixels, after scrolling it into view. */
function point(ref) {
  const el = byRef(ref)
  let r = el.getBoundingClientRect()
  if (!inView(r)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    r = el.getBoundingClientRect()
  }
  if (r.width === 0 && r.height === 0) throw new Error(ref + ' has no size on the page, so it cannot be clicked')
  const vv = window.visualViewport
  const scale = vv ? vv.scale : 1
  return {
    x: Math.round((r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale),
    y: Math.round((r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale),
    label: (role(el) || el.tagName.toLowerCase()) + (nameOf(el, role(el)) ? ' ' + quote(nameOf(el, role(el))) : ''),
  }
}

function scrollTo(ref) {
  const el = byRef(ref)
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  return (role(el) || el.tagName.toLowerCase())
}

function fire(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function formInput(ref, value) {
  const el = byRef(ref)
  const tag = el.tagName
  if (tag === 'SELECT') {
    const want = String(value)
    const options = [...el.options]
    const option = options.find((o) => o.value === want) || options.find((o) => o.text.trim() === want) || options.find((o) => o.text.trim().toLowerCase() === want.toLowerCase())
    if (!option) throw new Error('No option ' + JSON.stringify(want) + '. The options are ' + options.map((o) => JSON.stringify(o.text.trim())).join(', '))
    el.value = option.value
    fire(el)
    return 'Selected ' + JSON.stringify(option.text.trim())
  }
  if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = value === true || value === 'true' || value === 'on' || value === 1 || value === 'checked'
    if (el.checked !== want) el.click()
    return (el.checked ? 'Checked ' : 'Unchecked ') + el.type
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    el.focus()
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    // The prototype's setter, so frameworks that track the value see the change.
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value))
    fire(el)
    return 'Set the value to ' + JSON.stringify(String(value))
  }
  if (el.isContentEditable) {
    el.focus()
    el.textContent = String(value)
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return 'Set the text to ' + JSON.stringify(String(value))
  }
  throw new Error(ref + ' is a ' + tag.toLowerCase() + ' element, not a form field')
}

function text(maxChars) {
  const root = document.querySelector('article') || document.querySelector('main') || document.body
  const body = root ? root.innerText.replace(/\n{3,}/g, '\n\n').trim() : ''
  const header = 'Title: ' + document.title + '\nURL: ' + location.href + '\n\n'
  return body.length > maxChars ? header + body.slice(0, maxChars) + '\n\n[Truncated at ' + maxChars + ' of ' + body.length + ' characters]' : header + body
}

window.__kumi = { tree, find, point, scrollTo, formInput, text }
})()`

/** A call of the helper, which returns `{ ok }` or `{ error }` instead of throwing. */
export function helperCall(fn: 'tree' | 'find' | 'point' | 'scrollTo' | 'formInput' | 'text', ...args: unknown[]): string {
  const call = `window.__kumi.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`
  return `${HELPER_SOURCE};(() => { try { return { ok: ${call} } } catch (e) { return { error: String(e && e.message || e) } } })()`
}
