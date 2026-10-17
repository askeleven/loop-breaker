import { classifyMessage, normalizeMessage, stripQuoted } from './classify.js'
import { similarity, fingerprint, wordsOf } from './similar.js'

export { classifyMessage, normalizeMessage, isOptOut, stripQuoted } from './classify.js'
export { parseEmail, looksLikeEmail } from './email.js'
export { similarity, fingerprint } from './similar.js'
export { recordMessage, readLedger, parseLedger, ledgerEvent } from './ledger.js'

/**
 * @typedef {import('./classify.js').Message} Message
 * @typedef {import('./classify.js').Classification} Classification
 * @typedef {import('./classify.js').Kind} Kind
 * @typedef {import('./ledger.js').LedgerEvent} LedgerEvent
 *
 * @typedef {'keep'|'review'|'fail'} Verdict
 *
 * @typedef {'bounce'|'auto_reply'|'possible_auto_reply'|'bulk'|'no_reply'|'opt_out'
 *   |'repeated_inbound'|'echo'|'repeated_reply'|'machine_speed'|'too_many_sends'
 *   |'counterparty_rate'|'counterparty_automated'} ReasonCode
 *
 * @typedef {object} Reason
 * @property {ReasonCode} code Stable, safe to match on.
 * @property {Verdict} verdict What this reason alone would make of a reply.
 * @property {string} detail Plain English.
 *
 * @typedef {object} LatestFacts
 * @property {'in'|'out'} direction
 * @property {Kind | null} kind For an inbound message.
 * @property {import('./classify.js').Confidence | null} confidence
 * @property {import('./classify.js').Signal[]} signals
 *
 * @typedef {object} LedgerFacts
 * @property {string} counterparty
 * @property {number} sentLastDay Including the reply being checked.
 * @property {number} inboundInLookback
 * @property {number} automatedInLookback
 * @property {number} sameMessageBefore Earlier inbound messages with the same words.
 * @property {boolean} optedOut
 *
 * @typedef {object} Facts
 * @property {number} messages
 * @property {number} inbound
 * @property {number} outbound
 * @property {LatestFacts | null} latest The last message in the thread.
 * @property {number} automatedAnswered Times you already replied to an automated message
 *   in this thread.
 * @property {number} machineSpeedReplies Inbound replies that arrived faster than a
 *   person could type them.
 * @property {number} sentInWindow Messages you sent in the last windowMinutes, including
 *   the reply being checked.
 * @property {LedgerFacts | null} ledger
 *
 * @typedef {object} Result
 * @property {Verdict} verdict The worst verdict among the reasons; 'keep' with none.
 * @property {Reason[]} reasons Worst first.
 * @property {Facts} facts
 * @property {string[]} notes What the reader needs to know to trust the result, such as
 *   checks that could not run.
 *
 * @typedef {object} CheckOptions
 * @property {string} [reply] The message you are about to send.
 * @property {Date | number | (() => Date)} [now] The clock, for tests. Default now.
 * @property {number} [similarity] Two messages this alike or more count as the same.
 *   0 to 1. Default 0.85.
 * @property {number} [maxSends] Most messages you may send in this thread within
 *   windowMinutes. Default 5.
 * @property {number} [windowMinutes] Default 60.
 * @property {number} [wordsPerSecond] An inbound reply that arrives faster than this,
 *   counted from your last message, was not typed by a person. Default 3; a fast typist
 *   manages about 1.5.
 * @property {string} [counterparty] Who the thread is with, to match against history.
 * @property {LedgerEvent[]} [history] Ledger events, for checks across threads.
 * @property {number} [maxSendsPerDay] Most messages to the counterparty across all
 *   threads in 24 hours. Default 10. Needs history.
 * @property {number} [lookbackHours] How far back history counts. Default 168 (7 days).
 */

export const DEFAULTS = Object.freeze({
  similarity: 0.85,
  maxSends: 5,
  windowMinutes: 60,
  wordsPerSecond: 3,
  maxSendsPerDay: 10,
  lookbackHours: 168,
})

const VERDICT_ORDER = { keep: 0, review: 1, fail: 2 }

