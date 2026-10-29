import { describe, expect, it } from 'vitest'
import { isLocalUrl, normalizeUrl, originOf, redact } from './urls'

describe('urls', () => {
  it('completes typed URLs', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('localhost:5173/a?b')).toBe('http://localhost:5173/a?b')
    expect(normalizeUrl('app.test/x')).toBe('http://app.test/x')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl(' https://example.com/a ')).toBe('https://example.com/a')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })

  it('tells local pages from the rest', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:80/', 'https://app.localhost/', 'http://site.test/', 'about:blank']) expect(isLocalUrl(url), url).toBe(true)
    for (const url of ['https://example.com/', 'file:///etc/passwd', 'http://localhost.example.com/', 'data:text/html,hi']) expect(isLocalUrl(url), url).toBe(false)
  })

  it('shows URLs without their secrets', () => {
    expect(redact('https://u:p@example.com/a?token=abc&page=2&api_key=x')).toBe('https://REDACTED:REDACTED@example.com/a?token=REDACTED&page=2&api_key=REDACTED')
    expect(originOf('http://localhost:5173/a/b')).toBe('http://localhost:5173')
    expect(originOf('about:blank')).toBe('about:blank')
  })
})
