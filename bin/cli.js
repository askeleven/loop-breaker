#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { checkThread, classifyMessage, looksLikeEmail, LoopError, DEFAULTS } from '../src/index.js'
import { readLedger, recordMessage } from '../src/ledger.js'
import { formatText, formatClassification } from '../src/report.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'
import { starHint } from './star-hint.js'

const USAGE = `
loop-breaker <thread.json | message.eml | ->
loop-breaker record --ledger <file> --counterparty <id> --direction <in|out> [message]
loop-breaker mcp [--ledger <file>]

  Checks a thread before your agent replies, for the signs of a loop: the last
  message came from an autoresponder, a bounce, a list or a no-reply address;
  they opted out; they send the same message again or echo yours; your reply
  repeats one you sent; replies arrive faster than a person types; you have
  sent too many. Any channel. Runs locally, no network.

  A JSON file is a thread: a list of messages, or { "messages": [...],
  "reply": "...", "counterparty": "..." }. Each message has "direction"
  ("in" or "out"), and any of "at", "text", "from", "subject", "headers",
  "raw". A raw email, or plain text, is one inbound message: it is classified
  as from a person or a machine.

Options
  --reply <text|file>   The message you are about to send.
  --ledger <file>       JSONL ledger, for checks across threads. Needs
                        --counterparty to check; written by "record".
  --counterparty <id>   Who the thread is with: an address, number or id.
  --similarity <0-1>    Messages this alike count as the same. Default ${DEFAULTS.similarity}.
  --max-sends <n>       Most messages you send on a thread within --window.
                        Default ${DEFAULTS.maxSends}.
  --window <minutes>    Default ${DEFAULTS.windowMinutes}.
  --max-per-day <n>     Most messages to the counterparty in 24 hours, across
                        threads. Default ${DEFAULTS.maxSendsPerDay}. Needs --ledger.
  --now <time>          Check as of this time, ISO 8601. Default now.
  --json                Machine-readable output.
  --no-colour           Plain text.
  --version, --help

record
  --direction <in|out>  Which way the message went.
  --thread <id>         Your thread id, shown in reasons.
  --at <time>           When, ISO 8601. Default now.
  The message (text, a file, or "-") is optional. It is classified and
  fingerprinted; the text itself is never written to the ledger.

Exit codes
  0  OK to reply (a single message: from a person)
  1  do not reply as it stands: failed, or needs a person to review
     (a single message: automated)
  2  could not run

Examples
  npx @askeleven/loop-breaker thread.json --reply reply.txt
  npx @askeleven/loop-breaker bounce.eml
  npx @askeleven/loop-breaker thread.json --ledger loops.jsonl --counterparty dana@acme.com
  npx @askeleven/loop-breaker record --ledger loops.jsonl --counterparty dana@acme.com --direction in reply.eml
  npx @askeleven/loop-breaker mcp --ledger loops.jsonl
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const sub = argv[0] === 'mcp' || argv[0] === 'record' ? argv[0] : null
  let parsed
  try {
    parsed = parseArgs({
      args: sub ? argv.slice(1) : argv,
      allowPositionals: true,
      options: {
        reply: { type: 'string' },
        ledger: { type: 'string' },
        counterparty: { type: 'string' },
        similarity: { type: 'string' },
        'max-sends': { type: 'string' },
        window: { type: 'string' },
        'max-per-day': { type: 'string' },
        now: { type: 'string' },
        direction: { type: 'string' },
        thread: { type: 'string' },
        at: { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  if (sub === 'mcp') {
    await serve({ ledger: values.ledger })
    return 0
  }
  if (sub === 'record') return record(values, positionals)

  /** @type {Partial<import('../src/index.js').CheckOptions>} */
  const options = {}
  try {
    if (values.similarity !== undefined) options.similarity = number(values.similarity, '--similarity')
    if (values['max-sends'] !== undefined) options.maxSends = number(values['max-sends'], '--max-sends')
    if (values.window !== undefined) options.windowMinutes = number(values.window, '--window')
    if (values['max-per-day'] !== undefined) options.maxSendsPerDay = number(values['max-per-day'], '--max-per-day')
    if (values.now !== undefined) options.now = time(values.now, '--now')
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }

  let input
  try {
    input = await readInput(positionals)
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }
  const colour = useColour(values)

  /** @type {any} */
  let json = null
  if (/^\s*[[{]/.test(input)) {
    try {
      json = JSON.parse(input)
    } catch (error) {
      process.stderr.write(`Not valid JSON: ${/** @type {Error} */ (error).message}\n`)
      return 2
    }
  }

  // One message: classify it.
  if (!json || (!Array.isArray(json) && !Array.isArray(json.messages))) {
    const message = json && typeof json === 'object' ? json : looksLikeEmail(input) ? { direction: 'in', raw: input } : { direction: 'in', text: input }
    if (message.direction !== 'in' && message.direction !== 'out') message.direction = 'in'
    const c = classifyMessage(message)
    process.stdout.write(values.json ? `${JSON.stringify(c, null, 2)}\n` : formatClassification(c, { colour }))
    return c.kind === 'person' && !c.optOut ? 0 : 1
  }

  const messages = Array.isArray(json) ? json : json.messages
  try {
    if (values.reply !== undefined) options.reply = await textOrFile(values.reply)
    else if (typeof json.reply === 'string') options.reply = json.reply
    options.counterparty = values.counterparty ?? (typeof json.counterparty === 'string' ? json.counterparty : undefined)
    if (values.ledger) {
      const ledger = await readLedger(values.ledger)
      options.history = ledger.events
      if (!options.counterparty) process.stderr.write('--ledger needs --counterparty to check across threads.\n')
    }
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }

  let result
  try {
    result = checkThread(messages, options)
  } catch (error) {
    if (error instanceof LoopError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(
      formatText(result, {
        colour,
        maxSends: options.maxSends ?? DEFAULTS.maxSends,
        windowMinutes: options.windowMinutes ?? DEFAULTS.windowMinutes,
        maxSendsPerDay: options.maxSendsPerDay ?? DEFAULTS.maxSendsPerDay,
      }),
    )
  }
  return result.verdict === 'keep' ? 0 : 1
}

/**
 * @param {Record<string, any>} values
 * @param {string[]} positionals
 * @returns {Promise<number>}
 */
async function record(values, positionals) {
  if (!values.ledger || !values.counterparty || !values.direction) {
    process.stderr.write(`record needs --ledger, --counterparty and --direction.\n${USAGE}`)
    return 2
  }
  try {
    /** @type {import('../src/classify.js').Message | undefined} */
    let message
    if (positionals.length > 0 || !process.stdin.isTTY) {
      const text = await readInput(positionals)
      message = looksLikeEmail(text)
        ? { direction: values.direction, raw: text }
        : { direction: values.direction, text }
    }
    const event = await recordMessage(values.ledger, {
      counterparty: values.counterparty,
      direction: values.direction,
      thread: values.thread,
      at: values.at !== undefined ? time(values.at, '--at') : undefined,
      message,
    })
    process.stdout.write(values.json ? `${JSON.stringify(event)}\n` : `Recorded ${event.direction} ${event.counterparty}${event.kind ? ` (${event.kind})` : ''}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {number}
 */
