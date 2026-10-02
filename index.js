/**
 * dsh-groupchat — host half.
 *
 * One group per project (cwd basename). Membership = "the session's agent loop
 * is RUNNING right now" and nothing else: `agent/status` transitions move
 * sessions in and out, so a stopped session simply leaves the group.
 *
 * Message flow: any message (human via the web tab, agent via groupchat_post)
 *   is injected into every CURRENTLY ONLINE member's next step boundary via
 *   agent.inject() (queued, no wake) — as a truncated preview plus a hint, so
 *   two members chatting never flood a third member's context; the full text
 *   stays behind groupchat_read. A member whose nick the message @s gets the
 *   addressed variant ("… @你:", "群聊有人@你"). Offline sessions are not
 *   members and receive nothing.
 *
 * The human's @ (posting as「用户」from the web tab) both wakes and creates:
 *   it delivers the message to an offline-but-known session via
 *   agent.followup() (next-turn + wake); that session comes online,
 *   auto-joins its project group, and sees the message in its very first
 *   turn. The reserved mention `@创建成员` (picked from the @-popup, rest of
 *   the message is normal prose) creates ONE new member session in the
 *   group's project directory — unnamed, told to name itself via
 *   groupchat_nick. An AGENT's @ is a plain mention — online members get the
 *   addressed marker, offline ones stay asleep (wakes and creations cost
 *   tokens, and agents doing either invites @ storms). Mentions only resolve
 *   within the same project — groups stay project-isolated.
 *
 * Everything lives in process memory: groups, messages (capped), and the
 * known-sessions table (mention candidates, including offline ones) all
 * vanish when DSH restarts.
 */

/** Route pathname owned by this plugin (exact match). */
export const ROUTE_PATH = '/groupchat'

/** Per-group retained message count. */
const MESSAGE_CAP = 200
/** Hard cap on one message's text length. */
const TEXT_CAP = 4000
/** Preview cap injected into member conversations; full text stays behind groupchat_read. */
const SNIPPET_CAP = 10

/**
 * Live activation bookkeeping, one entry per process — the module instance
 * outlives every enable/disable cycle, so this is where the previous
 * activation leaves its mark. `webServer.register` stores routes in a
 * service-level Map, NOT in the calling fiber, and hands back a disposer; drop
 * that disposer (as an early version did) and disabling the plugin tears down
 * its tools and listeners while /groupchat stays in the table forever, so the
 * next enable dies on "duplicate exact route". Holding both the disposer and
 * the owning fiber lets the next activation tell those two cases apart.
 */
let live = null

/** Cordis fiber state for a disposed fiber (const enum mirrored — no runtime object). */
const FIBER_DISPOSED = 4

export const inject = ['webServer', 'tools', 'agents', 'workspaceRegistry', 'sessionTitle', 'sessionQuery', 'agentDefaultModel', 'agentPresets']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host root context.
 */