/** Fewer words than this and a reply could be "ok" typed in a second. */
const MIN_WORDS_FOR_SPEED = 15

/** Fewer words than this and two messages saying the same thing is normal. */
const MIN_WORDS_FOR_REPEAT = 5

export class LoopError extends Error {
  /**
   * @param {'invalid_option'|'invalid_thread'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'LoopError'
    this.code = code
  }
}

/**
 * Checks a thread before you reply to it, for the signs of a loop: the last message
 * came from a machine (an autoresponder, a bounce, a list, a no-reply address), the
 * other side is repeating itself or echoing you, it answers faster than a person could
 * type, you are about to repeat yourself, or you have sent too much. With ledger
 * history, it also looks across threads. Runs locally.
 *
 * @param {Message[]} messages Oldest first, or in any order if every one has `at`.
 * @param {CheckOptions} [options]
 * @returns {Result}
 */
export function checkThread(messages, options = {}) {
  const o = resolveOptions(options)
  if (!Array.isArray(messages)) throw new LoopError('invalid_thread', 'The thread must be a list of messages.')

  const items = messages.map((m, i) => {
    if (!m || typeof m !== 'object' || (m.direction !== 'in' && m.direction !== 'out')) {
      throw new LoopError('invalid_thread', `Message ${i + 1}: direction must be 'in' or 'out'.`)
    }
    const n = normalizeMessage(m)
    // A raw email carries its own time; a malformed Date header is ignored, not fatal.
    const headerDate = n.headers.date !== undefined ? Date.parse(n.headers.date) : Number.NaN
    const t =
      m.at === undefined && Number.isFinite(headerDate) ? headerDate : timeOf(m.at, `Message ${i + 1}: at`)
    return {
      index: i,
      message: m,
      direction: m.direction,
      t,
      text: n.text,
      words: wordsOf(n.text).length,
      written: stripQuoted(n.text),
      c: m.direction === 'in' ? classifyMessage(m) : null,
    }
  })

  /** @type {string[]} */
  const notes = []
  const timed = items.every((x) => x.t !== null)
  if (timed) {
    items.sort((a, b) => /** @type {number} */ (a.t) - /** @type {number} */ (b.t) || a.index - b.index)
  } else if (items.some((x) => x.t !== null)) {
    notes.push('Some messages have no time, so the thread was read in the order given and timing checks skipped them.')
  } else if (items.length > 0) {
    notes.push('No message has a time, so the thread was read in the order given and the timing checks did not run.')
  }

  /** @type {Reason[]} */
  const reasons = []
  const add = (/** @type {ReasonCode} */ code, /** @type {Verdict} */ verdict, /** @type {string} */ detail) =>
    reasons.push({ code, verdict, detail })

  const inbound = items.filter((x) => x.direction === 'in')
  const outbound = items.filter((x) => x.direction === 'out')
  const latest = items[items.length - 1] ?? null
  const latestIn = inbound[inbound.length - 1] ?? null
  const isAutomated = (/** @type {typeof items[number]} */ x) =>
    x.c !== null && x.c.kind !== 'person' && x.c.confidence !== 'possible'

  let automatedAnswered = 0
  for (let i = 1; i < items.length; i++) {
    if (items[i].direction === 'out' && items[i - 1].direction === 'in' && isAutomated(items[i - 1])) {
      automatedAnswered++
    }
  }
  const already = automatedAnswered
    ? ` You have already answered ${automatedAnswered} automated message${automatedAnswered === 1 ? '' : 's'} in this thread.`
    : ''

  // What you would be replying to.
  if (latest && latest.direction === 'in' && latest.c) {
    const { kind, confidence, signals } = latest.c
    const why = signals.filter((s) => s.kind === kind).map((s) => s.detail).slice(0, 3).join('; ')
    if (kind === 'bounce') {
      add(
        'bounce',
        'fail',
        `The last message is a delivery failure (${why}). Nobody read your message, and a ` +
          'reply goes to the mail system, not a person. Do not reply; mark the address as ' +
          'undeliverable and stop sending to it.',
      )
    } else if (kind === 'auto_reply' && confidence !== 'possible') {
      add(
        'auto_reply',
        'fail',
        `The last message is an automatic reply (${why}). Answering an autoresponder is how ` +
          'mail loops start: it answers again, and so do you. Do not reply. If it gives a ' +
          `return date, follow up after it.${already}`,
      )
    } else if (kind === 'auto_reply') {
      add(
        'possible_auto_reply',
        'review',
        `The last message reads like an automatic acknowledgement (${why}). If it is, a ` +
          'reply starts a loop; if a person wrote it, it needs an answer. A person should ' +
          `decide.${already}`,
      )
    } else if (kind === 'bulk') {
      add(
        'bulk',
        'fail',
        `The last message is bulk or list mail (${why}). Replies go to a list or a campaign ` +
          'tool, not to someone waiting for an answer. Do not reply.',
      )
    } else if (kind === 'no_reply') {
      add(
        'no_reply',
        'fail',
        `The last message came from an address that does not take replies (${why}). Do not ` +
          'reply; nobody will read it, and some of these answer with an automatic message.',
      )
    }
  }

  // An opt-out stands until the person writes again.
  const lastOptOut = inbound.findLastIndex((x) => x.c?.optOut)
  if (lastOptOut !== -1 && !inbound.slice(lastOptOut + 1).some((x) => x.c?.kind === 'person' && !x.c.optOut)) {
    add(
      'opt_out',
      'fail',
      `They asked you to stop: "${clip(inbound[lastOptOut].written)}". Do not send anything ` +
        'else to them on this thread, and record the opt-out wherever else you contact them.',
    )
  }

  // The other side repeating itself, or echoing you.
  if (latestIn && wordsOf(latestIn.written).length >= MIN_WORDS_FOR_REPEAT) {
    const before = inbound.filter((x) => x !== latestIn && order(x, items) < order(latestIn, items))
    const repeats = before.filter((x) => similarity(x.written, latestIn.written) >= o.similarity)
    if (repeats.length > 0) {
      add(
        'repeated_inbound',
        'fail',
        `The last message is the same as ${repeats.length === 1 ? 'an earlier one' : `${repeats.length} earlier ones`} ` +
          'from them, with at most a detail changed. People do not send the same message ' +
          'twice; machines answering each message do. Do not reply.',
      )
    }
    const sentBefore = outbound.filter((x) => order(x, items) < order(latestIn, items))
    const echoed = sentBefore.find((x) => similarity(x.written, latestIn.written) >= o.similarity)
    if (echoed) {
      add(
        'echo',
        'fail',
        'The last message repeats one of yours back to you. That is another bot or a ' +
          'misconfigured relay, not a person. Do not reply.',
      )
    }
  }

  // You repeating yourself.
  if (o.reply !== undefined && wordsOf(o.reply).length >= MIN_WORDS_FOR_REPEAT) {
    const same = outbound.filter((x) => similarity(x.written, o.reply ?? '') >= o.similarity)
    if (same.length > 0) {
      add(
        'repeated_reply',
        'fail',
        `Your reply is the same as ${same.length === 1 ? 'a message' : `${same.length} messages`} ` +
          'you already sent on this thread. Saying it again is the loop. Do not send it; ' +
          'if they have not answered, a person should decide what happens next.',
      )
    }
  }

  // Replies faster than typing.
  let machineSpeedReplies = 0
  for (let i = 1; i < items.length; i++) {
    const x = items[i]
    if (x.direction !== 'in' || x.t === null) continue
    const prevOut = items.slice(0, i).findLast((y) => y.direction === 'out')
    if (!prevOut || prevOut.t === null) continue
    const words = wordsOf(x.written).length
    const seconds = Math.max((x.t - prevOut.t) / 1000, 0.001)
    if (words >= MIN_WORDS_FOR_SPEED && words / seconds > o.wordsPerSecond) machineSpeedReplies++
  }
  if (machineSpeedReplies >= 2) {
    add(
      'machine_speed',
      'review',
      `${machineSpeedReplies} replies arrived faster than a person can type them, counting ` +
        `from your message before each (over ${o.wordsPerSecond} words a second). The other ` +
        'side is probably software. A person should look before this goes on.',
    )
  }

  // Volume.
  const now = nowOf(o.now)
  const windowStart = now - o.windowMinutes * 60_000
  const sentInWindow =
    outbound.filter((x) => x.t !== null && x.t >= windowStart && x.t <= now).length + (o.reply !== undefined ? 1 : 0)
  if (sentInWindow > o.maxSends) {
    add(
      'too_many_sends',
      'fail',
      `This would be message ${sentInWindow} you have sent on this thread in the last ` +
        `${duration(o.windowMinutes)}, over the limit of ${o.maxSends}. Conversations with ` +
        'people do not move that fast; loops do. Stop and let a person look.',
    )
  }

  const ledger = o.history ? checkHistory(o, latestIn, now, add, notes) : null
  if (o.history && !o.counterparty) {
    notes.push('History was given without a counterparty, so the checks across threads did not run.')
  }

  reasons.sort((a, b) => VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict])
  const verdict = reasons.reduce(
    (worst, r) => (VERDICT_ORDER[r.verdict] > VERDICT_ORDER[worst] ? r.verdict : worst),
    /** @type {Verdict} */ ('keep'),
  )

