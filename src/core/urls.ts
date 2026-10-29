// URL rules of the browser: which pages are local, how a typed URL is completed,
// and how URLs are shown with their secrets hidden.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}

/** Pages the agent may open without asking: blank pages and local servers (*.test included). */
export function isLocalUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && (isLocalHost(u.hostname) || u.hostname.endsWith('.test'))
  } catch {
    return false
  }
}

/** A URL as typed: without a scheme, http for local hosts and https for the rest. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  // "localhost:5173" has a colon but no scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/:]+:\d+(\/|$)/.test(trimmed)) return trimmed
  const host = trimmed.split(/[/?#]/)[0]?.replace(/:\d+$/, '') ?? ''
  return `${isLocalHost(host) || host.endsWith('.test') ? 'http' : 'https'}://${trimmed}`
}

/** A URL's origin; a URL without one, such as about:blank, stands for itself. */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.origin === 'null' ? `${u.protocol}${u.pathname}` : u.origin
  } catch {
    return url
  }
}

/** A URL with credentials and secret-looking query values replaced. */
export function redact(url: string): string {
  try {
    const u = new URL(url)
    if (u.username) u.username = 'REDACTED'
    if (u.password) u.password = 'REDACTED'
    for (const key of [...u.searchParams.keys()]) if (/token|key|auth|secret|passw|session|signature|sig|code|credential/i.test(key)) u.searchParams.set(key, 'REDACTED')
    return u.toString()
  } catch {
    return url
  }
}
