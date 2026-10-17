import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkThread,
  classifyMessage,
  isOptOut,
  stripQuoted,
  parseEmail,
  looksLikeEmail,
  similarity,
  fingerprint,
  recordMessage,
  readLedger,
  parseLedger,
  ledgerEvent,
  LoopError,
} from '../src/index.js'
import { formatText, formatClassification } from '../src/report.js'
import { serve } from '../src/mcp.js'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const NOW = new Date('2026-10-16T15:00:00Z')
const at = (/** @type {number} */ minute, second = 0) =>
  `2026-10-16T14:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`
const tmp = () => mkdtempSync(join(tmpdir(), 'loop-breaker-'))

/** @param {import('../src/index.js').Result} r */
const codes = (r) => r.reasons.map((x) => x.code)

const OOO_RAW = [
  'From: Dana Lee <Dana@Acme.com>',
  'To: sam@shop.example',
  'Subject: =?UTF-8?Q?Automatic_reply:_Your_quote?=',
  'Auto-Submitted: auto-replied',
  'X-Auto-Response-Suppress: All',
  'Date: Thu, 16 Oct 2026 14:01:05 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'I am out of the office until Monday 20 October with limited access to email.',
].join('\r\n')

const BOUNCE_RAW = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'Subject: Delivery Status Notification (Failure)',
  'X-Failed-Recipients: dana@acme.co',
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  "Address not found. Your message wasn=E2=80=99t delivered to dana@acme.co because th=",
  "e address couldn't be found.",
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Status: 5.1.1',
  '--b1--',
].join('\n')

const TICKET = 'Thank you for your message. Our team will get back to you within 24 hours. Your ticket number is 48213.'

// Email

test('parseEmail: folded headers, encoded subject, multipart and quoted-printable', () => {
  const ooo = parseEmail(OOO_RAW)
  assert.equal(ooo.from, 'dana@acme.com')
  assert.equal(ooo.subject, 'Automatic reply: Your quote')
  assert.equal(ooo.headers['auto-submitted'], 'auto-replied')
  assert.match(ooo.text, /^I am out of the office/)

  const bounce = parseEmail(BOUNCE_RAW)
  assert.match(bounce.headers['content-type'], /report-type=delivery-status; boundary="b1"/)
  assert.equal(bounce.text, "Address not found. Your message wasn’t delivered to dana@acme.co because the address couldn't be found.")

  const b64 = parseEmail('From: a@b.co\nContent-Transfer-Encoding: base64\n\nSGVsbG8gdGhlcmU=')
  assert.equal(b64.text, 'Hello there')
  const html = parseEmail('From: a@b.co\nContent-Type: text/html\n\n<p>Hi&nbsp;there</p><p>Bye</p>')
  assert.equal(html.text, 'Hi there\nBye')
})

test('looksLikeEmail: header lines first, not a message that mentions one', () => {
  assert.ok(looksLikeEmail(OOO_RAW))
  assert.ok(!looksLikeEmail('Subject: lunch\nAre you free?'))
  assert.ok(!looksLikeEmail('Hi Dana, here is the quote.'))
})

// Classifying

