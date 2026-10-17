import { createInterface } from 'node:readline'
import { checkThread, classifyMessage, LoopError, DEFAULTS } from './index.js'
import { readLedger, recordMessage } from './ledger.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Messages in one thread, and characters in one message. */
const MAX_MESSAGES = 500
const MAX_TEXT = 200_000

const INSTRUCTIONS =
  'Call check_thread before every reply you send on a thread, with the whole thread and ' +
  'your reply. Never send when the verdict is fail: an autoresponder, bounce, list or ' +
  'no-reply sender is not a person, and answering it is how loops start. If they opted ' +
  'out, stop on every thread. If the verdict is review, show the reasons to a person and ' +
  'let them decide; do not decide for them. Do not rephrase a reply to get past ' +
  'repeated_reply: the loop is the problem, not the wording.'

const LEDGER_INSTRUCTIONS =
  ' This server keeps a ledger: call record_message for every message you send and ' +
  'every message you receive, with the same counterparty you pass to check_thread, so ' +
  'loops across threads are caught.'

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['in', 'out'], description: "'in' from them, 'out' from you." },
    at: { type: 'string', description: 'When, ISO 8601 with an offset or Z.' },
    text: { type: 'string', maxLength: MAX_TEXT, description: 'The body as plain text.' },
    from: { type: 'string', description: 'Sender address or number.' },
    subject: { type: 'string' },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Email headers, if you have them. Auto-Submitted, Precedence and List-Id matter most.',
    },
    raw: { type: 'string', maxLength: MAX_TEXT, description: 'The raw email (RFC 5322), instead of the fields above.' },
  },
  required: ['direction'],
  additionalProperties: false,
}

/**
 * @param {boolean} withLedger
 */
function tools(withLedger) {
  /** @type {Array<{ name: string } & Record<string, unknown>>} */
  const list = [
    {
      name: 'check_thread',
      title: 'Check a thread before replying',
      description:
        'Checks a conversation before you reply, for the signs of a loop. Returns verdict ' +
        '(keep, review or fail), reasons with a stable code and a plain-English detail, ' +
        'and facts. Fails when the last message is an automatic reply, a bounce, list mail ' +
        'or from a no-reply address; when they opted out; when they send the same message ' +
        'again or echo yours; when your reply repeats one you sent; or when you have sent ' +
        `too many (default ${DEFAULTS.maxSends} in ${DEFAULTS.windowMinutes} minutes). ` +
        'Flags replies that arrive faster than a person types for review. Any channel: ' +
        'email headers are used when given.' +
        (withLedger ? ' With counterparty, also checks the ledger across threads.' : ''),
      inputSchema: {
        type: 'object',
        properties: {
          messages: { type: 'array', maxItems: MAX_MESSAGES, items: MESSAGE_SCHEMA, description: 'The thread, oldest first.' },
          reply: { type: 'string', maxLength: MAX_TEXT, description: 'The message you are about to send.' },
          ...(withLedger
            ? { counterparty: { type: 'string', description: 'Who the thread is with: an address, number or id.' } }
            : {}),
        },
        required: ['messages'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'classify_message',
      title: 'Is this message from a person?',
      description:
        'Says whether one message came from a person, an autoresponder, a bounce, bulk or ' +
        'list mail, or a no-reply address, how sure that is (certain from headers and ' +
        'senders, likely or possible from wording), the evidence, and whether it is an opt-out.',
      inputSchema: {
        type: 'object',
        properties: { message: MESSAGE_SCHEMA },
        required: ['message'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ]
  if (withLedger) {
    list.push({
      name: 'record_message',
      title: 'Record a message in the ledger',
      description:
        'Adds one sent or received message to the ledger, so later checks see it across ' +
        'threads. Stores who, when, which way, what kind of message, and a fingerprint of ' +
        'the words; never the text itself.',
      inputSchema: {
        type: 'object',
        properties: {
          counterparty: { type: 'string', description: 'Who it was to or from.' },
          message: MESSAGE_SCHEMA,
          thread: { type: 'string', description: 'Your thread or conversation id.' },
        },
        required: ['counterparty', 'message'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    })
  }
  return list
}

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 * @property {string} [ledger] Path to the ledger file.
 * @property {Partial<import('./index.js').CheckOptions>} [checkOptions] Overrides, such as
 *   a fixed clock for tests.
 */

/**
 * Serves until the input stream closes. Requests are handled one at a time, in order,
 * so a record_message is on disk before the check that follows it.
 *
 * @param {ServeOptions} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  let queue = Promise.resolve()
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    queue = queue.then(() => handleLine(line, send, options))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      queue.then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @param {ServeOptions} options
 * @returns {Promise<void>}
 */
async function handleLine(line, send, options) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.

  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {}, options)
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} method
 * @param {any} params
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function dispatch(method, params, options) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'loop-breaker', title: 'loop-breaker', version: VERSION },
        instructions: INSTRUCTIONS + (options.ledger ? LEDGER_INSTRUCTIONS : ''),
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: tools(Boolean(options.ledger)) }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {}, options)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message and can act on it.
 *
 * @param {string} name
 * @param {any} args
 * @param {ServeOptions} options
 * @returns {Promise<object>}
 */
async function callTool(name, args, options) {
  const known = tools(Boolean(options.ledger)).map((t) => t.name)
  if (!known.includes(name)) throw new RpcError(-32602, `Unknown tool: ${name}`)
  try {
    let payload
    if (name === 'check_thread') payload = await checkTool(args, options)
    else if (name === 'classify_message') payload = classifyMessage(messageArg(args.message, 'message'))
    else payload = await recordTool(args, options)
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    }
  } catch (error) {
    if (error instanceof LoopError || error instanceof ToolInputError || error instanceof TypeError) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    throw error
  }
}

class ToolInputError extends Error {}

/**
 * @param {any} m
 * @param {string} label
 * @returns {import('./classify.js').Message}
 */
function messageArg(m, label) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new ToolInputError(`${label} must be an object.`)
  if (m.direction !== 'in' && m.direction !== 'out') throw new ToolInputError(`${label}.direction must be 'in' or 'out'.`)
  for (const key of ['at', 'text', 'from', 'subject', 'raw']) {
    if (m[key] !== undefined && typeof m[key] !== 'string') throw new ToolInputError(`${label}.${key} must be a string.`)
    if (typeof m[key] === 'string' && m[key].length > MAX_TEXT) throw new ToolInputError(`${label}.${key} is too long.`)
  }
  if (m.headers !== undefined && (typeof m.headers !== 'object' || m.headers === null || Array.isArray(m.headers))) {
    throw new ToolInputError(`${label}.headers must be an object of strings.`)
  }
  return m
}

