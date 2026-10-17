import { appendFile, readFile } from 'node:fs/promises'
import { classifyMessage, normalizeMessage } from './classify.js'
import { fingerprint } from './similar.js'

/**
 * An append-only JSONL file with one line per message sent to or received from a
 * counterparty, on any thread. It lets a check see past the thread it was given: a
 * loop that opens a new thread every time, the same autoresponse arriving on five
 * threads, an opt-out sent on another channel.
 *
 * It never stores what a message said: only who, when, which way, what kind, and a
 * fingerprint of the words to spot the same message again.
 */

/**
 * @typedef {import('./classify.js').Message} Message
 * @typedef {import('./classify.js').Kind} Kind
 *
 * @typedef {object} LedgerEvent One line of the ledger.
 * @property {string} ts ISO 8601.
 * @property {string} counterparty Who the message was to or from: an address, a number,
 *   a user id. Compared case-insensitively.
 * @property {'in'|'out'} direction
 * @property {Kind} [kind] For inbound messages.
 * @property {boolean} [optOut] The counterparty asked not to be contacted.
 * @property {string} [fp] Fingerprint of the words.
 * @property {string} [thread] Your thread or conversation id.
 *
 * @typedef {object} RecordInput
 * @property {string} counterparty
 * @property {'in'|'out'} direction
 * @property {Message | string} [message] The message, to classify and fingerprint. Its
 *   text is not stored.
 * @property {string} [thread]
 * @property {string | number | Date} [at] Default now.
 *
 * @typedef {object} Ledger
 * @property {LedgerEvent[]} events In file order.
 * @property {number} malformed Lines that could not be read.
 * @property {boolean} missing The file does not exist yet.
 */

/**
 * Builds the ledger line for a message, without writing it.
 *
 * @param {RecordInput} input
 * @param {{ now?: number }} [options]
 * @returns {LedgerEvent}
 */
export function ledgerEvent(input, options = {}) {
  if (!input || typeof input.counterparty !== 'string' || !input.counterparty.trim()) {
    throw new TypeError('counterparty must be a non-empty string.')
  }
  if (input.direction !== 'in' && input.direction !== 'out') {
    throw new TypeError("direction must be 'in' or 'out'.")
  }
  const at = input.at ?? options.now ?? Date.now()
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(t)) throw new TypeError(`at is not a valid time: ${String(at)}.`)

  /** @type {LedgerEvent} */
  const event = {
    ts: new Date(t).toISOString(),
    counterparty: input.counterparty.trim().toLowerCase(),
    direction: input.direction,
  }
  if (input.thread !== undefined) event.thread = String(input.thread)
  if (input.message !== undefined) {
    const message =
      typeof input.message === 'string'
        ? { direction: input.direction, text: input.message }
        : { ...input.message, direction: input.direction }
    const fp = fingerprint(normalizeMessage(message).text)
    if (fp) event.fp = fp
    if (input.direction === 'in') {
      const c = classifyMessage(message)
      event.kind = c.kind
      if (c.optOut) event.optOut = true
    }
  }
  return event
}

/**
 * Appends one message to the ledger. Each call is a single append of one line, so
 * several processes can share a ledger.
 *
 * @param {string} path
 * @param {RecordInput} input
 * @param {{ now?: number }} [options] `now` is for tests.
 * @returns {Promise<LedgerEvent>} What was written.
 */
export async function recordMessage(path, input, options = {}) {
  const event = ledgerEvent(input, options)
  await appendFile(path, `${JSON.stringify(event)}\n`)
  return event
}

/**
 * @param {string} text
 * @returns {Omit<Ledger, 'missing'>}
 */
export function parseLedger(text) {
  /** @type {LedgerEvent[]} */
  const events = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (
        e && typeof e === 'object' &&
        typeof e.counterparty === 'string' &&
        (e.direction === 'in' || e.direction === 'out') &&
        typeof e.ts === 'string' && Number.isFinite(Date.parse(e.ts))
      ) {
        events.push({ ...e, counterparty: e.counterparty.toLowerCase() })
        continue
      }
    } catch {
      // Counted below.
    }
    malformed++
  }
  return { events, malformed }
}

/**
 * Reads the ledger. A file that does not exist yet is an empty ledger.
 *
 * @param {string} path
 * @returns {Promise<Ledger>}
 */
export async function readLedger(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { events: [], malformed: 0, missing: true }
    }
    throw error
  }
  return { ...parseLedger(text), missing: false }
}
