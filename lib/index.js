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

export const inject = ['webServer', 'tools', 'agents', 'workspaceRegistry', 'workspaceController', 'sessionTitle', 'sessionQuery', 'agentDefaultModel', 'agentPresets', 'sessionController']

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

  /**
   * The web tab's "new member model" pick: the exact model (and reasoning
   * effort) a later `@创建成员` builds its member with. null = follow the
   * deployment default. `sessionController` is only a dependency of the PICKER
   * being possible; a host without it must still load and run the chat.
   */
  let preferredModel = null
  /** Cached catalog; it does not move within a boot once it has answers. */
  let modelCatalog = null

  /**
   * The very catalog DSH's own model selector consumes
   * (`ctx.sessionController.modelCatalog()`): provider groups with display
   * names, per-model reasoning metadata, and per-provider failures. Passing it
   * through untouched is what makes the tab's picker agree with the host's.
   * Only a NON-EMPTY result is cached — a failed/empty load must not disable
   * the picker for the rest of the boot.
   */
  async function getModelCatalog() {
    if (modelCatalog !== null) return modelCatalog
    if (ctx.sessionController?.modelCatalog === undefined) {
      ctx.logger.warn('groupchat: no sessionController; the new-member model picker stays hidden')
      return null
    }
    let catalog = null
    try {
      catalog = await ctx.sessionController.modelCatalog()
    } catch (error) {
      ctx.logger.warn('groupchat: model catalog load failed', error)
      return null
    }
    if ((catalog?.groups?.length ?? 0) > 0) modelCatalog = catalog
    return catalog
  }

  /** The catalog entry behind a `{provider, model}` pair, or null. */
  function findCatalogEntry(catalog, provider, model) {
    const group = catalog?.groups?.find(g => g.id === provider)
    const entry = group?.models?.find(m => m.id === model)
    return entry === undefined ? undefined : { group, entry }
  }

  // ------------------------------------------------------- update checking

  /**
   * The installed version, kept in step with package.json by hand. Doubles as
   * the left side of the comparison below — a mismatch here is the only way a
   * "no update available" answer can be wrong.
   */
  const CURRENT_VERSION = '0.4.0'

  /**
   * Where an update is fetched from, in order. The gitee mirror comes first
   * because a direct GitHub fetch fails outright on a mainland connection, and
   * the tab must not sit there silently for a minute before falling back.
   * Both addresses are the ones the README tells users to install from; the
   * `.git` suffix on gitee is REQUIRED (pnpm treats a bare non-GitHub URL as a
   * tarball and fails with ERR_PNPM_TARBALL_EXTRACT).
   */
  const INSTALL_URL = 'https://gitee.com/jaxleon/dsh-groupchat.git'
  const REMOTE_MANIFESTS = [
    'https://gitee.com/jaxleon/dsh-groupchat/raw/main/package.json',
    'https://raw.githubusercontent.com/ikun666666/dsh-groupchat/main/package.json',
  ]

  /** How long a fetched answer stays fresh. The tab polls every 5s. */
  const UPDATE_TTL_MS = 30 * 60 * 1000
  /**
   * How long a FAILED attempt is remembered. Deliberately far shorter than
   * UPDATE_TTL_MS: gitee's raw door redirects to a signed
   * raw.giteeusercontent.com URL whose signature lives ~10 minutes, so the
   * door is not the stable thing it looks like. A 30-minute failure cache
   * would turn a 1-minute wobble into half an hour of update blindness.
   */
  const UPDATE_FAIL_TTL_MS = 3 * 60 * 1000
  /** Per-request ceiling; a hung socket must not hold up the whole payload. */
  const UPDATE_TIMEOUT_MS = 6000

  /** Cached answer: `{latest, ok, checkedAt}`. */
  let updateCache = null
  /** In-flight guard so N concurrent GETs cause ONE network round trip. */
  let updatePending = null

  /**
   * Is a cached answer still fresh? Failures expire on their own, shorter clock.
   */
  function cacheIsFresh() {
    if (updateCache === null) return false
    const ttl = updateCache.ok === true ? UPDATE_TTL_MS : UPDATE_FAIL_TTL_MS
    return Date.now() - updateCache.checkedAt < ttl
  }

  /**
   * Compare dotted numeric versions. Returns >0 when `a` is NEWER than `b`,
   * <0 when older, 0 when equal or either side is unparseable — an unknown
   * version must never fake an update prompt.
   */
  function compareVersions(a, b) {
    const parse = v => String(v ?? '')
      .split('-')[0]
      .split('.')
      .map(part => Number.parseInt(part, 10))
    const left = parse(a)
    const right = parse(b)
    if (left.length === 0 || right.length === 0) return 0
    if (left.some(n => !Number.isFinite(n)) || right.some(n => !Number.isFinite(n))) return 0
    const len = Math.max(left.length, right.length)
    for (let i = 0; i < len; i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  /**
   * Hosts a raw redirect is allowed to land on. gitee's raw door answers 302
   * into raw.giteeusercontent.com with a signed, ~10-minute URL; the mirror
   * serves GitHub's own CDN. Anything else means the door changed shape, and
   * trusting an unknown host with a fetch is not worth the convenience.
   */
  const ALLOWED_REDIRECT_HOSTS = new Set([
    'gitee.com',
    'raw.giteeusercontent.com',
    'raw.githubusercontent.com',
  ])

  /** One manifest fetch with a hard timeout, returning the version or null. */
  async function fetchRemoteVersion(url) {
    // DSH may run on Node 18+ (global fetch) or an older runtime; the Abort
    // signal is the only way to bound this, so a missing one means no timeout.
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        // MUST be follow: the raw doors answer 302, and reading the redirect
        // body would look exactly like an empty manifest — a silent "no
        // update" that never surfaces anywhere.
        redirect: 'follow',
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      if (!response.ok) return null
      // Verify where we actually landed. A real fetch always reports a
      // `response.url`; an empty one means the answer cannot be attributed, and
      // "cannot be attributed" must read as failure — accepting it would let
      // any body through unchecked, which is the one thing this guard is for.
      let landed = null
      try {
        landed = new URL(response.url).host
      } catch (error) {
        ctx.logger.warn('groupchat: update check got a response with no usable URL; ignored')
        return null
      }
      if (!ALLOWED_REDIRECT_HOSTS.has(landed)) {
        ctx.logger.warn(`groupchat: update check landed on ${landed}, which is not a known raw host; ignored`)
        return null
      }
      const manifest = await response.json()
      const version = manifest?.version
      return typeof version === 'string' && version !== '' ? version : null
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Latest published version, or null when unknown. NEVER throws and never
   * blocks for long: the tab's 5s poll renders the same layout with or without
   * this answer, so a network failure is a missing badge, not a broken tab.
   */
  async function checkForUpdate() {
    if (cacheIsFresh()) return updateCache.latest
    if (updatePending !== null) return updatePending
    updatePending = (async () => {
      let latest = null
      for (const url of REMOTE_MANIFESTS) {
        try {
          latest = await fetchRemoteVersion(url)
        } catch (error) {
          latest = null // timeout / DNS / offline — try the next mirror
        }
        if (latest !== null) break
      }
      if (latest === null) {
        // Remember the failure too, else every poll retries the dead network
        // and the tab pays the timeout forever.
        updateCache = { latest: null, ok: false, checkedAt: Date.now() }
        return null
      }
      updateCache = { latest, ok: true, checkedAt: Date.now() }
      if (compareVersions(latest, CURRENT_VERSION) > 0) {
        ctx.logger.info(`groupchat: update available ${CURRENT_VERSION} -> ${latest}`)
      }
      return latest
    })()
    try {
      return await updatePending
    } finally {
      updatePending = null
    }
  }

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

  /**
   * The Workspace backing one group, located by path — the only identity a
   * group actually has. Its `key` is the lowercased path basename, which stays
   * correct across a rename: renaming a Workspace changes its TITLE, never its
   * path, so the group key survives while the display name moves underneath it.
   * Null when the workspace is gone (deleted while DSH ran) or the service is
   * unavailable.
   */
  function workspaceOfGroup(group) {
    if (group.cwd === '') return null
    try {
      const list = ctx.workspaceRegistry?.list?.() ?? []
      return list.find(ws => samePath(ws.path, group.cwd)) ?? null
    } catch (error) {
      return null
    }
  }

  /**
   * Rename a group AND the Workspace behind it as ONE operation, because in
   * this UI the two are the same row shown twice: the sidebar lists Workspaces,
   * the group tab lists groups. Half-renaming leaves the user staring at two
   * different names for one project, which is worse than not renaming at all.
   *
   * So this is all-or-nothing, and the ORDER is what makes it so: the
   * Workspace goes first, because its rename is the one that can be REFUSED
   * (DSH rejects a title another Workspace already owns —
   * `workspace/name-conflict`). Only once it has actually landed do we touch
   * the group. A group whose backing Workspace is gone or uncontrollable is
   * renamed on its own, since there is nothing to disagree with.
   *
   * Returns `{ name, workspaceTitle, workspaceRenamed, error }`; `error` is
   * non-empty exactly when nothing was changed.
   */
  async function renameGroupAndWorkspace(group, name) {
    const previous = group.name
    const unchanged = { name: previous, workspaceTitle: null, workspaceRenamed: false, error: '' }

    const workspace = workspaceOfGroup(group)
    if (workspace === null) {
      // Session-only group, or the registry is unavailable. The group name is
      // the only name there is, so it just takes the new one.
      if (name !== previous) {
        group.name = name
        sys(group, `群改名为「${name}」`)
      }
      return { name, workspaceTitle: null, workspaceRenamed: false, error: '' }
    }

    if (workspace.title === name) {
      // Already in agreement; treat as a no-op success rather than calling the
      // rename for nothing.
      if (name !== previous) {
        group.name = name
        sys(group, `群改名为「${name}」`)
      }
      return { name, workspaceTitle: name, workspaceRenamed: true, error: '' }
    }

    if (ctx.workspaceController?.rename === undefined) {
      return {
        ...unchanged,
        workspaceTitle: workspace.title,
        error: '这个 DSH 没有工作区改名接口，群名和工作区名都没改',
      }
    }

    // `id` is the registry field; the wire shape calls it workspaceId.
    const id = workspace.id ?? workspace.workspaceId
    if (typeof id !== 'string' || id === '') {
      return {
        ...unchanged,
        workspaceTitle: workspace.title,
        error: '找不到这个工程的工作区编号，群名和工作区名都没改',
      }
    }

    try {
      await ctx.workspaceController.rename({ workspaceId: id, title: name })
    } catch (error) {
      const message = String(error && error.message || error)
      const conflict = message.includes('already in use') || message.includes('name-conflict')
      ctx.logger.warn('groupchat: workspace rename failed, group name left untouched', error)
      return {
        ...unchanged,
        workspaceTitle: workspace.title,
        error: conflict
          ? `工作区「${name}」已被其他工程占用，群名和工作区名都没改（都还是「${previous}」）`
          : `工作区改名失败，群名和工作区名都没改：${message}`,
      }
    }

    // The Workspace took the new title, so it is now safe to move the group.
    group.name = name
    sys(group, `群改名为「${name}」`)
    ctx.logger.info(`groupchat: renamed workspace ${id} and group ${group.key} to "${name}"`)
    return { name, workspaceTitle: name, workspaceRenamed: true, error: '' }
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
   * Truncate by CODE POINT, never by UTF-16 code unit: an emoji straddling the
   * cap would otherwise be cut in half, and the lone half surrogate makes the
   * whole model request fail with 400 INVALID_REQUEST (it is invalid Unicode,
   * and the message stays in the member's history for good).
   */
  function clip(text, cap) {
    const points = [...text]
    return points.length > cap ? `${points.slice(0, cap).join('')}…` : text
  }

  /**
   * Build the UserMessage that lands in a member's conversation. Only a
   * truncated preview travels — two members chatting must not flood a third
   * member's context; the full text stays behind groupchat_read.
   */
  function buildUserMessage(group, msg, { addressed = false } = {}) {
    const snippet = clip(msg.text, SNIPPET_CAP)
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
      text: clip(String(text), TEXT_CAP),
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
   * `modelOverride` replaces that default pair (the web tab's "new member
   * model" picker) and carries its own reasoning effort when the catalog has
   * one for the model.
   */
  async function composeAgentLaunch(presetId, modelOverride) {
    const fallback = ctx.agentDefaultModel.currentSelection()
    const picked = modelOverride ?? fallback
    const agentOptions = { provider: picked.provider, model: picked.model }
    if (picked.reasoningEffort !== undefined) agentOptions.reasoningEffort = picked.reasoningEffort
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
      agentOptions,
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
    const launch = await composeAgentLaunch(undefined, preferredModel ?? undefined)
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
    if (preferredModel === null) {
      sys(group, '一位新成员被创建并加入（正在给自己取名）')
    } else {
      const named = findCatalogEntry(modelCatalog, preferredModel.provider, preferredModel.model)
      sys(group, `一位新成员被创建并加入（模型 ${named?.entry?.name ?? preferredModel.model}，正在给自己取名）`)
    }
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

  // NOTE: there is deliberately no `groupchat_rename` tool. Renaming a project
  // is the user's call alone: the same rename moves the DSH Workspace title,
  // which is a durable change to their sidebar, and an agent deciding that on
  // its own (or being talked into it mid-task) would be reaching outside its
  // remit. The web tab does it instead, and announces it to the group.

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
          const catalog = await getModelCatalog()
          // Raw deployment default; the tab resolves its display name and the
          // effective effort from the catalog, exactly like DSH's own selector.
          let defaultSelection = null
          try {
            defaultSelection = ctx.agentDefaultModel.currentSelection()
          } catch (error) {
            ctx.logger.warn('groupchat: default model lookup failed', error)
          }
          sendJson(res, 200, {
            ...groupsPayload(),
            modelGroups: catalog?.groups ?? [],
            modelFailures: catalog?.failures ?? [],
            newMemberModel: preferredModel,
            defaultSelection,
            // Update state rides along on the poll the tab already makes.
            // `updateAvailable` is the only field the prompt keys off; the
            // version pair is for the text, installUrl is what gets copied.
            currentVersion: CURRENT_VERSION,
            latestVersion: await checkForUpdate(),
            installUrl: INSTALL_URL,
          })
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
            // All-or-nothing: on failure NOTHING moved, so the reply says so
            // with a non-2xx and the tab keeps the user in the editor.
            const result = await renameGroupAndWorkspace(group, name)
            if (result.error !== '') {
              return sendJson(res, 409, { ok: false, error: result.error, name: result.name, workspaceTitle: result.workspaceTitle })
            }
            return sendJson(res, 200, { ok: true, ...result })
          }
          if (body.action === 'new-member-model') {
            const provider = String(body.provider ?? '')
            const model = String(body.model ?? '')
            const effort = body.reasoningEffort === undefined || body.reasoningEffort === null
              ? undefined
              : String(body.reasoningEffort)
            // An empty model clears the pick: follow the deployment default
            // again (what the tab's "跟随默认" row sends).
            if (model === '') {
              preferredModel = null
              return sendJson(res, 200, { ok: true, newMemberModel: null })
            }
            const found = findCatalogEntry(await getModelCatalog(), provider, model)
            if (found === undefined) return sendJson(res, 400, { ok: false, error: 'unknown-model' })
            preferredModel = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
            return sendJson(res, 200, { ok: true, newMemberModel: preferredModel })
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