  if (items.length === 0) notes.push('The thread is empty.')
  else if (inbound.length === 0) notes.push('Nothing has come back on this thread yet.')
  if (latest && latest.direction === 'out' && o.reply !== undefined) {
    notes.push('The last message on the thread is yours, so this reply would be a follow-up, not an answer.')
  }

  return {
    verdict,
    reasons,
    facts: {
      messages: items.length,
      inbound: inbound.length,
      outbound: outbound.length,
      latest: latest
        ? {
            direction: latest.direction,
            kind: latest.c?.kind ?? null,
            confidence: latest.c?.confidence ?? null,
            signals: latest.c?.signals ?? [],
          }
        : null,
      automatedAnswered,
      machineSpeedReplies,
      sentInWindow,
      ledger,
    },
    notes,
  }
}

/**
 * @param {ReturnType<typeof resolveOptions>} o
 * @param {{ t: number | null, text: string } | null} latestIn
 * @param {number} now
 * @param {(code: ReasonCode, verdict: Verdict, detail: string) => void} add
 * @param {string[]} notes
 * @returns {LedgerFacts | null}
 */
function checkHistory(o, latestIn, now, add, notes) {
  if (!o.counterparty || !o.history) return null
  const who = o.counterparty.trim().toLowerCase()
  const mine = o.history.filter((e) => e.counterparty === who).map((e) => ({ ...e, t: Date.parse(e.ts) }))
  const since = now - o.lookbackHours * 3_600_000

  const sentLastDay =
    mine.filter((e) => e.direction === 'out' && e.t > now - 86_400_000 && e.t <= now).length +
    (o.reply !== undefined ? 1 : 0)
  if (sentLastDay > o.maxSendsPerDay) {
    add(
      'counterparty_rate',
      'fail',
      `This would be message ${sentLastDay} to ${who} in 24 hours, across all threads, over ` +
        `the limit of ${o.maxSendsPerDay}. Stop and let a person look.`,
    )
  }

  const inbound = mine.filter((e) => e.direction === 'in' && e.t > since && e.t <= now)
  const automated = inbound.filter((e) => e.kind && e.kind !== 'person')
  if (inbound.length >= 2 && automated.length === inbound.length) {
    add(
      'counterparty_automated',
      'fail',
      `All ${inbound.length} messages from ${who} in the last ${duration(o.lookbackHours * 60)} ` +
        'were automated. Nobody there is reading. Stop writing to them until a person does.',
    )
  }

  let sameMessageBefore = 0
  const fp = latestIn ? fingerprint(latestIn.text) : null
  if (fp && latestIn && latestIn.t !== null) {
    const latestT = latestIn.t
    sameMessageBefore = inbound.filter((e) => e.fp === fp && e.t < latestT - 1000).length
    if (sameMessageBefore > 0 && wordsOf(latestIn.text).length >= MIN_WORDS_FOR_REPEAT) {
      add(
        'repeated_inbound',
        'fail',
        `${who} has sent these exact words ${sameMessageBefore === 1 ? 'once' : `${sameMessageBefore} times`} ` +
          'before, on other threads. A message that arrives word for word every time is ' +
          'automated. Do not reply.',
      )
    }
  } else if (fp && latestIn) {
    notes.push('The last inbound message has no time, so it was not matched against history.')
  }

  // An opt-out anywhere, ever, stands until they write again as a person.
  const ordered = [...mine].sort((a, b) => a.t - b.t)
  const lastOptOut = ordered.findLastIndex((e) => e.optOut)
  const optedOut =
    lastOptOut !== -1 && !ordered.slice(lastOptOut + 1).some((e) => e.direction === 'in' && e.kind === 'person' && !e.optOut)
  if (optedOut) {
    add(
      'opt_out',
      'fail',
      `${who} asked not to be contacted on ${ordered[lastOptOut].ts.slice(0, 10)}` +
        `${ordered[lastOptOut].thread ? `, on thread ${ordered[lastOptOut].thread}` : ''}. ` +
        'That covers every thread and channel until they write to you again.',
    )
  }

  return {
    counterparty: who,
    sentLastDay,
    inboundInLookback: inbound.length,
    automatedInLookback: automated.length,
    sameMessageBefore,
    optedOut,
  }
}