test('classify: headers and senders are certain', () => {
  const cases = /** @type {const} */ ([
    [{ 'Auto-Submitted': 'auto-replied' }, 'auto_reply'],
    [{ 'X-Autoreply': 'yes' }, 'auto_reply'],
    [{ Precedence: 'auto_reply' }, 'auto_reply'],
    [{ Precedence: 'bulk' }, 'bulk'],
    [{ 'List-Id': '<news.acme.com>' }, 'bulk'],
    [{ 'X-Failed-Recipients': 'a@b.co' }, 'bounce'],
    [{ 'Content-Type': 'multipart/report; report-type=disposition-notification; boundary=x' }, 'auto_reply'],
  ])
  for (const [headers, kind] of cases) {
    const c = classifyMessage({ direction: 'in', headers, text: 'Hello' })
    assert.equal(c.kind, kind, JSON.stringify(headers))
    assert.equal(c.confidence, 'certain')
    assert.equal(c.signals[0].source, 'header')
  }
  assert.equal(classifyMessage({ direction: 'in', headers: { 'Auto-Submitted': 'no' }, text: 'Hi' }).kind, 'person')
  assert.equal(classifyMessage({ direction: 'in', from: 'no-reply@accounts.example.com' }).kind, 'no_reply')
  assert.equal(classifyMessage({ direction: 'in', from: 'notifications+abc@github.com' }).kind, 'no_reply')
  assert.equal(classifyMessage({ direction: 'in', from: 'MAILER-DAEMON@mx.example.com' }).kind, 'bounce')
  assert.equal(classifyMessage({ direction: 'in', from: 'noreen@acme.com' }).kind, 'person', 'a name that starts like no-reply')
})

test('classify: a raw email uses its headers, and a bounce outranks an autoresponder', () => {
  const ooo = classifyMessage({ direction: 'in', raw: OOO_RAW })
  assert.equal(ooo.kind, 'auto_reply')
  assert.equal(ooo.confidence, 'certain')
  assert.ok(ooo.signals.some((s) => s.source === 'subject'))
  assert.ok(ooo.signals.some((s) => s.source === 'text'))

  const bounce = classifyMessage({ direction: 'in', raw: BOUNCE_RAW })
  assert.equal(bounce.kind, 'bounce')
  const both = classifyMessage({ direction: 'in', headers: { 'Auto-Submitted': 'auto-generated', 'X-Failed-Recipients': 'x@y.co' } })
  assert.equal(both.kind, 'bounce')
})

test('classify: wording, on any channel', () => {
  const likely = [
    "I'm currently out of the office until Monday and will respond when I return.",
    'I am on annual leave until 3 November with no access to email.',
    'This is an automated message. Please do not reply to this email.',
    "I'm driving with Driving Focus turned on. I'll see your message when I get where I'm going.",
    'This mailbox is not monitored.',
  ]
  for (const text of likely) {
    const c = classifyMessage({ direction: 'in', text })
    assert.equal(c.kind, 'auto_reply', text)
    assert.equal(c.confidence, 'likely', text)
  }
  const ticket = classifyMessage({ direction: 'in', text: TICKET })
  assert.equal(ticket.kind, 'auto_reply')
  assert.equal(ticket.confidence, 'possible')
  assert.equal(classifyMessage({ direction: 'in', text: 'Your booking is confirmed. Reply STOP to opt out. Msg&data rates may apply.' }).kind, 'bulk')
  assert.equal(classifyMessage({ direction: 'in', subject: 'Out of Office: quote', text: 'Back Monday.' }).kind, 'auto_reply')
})

test('classify: people mentioning these things are still people', () => {
  for (const text of [
    "Thanks Sam. Looks good, but can we start on the 10th? Also, I'm out of office next week.",
    "I'll be on vacation in June, so let's book before then.",
    'Did you get my automated report yesterday?',
    'We received your invoice, thanks. Paying Friday.',
    'Stop by the office tomorrow and we can sign.',
  ]) {
    const c = classifyMessage({ direction: 'in', text })
    assert.equal(c.kind, 'person', text)
    assert.equal(c.optOut, false, text)
  }
  const quoted = classifyMessage({
    direction: 'in',
    text: 'Yes, Thursday works.\n\nOn Tue, Oct 14, 2026 at 9:00 AM Sam <sam@shop.example> wrote:\n> This is an automated message. Please do not reply to this email.',
  })
  assert.equal(quoted.kind, 'person', 'wording in the quoted message does not count')
})

