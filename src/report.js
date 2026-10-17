/**
 * @typedef {import('./index.js').Result} Result
 * @typedef {import('./index.js').ReasonCode} ReasonCode
 * @typedef {import('./index.js').Verdict} Verdict
 * @typedef {import('./classify.js').Classification} Classification
 * @typedef {import('./classify.js').Kind} Kind
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
}

/** Headings for each reason. */
export const REASON_TITLES = /** @type {Record<ReasonCode, string>} */ ({
  bounce: 'Delivery failure',
  auto_reply: 'Automatic reply',
  possible_auto_reply: 'Possibly an automatic reply',
  bulk: 'Bulk or list mail',
  no_reply: 'No-reply sender',
  opt_out: 'They asked you to stop',
  repeated_inbound: 'Same message again',
  echo: 'Your message echoed back',
  repeated_reply: 'You already sent this',
  machine_speed: 'Replies faster than typing',
  too_many_sends: 'Too many messages on this thread',
  counterparty_rate: 'Too many messages to them today',
  counterparty_automated: 'Nobody there is reading',
})

const HEADLINES = /** @type {Record<Verdict, string>} */ ({
  keep: 'OK to reply',
  review: 'A person should look before anything is sent',
  fail: 'Do not reply',
})

export const KIND_TITLES = /** @type {Record<Kind, string>} */ ({
  person: 'From a person',
  auto_reply: 'Automatic reply',
  bounce: 'Delivery failure',
  bulk: 'Bulk or list mail',
  no_reply: 'No-reply sender',
})

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} indent
 * @returns {string}
 */
function wrap(text, width, indent) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

/**
 * @param {number} n
 * @param {string} one
 * @returns {string}
 */
function plural(n, one) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/**
 * @param {Result} result
 * @param {{ colour?: boolean, width?: number, maxSends?: number, windowMinutes?: number, maxSendsPerDay?: number }} [options]
 * @returns {string}
 */
export function formatText(result, options = {}) {
  const { colour = true, width = 76 } = options
  const paint = painter(colour)
  const { facts } = result
  const lines = ['']

  const label = { keep: 'PASS', review: 'REVIEW', fail: 'FAIL' }[result.verdict]
  const tint = { keep: COLOURS.green, review: COLOURS.yellow, fail: COLOURS.red }[result.verdict]
  lines.push(`${paint(tint, label)}  ${paint(COLOURS.bold, HEADLINES[result.verdict])}`)
  lines.push('')

  const row = (/** @type {string} */ name, /** @type {string} */ value) =>
    lines.push(`      ${paint(COLOURS.dim, name.padEnd(12))} ${value}`)
  row(
    'Thread',
    `${plural(facts.messages, 'message')}, ${facts.inbound} in, ${facts.outbound} out`,
  )
  const latest = facts.latest
  if (latest) {
    if (latest.direction === 'out') {
      row('Last message', 'yours')
    } else {
      const kind = latest.kind ?? 'person'
      const title = KIND_TITLES[kind]
      row(
        'Last message',
        kind === 'person'
          ? title
          : `${paint(tint, title)} ${paint(COLOURS.dim, `(${latest.confidence})`)}`,
      )
      for (const s of latest.signals.slice(0, 3)) row('', paint(COLOURS.dim, s.detail))
    }
  }
  if (options.maxSends !== undefined && options.windowMinutes !== undefined) {
    row('Sent', `${facts.sentInWindow} in the last ${options.windowMinutes} minutes (limit ${options.maxSends})`)
  }
  const l = facts.ledger
  if (l) {
    const limit = options.maxSendsPerDay !== undefined ? ` (limit ${options.maxSendsPerDay})` : ''
    row(
      'Ledger',
      `${l.counterparty}: ${l.sentLastDay} sent in 24 hours${limit}, ` +
        `${l.automatedInLookback} of ${l.inboundInLookback} replies automated` +
        (l.optedOut ? `, ${paint(COLOURS.red, 'opted out')}` : ''),
    )
  }

  for (const verdict of /** @type {const} */ (['fail', 'review'])) {
    const reasons = result.reasons.filter((x) => x.verdict === verdict)
    if (reasons.length === 0) continue
    lines.push('')
    lines.push(verdict === 'fail' ? paint(COLOURS.red, 'FAIL') : paint(COLOURS.yellow, 'REVIEW'))
    for (const reason of reasons) {
      lines.push(`  ${paint(COLOURS.bold, REASON_TITLES[reason.code])}`)
      lines.push(wrap(reason.detail, width - 6, '      '))
    }
  }

  if (result.notes.length) {
    lines.push('')
    for (const note of result.notes) lines.push(paint(COLOURS.dim, wrap(note, width - 2, '  ')))
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * @param {Classification} c
 * @param {{ colour?: boolean }} [options]
 * @returns {string}
 */
export function formatClassification(c, options = {}) {
  const { colour = true } = options
  const paint = painter(colour)
  const automated = c.kind !== 'person'
  const tint = !automated ? COLOURS.green : c.confidence === 'possible' ? COLOURS.yellow : COLOURS.red
  const lines = ['']
  lines.push(
    `${paint(tint, automated ? 'AUTOMATED' : 'PERSON')}  ${paint(COLOURS.bold, KIND_TITLES[c.kind])}` +
      (c.confidence ? paint(COLOURS.dim, `, ${c.confidence}`) : ''),
  )
  if (c.signals.length) lines.push('')
  for (const s of c.signals) {
    lines.push(`      ${paint(COLOURS.dim, s.source.padEnd(8))} ${s.detail} ${paint(COLOURS.dim, `(${KIND_TITLES[s.kind].toLowerCase()}, ${s.confidence})`)}`)
  }
  if (c.optOut) {
    lines.push('')
    lines.push(`  ${paint(COLOURS.red, 'Opt-out:')} they asked not to be contacted again.`)
  }
  lines.push('')
  return lines.join('\n')
}