/**
 * @param {CheckOptions} options
 */
function resolveOptions(options) {
  const o = { ...DEFAULTS, ...stripUndefined(options) }
  if (typeof o.similarity !== 'number' || !(o.similarity > 0 && o.similarity <= 1)) {
    throw new LoopError('invalid_option', `similarity must be above 0 and at most 1, got ${o.similarity}.`)
  }
  for (const key of /** @type {const} */ (['maxSends', 'maxSendsPerDay'])) {
    if (!Number.isInteger(o[key]) || o[key] < 1) {
      throw new LoopError('invalid_option', `${key} must be a whole number of 1 or more, got ${o[key]}.`)
    }
  }
  for (const key of /** @type {const} */ (['windowMinutes', 'wordsPerSecond', 'lookbackHours'])) {
    if (typeof o[key] !== 'number' || !(o[key] > 0)) {
      throw new LoopError('invalid_option', `${key} must be a number above 0, got ${o[key]}.`)
    }
  }
  if (o.reply !== undefined && typeof o.reply !== 'string') {
    throw new LoopError('invalid_option', 'reply must be a string.')
  }
  if (o.history !== undefined && !Array.isArray(o.history)) {
    throw new LoopError('invalid_option', 'history must be a list of ledger events.')
  }
  return o
}