function number(value, name) {
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n)) throw new Error(`${name} must be a number, got ${value}`)
  return n
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {number}
 */
function time(value, name) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
  const t = Date.parse(value)
  if (!iso.test(value.trim()) || !Number.isFinite(t)) {
    throw new Error(`${name} must be ISO 8601 with an offset or Z, such as 2026-10-16T14:30:00Z, got ${value}`)
  }
  return t
}

/**
 * A file's contents when the value names a file, the value itself otherwise.
 *
 * @param {string} value
 * @returns {Promise<string>}
 */
async function textOrFile(value) {
  if (existsSync(value) && statSync(value).isFile()) return dropTrailingNewlines(await readFile(value, 'utf8'))
  return value
}

/**
 * One positional that names a file is read from it; "-", or nothing with input piped
 * in, reads standard input; anything else is the message itself.
 *
 * @param {string[]} positionals
 * @returns {Promise<string>}
 */
async function readInput(positionals) {
  if (positionals.length === 0 || (positionals.length === 1 && positionals[0] === '-')) {
    if (process.stdin.isTTY) throw new Error(`Give a thread, a message, or pipe one in.\n${USAGE}`)
    return dropTrailingNewlines(await readStdin())
  }
  if (positionals.length === 1 && existsSync(positionals[0]) && statSync(positionals[0]).isFile()) {
    return dropTrailingNewlines(await readFile(positionals[0], 'utf8'))
  }
  return positionals.join(' ')
}

/**
 * @param {string} text
 * @returns {string}
 */
function dropTrailingNewlines(text) {
  return text.replace(/[\r\n]+$/, '')
}

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
    starHint('loop-breaker', code, process.argv.slice(2))
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
