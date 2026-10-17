import { parseEmail, addressOf } from './email.js'

/**
 * @typedef {'in'|'out'} Direction
 *
 * @typedef {object} Message One message in a thread, on any channel.
 * @property {Direction} direction 'in' from the other side, 'out' from you.
 * @property {string | number | Date} [at] When it was sent or received. ISO 8601 with
 *   an offset or Z, epoch milliseconds, or a Date. Without it, timing checks skip it.
 * @property {string} [text] The body as plain text.
 * @property {string} [from] Sender address or number.
 * @property {string} [subject]
 * @property {Record<string, string>} [headers] Email headers, any case.
 * @property {string} [raw] A raw RFC 5322 email. Headers, sender, subject and body are
 *   read from it where not given separately.
 *
 * @typedef {'person'|'auto_reply'|'bounce'|'bulk'|'no_reply'} Kind
 *   person: nothing marks it as automated. auto_reply: an out-of-office, autoresponder,
 *   ticket acknowledgement or read receipt. bounce: a delivery failure. bulk: list,
 *   newsletter or campaign mail. no_reply: from an address that does not take replies.
 *
 * @typedef {'certain'|'likely'|'possible'} Confidence
 *   certain: a header or sender that only automated mail carries. likely: wording that
 *   is almost always automated. possible: wording that often is.
 *
 * @typedef {'header'|'sender'|'subject'|'text'} Source
 *
 * @typedef {object} Signal
 * @property {Exclude<Kind, 'person'>} kind
 * @property {Confidence} confidence
 * @property {Source} source
 * @property {string} detail What was found, such as "Auto-Submitted: auto-replied".
 *
 * @typedef {object} Classification
 * @property {Kind} kind
 * @property {Confidence | null} confidence Null for a person.
 * @property {boolean} optOut The sender asked not to be contacted again.
 * @property {Signal[]} signals Everything found, strongest first.
 *
 * @typedef {object} Normalized
 * @property {string} text
 * @property {string | undefined} from
 * @property {string | undefined} subject
 * @property {Record<string, string>} headers Lower-case names.
 */

const KIND_ORDER = /** @type {const} */ (['bounce', 'auto_reply', 'bulk', 'no_reply'])
const CONFIDENCE_ORDER = { certain: 0, likely: 1, possible: 2 }

/**
 * Fills text, sender, subject and headers from a raw email where they were not given.
 *
 * @param {Message} message
 * @returns {Normalized}
 */
export function normalizeMessage(message) {
  const parsed = message.raw ? parseEmail(message.raw) : null
  /** @type {Record<string, string>} */
  const headers = { ...(parsed?.headers ?? {}) }
  for (const [k, v] of Object.entries(message.headers ?? {})) headers[k.toLowerCase()] = String(v)
  return {
    text: message.text ?? parsed?.text ?? '',
    from: message.from ?? parsed?.from ?? addressOf(headers.from),
    subject: message.subject ?? parsed?.subject ?? headers.subject,
    headers,
  }
}

/**
 * Says whether a message came from a person or a machine, and why. Headers and senders
 * are certain; wording is likely or possible. Runs locally.
 *
 * @param {Message} message
 * @returns {Classification}
 */
export function classifyMessage(message) {
  const m = normalizeMessage(message)
  /** @type {Signal[]} */
  const signals = []
  const add = (
    /** @type {Signal['kind']} */ kind,
    /** @type {Confidence} */ confidence,
    /** @type {Source} */ source,
    /** @type {string} */ detail,
  ) => signals.push({ kind, confidence, source, detail })

  headerSignals(m.headers, add)
  senderSignals(m.from, add)
  for (const rule of SUBJECT_RULES) {
    if (m.subject && rule.pattern.test(m.subject)) add(rule.kind, 'likely', 'subject', `Subject: ${clip(m.subject)}`)
  }
  const written = stripQuoted(m.text)
  for (const rule of TEXT_RULES) {
    const found = rule.pattern.exec(written)
    if (found) add(rule.kind, rule.confidence, 'text', `"${clip(found[0])}"`)
  }

  signals.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  )
  const unique = signals.filter(
    (s, i) => signals.findIndex((t) => t.kind === s.kind && t.detail === s.detail) === i,
  )

  // The kind is the strongest evidence; between equally strong, a bounce outranks an
  // autoresponder, which outranks bulk mail.
  const top = unique[0]
  return {
    kind: top ? top.kind : 'person',
    confidence: top ? top.confidence : null,
    optOut: message.direction !== 'out' && isOptOut(m.text),
    signals: unique,
  }
}