test('opt-outs: keywords alone, sentences that say it, not words in passing', () => {
  for (const t of ['STOP', 'stop.', 'Unsubscribe', 'Please stop texting me', 'Remove me from your list', "Don't contact me again"]) {
    assert.ok(isOptOut(t), t)
  }
  for (const t of ["Don't stop, this is great", 'Stop by at 3', 'I cancelled the order', 'The bus stop is near']) {
    assert.ok(!isOptOut(t), t)
  }
  assert.equal(classifyMessage({ direction: 'out', text: 'STOP' }).optOut, false, 'only theirs counts')
})

test('stripQuoted: replies, forwards and > lines', () => {
  assert.equal(stripQuoted('Sounds good.\n\nOn Mon, 13 Oct 2026, Sam wrote:\n> Hi'), 'Sounds good.')
  assert.equal(stripQuoted('See below\n\n-----Original Message-----\nFrom: x'), 'See below')
  assert.equal(stripQuoted('> quoted\nmine'), 'mine')
})

// Similarity

test('similarity: the same words with a detail changed match; different messages do not', () => {
  assert.ok(similarity(TICKET, TICKET.replace('48213', '99812')) === 1, 'numbers ignored')
  assert.ok(similarity(TICKET, 'Hi Sam, can we move the call to Thursday at 3? Something came up.') < 0.2)
  assert.equal(similarity('ok', 'ok'), 1)
  assert.equal(similarity('ok thanks', 'ok'), 0, 'short messages must be identical')
  assert.equal(similarity('', 'x'), 0)
  assert.equal(fingerprint(TICKET), fingerprint(TICKET.replace('48213', '1')))
  assert.equal(fingerprint('  '), null)
})

// Threads

test('thread: replying to an out-of-office fails, with the evidence', () => {
  const r = checkThread(
    [{ direction: 'out', at: at(0), text: 'Hi Dana, here is the quote.' }, { direction: 'in', raw: OOO_RAW }],
    { now: NOW, reply: 'Thanks Dana!' },
  )
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(codes(r), ['auto_reply'])
  assert.match(r.reasons[0].detail, /Auto-Submitted: auto-replied/)
  assert.equal(r.facts.latest?.kind, 'auto_reply')
  assert.equal(r.facts.messages, 2)
})

test('thread: a person replying is fine, even fast and short', () => {
  const r = checkThread(
    [
      { direction: 'out', at: at(0), text: 'Hi Dana, here is the quote for the redesign.' },
      { direction: 'in', at: at(0, 9), text: 'ok thanks!' },
      { direction: 'out', at: at(1), text: 'Great. Shall I book the 10th?' },
      { direction: 'in', at: at(5), text: "Thanks Sam. Looks good, but can we start on the 10th? Also, I'm out of office next week." },
    ],
    { now: NOW, reply: 'Sure, the 10th works. Enjoy the time off.' },
  )
  assert.equal(r.verdict, 'keep', JSON.stringify(r.reasons))
  assert.equal(r.facts.machineSpeedReplies, 0)
})

test('thread: two bots talking fail on repetition, and machine speed is flagged', () => {
  const r = checkThread(
    [
      { direction: 'out', at: at(40, 0), text: 'Hi, following up on my last note about pricing for your team.' },
      { direction: 'in', at: at(40, 2), text: TICKET },
      { direction: 'out', at: at(40, 5), text: 'Thanks for getting back to me! Happy to share pricing details whenever works.' },
      { direction: 'in', at: at(40, 7), text: TICKET.replace('48213', '48214') },
    ],
    { now: NOW, reply: 'Thanks for getting back to me! Happy to share pricing details whenever works.' },
  )
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(codes(r), ['repeated_inbound', 'repeated_reply', 'possible_auto_reply', 'machine_speed'])
  assert.equal(r.facts.machineSpeedReplies, 2)
})

