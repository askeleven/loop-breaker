import { createHash } from 'node:crypto'
import { stripQuoted } from './classify.js'

/**
 * Comparing messages the way a loop repeats them: the same words, with the ticket
 * number, date or name changed. Quoted text, links, numbers, case and punctuation are
 * ignored.
 */

/** Below this many words, two messages only match when they are the same. */
const SHORT = 5

/**
 * @param {string} text
 * @returns {string[]}
 */
export function wordsOf(text) {
  return stripQuoted(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, ' url ')
    .replace(/\S+@\S+\.\S+/g, ' email ')
    .replace(/\d+(?:[.,:/-]\d+)*/g, ' 0 ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * How alike two messages are, from 0 to 1: the share of three-word runs they have in
 * common, or of words for short messages. Messages under five words score 1 only when
 * they are the same.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const wa = wordsOf(a)
  const wb = wordsOf(b)
  if (wa.length === 0 || wb.length === 0) return 0
  if (wa.length < SHORT || wb.length < SHORT) return wa.join(' ') === wb.join(' ') ? 1 : 0
  const size = Math.min(wa.length, wb.length) >= 8 ? 3 : 1
  const sa = shingles(wa, size)
  const sb = shingles(wb, size)
  let shared = 0
  for (const s of sa) if (sb.has(s)) shared++
  return shared / (sa.size + sb.size - shared)
}

/**
 * A short hash of the message as compared, so a ledger can spot the same message again
 * without storing what it said.
 *
 * @param {string} text
 * @returns {string | null} Null when there are no words to compare.
 */
export function fingerprint(text) {
  const words = wordsOf(text)
  if (words.length === 0) return null
  return createHash('sha256').update(words.join(' ')).digest('hex').slice(0, 16)
}

/**
 * @param {string[]} words
 * @param {number} size
 * @returns {Set<string>}
 */
function shingles(words, size) {
  const out = new Set()
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '))
  return out
}