/**
 * @param {Record<string, string>} h
 * @param {(kind: Signal['kind'], confidence: Confidence, source: Source, detail: string) => void} add
 */
function headerSignals(h, add) {
  const auto = h['auto-submitted']
  if (auto !== undefined && !/^\s*no\b/i.test(auto)) {
    add('auto_reply', 'certain', 'header', `Auto-Submitted: ${auto.trim()}`)
  }
  for (const name of ['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-reply']) {
    if (h[name] !== undefined) add('auto_reply', 'certain', 'header', `${display(name)}: ${h[name].trim()}`)
  }
  if (h['x-auto-response-suppress'] !== undefined) {
    add('auto_reply', 'likely', 'header', `X-Auto-Response-Suppress: ${h['x-auto-response-suppress'].trim()}`)
  }
  for (const name of ['precedence', 'x-precedence']) {
    const v = h[name]?.trim().toLowerCase()
    if (!v) continue
    if (v === 'auto_reply') add('auto_reply', 'certain', 'header', `${display(name)}: ${v}`)
    else if (v === 'bulk' || v === 'junk' || v === 'list') add('bulk', 'certain', 'header', `${display(name)}: ${v}`)
  }
  if (h['list-id'] !== undefined) add('bulk', 'certain', 'header', `List-Id: ${clip(h['list-id'])}`)
  if (h['list-unsubscribe'] !== undefined) add('bulk', 'likely', 'header', 'List-Unsubscribe')
  if (h['x-failed-recipients'] !== undefined) {
    add('bounce', 'certain', 'header', `X-Failed-Recipients: ${clip(h['x-failed-recipients'])}`)
  }
  const type = h['content-type'] ?? ''
  if (/multipart\/report/i.test(type) && /report-type="?delivery-status/i.test(type)) {
    add('bounce', 'certain', 'header', 'Content-Type: multipart/report (delivery-status)')
  }
  if (/multipart\/report/i.test(type) && /report-type="?disposition-notification/i.test(type)) {
    add('auto_reply', 'certain', 'header', 'Content-Type: multipart/report (read receipt)')
  }
  if (h['return-path'] !== undefined && /^\s*<\s*>\s*$/.test(h['return-path'])) {
    add('auto_reply', 'likely', 'header', 'Return-Path: <> (null sender)')
  }
}

/**
 * @param {string | undefined} from
 * @param {(kind: Signal['kind'], confidence: Confidence, source: Source, detail: string) => void} add
 */
function senderSignals(from, add) {
  if (!from || !from.includes('@')) return
  const local = from.split('@')[0]
  if (/^(?:mailer-daemon|postmaster|mail-daemon)$/i.test(local)) {
    add('bounce', 'certain', 'sender', `From ${from}`)
  } else if (
    /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|dont[-_.]?reply|noreply|notifications?|bounces?|mailer)(?:[-_.+].*)?$/i.test(local)
  ) {
    add('no_reply', 'certain', 'sender', `From ${from}`)
  }
}

/**
 * @typedef {{ kind: Signal['kind'], confidence: Confidence, pattern: RegExp }} TextRule
 */

/** @type {Array<{ kind: Signal['kind'], pattern: RegExp }>} */
const SUBJECT_RULES = [
  {
    kind: 'bounce',
    pattern:
      /^\s*(?:undeliverable|undelivered mail|delivery (?:status notification|failure|has failed|incomplete)|mail delivery (?:failed|failure|system)|returned mail|failure notice|message not delivered|delivery notification)\b/i,
  },
  {
    kind: 'auto_reply',
    pattern:
      /^\s*(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response)|autoreply|out of (?:the )?office|ooo\b|away from (?:the )?office|abwesend|abwesenheitsnotiz|r[ée]ponse automatique|absence du bureau|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|resposta autom[áa]tica|read:|leído:|gelesen:|lu ?:)/i,
  },
]