/**
 * @param {any} args
 * @param {ServeOptions} options
 */
async function checkTool(args, options) {
  if (!Array.isArray(args.messages)) throw new ToolInputError('messages must be a list.')
  if (args.messages.length > MAX_MESSAGES) throw new ToolInputError(`At most ${MAX_MESSAGES} messages.`)
  const messages = args.messages.map((/** @type {any} */ m, /** @type {number} */ i) => messageArg(m, `messages[${i}]`))
  if (args.reply !== undefined && typeof args.reply !== 'string') throw new ToolInputError('reply must be a string.')
  if (args.counterparty !== undefined && typeof args.counterparty !== 'string') {
    throw new ToolInputError('counterparty must be a string.')
  }
  const history = options.ledger && args.counterparty ? (await readLedger(options.ledger)).events : undefined
  const result = checkThread(messages, {
    ...options.checkOptions,
    reply: args.reply,
    counterparty: args.counterparty,
    history,
  })
  return { passed: result.verdict === 'keep', ...result }
}

/**
 * @param {any} args
 * @param {ServeOptions} options
 */
async function recordTool(args, options) {
  const message = messageArg(args.message, 'message')
  if (typeof args.counterparty !== 'string') throw new ToolInputError('counterparty must be a string.')
  if (args.thread !== undefined && typeof args.thread !== 'string') throw new ToolInputError('thread must be a string.')
  const now = options.checkOptions?.now
  const event = await recordMessage(
    /** @type {string} */ (options.ledger),
    { counterparty: args.counterparty, direction: message.direction, message, thread: args.thread, at: message.at },
    { now: typeof now === 'function' ? now().getTime() : now instanceof Date ? now.getTime() : now },
  )
  return { recorded: event }
}