test('thread: echo, bounce, list mail, no-reply sender', () => {
  const sent = 'Hi Dana, I wanted to check whether the proposal arrived and if you had any questions.'
  const echo = checkThread([{ direction: 'out', at: at(0), text: sent }, { direction: 'in', at: at(9), text: `Re: ${sent}` }], { now: NOW })
  assert.deepEqual(codes(echo), ['echo'])

  const bounce = checkThread([{ direction: 'out', text: 'Hi' }, { direction: 'in', raw: BOUNCE_RAW }], { now: NOW })
  assert.deepEqual(codes(bounce), ['bounce'])

  const list = checkThread([{ direction: 'in', headers: { 'List-Id': '<x.list>' }, text: 'Weekly digest' }], { now: NOW })
  assert.deepEqual(codes(list), ['bulk'])

  const noreply = checkThread([{ direction: 'in', from: 'noreply@shop.example', text: 'Your order shipped.' }], { now: NOW })
  assert.deepEqual(codes(noreply), ['no_reply'])
})

test('thread: an automated message earlier on is no reason not to reply to a person now', () => {
  const r = checkThread(
    [
      { direction: 'out', at: at(0), text: 'Hi Dana' },
      { direction: 'in', at: at(1), headers: { 'Auto-Submitted': 'auto-replied' }, text: 'Out until Monday.' },
      { direction: 'in', at: at(30), text: "Back now, sorry. What's the price?" },
    ],
    { now: NOW, reply: 'It is $4,800.' },
  )
  assert.equal(r.verdict, 'keep')
})

test('thread: replies to automated messages are counted in the detail', () => {
  const auto = { headers: { 'Auto-Submitted': 'auto-replied' }, text: 'Out until Monday.' }
  const r = checkThread(
    [
      { direction: 'out', at: at(0), text: 'Hi' },
      { direction: 'in', at: at(1), ...auto },
      { direction: 'out', at: at(2), text: 'Thanks!' },
      { direction: 'in', at: at(3), ...auto },
    ],
    { now: NOW },
  )
  assert.equal(r.facts.automatedAnswered, 1)
  assert.match(r.reasons[0].detail, /already answered 1 automated message/)
})

test('thread: opt-out stands until they write again', () => {
  const stop = checkThread(
    [{ direction: 'out', at: at(0), text: 'Your table is booked.' }, { direction: 'in', at: at(3), text: 'STOP' }],
    { now: NOW, reply: 'Sorry to see you go!' },
  )
  assert.deepEqual(codes(stop), ['opt_out'])
  const back = checkThread(
    [
      { direction: 'in', at: at(1), text: 'STOP' },
      { direction: 'in', at: at(20), text: 'Actually, can I rebook for Friday at 7?' },
    ],
    { now: NOW },
  )
  assert.equal(back.verdict, 'keep')
})

test('thread: too many sends in the window', () => {
  const messages = [0, 5, 10, 15, 20].map((m) => ({ direction: /** @type {const} */ ('out'), at: at(m), text: `Following up ${m}` }))
  assert.equal(checkThread(messages, { now: NOW }).verdict, 'keep', 'five sent, none being added')
  const r = checkThread(messages, { now: NOW, reply: 'One more thing.' })
  assert.deepEqual(codes(r), ['too_many_sends'])
  assert.equal(r.facts.sentInWindow, 6)
  assert.equal(checkThread(messages, { now: NOW, reply: 'x', maxSends: 6 }).verdict, 'keep')
  assert.match(r.notes.join(' '), /follow-up, not an answer/)
})

test('thread: order by time when every message has one, and say so when not', () => {
  const r = checkThread(
    [
      { direction: 'in', at: at(5), headers: { 'Auto-Submitted': 'auto-replied' }, text: 'Away' },
      { direction: 'out', at: at(1), text: 'Hi' },
    ],
    { now: NOW },
  )
  assert.equal(r.facts.latest?.direction, 'in', 'sorted, so the autoreply is last')
  assert.equal(r.verdict, 'fail')

  const untimed = checkThread([{ direction: 'out', text: 'Hi' }, { direction: 'in', text: 'Hello!' }], { now: NOW })
  assert.match(untimed.notes[0], /timing checks did not run/)
  assert.match(checkThread([], { now: NOW }).notes.join(' '), /empty/)
})