/** @type {TextRule[]} */
const TEXT_RULES = [
  {
    kind: 'bounce',
    confidence: 'likely',
    pattern:
      /\b(?:(?:your |this )?message (?:could not|couldn't|was not|wasn't) (?:be )?delivered|delivery (?:to the following recipients? )?(?:has )?failed|address (?:not found|couldn't be found|could not be found)|recipient address rejected|user (?:unknown|not found)|no such user|mailbox (?:unavailable|is full|not found|does not exist)|550[ -]5\.1\.1|permanent (?:error|failure)|this is the mail system at host|undeliverable to)\b/i,
  },
  {
    kind: 'auto_reply',
    confidence: 'likely',
    pattern:
      /\b(?:this is an? (?:automated|automatic|auto-generated) (?:message|response|reply|e-?mail|notification)|automatic(?:ally generated)? reply|auto-?reply|I(?:'m| am) (?:currently )?(?:out of (?:the )?office|away from (?:the |my )?(?:office|desk)|on (?:annual |parental |maternity |paternity |sick )?leave|on (?:vacation|holiday)|travell?ing)(?: [^.!\n]{0,60})? (?:until|till|through|returning|and will (?:return|be back|respond|reply)|with (?:limited|no) access)|I will (?:be back|return) (?:on|in the office)[^.!\n]{0,40}\b(?:and )?will (?:respond|reply)|(?:with|have) (?:limited|no) access to (?:my )?e-?mail|this (?:mailbox|inbox|e-?mail address|number) is (?:not monitored|unmonitored|no longer (?:monitored|in use|active))|please do not reply to this (?:e-?mail|message|text)|I(?:'m| am) driving with (?:do not disturb|driving focus)|I(?:'ll| will) see your message when I get where I'm going)\b/i,
  },
  {
    kind: 'auto_reply',
    confidence: 'possible',
    pattern:
      /\b(?:we(?:'ve| have) received your (?:message|e-?mail|request|inquiry|enquiry|ticket)|your (?:request|ticket|case|inquiry) (?:#|number |no\.? |id )?:?\s*[A-Z0-9-]*\d[A-Z0-9-]* has been (?:received|created|opened|logged)|(?:one of )?our (?:team|agents?|representatives?) will (?:get back to you|respond|be in touch|contact you) (?:within|in|as soon as)|thank you for (?:contacting|your (?:e-?mail|message|inquiry|enquiry))[^.!\n]{0,40}[.!] (?:we|this|our)[^.!\n]{0,40}(?:receive|respond|get back))/i,
  },
  {
    kind: 'bulk',
    confidence: 'likely',
    pattern: /\b(?:reply|text|txt) (?:STOP|END) to (?:opt[- ]?out|unsubscribe|cancel|stop|end)|\bmsg ?(?:&|and) ?data rates (?:may|might) apply\b/i,
  },
]

/**
 * A request to stop: a keyword on its own, or a sentence that says it.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isOptOut(text) {
  const body = stripQuoted(text).trim()
  if (/^(?:stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[- ]?out|remove)[.!\s]*$/i.test(body)) return true
  return /\b(?:please )?(?:stop (?:texting|emailing|messaging|contacting|calling|sending)(?: me)?|remove me from|unsubscribe me|take me off (?:your|the|this) (?:list|mailing list)|(?:do not|don't|never) (?:contact|email|e-mail|text|message|call) me|leave me alone|no more (?:emails|texts|messages))\b/i.test(
    body,
  )
}

/**
 * The part of a message the sender wrote, without the quoted message under it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripQuoted(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  /** @type {string[]} */
  const kept = []
  for (const line of lines) {
    if (
      /^\s*On\b.{0,200}\bwrote:\s*$/i.test(line) ||
      /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) ||
      /^\s*From:\s.+$/i.test(line) && kept.length > 0 && /^\s*$/.test(kept[kept.length - 1] ?? '') ||
      /^\s*_{10,}\s*$/.test(line)
    ) {
      break
    }
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/**
 * @param {string} name
 * @returns {string}
 */
function display(name) {
  return name.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase())
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat
}