/**
 * @template {object} T
 * @param {T} obj
 * @returns {Partial<T>}
 */
function stripUndefined(obj) {
  return /** @type {Partial<T>} */ (Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined)))
}

/**
 * @param {unknown} at
 * @param {string} label
 * @returns {number | null}
 */
function timeOf(at, label) {
  if (at === undefined || at === null || at === '') return null
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) throw new LoopError('invalid_thread', `${label} is not a valid time.`)
    return at.getTime()
  }
  if (typeof at === 'number') {
    if (!Number.isFinite(at)) throw new LoopError('invalid_thread', `${label} is not a valid time.`)
    return at
  }
  if (typeof at === 'string') {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
    const rfc = /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UT|UTC)/
    if ((iso.test(at.trim()) || rfc.test(at.trim())) && Number.isFinite(Date.parse(at))) return Date.parse(at)
  }
  throw new LoopError(
    'invalid_thread',
    `${label} must be ISO 8601 with an offset or Z (or an email Date header), got ${String(at)}.`,
  )
}

/**
 * @param {Date | number | (() => Date) | undefined} now
 * @returns {number}
 */
function nowOf(now) {
  if (typeof now === 'function') return now().getTime()
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number') return now
  return Date.now()
}

/**
 * @template {{ index: number }} T
 * @param {T} x
 * @param {T[]} items
 * @returns {number}
 */
function order(x, items) {
  return items.indexOf(x)
}

/**
 * @param {number} minutes
 * @returns {string}
 */
function duration(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}