test('thread: bad input is an error, not a verdict', () => {
  assert.throws(() => checkThread(/** @type {any} */ ('x')), LoopError)
  assert.throws(() => checkThread([/** @type {any} */ ({ direction: 'sideways' })]), /direction/)
  assert.throws(() => checkThread([{ direction: 'in', at: 'yesterday' }]), /ISO 8601/)
  assert.throws(() => checkThread([], { similarity: 2 }), /similarity/)
  assert.throws(() => checkThread([], { maxSends: 0 }), /maxSends/)
  assert.doesNotThrow(() => checkThread([{ direction: 'in', at: 'Thu, 16 Oct 2026 14:01:05 +0000' }]))
})

// Ledger

test('ledger: records classify and fingerprint, never store the text', async () => {
  const path = join(tmp(), 'ledger.jsonl')
  const e = await recordMessage(path, { counterparty: ' Dana@Acme.com ', direction: 'in', message: { direction: 'in', raw: OOO_RAW }, thread: 't1' }, { now: NOW.getTime() })
  assert.deepEqual(Object.keys(e).sort(), ['counterparty', 'direction', 'fp', 'kind', 'thread', 'ts'])
  assert.equal(e.counterparty, 'dana@acme.com')
  assert.equal(e.kind, 'auto_reply')
  await recordMessage(path, { counterparty: 'dana@acme.com', direction: 'out' })
  const file = readFileSync(path, 'utf8')
  assert.ok(!/office/i.test(file), 'no message text in the file')
  const ledger = await readLedger(path)
  assert.equal(ledger.events.length, 2)
  assert.equal(ledger.missing, false)
  assert.deepEqual(await readLedger(join(tmp(), 'none.jsonl')), { events: [], malformed: 0, missing: true })
  assert.equal(parseLedger('{"x":1}\nnot json\n').malformed, 2)
  assert.throws(() => ledgerEvent({ counterparty: '', direction: 'in' }), /counterparty/)
  assert.equal(ledgerEvent({ counterparty: 'a', direction: 'in', message: 'STOP' }).optOut, true)
})

test('ledger: the same autoresponse on new threads, and nobody reading', () => {
  const history = [
    ledgerEvent({ counterparty: 'help@vendor.example', direction: 'out', at: '2026-10-15T10:00:00Z' }),
    ledgerEvent({ counterparty: 'help@vendor.example', direction: 'in', at: '2026-10-15T10:00:03Z', message: TICKET }),
    ledgerEvent({ counterparty: 'help@vendor.example', direction: 'out', at: '2026-10-16T09:00:00Z' }),
    ledgerEvent({ counterparty: 'help@vendor.example', direction: 'in', at: '2026-10-16T09:00:02Z', message: TICKET.replace('48213', '50001') }),
  ]
  const r = checkThread(
    [
      { direction: 'out', at: at(30), text: 'Hello, a new question about invoices.' },
      { direction: 'in', at: at(30, 3), text: TICKET.replace('48213', '50777') },
    ],
    { now: NOW, counterparty: 'Help@Vendor.example', history },
  )
  assert.ok(codes(r).includes('counterparty_automated'))
  assert.ok(codes(r).filter((c) => c === 'repeated_inbound').length === 1, 'across threads')
  assert.equal(r.facts.ledger?.sameMessageBefore, 2)
  assert.equal(r.facts.ledger?.automatedInLookback, 2)
})

