/**
 * Smoke test: load the plugin and run `apply` against a stub host.
 *
 * It cannot prove behaviour that depends on the real app (host events, UI
 * ordering), but it DOES catch the class of bug that has bitten this plugin
 * twice: a handler that references a function removed in a later refactor, and
 * an apply-time crash. `node --check` sees neither.
 *
 *   node scripts/smoke.mjs
 */
import { apply, inject } from '../lib/index.js'

const listeners = new Map()
const tools = new Map()
const warnings = []
const routes = []

// Update checks would go to the network on every GET; fail them instantly.
globalThis.fetch = async () => { throw new Error('offline (smoke)') }

function fail(message) {
  console.error('FAIL:', message)
  process.exitCode = 1
}

const stubAgent = {
  id: 'session-stub',
  status: 'idle',
  session: {},
  followup() {},
  inject() {},
  cancel() {},
  whenIdle: async () => {},
}

const ctx = {
  logger: {
    warn: (...args) => warnings.push(args[0]),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
  },
  inject(deps, fn) {
    if (typeof fn === 'function') fn(ctx)
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') dispose()
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return { dispose() {}, ...route }
    },
  },
  agents: {
    list: () => [],
    get: () => undefined,
    create: async () => ({ agent: stubAgent }),
    resume: async () => ({ agent: stubAgent }),
  },
  llm: { stream: () => { throw new Error('no llm in smoke') } },
  agentDefaultModel: { currentSelection: () => undefined },
  agentPresets: { list: () => [] },
  sessionTitle: { rename: () => {} },
  sessionQuery: { observeSession: async () => undefined },
  sessionController: undefined,
  workspaceRegistry: { list: () => [{ path: 'D:/tmp/proj', title: 'proj' }] },
  workspaceController: undefined,
  reflect: { get: () => undefined },
  fiber: { state: 0 },
}

apply(ctx)

const expectedTools = [
  'groupchat_read',
  'groupchat_post',
  'groupchat_members',
  'groupchat_nick',
  'groupchat_requirement',
  'groupchat_dispatch',
]
for (const name of expectedTools) {
  if (!tools.has(name)) fail(`tool not registered: ${name}`)
}

const expectedEvents = ['agent/pre-step', 'tools/pre-execute', 'session/event', 'agent/status']
for (const name of expectedEvents) {
  if (!listeners.has(name)) fail(`listener not registered: ${name}`)
}

if (!Array.isArray(inject) || !inject.includes('llm')) fail('inject must declare llm')

const decision = { kind: 'enter', messages: [] }
const next = async () => decision

// 1. pre-step with no group: must delegate untouched.
{
  const handler = listeners.get('agent/pre-step')?.[0]
  if (handler === undefined) fail('agent/pre-step handler missing')
  else {
    const got = await handler({ agent: { id: 'not-a-supervisor' }, messages: [] }, next)
    if (got !== decision) fail('pre-step must delegate when the agent owns no group')
  }
}

// 2. tool gate with no group: must allow.
{
  const handler = listeners.get('tools/pre-execute')?.[0]
  if (handler === undefined) fail('tools/pre-execute handler missing')
  else {
    const got = await handler({ agent: { id: 'not-a-supervisor' }, name: 'bash', arguments: {} }, next)
    if (got !== decision) fail('tool gate must allow calls outside a supervised group')
  }
}

// 3. session/event with a plugin-injected message: must be ignored, not thrown.
{
  const handler = listeners.get('session/event')?.[0]
  if (handler === undefined) fail('session/event handler missing')
  else {
    handler({ id: 's1' }, { type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'groupchat' }, content: [{ type: 'text', text: 'x' }] } })
    handler({ id: 's1' }, { type: 'session/title', data: { title: 'x' } })
  }
}

// 4. requirement tool: list on an empty roster must not throw.
{
  const tool = tools.get('groupchat_requirement')
  if (tool === undefined) fail('groupchat_requirement missing')
  else {
    const result = await tool.execute({ action: 'list' }, { agent: { id: 's1' } })
    if (result === undefined) fail('groupchat_requirement returned nothing')
  }
}

if (warnings.some(text => String(text).includes('Cannot read properties'))) {
  fail(`unexpected runtime warning: ${warnings.find(t => String(t).includes('Cannot read properties'))}`)
}

// ---------------------------------------------------------------- route test

const route = routes[0]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeReq(method, url, body) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield JSON.stringify(body)
    },
  }
}

async function call(method, url, body) {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status) { state.status = status },
    end(text) { state.body = String(text ?? '') },
  }
  await route.handler(makeReq(method, url, body), res)
  let json = null
  try { json = JSON.parse(state.body) } catch { /* non-JSON */ }
  return { status: state.status, json }
}

const findGroup = payload => payload?.groups?.find(group => group.key === 'proj')

// 5. A real message creates a ticket. The LLM stub throws, so this also proves
//    the "judge unavailable" path falls back to 要转化 + 要认可 instead of
//    dropping the message.
{
  const posted = await call('POST', '/groupchat', { action: 'post', group: 'proj', text: '把登录改成短信验证码' })
  if (posted.json?.ok !== true) fail(`post rejected: ${JSON.stringify(posted.json)}`)
  await sleep(200)
  const group = findGroup((await call('GET', '/groupchat')).json)
  const ticket = group?.requirements?.[0]
  if (ticket === undefined) fail('no ticket created for a real message')
  else if (ticket.status !== 'new') fail(`expected 待转化, got ${ticket.status}`)
}

// 6. The plugin's own injections must never become requirements.
{
  const before = findGroup((await call('GET', '/groupchat')).json)?.requirements?.length ?? 0
  const handler = listeners.get('session/event')?.[0]
  handler?.({ id: 's1' }, {
    type: 'user/message',
    data: {
      id: 'injected-1',
      role: 'user',
      source: { kind: 'groupchat' },
      content: [{ type: 'text', text: '系统注入' }],
    },
  })
  await sleep(80)
  const after = findGroup((await call('GET', '/groupchat')).json)?.requirements?.length ?? 0
  if (after !== before) fail('a plugin-injected message created a ticket')
}

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('SMOKE OK')
  console.log('tools:', [...tools.keys()].join(', '))
  console.log('listeners:', [...listeners.keys()].join(', '))
}
