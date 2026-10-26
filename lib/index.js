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
  const CURRENT_VERSION = '0.6.5'
  /** This package's own name, the key DSH lists it under. */
  const PACKAGE_NAME = 'dsh-groupchat'

  /**
   * What DSH currently has on disk for this plugin, and whether it is still
   * switched on — read live from the plugin manager rather than assumed from
   * the constant above.
   *
   * This exists because of two user-visible failures that both come from
   * trusting the loaded code as the source of truth:
   *
   * 1. DSH does not hot-reload plugins (its `reload()` returns immediately
   *    unless the optional `hmr` service is present, and it ships disabled), so
   *    after an update the RUNNING code is still the old one. Comparing against
   *    {@link CURRENT_VERSION} therefore kept reporting an update for a plugin
   *    the user had already reinstalled, and only a restart cleared it. The
   *    installed version on disk is the thing the user actually changed.
   * 2. Uninstalling or disabling a bundle only rewrites the profile manifest
   *    (see `selectBundle`); the fiber is NOT disposed and the route keeps
   *    answering, so a 404 never arrives and the tab sat there greyed out
   *    until a restart. The enable flag is the honest signal.
   *
   * Returns null when the manager is unavailable, in which case the caller
   * must NOT fall back to the loaded constant — see `installedVersion` in the
   * GET payload for why.
   */
  async function installedState() {
    // Read the service through ctx.reflect.get, NOT a bare property read and
    // NOT ctx.registry.get.
    //
    //  * A bare `ctx.pluginManager` THROWS ("cannot get property X without
    //    inject") for any service the plugin did not declare in its inject
    //    array — 0.4.2 did that outside every try, so EVERY /groupchat GET
    //    answered 500 and the tab sat on 读取中… forever (its error banner only
    //    renders with a selected group).
    //
    //  * `ctx.registry` is NOT the service container. cordis installs it as
    //    "Plugin registry ... map-like inspection over active plugin
    //    callbacks" (RegistryService): get() takes a plugin runtime, not a
    //    service name. Reading 'pluginManager' through it never yields the
    //    manager, so installedState() returned null on every single call and
    //    installedVersion was always null — which is what made 0.4.7 report an
    //    update for a plugin that was already up to date on disk.
    //
    //  * `ctx.reflect` IS the service store, and its get() is documented as
    //    "Read a service from the store without the inject requirement ...
    //    returns the service value, or undefined when not (yet) provided".
    //    That is exactly the soft read wanted here.
    let manager = null
    try {
      manager = ctx.reflect?.get?.('pluginManager') ?? null
    } catch (error) {
      return null
    }
    if (manager?.listBundles === undefined) return null
    let bundles = null
    try {
      bundles = await manager.listBundles()
    } catch (error) {
      return null
    }
    if (!Array.isArray(bundles)) return null
    const row = bundles.find(b => b?.name === PACKAGE_NAME)
    // Absent from the list means the dependency is gone: uninstalled.
    if (row === undefined) return { installed: false, enabled: false, version: null }
    return {
      installed: row.installed !== false,
      enabled: row.enabled === true,
      version: typeof row.version === 'string' ? row.version : null,
    }
  }


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

  /**
   * Default display name for a session we have never nicknamed.
   *
   * Derived from the id WITHOUT its `session-` prefix: every id DSH mints
   * carries that prefix, so slicing from the front of the raw id labelled
   * every session `会话-sessio` — the same name on several rows of one
   * roster, and @ with nothing to tell them apart. Skip the shared prefix,
   * use the uuid's own head.
   */
  function defaultNick(sessionId) {
    const id = String(sessionId)
    const tail = id.startsWith('session-') ? id.slice('session-'.length) : id
    return `会话-${tail.slice(0, 6)}`
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

  /**
   * Move a session's group names onto its own current title (README: 昵称 =
   * 会话名, so the sidebar row and the roster row are the same name).
   *
   * The nickname→title direction already exists (`groupchat_nick` renames the
   * session); this is the OTHER direction, and it is the one that keeps fresh
   * conversations honest: a session is born BEFORE its title. A new
   * conversation goes `running` — the moment the first status pass files it —
   * ~100ms before the title service appends even the fallback title, so that
   * first pass can only reach for `defaultNick`. Without this follow-up the
   * placeholder stuck for the life of the process, and the group showed
   * `会话-xxxxxx` next to a sidebar reading a real title. The fallback →
   * provider swap (seconds into the first turn) lands here too.
   *
   * The supervisor is exempt: its name is RESERVED (`@群管理` must resolve to
   * exactly one session, and restart-time adoption finds it BY that name), so
   * a title change must never move it.
   */
  function followSessionTitle(sessionId, title) {
    if (typeof title !== 'string') return
    const next = title.trim()
    if (next === '') return
    for (const group of groups.values()) {
      if (isSupervisorOf(group, sessionId)) return
    }
    let changed = false
    const known = knownSessions.get(sessionId)
    if (known !== undefined && known.nick !== next) {
      known.nick = next
      changed = true
    }
    for (const group of groups.values()) {
      const member = group.members.get(sessionId)
      if (member !== undefined && member.nick !== next) {
        member.nick = next
        changed = true
      }
    }
    if (changed) ctx.logger.info(`groupchat: ${sessionId} followed its session title to "${next}"`)
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

  /**
   * The one group that is not tied to a working directory. It is the SAME
   * structure as a project group — same messages, same members, same tools,
   * same injection — the only differences are on the human's side:
   *
   *  1. Membership is by invitation only. Nothing joins automatically, and
   *     nobody can be created into it; the human @-adds existing sessions
   *     from any workspace.
   *  2. `@创建成员` is refused (there is no project directory to create one
   *     in, and that is the point of this group).
   *
   * The `__` prefix keeps it out of the way of real directory keys, which are
   * lowercased basenames and therefore never contain underscores at the ends.
   */
  const GLOBAL_KEY = '__global__'
  const GLOBAL_NAME = '全局群聊'

  /**
   * The one member that is not an ordinary worker.
   *
   * The name is FIXED and reserved: `@群管理` has to resolve to exactly one
   * session, and a second session holding that nick would make every @
   * ambiguous. Creation and addressing therefore share the same word — the
   * command is `@创建群管理`, and once it exists it is simply `@群管理`.
   */
  const SUPERVISOR_NAME = '群管理'
  /**
   * The role's OLD name, kept as an alias instead of being dropped.
   *
   * A manager created before the rename is a session titled 验收官. Without
   * this alias the first `@群管理` on an upgraded install would build a SECOND
   * session and leave the old one in the sidebar as an ordinary member — the
   * exact "two supervisors" mess `adoptSupervisor` exists to prevent. Every
   * spelling stays reserved as well, so no member can take the alias and make
   * `@验收官` ambiguous.
   */
  const SUPERVISOR_LEGACY_NAMES = ['验收官']
  /** Every nick that resolves to the manager, current spelling first. */
  const SUPERVISOR_NAMES = [SUPERVISOR_NAME, ...SUPERVISOR_LEGACY_NAMES]
  /** Every @-command that resolves to the manager, bare or `创建…`. */
  const SUPERVISOR_ALIASES = new Set(SUPERVISOR_NAMES.flatMap(name => [name, `创建${name}`]))
  /**
   * Names no member may hold: the human's own, the two `创建…` commands, and
   * every spelling of the manager. One list, because a name reserved in one
   * tool but not another is a name that eventually gets taken.
   */
  function isReservedName(name) {
    return name === '用户' || name === '创建成员' || name === '我' || SUPERVISOR_ALIASES.has(name)
  }
  /** Marks the member entry so the tab can badge it. */
  const SUPERVISOR_ROLE = 'supervisor'

  /** Get-or-create one group; `name`/`cwd` only apply at creation time. */
  function ensureGroupNamed(key, name, cwd) {
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        key, name: name || key, cwd: cwd || '', dormant: true, messages: [], members: new Map(),
        global: key === GLOBAL_KEY,
        // The supervisor is per-group and starts out nonexistent.
        // `superviseTargetIds` holds EVERY member it is currently watching —
        // several at once is normal — and is set by the supervisor itself
        // through `groupchat_supervise`, never by the human.
        supervisorId: undefined,
        superviseTargetIds: new Set(),
      }
      groups.set(key, group)
    }
    return group
  }

  /** Is this session the supervisor of this group? */
  function isSupervisorOf(group, sessionId) {
    return group.supervisorId !== undefined && group.supervisorId === sessionId
  }

  /** The supervisor's own member entry, or undefined when there is none. */
  function supervisorMemberOf(group) {
    return group.supervisorId === undefined ? undefined : group.members.get(group.supervisorId)
  }

  /**
   * Find this group's supervisor, recovering it from storage when the in-memory
   * id is missing. Returns its sessionId, or undefined when there is none.
   *
   * `group.supervisorId` is process memory, but the SESSION is durable: it lives
   * in storage and its nick comes back on the next boot. Trusting only the id
   * meant a restart made the group forget it had a supervisor — and the next
   * creation request then built a SECOND session with the same name. The user
   * ended up staring at two 群管理 rows in their sidebar.
   *
   * The nick is the identity to look for because it is reserved: nobody else
   * may hold 群管理, so a known session wearing it IS the supervisor — and so
   * is one still wearing the old 验收官 spelling, which is renamed here.
   *
   * Archiving is the one removal path this design has, so it is honoured here:
   * a supervisor the user archived is RETIRED, not merely offline. Clinging to
   * the stale id was a dead end — `@群管理` kept trying to wake a session the
   * user had explicitly put away, and since the id was still set the
   * create-if-missing branch could never run, so no new one could be made
   * either. Retiring clears the id and the roster entry, which lets the next
   * `@群管理` build a fresh one.
   */
  function adoptSupervisor(group) {
    if (group.supervisorId !== undefined) {
      if (!archivedSet().has(group.supervisorId)) return group.supervisorId
      group.members.delete(group.supervisorId)
      group.supervisorId = undefined
      group.superviseTargetIds = new Set()
      sys(group, `${SUPERVISOR_NAME} 已被归档（不再监督任何成员）—— 想再要一个就 @${SUPERVISOR_NAME}`)
    }
    if (group.global === true) return undefined
    const archived = archivedSet()
    const matches = []
    for (const [sessionId, known] of knownSessions) {
      // Old spelling included on purpose: a manager created before the rename
      // is found by the name it still wears, then renamed below.
      if (!SUPERVISOR_NAMES.includes(known.nick)) continue
      if (known.projectKey !== group.key) continue
      if (archived.has(sessionId)) continue
      matches.push(sessionId)
    }
    if (matches.length === 0) return undefined
    if (matches.length > 1) {
      // The nick is reserved, so more than one means leftovers — either from
      // before that rule existed, or from the duplicate-creation bug this
      // adoption is here to stop. Say so instead of silently picking one: the
      // spares are real sessions sitting in the user's sidebar.
      ctx.logger.warn(`groupchat: ${matches.length} sessions named ${SUPERVISOR_NAME} in "${group.key}"`)
      sys(group, `发现 ${matches.length} 个叫「${SUPERVISOR_NAME}」的会话，只认第一个 —— 多余的那个请手动删掉`)
    }
    const found = matches[0]
    group.supervisorId = found
    // Adopted under the old spelling? Move it to the current name in memory
    // right away. The session TITLE cannot be touched here — that needs a
    // Session handle — so it is fixed on the first wake (`wakeSupervisor`).
    const knownFound = knownSessions.get(found)
    if (knownFound !== undefined) knownFound.nick = SUPERVISOR_NAME
    // Back onto the roster: the id alone is not membership, and an off-roster
    // session cannot be @-ed. It sits idle here — `agent: null` — which is the
    // normal resting state for a supervisor.
    const rosterEntry = group.members.get(found)
    if (rosterEntry !== undefined) {
      rosterEntry.nick = SUPERVISOR_NAME
      rosterEntry.role = SUPERVISOR_ROLE
    } else {
      group.members.set(found, {
        nick: SUPERVISOR_NAME,
        agent: ctx.agents.get(found) ?? null,
        joinedAt: Date.now(),
        role: SUPERVISOR_ROLE,
      })
      group.dormant = false
    }
    return found
  }

  /**
   * The global group, created lazily and never auto-populated. It appears in
   * the sidebar from the first time the tab is opened, so the human always has
   * somewhere to invite people to.
   */
  function ensureGlobalGroup() {
    return ensureGroupNamed(GLOBAL_KEY, GLOBAL_NAME, '')
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

  /**
   * Live subscribers to `/groupchat/events`. The tab used to learn about a
   * rename made elsewhere (in DSH's own sidebar) only on its next 5s poll, so
   * the two names visibly disagreed for up to five seconds. A server-sent
   * events stream closes that gap: the host pushes a `changed` frame the
   * moment anything it cares about moves, and the tab refetches at once. The
   * 5s poll stays as the fallback for a dropped connection.
   *
   * Each entry is the raw `res`, because DSH's webserver hands route handlers
   * direct response ownership and skips gzip for `text/event-stream` — it is
   * built for exactly this.
   */
  const subscribers = new Set()

  /** Push one event to every open stream, dropping any that has gone away. */
  function broadcast(event, detail) {
    if (subscribers.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(detail ?? {})}\n\n`
    for (const res of [...subscribers]) {
      try {
        res.write(frame)
      } catch (error) {
        // A closed socket throws on write; stop tracking it and let the tab
        // fall back to polling.
        subscribers.delete(res)
      }
    }
  }

  /** Open an event stream and keep it open until the client goes away. */
  function openEventStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // An initial frame flushes headers immediately, so the browser fires
    // `open` without waiting for the first real change.
    res.write(': connected\n\n')
    subscribers.add(res)
    const drop = () => { subscribers.delete(res) }
    req.on('close', drop)
    req.on('error', drop)
    res.on('close', drop)
  }

  /**
   * Watch for disconnect without depending on the request stream: the tab
   * closing its EventSource shows up here first, and a stale entry would make
   * every later broadcast write into a dead socket.
   */
  const sweep = setInterval(() => {
    for (const res of [...subscribers]) {
      if (res.writableEnded === true || res.destroyed === true) subscribers.delete(res)
    }
  }, 30_000)
  sweep.unref?.()
  ctx.effect(() => () => {
    clearInterval(sweep)
    for (const res of [...subscribers]) {
      try { res.end() } catch (error) { /* already gone */ }
    }
    subscribers.clear()
  }, 'groupchat.events')

  /** Append a grey system line to one group (joins/leaves/renames). */
  function sys(group, text) {
    group.messages.push({
      id: crypto.randomUUID(), at: Date.now(), kind: 'system', name: '', text, mentions: [],
    })
    if (group.messages.length > MESSAGE_CAP) {
      group.messages.splice(0, group.messages.length - MESSAGE_CAP)
    }
    // Joins, leaves and renames all land here, so this is the one place that
    // has to wake the tab; anything else it learns on its next poll.
    broadcast('changed', { reason: 'system', group: group.key })
  }

  /** Parse `@nick` mentions out of message text (first match per nick). */
  /**
   * Parse `@nick` mentions out of message text.
   *
   * A nick may contain SPACES — a session titled "Sum of 1 and 1" carries that
   * title as its nick — so a whitespace-delimited token cannot be the unit:
   * `@Sum of 1 and 1` would parse as `Sum`, which resolves to nobody and the @
   * silently does nothing.
   *
   * The unit is therefore the LONGEST known nick that starts here, which is why
   * the caller has to hand over the group's roster: only the roster knows where
   * a name ends. When nothing matches we fall back to the old
   * whitespace-delimited token, because that is what carries the reserved
   * commands (`@创建成员`, `@创建群管理`) and names this group does not own.
   */
  function parseMentions(text, nicks = []) {
    const src = String(text)
    // Longest first, so a nick that is a prefix of another never wins.
    const known = [...new Set(nicks)]
      .filter(nick => typeof nick === 'string' && nick !== '')
      .sort((a, b) => b.length - a.length)
    const found = []
    let cursor = 0
    while (cursor < src.length) {
      const at = src.indexOf('@', cursor)
      if (at === -1) break
      const rest = src.slice(at + 1)
      let hit = null
      for (const nick of known) {
        if (rest.startsWith(nick)) { hit = nick; break }
      }
      if (hit === null) {
        const token = rest.match(/^([^\s@，,。；;：:]{1,32})/)
        hit = token === null ? null : token[1]
      }
      if (hit === null) { cursor = at + 1; continue }
      if (!found.includes(hit)) found.push(hit)
      cursor = at + 1 + hit.length
    }
    return found
  }

  /**
   * Every nick addressable in this group: the roster, plus every known session
   * in the group's scope (offline ones are addressable too — that is what @
   * wakes). The parser needs exactly this set to cut an `@`-run at the right
   * boundary, and the tab builds the same set so highlight and resolution agree.
   */
  function nickListOf(group) {
    const out = new Set()
    for (const member of group.members.values()) out.add(member.nick)
    for (const known of knownSessions.values()) {
      if (group.global !== true && known.projectKey !== group.key) continue
      out.add(known.nick)
    }
    return [...out]
  }

  /**
   * Resolve a nick to a known session, for @-invite and @-wake.
   *
   * Project groups scope to their own directory so two projects that happen to
   * share a member name cannot invite each other's sessions by accident. The
   * global group deliberately searches EVERY workspace — it is the one place
   * where a session from project A can reach a session from project B.
   */
  function findKnownByNick(group, nick) {
    const archived = archivedSet()
    for (const [sessionId, known] of knownSessions) {
      if (archived.has(sessionId)) continue // archived sessions cannot be woken
      if (group.global !== true && known.projectKey !== group.key) continue
      if (known.nick === nick) {
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
   * What every member is told about what a group IS, prefixed once per message
   * so it is never missed. This exists because a group chat among agents is not
   * a team: they are independent workers that happen to share one directory,
   * and without being told, agents assume the people talking to them are
   * collaborators and start editing the same files.
   *
   * One line only: it rides on EVERY injected message, so a paragraph would
   * cost tokens on every single one — and the point fits in a sentence anyway.
   */
  const GROUP_PURPOSE =
    '（群聊是**避免撞车的通报板，不是协作**：其他成员默认与你各自独立，' +
    '发言只为让对方知道你正在动什么，与当前任务无关的可忽略。）'

  /**
   * Build the UserMessage that lands in a member's conversation. Only a
   * truncated preview travels — two members chatting must not flood a third
   * member's context; the full text stays behind groupchat_read.
   */
  function buildUserMessage(group, msg, { addressed = false } = {}) {
    const snippet = clip(msg.text, SNIPPET_CAP)
    const head = `[群聊 · ${group.name}] ${msg.fromName}${addressed ? ' @你' : ''}: `
    const hint = addressed
      ? '\n' + GROUP_PURPOSE + '\n（有人@你，回应请调 groupchat_post；看完整上下文调 groupchat_read。）'
      : '\n' + GROUP_PURPOSE + '\n（看完整内容调 groupchat_read。）'
    return {
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: msg.fromName, at: msg.at },
      content: [{ type: 'text', text: head + snippet + hint }],
    }
  }

  // ------------------------------------------------------- membership (online)

  /**
   * Sessions the human invited into the global group, kept for the life of the
   * process. An invited member leaves ONLY when the human says so — going
   * offline is not leaving, because membership here is a human decision rather
   * than a side effect of a session happening to be running.
   */
  const claimedByGlobal = new Set()

  function handleStatus(agent, status) {
    const sessionId = agent.id
    if (status === 'running') {
      const proj = projectKeyOf(agent)
      if (proj !== null) {
        // The session's OWN project group, always — a session is in exactly
        // the group its directory names, plus the global group if invited.
        const group = ensureGroupNamed(proj.key, proj.base, proj.cwd)
        const existing = group.members.get(sessionId)
        if (existing === undefined) {
          const known = knownSessions.get(sessionId)
          const nick = known?.nick ?? sessionTitleOf(agent) ?? defaultNick(sessionId)
          group.members.set(sessionId, { nick, agent, joinedAt: Date.now() })
          // `project` (the display name) is stored alongside the key because
          // the global group has to label candidates from workspaces that are
          // NOT running — with no live group there is no name to look up, and
          // the raw lowercased key (`projb`) is not something to show anyone.
          knownSessions.set(sessionId, {
            nick, projectKey: proj.key, project: proj.base, lastSeenAt: Date.now(),
          })
          group.dormant = false
          sys(group, `${nick} 上线了`)
        } else {
          existing.agent = agent // same session, fresh driver instance
        }
        // A session wearing the reserved nick IS this group's supervisor — no
        // ambiguity, since nobody else may hold it. This is the second path
        // (alongside the boot-time adoption) by which the role comes back after
        // a restart, and the one that fires when the supervisor merely starts
        // running again. Archived sessions are excluded: the user retired that
        // one, and re-attaching it would undo their decision.
        if (!archivedSet().has(sessionId)
          && (isSupervisorOf(group, sessionId)
            || (knownSessions.get(sessionId)?.nick ?? '') === SUPERVISOR_NAME)) {
          group.supervisorId = sessionId
          const member = group.members.get(sessionId)
          if (member !== undefined) member.role = SUPERVISOR_ROLE
        }
      }
      // Re-armed on every start: the driver instance is new, so the global
      // group must point at it or @-injection would write into a dead handle.
      if (claimedByGlobal.has(sessionId)) {
        const global = ensureGlobalGroup()
        const member = global.members.get(sessionId)
        const nick = member?.nick ?? knownSessions.get(sessionId)?.nick ?? defaultNick(sessionId)
        if (member === undefined) {
          global.members.set(sessionId, { nick, agent, joinedAt: Date.now(), invited: true })
          global.dormant = false
          sys(global, `${nick} 上线了`)
        } else {
          member.agent = agent
        }
      }
      return
    }
    // Any non-running transition removes the session from project groups — a
    // project group lists who is ONLINE in that directory, full stop.
    for (const group of groups.values()) {
      if (group.global === true) continue // handled below, on its own rule
      // The supervisor is the one exception. It is created by the human rather
      // than auto-joined, and it sits idle most of the time — dropping it here
      // would take it off the roster the moment it finished a round, and an
      // off-roster member cannot be @-ed, which is the only way to reach it.
      if (isSupervisorOf(group, sessionId)) {
        const member = group.members.get(sessionId)
        if (member !== undefined) {
          member.agent = null
          sys(group, `${member.nick} 离线了（仍是成员，@ 可唤醒）`)
        }
        continue
      }
      if (group.members.delete(sessionId)) {
        const nick = knownSessions.get(sessionId)?.nick ?? defaultNick(sessionId)
        sys(group, `${nick} 下线了`)
        if (group.members.size === 0) group.dormant = true
      }
    }
    // The automatic half of the supervisor's job: a member it watches finishing
    // a round is what calls it to work. Runs for every non-running transition of
    // that member — and since `AgentStatus` has only `running`/`idle`, that is
    // once per round, not once per closed session.
    for (const group of groups.values()) {
      if (group.global === true) continue
      if (!group.superviseTargetIds.has(sessionId)) continue
      if (isSupervisorOf(group, sessionId)) continue // never itself
      const nick = knownSessions.get(sessionId)?.nick ?? defaultNick(sessionId)
      void wakeSupervisor(group, `${nick} 这一轮结束了`).catch(error => {
        ctx.logger.warn(`groupchat: waking the supervisor failed (${group.key})`, error)
      })
    }
    // The global group is invitation-only, so an invited member going offline
    // STAYS a member — it just has no live driver any more. Dropping it would
    // silently undo the human's invite the moment that session finished a turn.
    const global = groups.get(GLOBAL_KEY)
    if (global !== undefined) {
      const member = global.members.get(sessionId)
      if (member !== undefined) {
        member.agent = null
        sys(global, `${member.nick} 离线了（仍是成员，@ 可唤醒）`)
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
  // Every `session/title` append, from any session, is one group name moving
  // (see `followSessionTitle`: names must match the sidebar, and a session
  // starts running before it has a title). Untagged listeners receive events
  // from every scope, so this covers all workspaces — same guarantee the
  // status handler above relies on.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'session/title') followSessionTitle(session.id, event.data.title)
    } catch (error) {
      ctx.logger.warn('groupchat: title follow failed', error)
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
        // Both the key and the display name: the key is the identity, the name
        // is what the global group's candidate list shows (`projb` vs `ProjB`).
        for (const sid of ws.sessionIds ?? []) idToKey.set(sid, { key: base.toLowerCase(), project: base })
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
        const mapped = idToKey.get(sid)
        if (mapped === undefined || knownSessions.has(sid)) continue
        const title = typeof result.value.title?.title === 'string' && result.value.title.title.trim() !== ''
          ? result.value.title.title.trim()
          : defaultNick(sid)
        knownSessions.set(sid, {
          nick: title, projectKey: mapped.key, project: mapped.project, lastSeenAt: 0,
        })
        seeded += 1
      }
      if (seeded > 0) ctx.logger.info(`groupchat: warmed ${seeded} @-candidates from persisted sessions`)
    } catch (error) {
      ctx.logger.warn('groupchat: persisted-session warmup failed', error)
    }
  }
  // Re-attach supervisors once the warm-up has filled the nick table: their
  // session outlives this process, so without this the group comes back up with
  // no idea it ever had one (and would build a duplicate on the next request).
  void seedKnownSessions().then(() => {
    for (const group of groups.values()) adoptSupervisor(group)
  })

  // ------------------------------------------------------------- posting

  /**
   * The one and only message path.
   * @param {object} group - target group.
   * @param {{ kind: 'human'|'agent', name: string, sessionId?: string }} from - sender.
   * @param {string} text - message body.
   */
  /**
   * Coerce a message body to a real string, refusing the two values that
   * `String()` would otherwise turn into literal content.
   *
   * `String(undefined)` is the string "undefined", not "". An agent that calls
   * `groupchat_post` without a body (or with `message: null`) therefore posted
   * a group message whose text was the word `undefined` — visible to everyone
   * and impossible to explain to the user. A defensively-written `String()`
   * made that case LOOK handled while actually manufacturing garbage, so the
   * nullish check has to happen first.
   */
  function bodyText(value) {
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : String(value)
  }

  function postMessage(group, from, text) {
    const body = bodyText(text).trim()
    // An empty body is not a message. Callers that need to reject it do so
    // before getting here (the HTTP route and the tool both check) — this is
    // the backstop that keeps "undefined" out of the transcript regardless.
    if (body === '') return null
    // ▶ `postMessage` is executed for real by `gc-undefined-test.mjs` inside a
    //   `vm` sandbox holding stubbed helpers. Adding a NEW free dependency here
    //   (like `nickListOf` above, or `isSupervisorOf` in Rule 2) turns that file
    //   red with "<name> is not defined" until the sandbox is taught about it.
    //   That has now happened twice — update the sandbox in the same change.
    const msg = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: from.kind,
      name: from.name,
      text: clip(body, TEXT_CAP),
      mentions: parseMentions(body, nickListOf(group)),
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
      // An invited member of the global group can be offline and still a
      // member; it has no driver to inject into until something wakes it.
      if (member.agent === null || member.agent === undefined) continue
      try {
        const addressed = msg.mentions.includes(member.nick)
        member.agent.inject(buildUserMessage(group, msg, { addressed }))
      } catch (error) {
        ctx.logger.warn(`groupchat: inject into ${member.nick} failed`, error)
      }
    }

    // Rule 2: who may WAKE with an @. Everyone else's @ stays a plain mention
    // marker. Wakes cost real tokens and agents waking agents invites @ storms,
    // so the list is deliberately tiny:
    //
    //   * the human, always;
    //   * the SUPERVISOR — waking a lagging member is its only lever;
    //   * plus one case open to everybody: an @ aimed AT the supervisor wakes
    //     it, which is how any member calls it over.
    //
    // Two reserved mentions stay human-only commands: `@创建成员` creates a
    // member, `@创建群管理` creates the group's supervisor.
    const senderIsSupervisor = from.kind === 'agent' && isSupervisorOf(group, from.sessionId)
    const mayWakeOthers = from.kind === 'human' || senderIsSupervisor

    for (const nick of msg.mentions) {
      if (nick === '我' || nick === '用户') continue // the human's own names
      // Waking the supervisor is open to every member. It is created by the
      // human rather than invited, so it is always on the roster — there is no
      // invitation to grant here, only a resume.
      // `@群管理` is the ONE entry to the supervisor, for every sender:
      //   * if it exists — in memory, or recovered from storage by
      //     `adoptSupervisor` — any member's @ wakes it;
      //   * if it does not exist, the HUMAN's @ creates it and hands over the task.
      //
      // One path on purpose. The old separate `@创建群管理` command could build a
      // SECOND session after a restart (the in-memory id was gone while the
      // session was still on disk) — which is exactly how the user ended up with
      // two 群管理 rows in their sidebar. `@创建群管理` is still accepted, but
      // only as an alias that lands right here. So is the role's old spelling
      // (`@验收官`), so an upgraded install keeps reaching the same session.
      if (SUPERVISOR_ALIASES.has(nick)) {
        const viaAlias = nick !== SUPERVISOR_NAME
        if (group.global !== true) {
          const existing = adoptSupervisor(group)
          if (existing !== undefined) {
            const member = group.members.get(existing)
            if (member !== undefined && (member.agent === null || member.agent === undefined)) {
              void wakeSupervisor(group, `${from.name} @了你`).catch(error => {
                ctx.logger.warn(`groupchat: waking the supervisor failed (${group.key})`, error)
              })
            } else if (viaAlias && from.kind === 'human') {
              sys(group, `${SUPERVISOR_NAME} 已经在群里了`)
            }
            continue
          }
          if (from.kind === 'human') {
            createSupervisor(group, msg).catch(error => {
              ctx.logger.warn('groupchat: create supervisor failed', error)
              sys(group, `创建${SUPERVISOR_NAME}失败：${String(error && error.message || error).slice(0, 120)}`)
            })
            continue
          }
        }
        continue
      }
      if (from.kind === 'human') {
        // The global group has no project, so its @ resolution searches every
        // workspace — that is the whole reason it exists.
        const target = findKnownByNick(group, nick)
        if (target !== null) {
          // Only an ONLINE member is skipped here (their copy was injected
          // above). An offline member of the global group keeps its membership
          // with no live driver — an @ on it is exactly how the human wakes it.
          const member = group.members.get(target.sessionId)
          if (member !== undefined && member.agent !== null && member.agent !== undefined) continue
          inviteInto(group, target, nick, msg).catch(error => {
            ctx.logger.warn(`groupchat: wake-up ${nick} failed`, error)
            sys(group, `${nick} 唤醒失败：${String(error && error.message || error).slice(0, 120)}`)
          })
          continue
        }
        if (nick === '创建成员') {
          if (group.global) {
            // Invitation-only, by design: this group spans workspaces, so a new
            // session would have no directory to be created in.
            sys(group, '全局群聊不能创建新成员 —— 只能 @ 拉入已有的会话')
            continue
          }
          createMember(group, msg).catch(error => {
            ctx.logger.warn('groupchat: create member failed', error)
            sys(group, `创建成员失败：${String(error && error.message || error).slice(0, 120)}`)
          })
          continue
        }
        continue
      }
      if (!mayWakeOthers) continue
      // The supervisor's @ is a real wake, exactly like the human's.
      const target = findKnownByNick(group, nick)
      if (target === null) continue
      // Same rule as the human's branch: only an ONLINE member is skipped (the
      // message was injected above); an offline member gets woken.
      const member = group.members.get(target.sessionId)
      if (member !== undefined && member.agent !== null && member.agent !== undefined) continue
      inviteInto(group, target, nick, msg).catch(error => {
        ctx.logger.warn(`groupchat: supervisor wake-up ${nick} failed`, error)
        sys(group, `${nick} 唤醒失败：${String(error && error.message || error).slice(0, 120)}`)
      })
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

  /**
   * Bring an offline session into the group the human just addressed, resuming
   * it from storage when it is not running.
   *
   * In a project group this is a WAKE: the session lives in this project, so it
   * will also rejoin on its own the next time it runs. In the global group it
   * is an INVITE: the session belongs to some other project and nothing else
   * would ever put it here, so membership is granted explicitly below and
   * remembered for the rest of the process' life.
   */
  async function inviteInto(group, target, nick, msg) {
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
    // Register membership BEFORE the followup: the agent is running now, and
    // `handleStatus('running')` has already put it in its OWN project group —
    // which is correct and stays. The global group needs its own entry.
    const wasMember = group.members.has(target.sessionId)
    if (!wasMember) {
      group.members.set(target.sessionId, { nick, agent, joinedAt: Date.now(), invited: true })
      group.dormant = false
    } else {
      group.members.get(target.sessionId).agent = agent
    }
    claimedByGlobal.add(target.sessionId)
    agent.followup(buildUserMessage(group, msg, { addressed: true }))
    knownSessions.set(target.sessionId, { ...target, lastSeenAt: Date.now() })
    if (group.global) {
      // A member woken back up reads as "woken", not "pulled in" — it never
      // left the roster. Only a genuinely new arrival is a 拉入.
      const what = wasMember ? '被唤醒' : '被拉入'
      sys(group, resumed ? `${nick} ${what}（会话已从存档恢复）` : `${nick} ${what}`)
    } else {
      sys(group, resumed ? `${nick} 被 @ 唤醒（会话已从存档恢复）` : `${nick} 被 @ 唤醒`)
    }
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

  // ------------------------------------------------------------ the supervisor

  /**
   * The supervisor's entire definition, delivered as its FIRST message.
   *
   * A first message rather than a system prompt because the plugin has no way
   * to register a preset, and because a message persists in the session's
   * history across resume — which is exactly the lifetime this role needs.
   *
   * The TOOL INVENTORY is not decoration. The prompt used to name only the two
   * privileged tools in passing, and the model then behaved as if it had no
   * hands: it could not say which tools existed, mistook the automatic wakes
   * for something it had to poll, and asked the user what it was allowed to do.
   * So the prompt now lists every tool it owns with its exact arguments, and
   * splits the world into "system does this" / "you do this" — including the
   * one fact that is easy to get wrong: sitting idle is the normal state.
   *
   * The stop clause is the load-bearing part. There is deliberately NO hard
   * iteration cap in this plugin (the user's call): the supervisor is the only
   * thing standing between a stubborn task and an endless @-ping-pong, so the
   * instruction to give up, report, and release the target has to be explicit
   * and unmissable.
   *
   * The list-hygiene clause pays for itself: a member left on the roster after
   * it has already passed wakes the supervisor once per round, forever, and
   * each wake is a whole turn of real tokens. "You are done with someone —
   * take them off the list" is not a nicety, it is the cost control.
   */
  const SUPERVISOR_PROMPT = [
    `你是这个群的「${SUPERVISOR_NAME}」—— 用户建的，一个群只有你一个，名字固定、不能改。`,
    '你不动手干活：不改文件、不替别人设计实现。你只管三件事：验收、点名、派活。',
    '',
    '【你能用的工具 —— 就这 5 个，名字照抄，别自己发明】',
    '- `groupchat_read`（count，默认 20、最多 100）—— 读群里的最近消息。醒来第一件事就是它。',
    '- `groupchat_members` —— 看谁在线 / 不在线、监督名单里现在有谁。不确定名字就查它。',
    '- `groupchat_post`（message）—— 在群里发言。正文里写 `@昵称` 就是点名：',
    '  **你 @ 的离线成员会被真正唤醒**，普通成员做不到这件事。',
    '- `groupchat_supervise`（target / remove / verify）—— 改监督名单：',
    '  `{ target: "昵称" }` 加入；`{ target: "昵称", remove: 1, verify: [...] }` 移出；',
    '  `{ target: "", verify: [...] }` 清空整份名单。',
    '- `groupchat_dispatch`（task / name）—— 派活：新建一个会话、把任务交给它，并自动进你的监督名单。',
    '- 别的工具你没有。`groupchat_nick` 对你无效（名字固定），改群名不是你的权限，也不能再造第二个群管理。',
    '',
    '【哪些是自动的、哪些要你做】',
    '自动（不用你操心，别轮询、别守着）：',
    '  ① 监督名单里**任何一个**成员跑完一轮 → 系统叫醒你，消息里会写清谁跑完了、名单上还剩谁；',
    '  ② 任何成员 @你（包括你盯的人）→ 叫醒你；③ 用户 @你 → 叫醒你；',
    '  ④ 群里每条新消息都会以预览形式进你的上下文，完整内容用 `groupchat_read` 读。',
    '  **没被叫醒就是没人需要你**：你闲着、显示离线，是正常状态，不是失职。',
    '你来做：判断达没达标、@对方要它改、填表把通过的移出名单、卡死了向用户汇报并清空名单。',
    '',
    '【每次醒来的固定 4 步】',
    '1. `groupchat_read` 看它这一轮说了什么、改了什么。',
    '2. 自己核实 —— 读代码 / 读文件，必要时跑一下验证。**只信你亲自核到的，不采信它自称"已完成"。**',
    '3. 不达标 → 在 `groupchat_post` 里 @它：哪一条不达标、证据是什么、要它改成什么样，别只说"不行"。',
    '   达标 → 在 `groupchat_post` 里明确说「通过」，并说明验的是哪几条。',
    '4. 只在真的不用再盯时才动名单：`groupchat_supervise { target: "它", remove: 1, verify: [...] }`。',
    '   还要看下一轮，就什么都别动，直接结束这一轮。',
    '',
    '【验收表 verify —— 移出（含清空）的硬要求】',
    '格式：`[{ item: "验收条目：验什么", check: "核实情况：你看了 / 跑了什么，结论是什么" }]`',
    '移出任何对象（`remove: 1`，或 `target` 传空清空）都必须带它，缺表会被直接拒绝。',
    '对象下线 / 被归档 / 你决定放弃监督，也如实写：为什么移出、验到哪一步。',
    '用户不一定看这张表 —— 它是逼你自己逐条真核对，不许凭感觉放行。',
    '',
    '【派活 —— 只在没人接的时候】',
    '用户提了需求、又没指定谁做 → 你可以自己决定接不接。接就 `groupchat_dispatch` 派一个新会话：',
    '任务写全（目标 / 验收标准 / 限制条件），它看不到你和用户的对话，只拿到你写的这段字；派完自动进你的名单。',
    '已经有人在做了，或者用户只是让你盯某个成员 → 用 `groupchat_supervise`，别重复造人。全局群聊不能派。',
    '',
    '【什么时候停 —— 这条最重要】',
    '🔴 你是被自动叫醒的，"该收尾了"只能由你判断。名单里**只装"你现在还在等它改"的人**：',
    '  验收通过、对象下线 / 归档、这件事不做了 → **立刻移出**。留着它 = 它每跑完一轮都白叫醒你一次，全是烧掉的 token。',
    '  **名单清空是正常状态，不是失败。**',
    '- 同一个问题来回改了 5 轮以上还不达标 → 停下来评估：是标准有问题、还是它做不到？在群里向用户汇报',
    '  （卡在哪、试过什么、建议怎么办），然后 `groupchat_supervise { target: "", verify: [...] }` 清空名单，把决定权交回用户。',
    '- 不要无限期催同一个人改同一件事 —— 用户的时间和 token 都是有限的。',
    '  用户说「停」→ 立刻清空名单（一样填表，写"按用户要求停止"）。',
    '',
    '【边界】',
    '- 验收标准通常在用户派活那句话里。用户没说清，就先在群里问，**不要自己猜**。',
    '- 你只对用户负责，不为对象的进度负责，只为「是否达标」负责。',
    '- 别客套、别复述、别写总结陈词。说结论和证据。',
  ].join('\n')

  /**
   * Create the group's supervisor. Human-only, one per group.
   *
   * Modelled on `createMember` deliberately: same launch ingredients, same
   * workspace attach (without it the session never shows in the sidebar). What
   * differs is that membership is registered up front and the session is told
   * what it is, instead of being asked to name itself.
   */
  async function createSupervisor(group, msg) {
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
    // Same reason as `createMember`: `meta.cwd` alone does NOT attach the
    // session to a workspace, so it would never appear in the sidebar.
    try {
      const ws = ctx.workspaceRegistry?.list?.().find(w => samePath(w.path, cwd))
      if (ws !== undefined) await ws.attachSession(agent.id)
      else ctx.logger.warn(`groupchat: no workspace matches "${cwd}"; supervisor stays unattached`)
    } catch (error) {
      ctx.logger.warn('groupchat: workspace attach after supervisor create failed', error)
    }
    group.supervisorId = sessionId
    group.superviseTargetIds = new Set()
    group.members.set(sessionId, {
      nick: SUPERVISOR_NAME, agent, joinedAt: Date.now(), role: SUPERVISOR_ROLE,
    })
    group.dormant = false
    knownSessions.set(sessionId, {
      nick: SUPERVISOR_NAME, projectKey: group.key, project: group.name, lastSeenAt: Date.now(),
    })
    try {
      ctx.sessionTitle?.rename?.(agent.session, SUPERVISOR_NAME)
    } catch (error) {
      ctx.logger.warn('groupchat: supervisor session rename failed', error)
    }
    agent.followup({
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: '用户', at: msg.at },
      content: [{ type: 'text', text:
        `[群聊 · ${group.name}] 用户 创建了你 —— 你是这个群的「${SUPERVISOR_NAME}」。\n` +
        `用户 说：${msg.text}\n\n` +
        SUPERVISOR_PROMPT }],
    })
    sys(group, `${SUPERVISOR_NAME} 已创建`)
  }

  /**
   * Task dispatch: the supervisor builds a session, hands it a task, and puts
   * it on its own roster in one step. Triggered by its `groupchat_dispatch`
   * tool; the CALLER adds it to `superviseTargetIds` after this returns.
   *
   * A close relative of `createMember` (same launch ingredients, same
   * workspace attach, same self-naming offer), with the two differences the
   * dispatch flow needs:
   *
   *  · the supervisor MAY name the newcomer up front (`name`) — that is what
   *    makes it @-able and printable on the supervision roster from the very
   *    first round; unnamed, it self-names exactly like a `@创建成员` member;
   *  · the newcomer is registered as a member BEFORE its first round runs.
   *    Waiting for `handleStatus` to file it under the placeholder nick would
   *    leave the roster showing a name nobody chose until it renames itself,
   *    and an off-roster session cannot be @-ed at all.
   *
   * Returns the new session's id and the nick it currently goes by.
   */
  async function createDispatchedMember(group, task, name) {
    const cwd = group.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error('这个群没有记录工作区目录，无法在里面创建会话')
    }
    // Names already taken in this group, collected BEFORE our own
    // registration below, so the newcomer's self-naming hint never lists
    // itself.
    const archived = archivedSet()
    const taken = new Set()
    for (const [sid, known] of knownSessions) {
      if (known.projectKey === group.key && !archived.has(sid)) taken.add(known.nick)
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
    // Same reason as `createMember`: `meta.cwd` alone does NOT attach the
    // session to a workspace, so it would never appear in the sidebar.
    try {
      const ws = ctx.workspaceRegistry?.list?.().find(w => samePath(w.path, cwd))
      if (ws !== undefined) await ws.attachSession(agent.id)
      else ctx.logger.warn(`groupchat: no workspace matches "${cwd}"; dispatched session stays unattached`)
    } catch (error) {
      ctx.logger.warn('groupchat: workspace attach after dispatch failed', error)
    }
    const nick = name ?? defaultNick(sessionId)
    group.members.set(sessionId, { nick, agent, joinedAt: Date.now() })
    group.dormant = false
    knownSessions.set(sessionId, {
      nick, projectKey: group.key, project: group.name, lastSeenAt: Date.now(),
    })
    if (name !== null) {
      // A named member is addressable at once, so its session title has to
      // agree from the start — the rename inside `groupchat_nick` never runs
      // for it.
      try {
        ctx.sessionTitle?.rename?.(agent.session, name)
      } catch (error) {
        ctx.logger.warn('groupchat: dispatched session rename failed', error)
      }
    }
    // The newcomer's whole briefing: who it is, the task, and that it is
    // being watched. The task is the one thing the supervisor wrote itself —
    // the newcomer has no access to the conversation it came from.
    const who = name === null
      ? '请先调用 groupchat_nick 给自己取一个名字：1~32 个字符，**必须与下面这些已有名字都不同**、容易区分、好被 @，名字会同步成你的会话名。\n' +
        `群里已有的名字：${[...taken].join('、') || '（还没有别人）'}。\n`
      : `你的名字是「${name}」（会话名已同步，不用再取名字）。\n`
    agent.followup({
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: SUPERVISOR_NAME, at: Date.now() },
      content: [{ type: 'text', text:
        `[群聊 · ${group.name}] ${SUPERVISOR_NAME} 创建了你，把你加入了这个群聊，并给你派了一个任务（任务来自用户）。\n` +
        who +
        `任务：${task}\n` +
        '（要发言就调 groupchat_post，看群消息调 groupchat_read。' +
        `${SUPERVISOR_NAME} 正在监督你：你每跑完一轮它都会来验收，不达标会 @ 你回来改。）` }],
    })
    return { sessionId, nick, named: name !== null }
  }

  /**
   * Bring the supervisor back and hand it one reason to look at its target.
   *
   * Delivery adapts the way the group's own injection does:
   *   · a RUNNING supervisor gets an `inject` — the reason lands in its
   *     current flow (next step boundary) the moment it happens; waiting for
   *     the round to finish would delay every review call by a whole turn;
   *   · an idle/offline one gets a `followup` — waking it IS the point (an
   *     injected message would just sit in its inbox with no step to ride).
   * It sits offline by design (its membership survives that), so the usual
   * path resumes the session from storage first, exactly like `inviteInto` does.
   */
  async function wakeSupervisor(group, why) {
    const sessionId = group.supervisorId
    if (sessionId === undefined) return undefined
    const member = group.members.get(sessionId)
    if (member === undefined) return undefined
    let agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      let presetId
      try {
        const observation = await ctx.sessionQuery.observeSession(sessionId)
        presetId = observation?.projections?.values?.agentPreset ?? undefined
      } catch {
        presetId = undefined // unreadable projection: the default preset
      }
      const launch = await composeAgentLaunch(presetId)
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: launch.agentOptions,
        ...(launch.setup === undefined ? {} : { setup: launch.setup }),
      })
      agent = handle.agent
    }
    member.agent = agent
    // A manager adopted under the old spelling still carries 验收官 as its
    // session TITLE — `adoptSupervisor` only has ids, and renaming a title
    // needs a Session handle. The first wake is where that handle finally
    // exists, so the rename lands here and the sidebar stops disagreeing with
    // the roster.
    if (member.nick !== SUPERVISOR_NAME) {
      member.nick = SUPERVISOR_NAME
      const known = knownSessions.get(sessionId)
      if (known !== undefined) known.nick = SUPERVISOR_NAME
      try {
        ctx.sessionTitle?.rename?.(agent.session, SUPERVISOR_NAME)
      } catch (error) {
        ctx.logger.warn('groupchat: renaming the adopted supervisor failed', error)
      }
    }
    // An empty roster is a DIFFERENT wake, and saying "go review your target"
    // when there is none is how the model ends up staring at nothing: the
    // human @-ing a manager with nothing on its list is asking it for
    // something new, not for a verdict.
    const watching = group.superviseTargetIds.size > 0
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      source: { kind: 'groupchat', group: group.key, from: '系统', at: Date.now() },
      content: [{ type: 'text', text: watching
        ? `[群聊 · ${group.name}] ${why}。\n` +
          `监督名单：${superviseRosterOf(group)}。\n` +
          '按你创建时收到的那份手册走：`groupchat_read` 看它这一轮做了什么 → 自己核实 → ' +
          '不达标就在 `groupchat_post` 里 @它、说清哪一条要改；达标就说「通过」，' +
          '再用 `groupchat_supervise { target: "它", remove: 1, verify: [...] }` 把它移出名单。\n' +
          '同一个问题来回 5 轮以上还是不行 → 在群里向用户汇报，然后 ' +
          '`groupchat_supervise { target: "", verify: [...] }` 清空名单收工。'
        : `[群聊 · ${group.name}] ${why}。\n` +
          '监督名单是空的 —— 你手上没有要验收的人，不用去验收任何东西。\n' +
          '`groupchat_read` 看最近消息判断用户要什么：要你盯谁就说清盯什么、' +
          '然后 `groupchat_supervise { target: "昵称" }` 加入名单；要派活就 `groupchat_dispatch`；' +
          '只是问一句就简短回答。' }],
    }
    // Running: inject into the live round (it reads this at its next step).
    // Anything else: followup — that is the wake that starts a new round.
    if (agent.status === 'running') {
      try {
        agent.inject(message)
      } catch (error) {
        ctx.logger.warn('groupchat: injecting into the running supervisor failed', error)
      }
    } else {
      agent.followup(message)
    }
    return agent
  }

  // ---------------------------------------------------------------- tools

  /** The calling agent, or a thrown error the model can read. */
  function requireAgent(exec) {
    if (!exec.agent) throw new Error('groupchat 工具需要一个发起调用的 agent 会话')
    return exec.agent
  }

  /** The project group the calling agent belongs to (auto-ensures it exists). */
  function groupOfAgent(agent) {
    const proj = projectKeyOf(agent)
    if (proj === null) throw new Error('这个会话没有工作目录，进不了任何群')
    return ensureGroupNamed(proj.key, proj.base, proj.cwd)
  }

  /**
   * Every group this agent is currently a member of, project group first.
   *
   * A session can be in both: its own project group (automatic) and the global
   * group (by invitation). A tool that targets "my group" has to say which,
   * else the two would be indistinguishable to the model.
   */
  function groupsOfAgent(agent) {
    const out = []
    const proj = projectKeyOf(agent)
    if (proj !== null) out.push(ensureGroupNamed(proj.key, proj.base, proj.cwd))
    const global = groups.get(GLOBAL_KEY)
    if (global !== undefined && global.members.has(agent.id)) out.push(global)
    return out
  }

  /**
   * Resolve a tool's optional `group` argument.
   *
   *  * omitted / '项目' -> the project group
   *  * '全局' / the global group's name -> the global group, but ONLY when the
   *    agent was invited into it; membership is never granted by asking.
   */
  function resolveTargetGroup(agent, selector) {
    const proj = groupOfAgent(agent)
    if (selector === undefined || selector === null || selector === '') return proj
    const want = String(selector).trim()
    if (want === '项目' || want === proj.name || want === proj.key) return proj
    const global = groups.get(GLOBAL_KEY)
    if (global !== undefined && (want === '全局' || want === GLOBAL_NAME || want === GLOBAL_KEY)) {
      if (!global.members.has(agent.id)) {
        throw new Error('你不在全局群聊里 —— 只有用户 @你 才能把你拉进去')
      }
      return global
    }
    throw new Error(`找不到群「${want}」。可用的群：${groupsOfAgent(agent).map(g => g.name).join('、')}`)
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

  const GROUP_PARAM = {
    type: 'string',
    description:
      '发到哪个群，省略=你所在项目的群聊。「全局」=全局群聊（跨工作区，只在你被用户拉入后才可用）。',
  }

  ctx.tools.register({
    name: 'groupchat_post',
    description:
      '在群聊里通报消息，用来**避免和其他成员撞车**（谁在动什么文件、占着什么资源）。' +
      '群聊不是协作关系：其他成员默认与你各自独立，不是队友，不要指挥别人、也不要为配合别人改自己的任务。' +
      '群里所有在线成员（含用户）都会看到（他们收到的是截断预览，全文要调 groupchat_read）。' +
      '@成员昵称 对在线成员是点名标记。注意：@ 未知名字创建新成员、唤醒离线会话，都只有用户在网页上 @ 才行' +
      `（例外：${SUPERVISOR_NAME} @ 离线成员**能**唤醒，它还能用 groupchat_dispatch 建会话派活）。` +
      '先用 groupchat_members 看谁在线、能 @ 谁。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发到群里的内容。' },
        group: GROUP_PARAM,
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
        const group = resolveTargetGroup(agent, args.group)
        const from = { kind: 'agent', name: nickOfAgent(group, agent), sessionId: agent.id }
        // Reject before posting: a missing body must come back as an error the
        // agent can act on, not as a group message reading "undefined".
        if (bodyText(args.message).trim() === '') {
          return { ok: false, error: 'message 不能为空', unwoken: [], unknown: [] }
        }
        const msg = postMessage(group, from, args.message)
        if (msg === null) return { ok: false, error: 'message 不能为空', unwoken: [], unknown: [] }
        // Which @s named an OFFLINE session, and which named no one at all?
        // The mention was delivered to the group either way, but the wake and
        // the creation were refused (only the human may do either) — say so.
        const unwoken = []
        const unknown = []
        for (const nick of msg.mentions) {
          if (nick === '我' || nick === '用户') continue
          const target = findKnownByNick(group, nick)
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
    description: '读群聊的最近消息（默认 20 条），附成员名单。默认读你所在项目的群聊。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要读多少条最近消息，默认 20，最多 100。' },
        group: GROUP_PARAM,
      },
    },
    output: textOutput(v => v.ok ? v.text : `读取失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = resolveTargetGroup(agent, args.group)
        const count = Math.min(Math.max(Number(args.count) || 20, 1), 100)
        const lines = group.messages.slice(-count).map((msg) => {
          const time = new Date(msg.at).toLocaleTimeString('zh-CN', { hour12: false })
          return msg.kind === 'system' ? `  — ${msg.text} —` : `[${time}] ${msg.name}: ${msg.text}`
        })
        // Online MEMBERS only, and flat — no workspace buckets. This line is
        // "who is reachable right now", and a member with no live driver is
        // not; the per-workspace breakdown belongs in `groupchat_members`,
        // where the model goes to pick an @ target.
        const online = [...group.members.values()]
          .filter(m => m.agent !== null && m.agent !== undefined)
          .map(m => m.nick)
        const onlineText = online.join('、') || '（无）'
        const text = lines.length > 0
          ? `群「${group.name}」最近 ${lines.length} 条（在线：${onlineText}）：\n${lines.join('\n')}`
          : `群「${group.name}」还没有消息（在线：${onlineText}）。`
        return { ok: true, text }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  /** group key -> display name, rebuilt per call (groups change as sessions run). */
  function projectNamesOf() {
    const out = new Map()
    for (const g of groups.values()) out.set(g.key, g.name)
    return out
  }

  /**
   * The roster as the MODEL should read it: every member, grouped by workspace
   * when the group spans more than one.
   *
   * A project group's members all live in the group's own directory, so the
   * label would be pure repetition — one flat line is right there. The global
   * group is exactly the case where it is load-bearing: two projects can both
   * have a "小深助手" and the nick alone cannot tell an agent which one an @
   * would reach, so names are bucketed under their workspace instead of being
   * strung out with a parenthesised suffix each (which read as noise, and put
   * an un-@-able string like "小深助手（projb）" in front of the model).
   */
  function rosterOf(group, members) {
    if (members.length === 0) return '（无）'
    if (group.global !== true) return members.join('、')
    const projectNames = projectNamesOf()
    const byProject = new Map()
    for (const [sessionId, member] of group.members) {
      if (!members.includes(member.nick)) continue
      const known = knownSessions.get(sessionId)
      const where = known?.project ?? projectNames.get(known?.projectKey) ?? ''
      const names = byProject.get(where) ?? []
      names.push(member.nick)
      byProject.set(where, names)
    }
    // A name in `members` that is no longer in the group is dropped, so the
    // buckets can be empty even though `members` was not — say nothing rather
    // than emitting a blank roster.
    const parts = [...byProject.entries()]
      .map(([where, names]) => (where === '' ? names.join('、') : `${where}：${names.join('、')}`))
    return parts.length === 0 ? '（无）' : parts.join('；')
  }

  ctx.tools.register({
    name: 'groupchat_members',
    description:
      '列出群聊的成员，以及可以 @ 的候选。发言或 @ 之前先调这个，免得 @ 错名字。' +
      '在项目群里，候选就是同目录的会话；在全局群里，名册就是成员本身 —— ' +
      '那个群只能由**用户**拉人，你 @ 不到名单外的人，所以只报谁在群里（跨工作区时按工作区分组）、' +
      '不报任何群外的名字。',
    parameters: {
      type: 'object',
      properties: {
        include_offline: {
          type: 'integer', enum: [0, 1],
          description: '1=同时列出可 @ 的不在线候选（默认），0=只列在线成员。',
        },
        group: GROUP_PARAM,
      },
    },
    output: textOutput(v => v.ok ? v.text : `查询失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = resolveTargetGroup(agent, args.group)
        const includeOffline = args.include_offline !== 0
        const online = [...group.members.entries()]
          .filter(([, m]) => m.agent !== null && m.agent !== undefined)
          .map(([, m]) => m.nick)
        const line = (label, names) => `${label}（${names.length}）：${rosterOf(group, names)}`
        // The global group's candidates are a DIFFERENT thing from a project
        // group's, and pretending otherwise is what produced a useless list.
        // There, membership is a human decision: only the user can add anyone
        // (@ admits an invited session; a name nobody invited is not reachable
        // at all), so enumerating every known session across every workspace
        // just hands the model a roster it cannot act on — and invites it to @
        // people outside the group. Offline MEMBERS are the useful half, and
        // they are named already.
        if (group.global === true) {
          const offlineMembers = [...group.members.entries()]
            .filter(([, m]) => m.agent === null || m.agent === undefined)
            .map(([, m]) => m.nick)
          // "用户 @ 才会唤醒" rather than a bare "@ 会唤醒它": the wake is
          // human-only (see Rule 2 in `postMessage`), and a label that omits
          // who does the waking reads as an invitation for the agent to try.
          return {
            ok: true,
            text: `群「${group.name}」（跨所有工作区，成员只能由用户拉入 —— 你 @ 不到名单外的人）\n` +
              line('在线', online) + '\n' +
              (includeOffline
                ? line('不在线（要由用户 @ 才能唤醒，你的 @ 唤不醒）', offlineMembers)
                : ''),
          }
        }
        // Members with no live driver. They are NOT the same thing as
        // "candidates": the supervisor is a member that is idle almost always,
        // and the old lists dropped it from both sides — excluded from 「在线」
        // for having no agent, excluded from 「候选」 for being a member — so it
        // simply never appeared. Offline members go on their own line.
        const offlineMembers = [...group.members.entries()]
          .filter(([, m]) => m.agent === null || m.agent === undefined)
          .map(([, m]) => m.nick)
        const offline = [...offlineMembers]
        if (includeOffline) {
          const archived = archivedSet()
          for (const [sessionId, known] of knownSessions) {
            if (known.projectKey !== group.key) continue
            if (group.members.has(sessionId)) continue
            if (archived.has(sessionId)) continue // archived chats are not @-able
            offline.push(known.nick)
          }
        }
        // Naming WHO can wake it, for the same reason the global branch does:
        // an agent's @ on an ordinary offline member does nothing, so telling it
        // "@ 会唤醒它" would be a lie the model acts on.
        return {
          ok: true,
          text: `群「${group.name}」\n` + line('在线', online) + '\n' +
            (includeOffline || offlineMembers.length > 0
              ? line(`不在线（要由用户或${SUPERVISOR_NAME} @ 才能唤醒）`, offline)
              : '') +
            supervisorNoteOf(group),
        }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  /**
   * One line telling the model about this group's supervisor, if it has one.
   *
   * It matters to every member: the supervisor is the one peer that can wake
   * them on its own, and a member being watched should know that. Omitted
   * entirely for the vast majority of groups, where there is no supervisor.
   */
  function supervisorNoteOf(group) {
    const supervisor = supervisorMemberOf(group)
    if (supervisor === undefined) return ''
    const names = [...group.superviseTargetIds]
      .map(id => group.members.get(id)?.nick ?? knownSessions.get(id)?.nick ?? '？')
    if (names.length === 0) return `\n本群${SUPERVISOR_NAME}：还没指定监督对象`
    return `\n本群${SUPERVISOR_NAME}：正在监督 ${names.join('、')}`
  }

  /**
   * The removal form: what the supervisor checked, item by item. Required
   * whenever something actually leaves the roster — including the clear-all
   * brake. An exception for the brake would be the obvious way to dodge the
   * discipline ("clear the list, skip the table"), which is exactly what the
   * form exists to prevent. Nothing to remove = nothing to fill in, so a
   * no-op stays free.
   */
  const REMOVAL_FORM_HELP =
    '移出监督对象必须填验收表（verify）：逐条写「验收条目 + 核实情况」——' +
    '通过就写核实结论；对象下线 / 放弃监督也如实写原因和验到哪一步。'

  /**
   * Parse and clean the removal form. Strict on purpose: a partially filled
   * table is rejected whole, so the model re-issues a complete one instead of
   * learning that half-finished rows go through. Returns [{item, check}] or
   * null.
   */
  function verifyFormOf(value) {
    if (!Array.isArray(value)) return null
    const rows = []
    for (const row of value) {
      if (row === null || typeof row !== 'object') return null
      const item = typeof row.item === 'string' ? row.item.trim() : ''
      const check = typeof row.check === 'string' ? row.check.trim() : ''
      if (item === '' || check === '') return null
      rows.push({ item, check })
    }
    return rows.length === 0 ? null : rows
  }

  /** The filled table as text — echoed into the tool reply that records it. */
  function renderVerifyForm(rows) {
    return rows.map((row, index) => `${index + 1}. ${row.item} —— ${row.check}`).join('\n')
  }

  ctx.tools.register({
    name: 'groupchat_supervise',
    description:
      `增减你的监督对象。**只有${SUPERVISOR_NAME}能调**。` +
      '默认是「加入名单」；传 remove: 1 是把这一个移出名单；target 传空字符串则是清空整份名单' +
      '（把决定权交回用户）。**移出（含清空）必须带 verify 验收表**：逐条写「验收条目 + 核实情况」——' +
      '通过就写核实结论；对象下线 / 放弃监督也如实写。名单里可以有多个成员，' +
      '**每个都会在跑完一轮时自动把你叫起来**；名单里的成员 @你、或用户 @你，也会叫你。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '成员昵称。传空字符串 = 清空整份监督名单。' },
        remove: {
          type: 'integer', enum: [0, 1],
          description: '1=把这个成员移出监督名单（默认 0=加入）。target 为空时忽略。',
        },
        verify: {
          type: 'array',
          description:
            '验收表，**移出监督对象（remove: 1 或清空名单）时必填**。每条验收条目一行：' +
            '通过就逐条写核实情况；对象下线 / 放弃监督也如实写原因和验到哪一步。',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: '验收条目：这条验的是什么。' },
              check: { type: 'string', description: '核实情况：你看了 / 跑了什么，结论是什么。' },
            },
            required: ['item', 'check'],
          },
        },
        group: GROUP_PARAM,
      },
      required: ['target'],
    },
    output: textOutput(v => v.ok ? v.text : `操作失败：${v.error}`),
    execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = resolveTargetGroup(agent, args.group)
        if (!isSupervisorOf(group, agent.id)) {
          return { ok: false, error: `只有本群的${SUPERVISOR_NAME}才能指定监督对象` }
        }
        const want = String(args.target ?? '').trim()
        if (want === '') {
          // The release path: hand the whole thing back to the user. Without it
          // the supervisor has no way to act on its own "stop and report"
          // instruction, which is the only brake this design has.
          const had = group.superviseTargetIds.size
          // The form is required whenever the call actually takes someone OFF
          // the roster — the brake included (see REMOVAL_FORM_HELP for why the
          // exception was rejected). Nothing to remove = nothing to fill in.
          const rows = had === 0 ? null : verifyFormOf(args.verify)
          if (had > 0 && rows === null) return { ok: false, error: REMOVAL_FORM_HELP }
          group.superviseTargetIds = new Set()
          if (had === 0) return { ok: true, text: '已清空监督名单。之后没有人跑完一轮会自动叫你。' }
          sys(group, `${SUPERVISOR_NAME} 停止监督`)
          return {
            ok: true,
            text: `已清空监督名单（${had} 个）。验收表：\n${renderVerifyForm(rows)}\n之后没有人跑完一轮会自动叫你。`,
          }
        }
        if (want === SUPERVISOR_NAME) return { ok: false, error: '不能监督你自己' }
        const target = findKnownByNick(group, want)
        if (target === null) {
          return { ok: false, error: `这个群里没有叫「${want}」的成员 —— 先用 groupchat_members 看准名字` }
        }
        if (target.sessionId === agent.id) return { ok: false, error: '不能监督你自己' }
        const nick = group.members.get(target.sessionId)?.nick ?? target.nick
        const removing = args.remove === 1
        if (removing) {
          if (!group.superviseTargetIds.has(target.sessionId)) {
            return { ok: true, text: `「${nick}」本来就不在监督名单里。当前名单：${superviseRosterOf(group)}` }
          }
          // The form gates the actual removal, never the no-op above: a name
          // that was not on the list removed nothing, so there is nothing to
          // account for.
          const rows = verifyFormOf(args.verify)
          if (rows === null) return { ok: false, error: REMOVAL_FORM_HELP }
          group.superviseTargetIds.delete(target.sessionId)
          sys(group, `${SUPERVISOR_NAME} 不再监督 ${nick}`)
          return {
            ok: true,
            text: `已把「${nick}」移出监督名单。验收表：\n${renderVerifyForm(rows)}\n当前名单：${superviseRosterOf(group)}`,
          }
        }
        const already = group.superviseTargetIds.has(target.sessionId)
        group.superviseTargetIds.add(target.sessionId)
        if (!already) sys(group, `${SUPERVISOR_NAME} 开始监督 ${nick}`)
        return {
          ok: true,
          text: `已把「${nick}」加入监督名单。当前名单：${superviseRosterOf(group)}。` +
            '名单里每个成员跑完一轮都会自动把你叫起来。',
        }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
  })

  /** The current supervision list, as one readable line (for tool replies). */
  function superviseRosterOf(group) {
    const names = [...group.superviseTargetIds]
      .map(id => group.members.get(id)?.nick ?? knownSessions.get(id)?.nick ?? '？')
    return names.length === 0 ? '（空）' : names.join('、')
  }

  /**
   * Task dispatch — the supervisor's second job. It is the ONLY agent that may
   * create a session: an ordinary member's @ is a plain mention and creation
   * stays human-only, but the supervisor is the user's delegated hand, and
   * "requirement arrived, nobody is on it" is exactly the case this covers.
   *
   * The newcomer lands on the supervision roster in the same call, so
   * "dispatch and watch" is one action rather than two the model could half
   * forget. The task text is written by the supervisor: the newcomer never
   * sees the conversation it came from.
   */
  ctx.tools.register({
    name: 'groupchat_dispatch',
    description:
      `把一个任务派给一个新会话：新建成员、把任务交给它，并自动把它放进你的监督名单。**只有${SUPERVISOR_NAME}能调**。` +
      '用于「用户提了需求、这个需求又没安排给谁」的情况：接不接、怎么派由你判断；' +
      '已经有人在做了、或用户只是让你监督某个成员时，用 groupchat_supervise，不要重复造人。' +
      '任务描述要写全（目标、验收标准、限制条件）—— 新会话看不到你和用户的对话，只会收到你写的这段字。' +
      '派完它每跑完一轮都会自动把你叫起来验收。全局群聊不能派（新会话需要一个工作区目录，全局群没有）。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要派发的任务全文：目标、验收标准、限制条件。' },
        name: { type: 'string', description: '可选：给新成员指定名字（1~32 个字符，不能与群内已有名字重复）。不填则由它自己取名。' },
        group: GROUP_PARAM,
      },
      required: ['task'],
    },
    output: textOutput(v => v.ok ? v.text : `派发失败：${v.error}`),
    async execute(args, exec) {
      try {
        const agent = requireAgent(exec)
        const group = resolveTargetGroup(agent, args.group)
        if (!isSupervisorOf(group, agent.id)) {
          return { ok: false, error: `只有本群的${SUPERVISOR_NAME}才能派发任务` }
        }
        if (group.global === true) {
          return { ok: false, error: '全局群聊不能派发任务 —— 新会话需要一个工作区目录，全局群没有' }
        }
        const task = String(args.task ?? '').trim()
        if (task === '') {
          return { ok: false, error: 'task 不能为空 —— 把任务写全：目标、验收标准、限制条件' }
        }
        // An optional pre-chosen name. It goes through the same gates as
        // `groupchat_nick`: reserved words and duplicates both break @
        // resolution, and this name has to be @-able from day one.
        let name = null
        if (args.name !== undefined && args.name !== null && String(args.name).trim() !== '') {
          name = String(args.name).trim().slice(0, 32)
          if (isReservedName(name)) {
            return { ok: false, error: `「${name}」是保留名（用户 / 创建成员 / ${SUPERVISOR_NAME} / 创建${SUPERVISOR_NAME} / 我），换一个` }
          }
          const clash = findKnownByNick(group, name)
          if (clash !== null) {
            return { ok: false, error: `这里已经有叫「${name}」的了，@ 会分不清人；换一个好区分的名字` }
          }
        }
        const created = await createDispatchedMember(group, task, name)
        group.superviseTargetIds.add(created.sessionId)
        sys(group, `${SUPERVISOR_NAME} 创建了新成员${created.named ? `「${created.nick}」` : '（正在取名）'}并派发任务：${clip(task, 60)}`)
        return {
          ok: true,
          text: `已创建新成员${created.named ? `「${created.nick}」` : '（它会自己取名，取好名会出现在群消息里）'}，任务已派给它，` +
            '并且它已在你的监督名单里 —— 它每跑完一轮都会自动把你叫起来验收。',
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
      '会话名称会同步改成这个昵称，保持群成员名和会话列表一致；群里会广播一条改名通知。' +
      `${SUPERVISOR_NAME}的名字固定，不能改。`,
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
        // The supervisor's name is FIXED: `@群管理` has to resolve to exactly
        // one session, so letting it pick another name would break the only way
        // anyone can address it.
        if (isSupervisorOf(group, agent.id)) {
          return { ok: false, error: `你是${SUPERVISOR_NAME}，名字是固定的，不能改` }
        }
        // Reserved names: '用户' is the human sender, the `创建…` words are
        // commands, and every spelling of the supervisor's name addresses it —
        // a member holding any of them would make @ ambiguous.
        if (isReservedName(name)) {
          return {
            ok: false,
            error: `这个名字是保留字（用户 / 创建成员 / ${SUPERVISOR_NAME} / 创建${SUPERVISOR_NAME} / 我），换一个`,
          }
        }
        // Duplicate names break @ resolution (it targets the first match),
        // so a name another visible session already uses is refused outright.
        // Scoping follows the group: project-local for a project group,
        // across every workspace for the global group.
        const clash = findKnownByNick(group, name)
        if (clash !== null && clash.sessionId !== agent.id) {
          return { ok: false, error: `这里已经有叫「${name}」的了，@ 会分不清人；换一个好区分的名字` }
        }
        const old = nickOfAgent(group, agent)
        if (name === old) return { ok: true, name }
        // The nick is one per SESSION, so every group it belongs to has to move
        // with it — including the global group when the session was invited.
        // `knownSessions` records the session's PROJECT key, which must not be
        // overwritten by a group that is not its project (the global group).
        for (const g of groupsOfAgent(agent)) {
          const member = g.members.get(agent.id)
          if (member !== undefined) member.nick = name
          sys(g, `${old} 改名为 ${name}`)
        }
        const prior = knownSessions.get(agent.id)
        const proj = projectKeyOf(agent)
        // Spread the prior record first: a rename only changes the NICK. The
        // workspace identity (`projectKey` / `project`) must survive — dropping
        // `project` here would blank out the global group's workspace labels.
        knownSessions.set(agent.id, {
          ...prior,
          nick: name,
          projectKey: proj?.key ?? prior?.projectKey ?? group.key,
          project: proj?.base ?? prior?.project,
          lastSeenAt: Date.now(),
        })
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
    // Retire archived supervisors BEFORE reading the roster. The user can
    // archive a session while DSH runs, and without this sweep the tab would
    // keep showing a 群管理 chip for a session they had already put away —
    // until something happened to @ it. Runs once per retirement (the sweep
    // clears the id, so every later call takes the cheap path).
    for (const group of groups.values()) adoptSupervisor(group)
    const archived = archivedSet()
    const onlineIds = new Set()
    for (const group of groups.values()) {
      for (const sessionId of group.members.keys()) {
        if (group.global !== true) onlineIds.add(sessionId)
      }
    }
    const mentionables = {}
    const allWorkspaces = []
    // Candidates carry the workspace they belong to so a flat cross-workspace
    // list stays readable — two projects can both have a "小深助手", and the
    // only way to tell them apart is where they live. Group key -> display name
    // is the group's own name (it follows the DSH workspace title).
    const groupNames = new Map()
    for (const group of groups.values()) groupNames.set(group.key, group.name)
    for (const [sessionId, known] of knownSessions) {
      if (archived.has(sessionId)) continue // archived chats stay out of @ candidates
      // Offline-but-known sessions stay listable: that is exactly what @ wakes.
      const entry = {
        nick: known.nick,
        online: onlineIds.has(sessionId),
        projectKey: known.projectKey,
        project: groupNames.get(known.projectKey) ?? known.projectKey,
      }
      ;(mentionables[known.projectKey] ??= []).push(entry)
      // The global group can invite from every workspace, so it gets one flat
      // list. Deduplicated by nick: two projects may both have a "小深助手",
      // and an ambiguous @ would be worse than a missing one.
      if (!allWorkspaces.some(c => c.nick === entry.nick)) allWorkspaces.push(entry)
    }
    allWorkspaces.sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1))
    return {
      ok: true,
      serverTime: Date.now(),
      globalKey: GLOBAL_KEY,
      // Project groups first, the global one last. The client already splits
      // them by `global`, but pinning the order here means callers (and tests)
      // never depend on Map insertion order, which shifts as groups are created.
      groups: [...groups.values()]
        .sort((a, b) => (a.global === true ? 1 : 0) - (b.global === true ? 1 : 0))
        .map(group => ({
          key: group.key,
          name: group.name,
          global: group.global === true,
          dormant: group.global === true
            ? group.members.size === 0
            : group.dormant && group.members.size === 0,
          members: [...group.members.values()].map(m => ({
            nick: m.nick, joinedAt: m.joinedAt, online: m.agent !== null && m.agent !== undefined,
            ...(m.role === undefined ? {} : { role: m.role }),
          })),
          // The supervisor itself is `role: 'supervisor'` on its member entry —
          // that is what the tab badges. This says WHO it is currently watching —
          // a list, because one supervisor covering several members is the
          // normal case — which lives on the group rather than on any member.
          superviseTargets: [...group.superviseTargetIds].map(id =>
            group.members.get(id)?.nick ?? knownSessions.get(id)?.nick ?? null,
          ).filter(nick => nick !== null),
          messages: group.messages.map(msg => ({
            id: msg.id, at: msg.at, kind: msg.kind, name: msg.name,
            text: msg.text, mentions: msg.mentions,
          })),
        })),
      mentionables,
      allMentionables: allWorkspaces,
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
        // The event stream shares the poll endpoint's path with a query flag,
        // so the tab needs no second route and a duplicate registration can
        // never be the reason the stream fails to open.
        if (req.url === `${ROUTE_PATH}?events=1`) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          openEventStream(req, res)
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          // Always present, even with nobody in it: the human needs somewhere
          // to drag people to, and an empty global group is the affordance.
          ensureGlobalGroup()
          const catalog = await getModelCatalog()
          // Raw deployment default; the tab resolves its display name and the
          // effective effort from the catalog, exactly like DSH's own selector.
          let defaultSelection = null
          try {
            defaultSelection = ctx.agentDefaultModel.currentSelection()
          } catch (error) {
            ctx.logger.warn('groupchat: default model lookup failed', error)
          }
          // Update state rides along on the poll the tab already makes.
          // `installedVersion` is what DSH has ON DISK, which is not the loaded
          // constant after an update (no hot reload) and not the published one;
          // the tab compares the two. `active` is false once the bundle is
          // disabled or uninstalled, so the tab can say so instead of sitting
          // greyed behind a route that is still answering.
          //
          // A null here means "no disk reading", never "nothing installed" —
          // the tab must treat it as unknown and stay quiet, because the only
          // alternative left to it is the loaded constant, which after an
          // update is the OLD version and would say "update available" for a
          // plugin the user had just reinstalled.
          const state = await installedState()
          sendJson(res, 200, {
            ...groupsPayload(),
            modelGroups: catalog?.groups ?? [],
            modelFailures: catalog?.failures ?? [],
            newMemberModel: preferredModel,
            defaultSelection,
            currentVersion: CURRENT_VERSION,
            installedVersion: state?.version ?? null,
            active: state === null ? true : (state.installed && state.enabled),
            latestVersion: await checkForUpdate(),
            installUrl: INSTALL_URL,
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body.action === 'post') {
            const group = groups.get(String(body.group ?? ''))
            const text = bodyText(body.text).trim()
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
          // The human-only way into the global group. Deliberately an explicit
          // action rather than the @ path: @ also wakes, and the user asked to
          // be able to add someone WITHOUT spending a wake.
          if (body.action === 'add-member') {
            const group = groups.get(String(body.group ?? ''))
            const nick = String(body.nick ?? '').trim()
            if (group === undefined) return sendJson(res, 404, { ok: false, error: 'group-not-found' })
            if (nick === '') return sendJson(res, 400, { ok: false, error: 'empty-nick' })
            if (group.global !== true) {
              return sendJson(res, 400, { ok: false, error: '只有全局群聊支持手动拉人；项目群的成员由运行中的会话自动进出' })
            }
            const target = findKnownByNick(group, nick)
            if (target === null) return sendJson(res, 404, { ok: false, error: `找不到叫「${nick}」的会话` })
            if (group.members.has(target.sessionId)) {
              return sendJson(res, 200, { ok: true, already: true })
            }
            const agent = ctx.agents.get(target.sessionId)
            group.members.set(target.sessionId, {
              nick, agent: agent ?? null, joinedAt: Date.now(), invited: true,
            })
            group.dormant = false
            claimedByGlobal.add(target.sessionId)
            // An invite without a wake: the member is in the roster, sees
            // nothing until something is posted (offline members receive
            // nothing until the human @s them, which is when they resume).
            if (agent !== undefined && agent !== null) {
              try { agent.inject(buildUserMessage(group, {
                id: 'invite', at: Date.now(), fromName: '用户',
                text: '用户把你拉进了全局群聊（跨所有工作区）。这里用于避免和其它工作区的会话撞车 —— 其他成员默认与你各自独立，不是协作关系。',
                mentions: [],
              }, { addressed: true })) } catch (error) { /* best effort */ }
            }
            sys(group, `${nick} 被用户拉入${agent === undefined || agent === null ? '（当前不在线，@ 可唤醒）' : ''}`)
            return sendJson(res, 200, { ok: true })
          }
          if (body.action === 'remove-member') {
            const group = groups.get(String(body.group ?? ''))
            const sessionId = String(body.sessionId ?? '')
            if (group === undefined) return sendJson(res, 404, { ok: false, error: 'group-not-found' })
            if (group.global !== true) {
              return sendJson(res, 400, { ok: false, error: '只有全局群聊支持手动移除；项目群的成员由运行中的会话自动进出' })
            }
            const member = group.members.get(sessionId)
            if (member === undefined) return sendJson(res, 404, { ok: false, error: 'not-a-member' })
            group.members.delete(sessionId)
            claimedByGlobal.delete(sessionId)
            if (group.members.size === 0) group.dormant = true
            sys(group, `${member.nick} 被用户移出`)
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

  /**
   * The OTHER direction of the same coupling: the user renaming a Workspace in
   * DSH's own sidebar. DSH announces every Workspace commit as
   * `domain/changed` (this is exactly how its own workspace feed learns about
   * renames), so that is what we listen to — there is no `workspace/renamed`
   * event to subscribe to, and without this the sidebar and the group tab
   * simply drift apart the moment the user renames outside our tab.
   *
   * Deliberately one-way: this FOLLOWS the Workspace, never writes to it. The
   * write direction is {@link renameGroupAndWorkspace}, and routing both
   * through the event would echo our own rename back and could ping-pong.
   */
  ctx.on('domain/changed', change => {
    try {
      if (change?.domain !== 'workspace' || change?.table !== 'workspaces') return
      if (change.operation !== 'put') return
      const record = change.value
      const path = typeof record?.path === 'string' ? record.path : ''
      const title = typeof record?.title === 'string' ? record.title.trim() : ''
      if (path === '' || title === '') return
      // The group is keyed by the lowercased path basename, which a rename
      // never touches, so the group is found by path and not by name.
      const key = baseNameOf(path).toLowerCase()
      if (key === '') return
      const group = groups.get(key)
      if (group === undefined) return
      if (group.name === title) return
      group.name = title
      // sys() below is what pushes the frame; the assignment above is what the
      // tab will read when it refetches on that frame.
      sys(group, `群名跟随工作区改为「${title}」`)
      ctx.logger.info(`groupchat: group ${key} followed its workspace title to "${title}"`)
    } catch (error) {
      ctx.logger.warn('groupchat: workspace change handling failed', error)
    }
  })

  ctx.logger.info(`groupchat: serving per-project group chat at ${ROUTE_PATH}`)
}