test('ledger: opt-out on another thread, and the daily limit across threads', () => {
  const history = [
    ledgerEvent({ counterparty: '+13055550100', direction: 'in', at: '2026-10-01T12:00:00Z', message: 'STOP', thread: 'sms-1' }),
  ]
  const r = checkThread([{ direction: 'out', at: at(0), text: 'New offer!' }], { now: NOW, counterparty: '+13055550100', history, reply: 'Hi again' })
  assert.deepEqual(codes(r), ['opt_out'])
  assert.match(r.reasons[0].detail, /2026-10-01, on thread sms-1/)
  assert.equal(r.facts.ledger?.optedOut, true)

  const sends = Array.from({ length: 10 }, (_, i) =>
    ledgerEvent({ counterparty: 'dana@acme.com', direction: 'out', at: new Date(NOW.getTime() - (i + 1) * 3_600_000) }),
  )
  const busy = checkThread([], { now: NOW, counterparty: 'dana@acme.com', history: sends, reply: 'Hi' })
  assert.deepEqual(codes(busy), ['counterparty_rate'])
  assert.equal(busy.facts.ledger?.sentLastDay, 11)
  assert.match(checkThread([], { now: NOW, history: sends }).notes.join(' '), /without a counterparty/)
})

// Report

test('report: verdict, facts, sections; classification', () => {
  const r = checkThread([{ direction: 'out', at: at(0), text: 'Hi' }, { direction: 'in', raw: OOO_RAW }], { now: NOW })
  const text = formatText(r, { colour: false, maxSends: 5, windowMinutes: 60 })
  assert.match(text, /^\nFAIL {2}Do not reply\n/)
  assert.match(text, /Last message Automatic reply \(certain\)/)
  assert.match(text, /Auto-Submitted: auto-replied/)
  assert.match(text, /Sent {9}1 in the last 60 minutes \(limit 5\)/)
  assert.match(text, /\nFAIL\n {2}Automatic reply\n/)
  assert.ok(!text.includes('\x1b['))

  const c = formatClassification(classifyMessage({ direction: 'in', raw: BOUNCE_RAW }), { colour: false })
  assert.match(c, /^\nAUTOMATED {2}Delivery failure, certain\n/)
  assert.match(formatClassification(classifyMessage({ direction: 'in', text: 'STOP' }), { colour: false }), /PERSON[\s\S]*Opt-out/)
})

// MCP

/**
 * @param {object[]} messages
 * @param {Parameters<typeof serve>[0]} [options]
 * @returns {Promise<any[]>}
 */