export function apply(ctx) {
  // Re-activation in the same process: either a previous fiber is still alive
  // (enable pressed twice — keep the live one, activating again would
  // duplicate its tools, listeners and route), or it was disposed and only its
  // route lingers in the webserver table (reclaim it before registering).
  if (live !== null) {
    if (live.fiber !== undefined && live.fiber.state !== FIBER_DISPOSED) {
      ctx.logger.warn('groupchat: already active in this process; duplicate activation ignored')
      return
    }
    try {
      live.disposeRoute?.()
    } catch (error) {
      ctx.logger.warn('groupchat: stale /groupchat route cleanup failed', error)
    }
    live = null
  }
  /**
   * projectKey → Group.
   * Group = { key, name, cwd, dormant, messages: Message[], members: Map<sessionId, Member> }
   * Message = { id, at, kind: 'human'|'agent'|'system', name, text, mentions: string[] }
   * Member  = { nick, agent, joinedAt }
   */
  const groups = new Map()
  /** sessionId → { nick, projectKey, lastSeenAt } — @ candidates, kept after going offline. Archived sessions may live here too (their workspace slots survive archiving); every read path filters them through {@link archivedSet} — do not add a second filter elsewhere. */
  const knownSessions = new Map()

  // ---------------------------------------------------------------- helpers

  /** Default display name for a session we have never nicknamed. */
  function defaultNick(sessionId) {
    return `会话-${String(sessionId).slice(0, 6)}`
  }

  /**
   * The session's own title (what the workspace sidebar shows), so group
   * member names always match the session list. Null when unavailable.
   */
  function sessionTitleOf(agent) {
    try {
      const title = ctx.sessionTitle?.get?.(agent.session)?.title
      if (typeof title !== 'string') return null
      const trimmed = title.trim()
      return trimmed === '' ? null : trimmed
    } catch {
      return null
    }
  }

  /** Basename of a path (trailing separators trimmed); '' when unusable. */
  function baseNameOf(path) {
    if (typeof path !== 'string' || path === '') return ''
    const trimmed = path.replace(/[\\/]+$/, '')
    return trimmed.split(/[\\/]/).pop() ?? ''
  }

  /** Case-insensitive path equality with forward slashes, no trailing separator. */
  function samePath(a, b) {
    const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return norm(a) === norm(b)
  }

  /**
   * The registry-global archive set as a live Set. Archived sessions keep
   * their workspace accounting slots (so the seed pass still picks them up)
   * and their wakes are blocked at agent/pre-step — they must never resurface
   * as @ candidates either. Read lazily on every lookup, never cached: the
   * sidebar can archive/unarchive while DSH keeps running, and a cached copy
   * would go stale exactly then.
   */
  function archivedSet() {
    try {
      return new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  /**
   * Project identity from the session's working directory: lowercased basename
   * as key (Windows cwd spellings must not split one project into two groups),
   * the original basename as default display name, and the raw cwd. Null when
   * unknown.
   */
  function projectKeyOf(agent) {
    const cwd = agent.session?.header?.cwd ?? agent.session?.meta?.cwd
    if (typeof cwd !== 'string' || cwd === '') return null
    const base = baseNameOf(cwd)
    if (base === '') return null
    return { key: base.toLowerCase(), base, cwd }
  }

  /** Get-or-create one group; `name`/`cwd` only apply at creation time. */
  function ensureGroupNamed(key, name, cwd) {
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, name: name || key, cwd: cwd || '', dormant: true, messages: [], members: new Map() }
      groups.set(key, group)
    }
    return group
  }

  /** Append a grey system line to one group (joins/leaves/renames). */
  function sys(group, text) {
    group.messages.push({
      id: crypto.randomUUID(), at: Date.now(), kind: 'system', name: '', text, mentions: [],
    })
    if (group.messages.length > MESSAGE_CAP) {
      group.messages.splice(0, group.messages.length - MESSAGE_CAP)
    }
  }

  /** Parse `@nick` mentions out of message text (first match per nick). */
  function parseMentions(text) {
    const found = []
    for (const match of String(text).matchAll(/@([^\s@，,。；;：:]{1,32})/g)) {
      if (!found.includes(match[1])) found.push(match[1])
    }
    return found
  }

  /** Resolve a nick to a known session of one project (for @ wake-up). */
  function findKnownByNick(projectKey, nick) {
    const archived = archivedSet()
    for (const [sessionId, known] of knownSessions) {
      if (archived.has(sessionId)) continue // archived sessions cannot be woken
      if (known.projectKey === projectKey && known.nick === nick) {
        return { sessionId, ...known }
      }
    }
    return null
  }

  /**
   * Build the UserMessage that lands in a member's conversation. Only a
   * truncated preview travels — two members chatting must not flood a third
   * member's context; the full text stays behind groupchat_read.
   */
  function buildUserMessage(group, msg, { addressed = false } = {}) {
    const snippet = msg.text.length > SNIPPET_CAP ? `${msg.text.slice(0, SNIPPET_CAP)}…` : msg.text
    const head = `[群聊 · ${group.name}] ${msg.fromName}${addressed ? ' @你' : ''}: `
    const hint = addressed
      ? '\n（群聊有人@你。要回应就调 groupchat_post；要看群里的完整上下文调 groupchat_read。）'
      : '\n（群聊有新消息。想看完整内容调 groupchat_read；与当前任务无关可忽略。）'
    return {
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: msg.fromName, at: msg.at },
      content: [{ type: 'text', text: head + snippet + hint }],
    }
  }

  // ------------------------------------------------------- membership (online)

  function handleStatus(agent, status) {
    const sessionId = agent.id
    if (status === 'running') {
      const proj = projectKeyOf(agent)
      if (proj === null) return
      const group = ensureGroupNamed(proj.key, proj.base, proj.cwd)
      const existing = group.members.get(sessionId)
      if (existing !== undefined) {
        existing.agent = agent // same session, fresh driver instance
        return
      }
      const known = knownSessions.get(sessionId)
      const nick = known?.nick ?? sessionTitleOf(agent) ?? defaultNick(sessionId)
      group.members.set(sessionId, { nick, agent, joinedAt: Date.now() })
      knownSessions.set(sessionId, { nick, projectKey: proj.key, lastSeenAt: Date.now() })
      group.dormant = false
      sys(group, `${nick} 上线了`)
      return
    }
    // Any non-running transition removes the session from every group.
    for (const group of groups.values()) {
      if (group.members.delete(sessionId)) {
        const nick = knownSessions.get(sessionId)?.nick ?? defaultNick(sessionId)
        sys(group, `${nick} 下线了`)
        if (group.members.size === 0) group.dormant = true
      }
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      handleStatus(agent, status)
    } catch (error) {
      ctx.logger.warn('groupchat: status handler failed', error)
    }
  })
  // Sweep sessions already running before this plugin loaded.
  for (const agent of ctx.agents.list()) {
    if (agent.status === 'running') {
      try {
        handleStatus(agent, 'running')
      } catch (error) {
        ctx.logger.warn('groupchat: initial sweep failed for one agent', error)
      }
    }
  }

  // Pre-create one group per known DSH workspace, so the tab shows every
  // workspace's group before any session runs. Key = lowercased basename of
  // the workspace path (sessions join via their cwd basename with the same
  // normalization); display name = the workspace's title when it has one.
  // Lazy `ctx.workspaceRegistry` access: if the service is absent the plugin
  // still loads — groups then simply appear on first join instead.
  try {
    for (const ws of ctx.workspaceRegistry?.list?.() ?? []) {
      const base = baseNameOf(ws.path)
      if (base !== '') ensureGroupNamed(base.toLowerCase(), ws.title || base, ws.path)
    }
  } catch (error) {
    ctx.logger.warn('groupchat: workspace group pre-create failed', error)
  }

  /**
   * Warm the @-candidate table from PERSISTED sessions, so @ works right
   * after a DSH restart before any session runs again. Titles are folded the
   * same way the workspace sidebar shows them. Explicit groupchat_nick renames
   * recorded earlier in this boot win over the stored title.
   */
  async function seedKnownSessions() {
    try {
      const idToKey = new Map()
      for (const ws of ctx.workspaceRegistry?.list?.() ?? []) {
        const base = baseNameOf(ws.path)
        if (base === '') continue
        for (const sid of ws.sessionIds ?? []) idToKey.set(sid, base.toLowerCase())
      }
      const ids = [...idToKey.keys()]
      if (ids.length === 0) return
      const results = await ctx.sessionQuery?.readTitleSnapshots?.(ids) ?? []
      let seeded = 0
      for (const result of results) {
        if (result?.status !== 'fulfilled' || !result.value?.session) continue
        const header = result.value.session
        if (header.origin === 'subagent') continue // children are not chat peers
        const sid = header.id
        const key = idToKey.get(sid)
        if (key === undefined || knownSessions.has(sid)) continue
        const title = typeof result.value.title?.title === 'string' && result.value.title.title.trim() !== ''
          ? result.value.title.title.trim()
          : defaultNick(sid)
        knownSessions.set(sid, { nick: title, projectKey: key, lastSeenAt: 0 })
        seeded += 1
      }
      if (seeded > 0) ctx.logger.info(`groupchat: warmed ${seeded} @-candidates from persisted sessions`)
    } catch (error) {
      ctx.logger.warn('groupchat: persisted-session warmup failed', error)
    }
  }
  void seedKnownSessions()

  // ------------------------------------------------------------- posting

  /**
   * The one and only message path.
   * @param {object} group - target group.
   * @param {{ kind: 'human'|'agent', name: string, sessionId?: string }} from - sender.
   * @param {string} text - message body.
   */
  function postMessage(group, from, text) {
    const msg = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: from.kind,
      name: from.name,
      text: String(text).slice(0, TEXT_CAP),
      mentions: parseMentions(text),
      fromName: from.name,
    }
    group.messages.push(msg)
    if (group.messages.length > MESSAGE_CAP) {
      group.messages.splice(0, group.messages.length - MESSAGE_CAP)
    }

    // Rule 1: inject into every online member's next step (no wake), except
    // sender. A member whose nick the message @s gets the addressed variant
    // ("… @你:", "群聊有人@你") — the marker is how they know it is THEM,
    // without having to know their own nick.
    for (const [sessionId, member] of group.members) {
      if (from.kind === 'agent' && sessionId === from.sessionId) continue
      try {
        const addressed = msg.mentions.includes(member.nick)
        member.agent.inject(buildUserMessage(group, msg, { addressed }))
      } catch (error) {
        ctx.logger.warn(`groupchat: inject into ${member.nick} failed`, error)
      }
    }

    // Rule 2: the human's @ wakes offline known sessions — an agent's @ is a
    // plain mention (online members still get the addressed marker via Rule
    // 1; offline ones stay asleep). Wakes cost real tokens, and agents
    // waking agents invites @ storms. One reserved mention is a command:
    // `@创建成员` (picked from the @-popup, rest of the message is normal
    // prose) creates ONE new member session in the group's project directory
    // and tells it to name itself via groupchat_nick.
    if (from.kind === 'human') {
      for (const nick of msg.mentions) {
        if (nick === '我' || nick === '用户') continue // the human's own names
        const target = findKnownByNick(group.key, nick)
        if (target !== null) {
          if (group.members.has(target.sessionId)) continue // online: injected above
          wakeOffline(group, target, nick, msg).catch(error => {
            ctx.logger.warn(`groupchat: wake-up ${nick} failed`, error)
            sys(group, `${nick} 唤醒失败：${String(error && error.message || error).slice(0, 120)}`)
          })
          continue
        }
        if (nick === '创建成员') {
          createMember(group, msg).catch(error => {
            ctx.logger.warn('groupchat: create member failed', error)
            sys(group, `创建成员失败：${String(error && error.message || error).slice(0, 120)}`)
          })
        }
      }
    }
    return msg
  }

  /**
   * Launch ingredients every composed agent needs, matching what the web UI
   * does when it opens or creates a session: the deployment's default
   * provider/model pair (the {{model}} prompt variable reads options.model —
   * a bare create/resume leaves it undefined and prompt assembly dies) and
   * the agent preset mounted into the agent scope. `presetId` picks a stored
   * session's own preset; undefined resolves the deployment default.
   */
  async function composeAgentLaunch(presetId) {
    const { provider, model } = ctx.agentDefaultModel.currentSelection()
    let setup
    let resolvedPreset
    try {
      const presets = ctx.agentPresets
      if (presets !== undefined) {
        resolvedPreset = await presets.resolve(presetId)
        setup = async (agentCtx) => { await presets.mount(agentCtx, resolvedPreset.id) }
      }
    } catch (error) {
      resolvedPreset = undefined
      ctx.logger.warn('groupchat: agent preset composition failed; continuing without one', error)
    }
    return {
      agentOptions: { provider, model },
      ...(setup === undefined ? {} : { setup }),
      ...(resolvedPreset === undefined ? {} : { preset: resolvedPreset.id }),
    }
  }

  /** Deliver one message to an offline session, resuming it from storage if needed. */
  async function wakeOffline(group, target, nick, msg) {
    let agent = ctx.agents.get(target.sessionId)
    let resumed = false
    if (agent === undefined) {
      let presetId
      try {
        const observation = await ctx.sessionQuery.observeSession(target.sessionId)
        presetId = observation?.projections?.values?.agentPreset ?? undefined
      } catch {
        presetId = undefined // unreadable projection: the default preset
      }
      const launch = await composeAgentLaunch(presetId)
      const handle = await ctx.agents.resume({
        resumeSessionId: target.sessionId,
        agentOptions: launch.agentOptions,
        ...(launch.setup === undefined ? {} : { setup: launch.setup }),
      })
      agent = handle.agent
      resumed = true
    }
    agent.followup(buildUserMessage(group, msg, { addressed: true }))
    knownSessions.set(target.sessionId, { ...target, lastSeenAt: Date.now() })
    sys(group, resumed ? `${nick} 被 @ 唤醒（会话已从存档恢复）` : `${nick} 被 @ 唤醒`)
  }

  /**
   * Create a brand-new session as a group member, triggered by the human's
   * `@创建成员` command (the rest of that message is normal prose, delivered
   * below). The session lands in the group's project directory with the
   * deployment's default preset; its first message tells it to name itself
   * via groupchat_nick — member name == session name from then on.
   */
  async function createMember(group, msg) {
    const cwd = group.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error('这个群没有记录工作区目录，无法在里面创建会话')
    }
    const launch = await composeAgentLaunch(undefined)
    const sessionId = `session-${crypto.randomUUID()}`
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: {
        cwd,
        ...(launch.preset === undefined ? {} : { agentPreset: launch.preset }),
      },
      agentOptions: launch.agentOptions,
      ...(launch.setup === undefined ? {} : { setup: launch.setup }),
    })
    // agents.create with meta.cwd alone does NOT register the session into a
    // workspace — the UI's session/create does that explicitly via
    // workspace.attachSession, and so do we, or the new member never shows
    // in the workspace's sidebar list.
    try {
      const ws = ctx.workspaceRegistry?.list?.().find(w => samePath(w.path, cwd))
      if (ws !== undefined) await ws.attachSession(agent.id)
      else ctx.logger.warn(`groupchat: no workspace matches "${cwd}"; created session stays unattached`)
    } catch (error) {
      ctx.logger.warn('groupchat: workspace attach after create failed', error)
    }
    // Names already taken in this group, so the newcomer picks a distinct one.
    const archived = archivedSet()
    const taken = new Set()
    for (const [sid, known] of knownSessions) {
      if (known.projectKey === group.key && !archived.has(sid)) taken.add(known.nick)
    }
    agent.followup({
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: '用户', at: msg.at },
      content: [{ type: 'text', text:
        `[群聊 · ${group.name}] 用户 创建了你，把你加入了这个群聊。\n` +
        `用户 说：${msg.text}\n` +
        `（请先调用 groupchat_nick 给自己取一个名字：1~32 个字符，**必须与下面这些已有名字都不同**、容易区分、好被 @，名字会同步成你的会话名。` +
        `群里已有的名字：${[...taken].join('、') || '（还没有别人）'}。\n` +
        '之后群里有新消息会通知你；要发言就调 groupchat_post，看群消息调 groupchat_read。）' }],
    })
    sys(group, '一位新成员被创建并加入（正在给自己取名）')
  }

  // ---------------------------------------------------------------- tools

  /** The calling agent, or a thrown error the model can read. */
  function requireAgent(exec) {
    if (!exec.agent) throw new Error('groupchat 工具需要一个发起调用的 agent 会话')
    return exec.agent
  }

  /** The group the calling agent currently belongs to (auto-ensures its project group). */
  function groupOfAgent(agent) {
    const proj = projectKeyOf(agent)
    if (proj === null) throw new Error('这个会话没有工作目录，进不了任何群')
    return ensureGroupNamed(proj.key, proj.base, proj.cwd)
  }

  function nickOfAgent(group, agent) {
    return group.members.get(agent.id)?.nick
      ?? knownSessions.get(agent.id)?.nick
      ?? sessionTitleOf(agent)
      ?? defaultNick(agent.id)
  }

  /** Shared output contract: one JSON value rendered into a single text block. */
  function textOutput(render) {
    return {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: render(value) }],
    }
  }

  ctx.tools.register({
    name: 'groupchat_post',
    description:
      '发言到你所在项目的群聊。群里所有在线成员（含用户）都会看到（他们收到的是截断预览，全文要调 groupchat_read）；' +
      '@成员昵称 对在线成员是点名标记。注意：@ 未知名字创建新成员、唤醒离线会话，都只有用户在网页上 @ 才行。' +
      '先用 groupchat_members 看谁在线、能 @ 谁。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发到群里的内容。' },
      },
      required: ['message'],
    },
    output: textOutput(v => v.ok
      ? `已发到群「${v.group}」（${v.online} 人在线）。`
        + (v.unwoken.length > 0
          ? `${v.unwoken.join('、')} 不在线：你的 @ 只是点名标记，唤不醒；只有用户在网页上 @ 才能唤醒离线会话。`
          : '')
        + (v.unknown.length > 0
          ? `${v.unknown.join('、')} 不是群成员：@ 未知名字创建新成员也只有用户在网页上能做。`
          : '')
      : `发送失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = groupOfAgent(agent)
        const from = { kind: 'agent', name: nickOfAgent(group, agent), sessionId: agent.id }
        const msg = postMessage(group, from, args.message)
        // Which @s named an OFFLINE session, and which named no one at all?
        // The mention was delivered to the group either way, but the wake and
        // the creation were refused (only the human may do either) — say so.
        const unwoken = []
        const unknown = []
        for (const nick of msg.mentions) {
          if (nick === '我' || nick === '用户') continue
          const target = findKnownByNick(group.key, nick)
          if (target === null) { unknown.push(nick); continue }
          if (!group.members.has(target.sessionId)) unwoken.push(nick)
        }
        return { ok: true, group: group.name, online: group.members.size, unwoken, unknown }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error), unwoken: [], unknown: [] }
      }
    },
  })

  ctx.tools.register({
    name: 'groupchat_read',
    description: '读你所在项目群聊的最近消息（默认 20 条），附在线成员名单。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要读多少条最近消息，默认 20，最多 100。' },
      },
    },
    output: textOutput(v => v.ok ? v.text : `读取失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = groupOfAgent(agent)
        const count = Math.min(Math.max(Number(args.count) || 20, 1), 100)
        const lines = group.messages.slice(-count).map((msg) => {
          const time = new Date(msg.at).toLocaleTimeString('zh-CN', { hour12: false })
          return msg.kind === 'system' ? `  — ${msg.text} —` : `[${time}] ${msg.name}: ${msg.text}`
        })
        const online = [...group.members.values()].map(m => m.nick).join('、') || '（无）'
        const text = lines.length > 0
          ? `群「${group.name}」最近 ${lines.length} 条（在线：${online}）：\n${lines.join('\n')}`
          : `群「${group.name}」还没有消息（在线：${online}）。`
        return { ok: true, text }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  ctx.tools.register({
    name: 'groupchat_members',
    description:
      '列出你所在项目群聊的在线成员，以及可以 @ 的候选（含不在线的已知会话）。' +
      '发言或 @ 之前先调这个，免得 @ 错名字。',
    parameters: {
      type: 'object',
      properties: {
        include_offline: {
          type: 'integer', enum: [0, 1],
          description: '1=同时列出可 @ 的不在线候选（默认），0=只列在线成员。',
        },
      },
    },
    output: textOutput(v => v.ok ? v.text : `查询失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = groupOfAgent(agent)
        const online = [...group.members.values()].map(m => m.nick)
        const includeOffline = args.include_offline !== 0
        const offline = []
        if (includeOffline) {
          const archived = archivedSet()
          for (const [sessionId, known] of knownSessions) {
            if (known.projectKey !== group.key || group.members.has(sessionId)) continue
            if (archived.has(sessionId)) continue // archived chats are not @-able
            offline.push(known.nick)
          }
        }
        return {
          ok: true,
          text: `群「${group.name}」在线（${online.length}）：${online.join('、') || '（无）'}` +
            (includeOffline ? `\n可 @ 的不在线候选（${offline.length}）：${offline.join('、') || '（无）'}` : ''),
        }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  ctx.tools.register({
    name: 'groupchat_rename',
    description: '修改你所在项目群聊的群名称（群里会广播一条改名通知）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新的群名，1~32 个字符。' },
      },
      required: ['name'],
    },
    output: textOutput(v => v.ok ? `群已改名为「${v.name}」。` : `改名失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = groupOfAgent(agent)
        const name = String(args.name ?? '').trim().slice(0, 32)
        if (name === '') return { ok: false, error: '群名不能为空' }
        if (name !== group.name) {
          group.name = name
          sys(group, `群改名为「${name}」`)
        }
        return { ok: true, name }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  ctx.tools.register({
    name: 'groupchat_nick',
    description:
      '修改你自己在群聊里的显示昵称（别人 @ 你时用的就是这个名字）。' +
      '会话名称会同步改成这个昵称，保持群成员名和会话列表一致；群里会广播一条改名通知。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '你的新昵称，1~32 个字符，建议短一点好 @。' },
      },
      required: ['name'],
    },
    output: textOutput(v => v.ok ? `你的昵称已改为「${v.name}」。` : `改昵称失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = groupOfAgent(agent)
        const name = String(args.name ?? '').trim().slice(0, 32)
        if (name === '') return { ok: false, error: '昵称不能为空' }
        // Reserved names: '用户' is the human sender, '创建成员' is the
        // creation command — a member holding either would make @ ambiguous.
        if (name === '用户' || name === '创建成员' || name === '我') {
          return { ok: false, error: '这个名字是保留字（用户 / 创建成员 / 我），换一个' }
        }
        // Duplicate names break @ resolution (it targets the first match),
        // so a name another visible session of this project already uses
        // is refused outright.
        const clash = findKnownByNick(group.key, name)
        if (clash !== null && clash.sessionId !== agent.id) {
          return { ok: false, error: `群里已经有叫「${name}」的了，@ 会分不清人；换一个好区分的名字` }
        }
        const old = nickOfAgent(group, agent)
        if (name === old) return { ok: true, name }
        const member = group.members.get(agent.id)
        if (member !== undefined) member.nick = name
        knownSessions.set(agent.id, {
          nick: name,
          projectKey: group.key,
          lastSeenAt: Date.now(),
        })
        sys(group, `${old} 改名为 ${name}`)
        // Keep the session list in sync: the workspace sidebar shows the
        // session title, and the user wants member name == session name.
        try {
          ctx.sessionTitle?.rename?.(agent.session, name)
        } catch (titleError) {
          ctx.logger.warn('groupchat: session title rename failed', titleError)
        }
        return { ok: true, name }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  // ---------------------------------------------------------------- routes

  /** JSON view of every group (for the web tab). */
  function groupsPayload() {
    const archived = archivedSet()
    const mentionables = {}
    for (const [sessionId, known] of knownSessions) {
      if (archived.has(sessionId)) continue // archived chats stay out of @ candidates
      // Offline-but-known sessions stay listable: that is exactly what @ wakes.
      ;(mentionables[known.projectKey] ??= []).push({
        nick: known.nick,
        online: [...groups.values()].some(g => g.members.has(sessionId)),
      })
    }
    return {
      ok: true,
      serverTime: Date.now(),
      groups: [...groups.values()].map(group => ({
        key: group.key,
        name: group.name,
        dormant: group.dormant && group.members.size === 0,
        members: [...group.members.values()].map(m => ({ nick: m.nick, joinedAt: m.joinedAt })),
        messages: group.messages.map(msg => ({
          id: msg.id, at: msg.at, kind: msg.kind, name: msg.name,
          text: msg.text, mentions: msg.mentions,
        })),
      })),
      mentionables,
    }
  }

  /** Collect and JSON-parse a POST body (small payloads only). */
  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (raw.length > 64 * 1024) throw new Error('body too large')
    return JSON.parse(raw || '{}')
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req, res) {
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, groupsPayload())
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body.action === 'post') {
            const group = groups.get(String(body.group ?? ''))
            const text = String(body.text ?? '').trim()
            if (group === undefined) return sendJson(res, 404, { ok: false, error: 'group-not-found' })
            if (text === '') return sendJson(res, 400, { ok: false, error: 'empty-text' })
            postMessage(group, { kind: 'human', name: '用户' }, text)
            return sendJson(res, 200, { ok: true })
          }
          if (body.action === 'rename') {
            const group = groups.get(String(body.group ?? ''))
            const name = String(body.name ?? '').trim().slice(0, 32)
            if (group === undefined) return sendJson(res, 404, { ok: false, error: 'group-not-found' })
            if (name === '') return sendJson(res, 400, { ok: false, error: 'empty-name' })
            if (name !== group.name) {
              group.name = name
              sys(group, `群改名为「${name}」`)
            }
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown-action' })
        }
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      } catch (error) {
        ctx.logger.warn('groupchat: route handler failed', error)
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })
  live = { disposeRoute, fiber: ctx.fiber }
  ctx.logger.info(`groupchat: serving per-project group chat at ${ROUTE_PATH}`)
}
