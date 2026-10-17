/**
 * Just enough of RFC 5322 and MIME to read a raw email the way loop-breaker needs it:
 * the headers that mark automated mail, who it is from, the subject, and the plain-text
 * body. Not a general-purpose parser.
 */

/**
 * @typedef {object} ParsedEmail
 * @property {Record<string, string>} headers Lower-case names, folded lines joined. A
 *   header that appears more than once keeps its first value.
 * @property {string | undefined} from The address only, lower case.
 * @property {string | undefined} subject
 * @property {string} text The text/plain body, or the body with tags stripped when there
 *   is only HTML.
 * @property {string | undefined} date As written.
 * @property {string | undefined} contentType
 */

/**
 * @param {string} raw
 * @returns {ParsedEmail}
 */
export function parseEmail(raw) {
  const source = String(raw).replace(/\r\n/g, '\n')
  const split = source.search(/\n\n/)
  const head = split === -1 ? source : source.slice(0, split)
  const body = split === -1 ? '' : source.slice(split + 2)
  const headers = parseHeaders(head)

  return {
    headers,
    from: addressOf(headers.from),
    subject: headers.subject !== undefined ? decodeWords(headers.subject) : undefined,
    text: bodyText(headers, body),
    date: headers.date,
    contentType: headers['content-type'],
  }
}

/**
 * Whether a string looks like a raw email rather than a message body: it starts with
 * header lines.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeEmail(text) {
  const head = String(text).replace(/\r\n/g, '\n').split('\n\n')[0]
  const lines = head.split('\n').filter((l) => !/^[ \t]/.test(l))
  return (
    lines.length >= 2 &&
    lines.every((l) => /^[!-9;-~]+:/.test(l)) &&
    lines.some((l) => /^(?:from|to|subject|date|message-id|received|return-path):/i.test(l))
  )
}

/**
 * @param {string} head
 * @returns {Record<string, string>}
 */
export function parseHeaders(head) {
  /** @type {Record<string, string>} */
  const headers = {}
  /** The header a continuation line belongs to; null for a repeat, which is skipped. */
  let current = /** @type {string | null} */ (null)
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (current) headers[current] += ` ${line.trim()}`
      continue
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line)
    if (!m) {
      current = null
      continue
    }
    const name = m[1].toLowerCase()
    if (name in headers) {
      current = null
    } else {
      headers[name] = m[2]
      current = name
    }
  }
  return headers
}

/**
 * The bare address from a From or Return-Path value, lower case.
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function addressOf(value) {
  if (value === undefined) return undefined
  const angle = /<([^<>]*)>/.exec(value)
  if (angle) return angle[1].trim().toLowerCase()
  const bare = /[^\s"<>,;]+@[^\s"<>,;]+/.exec(value)
  return bare ? bare[0].toLowerCase() : value.trim().toLowerCase() || undefined
}

/**
 * @param {Record<string, string>} headers
 * @param {string} body
 * @returns {string}
 */
function bodyText(headers, body) {
  const type = headers['content-type'] ?? 'text/plain'
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
  if (/^multipart\//i.test(type) && boundary) {
    const parts = splitParts(body, boundary).map((p) => {
      const at = p.search(/\n\n/)
      const h = parseHeaders(at === -1 ? p : p.slice(0, at))
      return { headers: h, body: at === -1 ? '' : p.slice(at + 2) }
    })
    // Prefer plain text anywhere in the tree, then HTML.
    for (const want of ['text/plain', 'text/html']) {
      for (const part of parts) {
        const partType = part.headers['content-type'] ?? 'text/plain'
        if (/^multipart\//i.test(partType)) {
          const inner = bodyText(part.headers, part.body)
          if (inner) return inner
        } else if (partType.toLowerCase().startsWith(want)) {
          return bodyText(part.headers, part.body)
        }
      }
    }
    return ''
  }
  const decoded = decodeTransfer(body, headers['content-transfer-encoding'])
  return /^text\/html/i.test(type) ? stripHtml(decoded).trim() : decoded.trim()
}

/**
 * @param {string} body
 * @param {string} boundary
 * @returns {string[]}
 */
function splitParts(body, boundary) {
  const marker = `--${boundary}`
  const parts = body.split(marker).slice(1)
  return parts
    .filter((p) => !p.startsWith('--'))
    .map((p) => p.replace(/^[ \t]*\n/, ''))
}

/**
 * @param {string} body
 * @param {string | undefined} encoding
 * @returns {string}
 */
function decodeTransfer(body, encoding) {
  const enc = (encoding ?? '').trim().toLowerCase()
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  }
  if (enc === 'quoted-printable') {
    const bytes = body
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => `%${hex}`)
    try {
      return decodeURIComponent(bytes.replace(/%(?![0-9A-F]{2})/gi, '%25'))
    } catch {
      return bytes.replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    }
  }
  return body
}

/**
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Decodes RFC 2047 encoded words in a header, such as =?UTF-8?Q?R=C3=A9ponse?=.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeWords(value) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (whole, _charset, kind, text) => {
      try {
        if (kind.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8')
        return decodeTransfer(text.replace(/_/g, ' '), 'quoted-printable')
      } catch {
        return whole
      }
    })
}