async function mcpSession(messages, options = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  /** @type {string[]} */
  const chunks = []
  output.on('data', (c) => chunks.push(String(c)))
  const done = serve({ input, output, checkOptions: { now: NOW }, ...options })
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`)
  input.end()
  await done
  return chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

test('mcp: without a ledger, two tools', async () => {
  const replies = await mcpSession([
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_thread', arguments: { messages: [{ direction: 'out', text: 'Hi' }, { direction: 'in', raw: OOO_RAW }], reply: 'Thanks' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'classify_message', arguments: { message: { direction: 'in', text: 'Sounds good, see you then.' } } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'record_message', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'check_thread', arguments: { messages: [{ direction: 'up' }] } } },
    { jsonrpc: '2.0', id: 7, method: 'nope' },
  ])
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))
  assert.equal(replies.length, 7)
  assert.equal(byId[1].result.serverInfo.name, 'loop-breaker')
  assert.match(byId[1].result.instructions, /Never send when the verdict is fail/)
  assert.doesNotMatch(byId[1].result.instructions, /record_message/)
  assert.deepEqual(byId[2].result.tools.map((/** @type {{name: string}} */ t) => t.name), ['check_thread', 'classify_message'])
  assert.equal(byId[3].result.structuredContent.verdict, 'fail')
  assert.equal(byId[3].result.structuredContent.passed, false)
  assert.equal(byId[4].result.structuredContent.kind, 'person')
  assert.equal(byId[5].error.code, -32602, 'record_message needs a ledger')
  assert.equal(byId[6].result.isError, true)
  assert.equal(byId[7].error.code, -32601)
})

test('mcp: with a ledger, records in order and checks across threads', async () => {
  const ledger = join(tmp(), 'ledger.jsonl')
  const record = (/** @type {number} */ id, /** @type {object} */ message) => ({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'record_message', arguments: { counterparty: '+13055550100', message } },
  })
  const replies = await mcpSession(
    [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      record(3, { direction: 'out', at: '2026-10-16T13:00:00Z', text: 'Your table is booked.' }),
      record(4, { direction: 'in', at: '2026-10-16T13:05:00Z', text: 'STOP' }),
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_thread', arguments: { counterparty: '+13055550100', messages: [{ direction: 'out', at: '2026-10-16T14:00:00Z', text: 'Hi' }], reply: 'Special offer!' } } },
    ],
    { ledger },
  )
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))
  assert.match(byId[1].result.instructions, /record_message/)
  assert.deepEqual(byId[2].result.tools.map((/** @type {{name: string}} */ t) => t.name), ['check_thread', 'classify_message', 'record_message'])
  assert.equal(byId[4].result.structuredContent.recorded.optOut, true)
  const check = byId[5].result.structuredContent
  assert.equal(check.verdict, 'fail')
  assert.deepEqual(check.reasons.map((/** @type {{code: string}} */ r) => r.code), ['opt_out'])
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 2)
})

// CLI

/**
 * @param {string[]} args
 * @param {string} [stdin]
 */
function cli(args, stdin) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

test('cli: threads, single messages, exit codes', () => {
  const dir = tmp()
  const thread = join(dir, 'thread.json')
  writeFileSync(thread, JSON.stringify({ messages: [{ direction: 'out', at: at(0), text: 'Hi' }, { direction: 'in', at: at(9), text: 'Sounds good, see you Thursday.' }] }))
  const keep = cli([thread, '--reply', 'Great, see you then.', '--now', NOW.toISOString()])
  assert.equal(keep.status, 0, keep.stderr)
  assert.match(keep.stdout, /^\nPASS {2}OK to reply/)

  const ooo = cli(['-'], OOO_RAW)
  assert.equal(ooo.status, 1)
  assert.match(ooo.stdout, /AUTOMATED {2}Automatic reply, certain/)
  assert.equal(cli(['Sounds good, see you then.']).status, 0)

  const json = JSON.parse(cli([thread, '--json', '--now', NOW.toISOString()]).stdout)
  assert.equal(json.verdict, 'keep')

  assert.equal(cli([thread, '--similarity', 'high']).status, 2)
  assert.equal(cli([thread, '--now', 'tomorrow']).status, 2)
  assert.equal(cli(['{not json']).status, 2)
  assert.equal(cli(['x', '--bogus']).status, 2)
  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+\n$/)
})

test('cli: record, then check with the ledger', () => {
  const dir = tmp()
  const ledger = join(dir, 'l.jsonl')
  const rec = cli(['record', '--ledger', ledger, '--counterparty', 'dana@acme.com', '--direction', 'in', '--at', '2026-10-16T12:00:00Z', 'Please stop emailing me'])
  assert.equal(rec.status, 0, rec.stderr)
  assert.match(rec.stdout, /Recorded in dana@acme.com \(person\)/)
  assert.equal(cli(['record', '--ledger', ledger]).status, 2)

  const thread = join(dir, 't.json')
  writeFileSync(thread, JSON.stringify([{ direction: 'out', at: at(0), text: 'New thread, new offer.' }]))
  const check = cli([thread, '--ledger', ledger, '--counterparty', 'dana@acme.com', '--reply', 'Hi Dana', '--now', NOW.toISOString()])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /They asked you to stop/)
  assert.match(check.stdout, /Ledger {7}dana@acme.com: 1 sent in 24 hours \(limit 10\), 0 of 1 replies automated, opted out/)
})
