/**
 * dsh-groupchat — browser half (web client).
 *
 * Registers the 「群聊」 tab into the conversation ViewMap. Pure consumer of the
 * host's /groupchat route: poll for the group list, post human messages and
 * renames back. The @-mention popup completes against the host-provided
 * candidate list (online members + known offline sessions of that project).
 *
 * Hand-written closure-factory bundle: the host serves it verbatim and the
 * browser registers it through window.__ModuleLoader__. Only react is
 * required from the platform-shared modules.
 */

window.__ModuleLoader__.load({
  id: 'dsh-groupchat',
  factory: function (require) {
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var POLL_MS = 5000

    // The conversation "active" phase lets .viewArea grow with content and
    // scrolls the whole view in the resident scrollport. For an app-like chat
    // layout (own scrolling feed + pinned composer) we re-constrain the host
    // wrapper while OUR view is mounted, keyed off a marker attribute.
    // :has() is guaranteed available (DSH's own ConversationRoot CSS uses it).
    var layoutStyle = document.createElement('style')
    layoutStyle.textContent =
      "[data-slot='conversation.session']:has([data-groupchat-root]) {" +
      ' flex: 1 1 0 !important; min-height: 0 !important; display: flex !important;' +
      ' flex-direction: column !important; overflow: hidden !important; }' +
      "[data-slot='conversation.session']:has([data-groupchat-root]) > div {" +
      ' flex: 1 1 0 !important; min-height: 0 !important; overflow: hidden !important; }'
    document.head.appendChild(layoutStyle)

    var LAST_GROUP_KEY = 'dsh-groupchat.lastGroup'
    var SIDEBAR_KEY = 'dsh-groupchat.sidebarCollapsed'

    /** Remember the group the user looked at last, across tab switches/reloads. */
    function rememberGroup(key) {
      try { window.localStorage.setItem(LAST_GROUP_KEY, key) } catch (e) { /* private mode etc. */ }
    }

    function recalledGroup() {
      try { return window.localStorage.getItem(LAST_GROUP_KEY) } catch (e) { return null }
    }

    /** Sidebar collapsed? Remembered, so a reload does not re-open it. */
    function readCollapsed() {
      try { return window.localStorage.getItem(SIDEBAR_KEY) === '1' } catch (e) { return false }
    }

    function rememberCollapsed(collapsed) {
      try {
        if (collapsed) window.localStorage.setItem(SIDEBAR_KEY, '1')
        else window.localStorage.removeItem(SIDEBAR_KEY)
      } catch (e) { /* private mode etc. */ }
    }

    /** The panel-toggle glyph: a rounded frame with its left column filled. */
    function PanelIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, style: { display: 'block', flexShrink: 0 } },
        h('rect', { x: 1.4, y: 2.6, width: 13.2, height: 10.8, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M3.4 2.6h3.1v10.8H3.4a2 2 0 0 1-2-2V4.6a2 2 0 0 1 2-2z', fill: 'currentColor', opacity: 0.9 }))
    }

    var styles = {
      root: { display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.6 },
      sidebar: { width: '180px', flexShrink: 0, borderRight: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)', padding: '10px 8px', display: 'flex', flexDirection: 'column', minHeight: 0 },
      sideList: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      searchWrap: { flexShrink: 0, marginBottom: '8px' },
      searchInput: { width: '100%', height: '26px', padding: '0 8px', fontSize: '12px', borderRadius: '8px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', outline: 'none' },
      sideCount: { marginLeft: 'auto', fontSize: '11px', opacity: 0.55, fontWeight: 400 },
      sideTitle: { fontSize: '11px', opacity: 0.55, margin: '0 0 8px 6px' },
      // The global group's own block, pinned BELOW the project list and above
      // the settings area. It is not a project, so it must not sit among them —
      // and keeping it out of the scrolling list means it never scrolls away.
      globalWrap: { flexShrink: 0, padding: '8px 8px 0', marginTop: '8px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)' },
      globalItem: { border: '0.5px solid color-mix(in srgb, #378ADD 45%, transparent)', marginBottom: 0 },
      groupItem: { borderRadius: '8px', padding: '8px 10px', marginBottom: '4px', cursor: 'pointer' },
      groupItemActive: { background: 'color-mix(in srgb, currentColor 8%, transparent)' },
      groupName: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupPreview: { fontSize: '11px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '3px 0 0' },
      modelRowWrap: { flexShrink: 0, position: 'relative', marginTop: '8px', paddingTop: '8px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)' },
      // The card and rows copy DSH's own model selector (ModelSelect.module.css):
      // 20px card, 4px padding, 40px root cells, 38px options, 10px radii.
      //
      // The surface MUST be opaque. This card floats up over the sidebar
      // (`bottom: 100%`), so anything showing through it collides with the card's
      // own text — the group preview line ("跨工作区 · @名字 拉人进来") was
      // landing right on top of the note at the bottom of this card.
      //
      // 🔴 Do NOT paint this with `--dsw-specific-menu`. That token is
      // translucent BY DESIGN — every definition DSH ships carries alpha
      // (`rgba(48, 49, 54, .94)`, `rgba(67, 69, 74, .45)`, `#303136f0`,
      // `#43454a73`) because DSH pairs it with `backdrop-filter` on its own
      // menus, and the blur is what keeps them legible.
      //
      // This card has no backdrop filter, so that alpha is just see-through:
      // whatever sits behind it (the sidebar's group list, its preview lines)
      // reads as ghost text inside the card. Both fixes have to line up —
      // first the 8% `currentColor` fallback went, then the token itself.
      //
      // `--dsw-alias-bg-layer-3` is the opaque surface `--dsw-specific-menu`
      // aliases to: dark `rgb(53, 54, 56)`, light `rgb(255, 255, 255)`. The
      // literal fallback matches the dark value so an unresolvable token still
      // yields an opaque card.
      modelCard: { position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: '8px', zIndex: 20, display: 'flex', flexDirection: 'column', maxHeight: '280px', overflow: 'hidden', padding: '4px', borderRadius: '20px', background: 'var(--dsw-alias-bg-layer-3, #353638)', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,0.28))', color: 'var(--dsw-alias-label-primary, inherit)' },
      modelScroll: { minHeight: 0, overflowY: 'auto' },
      modelCell: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', height: '40px', padding: '0 10px', border: 'none', borderRadius: '10px', background: 'transparent', color: 'inherit', fontSize: '14px', lineHeight: '22px', textAlign: 'left', cursor: 'pointer' },
      modelCellLabel: { flex: '0 0 auto', whiteSpace: 'nowrap' },
      modelCellValue: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary, currentColor)', opacity: 0.75 },
      modelCellChevron: { flex: '0 0 auto', opacity: 0.6, fontSize: '12px' },
      modelGroupTitle: { position: 'sticky', top: 0, padding: '5px 8px 3px', background: 'inherit', color: 'var(--dsw-alias-label-tertiary, currentColor)', opacity: 0.7, fontSize: '12px', lineHeight: '18px', fontWeight: 500 },
      modelOption: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '38px', padding: '6px 8px', border: 'none', borderRadius: '10px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
      modelOptionName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
      modelCheck: { flex: '0 0 18px', textAlign: 'center' },
      modelNote: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px 6px', marginTop: '4px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)', fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary, currentColor)', opacity: 0.8 },
      modelReset: { marginLeft: 'auto', flexShrink: 0, fontWeight: 600, color: '#378ADD', cursor: 'pointer' },
      modelTrigger: { display: 'flex', alignItems: 'center', gap: '4px', width: '100%', height: '28px', padding: '0 4px 0 8px', border: '0.5px solid color-mix(in srgb, currentColor 20%, transparent)', borderRadius: '24px', background: 'transparent', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '13px', lineHeight: '20px', fontWeight: 500, cursor: 'pointer', textAlign: 'left' },
      modelTriggerLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      modelTriggerEffort: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-caption, currentColor)', opacity: 0.65 },
      modelChevron: { flex: '0 0 auto', marginLeft: 'auto', opacity: 0.6, fontSize: '11px', transition: 'transform 120ms ease' },
      modelChevronOpen: { transform: 'rotate(180deg)' },
      // Update notice: one line at the very bottom of the sidebar. Kept quiet
      // (amber, not a filled block) so it reads as information, not an alert
      // that competes with the group list.
      updateRow: { flexShrink: 0, position: 'relative', marginTop: '8px' },
      updateBar: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '5px 8px', border: '0.5px solid #BA7517', borderRadius: '8px', background: 'color-mix(in srgb, #BA7517 12%, transparent)', color: 'inherit', fontSize: '12px', lineHeight: '18px', textAlign: 'left', cursor: 'pointer' },
      updateBarLabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      updateBarAction: { flex: '0 0 auto', fontWeight: 500, color: '#BA7517' },
      // Wider than the sidebar on purpose: the address and the three steps do
      // not fit in 180px, and a card clipped to the sidebar width was both
      // cramped and unreadable. Anchored to the row's LEFT edge and allowed to
      // run past the sidebar border, with a real opaque surface — the model
      // card below already reads as solid, and matching it is what makes this
      // look like part of the same UI.
      updateCard: { position: 'absolute', left: 0, width: '340px', bottom: '100%', marginBottom: '8px', zIndex: 30, display: 'flex', flexDirection: 'column', padding: '12px', borderRadius: '16px', background: 'var(--dsw-specific-menu, #1c1c1e)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '0.5px solid color-mix(in srgb, currentColor 20%, transparent)', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,0.28))', color: 'var(--dsw-alias-label-primary, inherit)' },
      updateCardTitle: { display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
      updateClose: { flex: '0 0 auto', marginLeft: 'auto', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.5, fontSize: '14px', lineHeight: '18px', cursor: 'pointer', padding: '0 2px' },
      updateSteps: { margin: '10px 0 0', padding: 0, listStyle: 'none', counterReset: 'gcstep' },
      updateStep: { display: 'flex', gap: '8px', margin: '0 0 8px', fontSize: '12px', lineHeight: '18px' },
      updateStepNum: { flex: '0 0 16px', height: '16px', marginTop: '1px', borderRadius: '50%', background: 'color-mix(in srgb, currentColor 12%, transparent)', fontSize: '10px', lineHeight: '16px', textAlign: 'center', fontWeight: 500 },
      updateStepBody: { flex: '1 1 auto', minWidth: 0 },
      updateStepNote: { display: 'block', marginTop: '1px', opacity: 0.6, fontSize: '11px', lineHeight: '16px' },
      updateUrlRow: { display: 'flex', alignItems: 'center', gap: '6px', margin: '2px 0 0' },
      updateUrl: { flex: '1 1 auto', minWidth: 0, padding: '5px 8px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '8px', background: 'transparent', color: 'inherit', fontSize: '11px', lineHeight: '16px', fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      updateCopy: { flex: '0 0 auto', padding: '5px 10px', border: '0.5px solid #378ADD', borderRadius: '8px', background: 'transparent', color: '#378ADD', fontSize: '12px', lineHeight: '16px', cursor: 'pointer' },
      updateCopyDone: { borderColor: '#1D9E75', color: '#1D9E75' },
      updateCopyFail: { borderColor: '#BA7517', color: '#BA7517' },
      updateFoot: { margin: '8px 0 0', paddingTop: '8px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)', fontSize: '11px', lineHeight: '16px', opacity: 0.6 },
      onlineBadge: { fontSize: '11px', borderRadius: '8px', padding: '1px 7px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', whiteSpace: 'nowrap' },
      main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
      head: { padding: '10px 14px 8px', borderBottom: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)' },
      headRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      groupTitle: { fontSize: '14px', fontWeight: 500 },
      toggleBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', padding: 0, borderRadius: '6px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', flexShrink: 0, opacity: 0.75 },
      renameBtn: { fontSize: '11px', opacity: 0.55, border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '8px', padding: '1px 8px', cursor: 'pointer', background: 'transparent', color: 'inherit' },
      chips: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '10px', padding: '2px 9px' },
      // The workspace heading inside the chip row (global group only): a plain
      // label, deliberately without a border so it does not read as a member.
      chipGroup: { fontSize: '11px', opacity: 0.5, marginLeft: '2px' },
      dot: { width: '6px', height: '6px', borderRadius: '50%', background: '#1D9E75', display: 'inline-block' },
      headHint: { fontSize: '11px', opacity: 0.45, margin: '6px 0 0' },
      feed: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      sysLine: { textAlign: 'center', fontSize: '11px', opacity: 0.45, margin: 0 },
      bubble: { maxWidth: '80%', borderRadius: '8px', padding: '8px 12px' },
      bubbleHuman: { alignSelf: 'flex-end', background: 'color-mix(in srgb, currentColor 10%, transparent)' },
      bubbleAgent: { alignSelf: 'flex-start', background: 'color-mix(in srgb, currentColor 5%, transparent)' },
      bubbleMeta: { fontSize: '11px', opacity: 0.55, margin: '0 0 3px' },
      bubbleText: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      mention: { fontWeight: 500, color: '#378ADD' },
      composer: { padding: '10px 14px', borderTop: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)', position: 'relative' },
      composerRow: { display: 'flex', gap: '8px' },
      input: { flex: 1, fontSize: '13px', padding: '6px 10px', borderRadius: '8px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', outline: 'none' },
      sendBtn: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      popup: { position: 'absolute', bottom: '100%', left: '14px', marginBottom: '6px', minWidth: '200px', border: '0.5px solid color-mix(in srgb, currentColor 30%, transparent)', borderRadius: '8px', background: 'color-mix(in srgb, currentColor 9%, transparent)', backdropFilter: 'blur(10px)', padding: '4px 0', zIndex: 10 },
      popupHead: { display: 'flex', alignItems: 'center', padding: '0 8px 4px' },
      popupFilter: { flex: 1, minWidth: 0, fontSize: '11px', padding: '3px 8px', borderRadius: '6px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', outline: 'none' },
      // Capped height with its own scroll: the popup sits over the feed, so it
      // must never grow to the point of hiding the conversation. Every match is
      // in here — the list scrolls rather than truncating.
      popupList: { maxHeight: '216px', overflowY: 'auto', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)' },
      popupItem: { padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
      // Where a candidate lives. Offline is stated once for the whole list, so
      // per-row hints stay down to just this — the workspace, which differs.
      popupWhere: { fontSize: '11px', opacity: 0.5, marginLeft: 'auto', paddingLeft: '8px', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      popupEmpty: { fontSize: '11px', opacity: 0.5, margin: '6px 10px' },
      popupNote: { fontSize: '11px', opacity: 0.5, margin: 0, padding: '4px 10px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)' },
      popupCreate: { borderTop: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)', marginTop: '2px', color: '#378ADD' },
      empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.45, fontSize: '13px' },
      gone: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '24px', textAlign: 'center' },
      goneTitle: { margin: 0, fontSize: '14px', fontWeight: 500 },
      goneBody: { margin: 0, maxWidth: '380px', fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
    }

    function fmtTime(at) {
      var d = new Date(at)
      var p = function (n) { return String(n).padStart(2, '0') }
      return p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /**
     * Is `latest` strictly newer than `current`? Same rules as the host's
     * compareVersions (numeric, prerelease suffix stripped, unknown = no):
     * the host uses it to decide WHAT to report, this decides WHETHER to show
     * what it reported, and the two must never disagree.
     */
    function isNewerVersion(latest, current) {
      var parse = function (v) {
        return String(v === null || v === undefined ? '' : v)
          .split('-')[0]
          .split('.')
          .map(function (part) { return Number.parseInt(part, 10) })
      }
      var left = parse(latest)
      var right = parse(current)
      if (left.length === 0 || right.length === 0) return false
      var usable = function (list) { return list.every(function (n) { return Number.isFinite(n) }) }
      if (!usable(left) || !usable(right)) return false
      var len = Math.max(left.length, right.length)
      for (var i = 0; i < len; i++) {
        var diff = (left[i] || 0) - (right[i] || 0)
        if (diff !== 0) return diff > 0
      }
      return false
    }

    /** Render message text with @mentions highlighted. */
    function renderText(text) {
      var parts = String(text).split(/(@[^\s@，,。；;：:]{1,32})/g)
      return parts.map(function (part, i) {
        return part.startsWith('@')
          ? h('span', { key: i, style: styles.mention }, part)
          : part
      })
    }

    function GroupchatView() {
      var _data = useState(null), data = _data[0], setData = _data[1]
      var _sel = useState(null), selected = _sel[0], setSelected = _sel[1]
      var _draft = useState(''), draft = _draft[0], setDraft = _draft[1]
      var _renaming = useState(false), renaming = _renaming[0], setRenaming = _renaming[1]
      var _renameVal = useState(''), renameVal = _renameVal[0], setRenameVal = _renameVal[1]
      var _err = useState(''), error = _err[0], setError = _err[1]
      var feedRef = useRef(null)
      // `uninstalled` is a REF on purpose: it gates the poll, which must stop
      // the instant the route 404s and must not restart because a render
      // happened. The visible notice is driven by `gone` (state) instead —
      // mutating a ref alone would not re-render, and the panel would stay
      // frozen on whatever it was showing. Two values, two jobs.
      var uninstalled = useRef(false)
      var _gone = useState(false), gone = _gone[0], setGone = _gone[1]
      var pollTimer = useRef(null)
      var stickBottom = useRef(true)
      var _collapsed = useState(readCollapsed), collapsed = _collapsed[0], setCollapsed = _collapsed[1]
      var _modelOpen = useState(false), modelOpen = _modelOpen[0], setModelOpen = _modelOpen[1]
      var _modelPane = useState('root'), modelPane = _modelPane[0], setModelPane = _modelPane[1]
      var _query = useState(''), query = _query[0], setQuery = _query[1]
      // Filter typed INSIDE the @ popup. The list of candidate sessions grows
      // with every workspace the user has, and a dropdown tall enough to hold
      // them all would cover the feed — this keeps it short instead.
      var _pick = useState(''), pickFilter = _pick[0], setPickFilter = _pick[1]
      var _updateOpen = useState(false), updateOpen = _updateOpen[0], setUpdateOpen = _updateOpen[1]
      var _copied = useState(false), copied = _copied[0], setCopied = _copied[1]
      var _copyFail = useState(false), copyFailed = _copyFail[0], setCopyFailed = _copyFail[1]

      function toggleSidebar() {
        var next = !collapsed
        rememberCollapsed(next)
        setCollapsed(next)
      }

      /** Pin the model a future `@创建成员` builds with (null model = follow the default). */
      function chooseModel(provider, model, reasoningEffort) {
        setModelPane('root')
        setModelOpen(false)
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'new-member-model',
            provider: provider,
            model: model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort }),
          }),
        })
          .then(function () { refresh() })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      /**
       * Bottom-of-sidebar row: which model a new member gets. This mirrors DSH's
       * own `ModelSelect` — the trigger chip (model · effort) opens a two-level
       * menu: a root pane of 模型 / 推理等级 cells, each drilling into its own
       * list; models are grouped by provider because two providers can offer the
       * same model name. Fed by the host's `sessionController.modelCatalog()`,
       * so the tab and the host never disagree.
       */
      function renderModelRow() {
        var groups = (data && data.modelGroups) || []
        if (groups.length === 0) return null
        var defaultSel = data.defaultSelection || null
        var picked = data.newMemberModel || null
        var effective = picked || defaultSel
        var found = null
        for (var gi = 0; gi < groups.length && found === null; gi++) {
          if (groups[gi].id !== (effective || {}).provider) continue
          for (var mi = 0; mi < groups[gi].models.length; mi++) {
            if (groups[gi].models[mi].id === (effective || {}).model) { found = groups[gi].models[mi]; break }
          }
        }
        var reasoning = found && found.reasoning
        var effortId = (effective || {}).reasoningEffort ?? (reasoning ? reasoning.defaultEffort : undefined)
        var effortLabel = reasoning === undefined || reasoning === null
          ? undefined
          : effortId === undefined
            ? '默认'
            : (reasoning.efforts.filter(function (e) { return e.id === effortId })[0] || { name: effortId }).name
        var modelLabel = found ? found.name : (effective ? effective.provider + '/' + effective.model : '选择模型')

        var trigger = h('button', {
          style: styles.modelTrigger,
          title: '新建群成员时使用的模型（只影响 @创建成员，不改全局默认）',
          onClick: function () { setModelPane('root'); setModelOpen(!modelOpen) },
        },
          h('span', { style: styles.modelTriggerLabel }, modelLabel),
          effortLabel === undefined ? null : h('span', { style: styles.modelTriggerEffort }, '· ' + effortLabel),
          h('span', { style: Object.assign({}, styles.modelChevron, modelOpen ? styles.modelChevronOpen : {}) }, '▾'))

        // The label sits OUTSIDE the card, so what this control is for is
        // readable without opening anything.
        var label = h('p', { style: styles.sideTitle }, '设置新成员模型')
        if (!modelOpen) return h('div', { style: styles.modelRowWrap }, label, trigger)

        var panes = []
        if (modelPane === 'model') {
          // Just the catalog, grouped by provider — the effective model already
          // shows what an un-picked install uses, so no "follow default" row.
          var blocks = groups.map(function (group) {
            return h('div', { key: group.id },
              h('div', { style: styles.modelGroupTitle }, group.name),
              group.models.map(function (m) {
                var selected = effective !== null && effective.provider === group.id && effective.model === m.id
                return h('button', {
                  key: group.id + '/' + m.id,
                  style: styles.modelOption,
                  title: m.description || m.name,
                  onMouseDown: function (e) { e.preventDefault(); chooseModel(group.id, m.id, undefined) },
                },
                  h('span', { style: styles.modelOptionName }, m.name),
                  h('span', { style: styles.modelCheck }, selected ? '✓' : ''))
              }))
          })
          panes.push(h('div', { style: styles.modelScroll, key: 'models' }, blocks))
        } else if (modelPane === 'effort') {
          var levels = reasoning === undefined || reasoning === null
            ? []
            : (reasoning.defaultEffort === undefined
              ? [{ id: undefined, name: '默认' }].concat(reasoning.efforts)
              : reasoning.efforts)
          panes.push(h('div', { style: styles.modelScroll, key: 'efforts' },
            levels.length === 0
              ? h('div', { style: styles.modelCellValue, key: 'none' }, '这个模型没有可选档位')
              : levels.map(function (level) {
                var selected = level.id === effortId
                return h('button', {
                  key: level.id || '__default__',
                  style: styles.modelOption,
                  onMouseDown: function (e) {
                    e.preventDefault()
                    chooseModel(effective.provider, effective.model, level.id)
                  },
                },
                  h('span', { style: styles.modelOptionName }, level.name),
                  h('span', { style: styles.modelCheck }, selected ? '✓' : ''))
              })))
        } else {
          panes.push(h('div', { key: 'root' },
            h('button', { style: styles.modelCell, onClick: function () { setModelPane('model') } },
              h('span', { style: styles.modelCellLabel }, '模型'),
              h('span', { style: styles.modelCellValue }, modelLabel),
              h('span', { style: styles.modelCellChevron }, '›')),
            reasoning === undefined || reasoning === null ? null : h('button', { style: styles.modelCell, onClick: function () { setModelPane('effort') } },
              h('span', { style: styles.modelCellLabel }, '推理等级'),
              h('span', { style: styles.modelCellValue }, effortLabel === undefined ? '默认' : effortLabel),
              h('span', { style: styles.modelCellChevron }, '›')),
            h('p', { style: styles.modelNote },
              picked === null
                ? '跟随部署默认模型。'
                : '只有 @创建成员 新建的成员用它。',
              picked === null
                ? null
                : h('span', { style: styles.modelReset, onMouseDown: function (e) { e.preventDefault(); chooseModel('', '', undefined) } }, '恢复默认'))))
        }
        return h('div', { style: styles.modelRowWrap },
          label,
          h('div', { style: styles.modelCard }, panes),
          trigger)
      }

      /**
       * Copy the install address, through DSH's own clipboard helper.
       *
       * This one comes straight from the official implementation
       * (`packages/client/ui-primitives/src/clipboard.ts` → `writeClipboard`),
       * which is the same code path the host's own copy buttons use. It lives in
       * the shell's PLATFORM_MODULES baseline (`client/web/src/seed.ts`), so a
       * plugin can require it directly and share the shell's single instance —
       * no `dsh.client.external` entry needed.
       *
       * Two hand-rolled versions of this each took the panel down, because both
       * reached into the shared document:
       *   1. textarea + select() into the page.
       *   2. createRange() + selectNodeContents() + addRange() — replacing the
       *      document's selection, which cleared the host's rendered content.
       * `writeClipboard` touches none of that: async Clipboard API first, its own
       * off-screen textarea for the execCommand fallback, and a plain `false` on
       * refusal. We only map its boolean onto the button label.
       */
      function copyInstallUrl() {
        var url = (data && data.installUrl) || ''
        if (url === '') return
        if (typeof primitives.writeClipboard !== 'function') {
          // Should not happen: the module ships in the platform baseline. If a
          // future DSH drops it, degrade to the same visible failure as a
          // refused write instead of throwing inside the click handler.
          flashFailed()
          return
        }
        var request
        try {
          request = primitives.writeClipboard(url)
        } catch (error) {
          flashFailed()
          return
        }
        // Guard the shape as well: an older/odd build could return a non-promise.
        if (request === undefined || request === null || typeof request.then !== 'function') {
          flashFailed()
          return
        }
        request.then(function (ok) {
          if (ok === true) flashCopied()
          else flashFailed()
        }, flashFailed)
      }

      function flashCopied() {
        setCopyState('ok')
        setTimeout(function () { setCopyState('idle') }, 1800)
      }

      /** Clipboard refused (no permission, not a secure context, …). Say so; touch nothing. */
      function flashFailed() {
        setCopyState('fail')
        setTimeout(function () { setCopyState('idle') }, 2600)
      }

      function setCopyState(next) {
        setCopied(next === 'ok')
        setCopyFailed(next === 'fail')
      }

      /**
       * Bottom-of-sidebar update notice. The host already decided there IS an
       * update (it compares versions; the tab never does), so this only has to
       * report it and explain the one supported upgrade path: copy the address,
       * uninstall, reinstall. Nothing is applied in-process — replacing a
       * running plugin's own files is not something a chat tab may do to itself.
       */
      function renderUpdateRow() {
        if (data === null) return null
        var latest = data.latestVersion
        if (typeof latest !== 'string' || latest === '') return null
        // Compare against what DSH has ON DISK, not against the version baked
        // into the running code. DSH does not hot-reload plugins, so right
        // after a reinstall the loaded constant is still the old one and
        // comparing against it kept the prompt up for a plugin the user had
        // already updated — it only cleared on the next restart.
        //
        // There is deliberately NO fallback to data.currentVersion here. That
        // fallback was the 0.4.7 bug: the host answered installedVersion: null
        // (it read the manager through the wrong cordis API), this fell back to
        // the loaded constant, and the constant — still the pre-update code,
        // because DSH never hot-reloads — beat the newer published version, so
        // the prompt stayed up for an install that had already happened.
        // No disk reading means no evidence of being behind, so say nothing.
        var installed = data.installedVersion
        if (typeof installed !== 'string' || installed === '') return null
        if (!isNewerVersion(latest, installed)) return null
        // Reached only when the disk really is behind the published version.
        // If the running code lags the disk, an update was already applied and
        // only a restart is missing — say that instead of implying the install
        // did not take.
        var restartNeeded = installed !== data.currentVersion

        var bar = h('button', {
          style: styles.updateBar,
          title: '磁盘上已是 ' + installed + '，仓库最新 ' + latest + '（需要重启 DSH 才会换代码）',
          onClick: function () { setUpdateOpen(!updateOpen); setCopied(false) },
        },
          h('span', { style: styles.updateBarLabel }, restartNeeded ? '已是 ' + installed + '，重启后生效' : '发现新版本 ' + latest),
          h('span', { style: styles.updateBarAction }, updateOpen ? '收起' : '查看'))
        if (!updateOpen) return h('div', { style: styles.updateRow }, bar)

        var step = function (index, body, note) {
          return h('li', { key: index, style: styles.updateStep },
            h('span', { style: styles.updateStepNum }, String(index)),
            h('span', { style: styles.updateStepBody }, body,
              note ? h('span', { style: styles.updateStepNote }, note) : null))
        }

        return h('div', { style: styles.updateRow },
          h('div', { style: styles.updateCard },
            h('h4', { style: styles.updateCardTitle },
              '更新到 ' + latest,
              h('button', {
                style: styles.updateClose,
                title: '关闭',
                onClick: function () { setUpdateOpen(false); setCopied(false) },
              }, '✕')),
            h('ol', { style: styles.updateSteps },
              step(1, '复制下载网址',
                'gitee 直连，github.com 在国内常连不上'),
              step(2, '在 DSH 设置页卸载本插件',
                '插件管理 → 群聊 → 卸载'),
              step(3, '用刚才复制的网址重新安装，再重启 DSH',
                '磁盘上已是 ' + installed + (restartNeeded ? '，但 DSH 不热重载 —— 必须重启才会换成新代码' : '，装完即为 ' + latest))),
            h('div', { style: styles.updateUrlRow },
              h('span', {
                style: styles.updateUrl,
                title: data.installUrl || '',
              }, data.installUrl || ''),
              h('button', {
                style: copyFailed
                  ? Object.assign({}, styles.updateCopy, styles.updateCopyFail)
                  : copied
                    ? Object.assign({}, styles.updateCopy, styles.updateCopyDone)
                    : styles.updateCopy,
                onClick: copyInstallUrl,
              }, copyFailed ? '复制失败' : copied ? '已复制' : '复制')),
            h('p', { style: styles.updateFoot },
              '本插件只在进程内运行，替换文件必须走卸载重装；不做自动更新，以免装到一半留下坏文件。')),
          bar)
      }

      /**
       * The plugin's own route is the liveness signal. When the plugin is
       * uninstalled the host tears the route down, and the poll below then gets
       * a 404 (or a body that is not our JSON) — which used to surface as a
       * permanent error banner over a dead panel, i.e. the greyed-out tab the
       * user reported. Treat "the route is gone" as its own state: say so once,
       * stop polling, and leave the user with an explanation instead of a
       * panel that looks broken.
       */
      var refresh = function () {
        if (uninstalled.current) return
        fetch('/groupchat', { cache: 'no-store' })
          .then(function (r) {
            if (r.status === 404) { markUninstalled(); return null }
            return r.json()
          })
          .then(function (payload) {
            if (payload === null) return
            if (!payload || payload.ok !== true) throw new Error('bad payload')
            // `active` is the bundle's own switch as DSH sees it on disk.
            // Disabling or uninstalling a bundle only rewrites the profile
            // manifest — the fiber is NOT disposed and this route keeps
            // answering — so a 404 never arrives and the tab used to sit greyed
            // until a restart. The flag is the honest signal.
            if (payload.active === false) { markUninstalled(); return }
            setData(payload)
            setError('')
            setSelected(function (prev) {
              if (prev !== null && payload.groups.some(function (g) { return g.key === prev })) return prev
              var stored = recalledGroup()
              if (stored !== null && payload.groups.some(function (g) { return g.key === stored })) return stored
              var first = payload.groups[0]
              return first ? first.key : null
            })
          })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      /** Latch the gone state and halt the poll. */
      function markUninstalled() {
        if (uninstalled.current) return
        uninstalled.current = true
        if (pollTimer.current !== null) {
          clearInterval(pollTimer.current)
          pollTimer.current = null
        }
        setData(null)
        setError('')
        setGone(true)
      }

      useEffect(function () {
        refresh()
        pollTimer.current = setInterval(refresh, POLL_MS)

        // Live updates over server-sent events. Renaming a Workspace in DSH's
        // own sidebar used to take up to POLL_MS to show up here, which read as
        // "the two names disagree for a few seconds"; the host now pushes the
        // frame the moment it changes anything, and this refetches at once.
        // The interval above stays as the safety net: EventSource reconnects
        // on its own, but a dropped stream must not stop the tab updating.
        var stream = null
        if (typeof EventSource === 'function') {
          try {
            stream = new EventSource('/groupchat?events=1')
            stream.addEventListener('changed', function () { refresh() })
          } catch (error) {
            stream = null
          }
        }

        return function () {
          if (pollTimer.current !== null) clearInterval(pollTimer.current)
          pollTimer.current = null
          if (stream !== null) { try { stream.close() } catch (error) { /* already closed */ } }
        }
      }, [])

      // Keep the feed pinned to the bottom unless the user scrolled up.
      useEffect(function () {
        var el = feedRef.current
        if (el && stickBottom.current) el.scrollTop = el.scrollHeight
      }, [data, selected])

      var group = data && data.groups.find(function (g) { return g.key === selected }) || null
      // The global group invites from EVERY workspace, so its candidate list is
      // the flat one the host builds for it; project groups stay scoped to
      // their own directory. Both feed the same popup.
      var candidates = (data && group)
        ? (group.global ? (data.allMentionables || []) : (data.mentionables[group.key] || []))
        : []
      // In the global group @ means INVITE, so someone already in it is not a
      // candidate. In a project group @ is a plain mention as well, so current
      // members must stay listed — that is how you address them.
      if (group && group.global) {
        var memberNicks = {}
        group.members.forEach(function (m) { memberNicks[m.nick] = true })
        candidates = candidates.filter(function (c) { return memberNicks[c.nick] !== true })
      }
      // Group list filter: group name, its online members, AND its @ candidates
      // (mentionables carries the offline-but-known sessions too — with every
      // group dormant, `members` alone would make member search look broken).
      var needle = query.trim().toLowerCase()
      // The global group is rendered on its own, ABOVE the project list — it is
      // not a project, and mixing it in would make it look like one more
      // directory. It is filtered by the same search box.
      var globalGroup = (data ? data.groups : []).find(function (g) { return g.global === true }) || null
      var projectGroups = (data ? data.groups : []).filter(function (g) { return g.global !== true })
      var shownGroups = projectGroups.filter(function (g) {
        if (needle === '') return true
        if (String(g.name).toLowerCase().indexOf(needle) !== -1) return true
        var nicks = g.members.map(function (m) { return String(m.nick) })
        var candidates = ((data.mentionables || {})[g.key] || []).map(function (m) { return String(m.nick) })
        return nicks.concat(candidates).some(function (n) { return n.toLowerCase().indexOf(needle) !== -1 })
      })
      var showGlobal = globalGroup !== null && (needle === '' ||
        String(globalGroup.name).toLowerCase().indexOf(needle) !== -1 ||
        globalGroup.members.some(function (m) { return String(m.nick).toLowerCase().indexOf(needle) !== -1 }))

      // The roster chips. In the global group they are GROUPED BY WORKSPACE,
      // because that is the one thing the header is for here: telling apart a
      // "小深助手" in project A from one in project B. A project group needs no
      // group heading — every member is in the group's own directory.
      var memberChips = (function () {
        if (group === null) return null
        var chips = []
        if (group.global !== true) {
          return group.members.map(function (m) {
            return h('span', { key: m.nick, style: styles.chip },
              h('i', { style: Object.assign({}, styles.dot, m.online === false ? { background: '#B4B2A9' } : {}) }),
              m.nick)
          })
        }
        // The workspace name comes off the member's own candidate entry, which
        // is keyed by nick; a member missing from that list still gets a chip,
        // just without a heading (better an unlabelled chip than a dropped one).
        var whereByNick = {}
        ;(data.allMentionables || []).forEach(function (c) { whereByNick[c.nick] = c.project || '' })
        var order = []
        var byWhere = {}
        group.members.forEach(function (m) {
          var where = whereByNick[m.nick] || ''
          if (byWhere[where] === undefined) { byWhere[where] = []; order.push(where) }
          byWhere[where].push(m)
        })
        order.forEach(function (where) {
          chips.push(h('span', { key: 'w:' + where, style: styles.chipGroup }, where || '未知工作区'))
          byWhere[where].forEach(function (m) {
            chips.push(h('span', { key: where + '/' + m.nick, style: styles.chip },
              h('i', { style: Object.assign({}, styles.dot, m.online === false ? { background: '#B4B2A9' } : {}) }),
              m.nick))
          })
        })
        return chips
      })()

      // The @-fragment at the caret end of the draft drives the popup. The
      // filter box inside it narrows the same list further, so a project with
      // dozens of sessions stays usable without a wall of rows.
      var atMatch = draft.match(/@([^\s@，,。；;：:]*)$/)
      var fragment = atMatch !== null ? atMatch[1] : ''
      var pick = pickFilter.trim().toLowerCase()
      var popupItems = atMatch !== null
        ? candidates.filter(function (c) {
            var nick = String(c.nick).toLowerCase()
            // Matches the @-fragment AND the filter box. The filter also looks at
            // the workspace, so "dsh" finds everything in that project.
            var where = String(c.project || '').toLowerCase()
            var byFragment = nick.indexOf(fragment.toLowerCase()) !== -1
            var byPick = pick === '' || nick.indexOf(pick) !== -1 || where.indexOf(pick) !== -1
            return byFragment && byPick
          })
        : []

      function send() {
        var text = draft.trim()
        if (text === '' || !group) return
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'post', group: group.key, text: text }),
        })
          .then(function (r) { return r.json() })
          .then(function (v) {
            if (!v.ok) throw new Error(v.error || 'post failed')
            setDraft('')
            stickBottom.current = true
            refresh()
          })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      /**
       * Rename the group. The host renames the DSH Workspace first and only
       * moves the group once that landed, so a refusal (name already taken by
       * another project) leaves BOTH names untouched — in which case the reply
       * is a non-2xx and the editor stays open with the text intact, so the
       * user can just pick a different name.
       */
      function submitRename() {
        var name = renameVal.trim()
        if (name === '' || !group) { setRenaming(false); return }
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'rename', group: group.key, name: name }),
        })
          .then(function (r) { return r.json().then(function (v) { return { status: r.status, v: v } }) })
          .then(function (res) {
            if (res.v.ok === false) {
              // Nothing changed; keep the editor open so the name can be fixed.
              setError(res.v.error || '改名失败')
              return
            }
            setError('')
            setRenaming(false)
            refresh()
          })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      function pickCandidate(nick) {
        setDraft(draft.replace(/@([^\s@，,。；;：:]*)$/, '@' + nick + ' '))
      }

      // Plugin gone: the host tore down our route. Render one honest notice
      // instead of a sidebar of "读取中…" that never resolves — the greyed-out
      // tab the user reported was exactly that, plus an error banner on top.
      if (gone) {
        return h('div', { style: styles.root, 'data-groupchat-root': '1' },
          h('div', { style: styles.gone },
            h('p', { style: styles.goneTitle }, '群聊插件已停用'),
            h('p', { style: styles.goneBody },
              '它已经被 DSH 停用或卸载，这个标签页随之失效。重新启用插件并重启 DSH 就会恢复。')))
      }

      return h('div', { style: styles.root, 'data-groupchat-root': '1' },
        // ---------------------------------------------------------- sidebar
        collapsed
          ? null
          : h('div', { style: styles.sidebar },
          h('div', { style: styles.searchWrap },
            h('input', {
              type: 'search',
              style: styles.searchInput,
              placeholder: '搜索群 / 会话名',
              value: query,
              onChange: function (e) { setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Escape') { setQuery('') } },
            })),
          // The global group is rendered AFTER the project list and BEFORE the
          // settings area — it is not a project, but it is also not a setting.
          h('div', { style: styles.sideList },
            h('p', { style: Object.assign({}, styles.sideTitle, query === '' ? {} : { display: 'flex', alignItems: 'baseline' }) },
              '群（按项目）',
              query === ''
                ? null
                : h('span', { style: styles.sideCount }, shownGroups.length + '/' + projectGroups.length)),
            data === null
              ? h('p', { style: styles.groupPreview }, '读取中…')
              : projectGroups.length === 0
                ? h('p', { style: styles.groupPreview }, '还没有群 —— 有会话跑起来就会自动建。')
                : shownGroups.length === 0
                  ? h('p', { style: styles.groupPreview }, '没有匹配「' + query + '」的群。')
                  : shownGroups.map(function (g) {
                    var last = g.messages.filter(function (m) { return m.kind !== 'system' }).slice(-1)[0]
                    var online = g.members.length
                    return h('div', {
                      key: g.key,
                      style: Object.assign({}, styles.groupItem, g.key === selected ? styles.groupItemActive : {}, g.dormant ? { opacity: 0.55 } : {}),
                      onClick: function () { setSelected(g.key); rememberGroup(g.key) },
                    },
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } },
                        h('span', { style: styles.groupName }, g.name),
                        online > 0
                          ? h('span', { style: styles.onlineBadge }, online + ' 在线')
                          : h('span', { style: { fontSize: '11px', opacity: 0.55 } }, '休眠')),
                      h('p', { style: styles.groupPreview },
                        last ? last.name + ': ' + last.text : (g.dormant ? '全员下线，消息保留' : '还没有消息')))
                    })
          ),
          showGlobal
            ? h('div', { style: styles.globalWrap },
                h('div', {
                  style: Object.assign({}, styles.groupItem, styles.globalItem,
                    globalGroup.key === selected ? styles.groupItemActive : {},
                    globalGroup.members.length === 0 ? { opacity: 0.6 } : {}),
                  onClick: function () { setSelected(globalGroup.key); rememberGroup(globalGroup.key) },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } },
                    h('span', { style: styles.groupName }, globalGroup.name),
                    globalGroup.members.length > 0
                      ? h('span', { style: styles.onlineBadge }, globalGroup.members.length + ' 人')
                      : h('span', { style: { fontSize: '11px', opacity: 0.55 } }, '空')),
                  h('p', { style: styles.groupPreview },
                    globalGroup.members.length === 0
                      ? '跨工作区 · @名字 拉人进来'
                      : '跨工作区 · 只能用户拉人')))
            : null,
          renderModelRow(),
          renderUpdateRow()
        ),

        // ------------------------------------------------------------- main
        h('div', { style: styles.main },
          group === null
            ? h('div', { style: styles.gone },
                data === null && error !== ''
                  ? [
                      h('p', { key: 't', style: styles.goneTitle }, '群聊加载失败'),
                      h('p', { key: 'b', style: styles.goneBody }, error),
                      h('p', { key: 'r', style: styles.goneBody }, '正在自动重试；若持续失败，把这条信息发给插件作者。'),
                    ]
                  : h('p', { style: styles.goneBody }, data === null ? '读取群聊…' : (collapsed ? '群列表已收起 —— 点左上角的按钮展开，或等一个会话跑起来。' : '左侧选一个群，或等一个会话跑起来。')))
            : [
              h('div', { key: 'head', style: styles.head },
                h('div', { style: styles.headRow },
                  h('button', {
                    style: Object.assign({}, styles.toggleBtn, collapsed ? { opacity: 1 } : {}),
                    title: collapsed ? '展开群列表' : '收起群列表',
                    onClick: toggleSidebar,
                  }, PanelIcon()),
                  renaming
                    ? h('input', {
                        style: Object.assign({}, styles.input, { flex: '0 1 220px' }),
                        value: renameVal,
                        autoFocus: true,
                        onChange: function (e) { setRenameVal(e.target.value) },
                        onKeyDown: function (e) {
                          if (e.key === 'Enter') submitRename()
                          if (e.key === 'Escape') setRenaming(false)
                        },
                        onBlur: submitRename,
                      })
                    : h('span', { style: styles.groupTitle }, group.name),
                  // Renaming is tied to a Workspace, and the global group has
                  // none — there is nothing to keep in sync.
                  renaming || group.global
                    ? null
                    : h('button', {
                        style: styles.renameBtn,
                        title: '改名（会同时改工作区名，让侧栏和这里保持一致）',
                        onClick: function () { setRenameVal(group.name); setRenaming(true) },
                      }, '改名'),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: { fontSize: '11px', opacity: 0.45 } }, '内存保留 ' + 200 + ' 条 · 重启 DSH 清空')),
                h('div', { style: styles.chips },
                  h('span', { style: Object.assign({}, styles.chip, { opacity: 0.65 }) }, '用户（人 · 界面发言）'),
                  memberChips),
                // What the HEADER tells the human is how to operate this page.
                // The group's cross-agent etiquette (`GROUP_PURPOSE`) is written
                // for agents and is injected into their context — showing it
                // here as well just puts internal wording in front of the user.
                h('p', { style: styles.headHint }, group.global
                  ? '跨所有工作区，成员只能由你拉入'
                  : '成员 = 正在运行的会话，上下线全自动；@名字 可唤醒不在线的会话，@创建成员 新建一个'),
                ),

              h('div', {
                key: 'feed',
                style: styles.feed,
                ref: feedRef,
                onScroll: function (e) {
                  var el = e.currentTarget
                  stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                },
              },
                group.messages.length === 0
                  ? h('p', { style: styles.sysLine }, '还没有消息。你发的每条消息都会注入在线成员的下一轮调用。')
                  : group.messages.map(function (msg) {
                      if (msg.kind === 'system') {
                        return h('p', { key: msg.id, style: styles.sysLine }, '— ' + msg.text + ' —')
                      }
                      var mine = msg.kind === 'human'
                      return h('div', {
                        key: msg.id,
                        style: Object.assign({}, styles.bubble, mine ? styles.bubbleHuman : styles.bubbleAgent),
                      },
                        h('p', { style: styles.bubbleMeta }, msg.name + ' · ' + fmtTime(msg.at)),
                        h('p', { style: styles.bubbleText }, renderText(msg.text)))
                    })),

              h('div', { key: 'composer', style: styles.composer },
                atMatch !== null
                  ? h('div', { style: styles.popup },
                      // No title row: the scope ("all workspaces" vs this project)
                      // lives in the placeholder, so the box stays one line tall.
                      h('div', { style: styles.popupHead },
                        h('input', {
                          type: 'search',
                          style: styles.popupFilter,
                          placeholder: group.global
                            ? '筛选名字 / 工作区 —— 拉人进全局群'
                            : '筛选名字 —— @ 本群成员',
                          value: pickFilter,
                          autoFocus: true,
                          onChange: function (e) { setPickFilter(e.target.value) },
                          onKeyDown: function (e) {
                            // Enter picks the only remaining row — the common
                            // case is "type three letters, hit Enter".
                            if (e.key === 'Enter' && popupItems.length === 1) {
                              e.preventDefault()
                              pickCandidate(popupItems[0].nick)
                            }
                            if (e.key === 'Escape') setPickFilter('')
                          },
                        })),
                      h('div', { style: styles.popupList },
                        popupItems.length === 0
                          ? h('p', { style: styles.popupEmpty },
                              candidates.length === 0
                                ? (group.global ? '没有可拉入的会话了 —— 已经都在群里。' : '没有可 @ 的会话。')
                                : '没有匹配的名字。')
                          : popupItems.map(function (c) {
                              return h('div', {
                                key: c.nick,
                                style: styles.popupItem,
                                onMouseDown: function (e) { e.preventDefault(); pickCandidate(c.nick) },
                              },
                                h('i', { style: Object.assign({}, styles.dot, c.online ? {} : { background: '#B4B2A9' }) }),
                                c.nick,
                                c.project
                                  ? h('span', { style: styles.popupWhere }, c.project)
                                  : null)
                            })),
                      // One note for the whole list instead of repeating "offline,
                      // @ wakes it" on every row — only the count is worth saying.
                      (function () {
                        var off = popupItems.filter(function (c) { return !c.online }).length
                        var msg = group.global
                          ? '灰点不在线，@ 会唤醒它并拉进群'
                          : '灰点不在线，@ 会唤醒它'
                        if (off > 0) msg = off + ' 个不在线 —— ' + msg
                        return h('p', { style: styles.popupNote }, msg)
                      })(),
                      // Creating a session needs a directory to create it in.
                      // The global group spans workspaces, so it has none — the
                      // host refuses there too, this just hides the affordance.
                      group.global
                        ? null
                        : h('div', {
                            key: '__create__',
                            style: Object.assign({}, styles.popupItem, styles.popupCreate),
                            onMouseDown: function (e) { e.preventDefault(); pickCandidate('创建成员') },
                          },
                            '＋ 创建成员',
                            h('span', { style: styles.popupWhere }, '发送后新建一个会话进本群'))
                    )
                  : null,
                h('div', { style: styles.composerRow },
                  h('input', {
                    style: styles.input,
                    placeholder: group.global
                      ? '通报给 ' + group.members.length + ' 个成员（@名字 拉人进来）'
                      : '发言给 ' + group.members.length + ' 个在线成员…（@名字 可唤醒不在线的会话）',
                    value: draft,
                    onChange: function (e) {
                      setDraft(e.target.value)
                      // Leaving the @-popup resets its filter, so the next one
                      // opens whole rather than pre-narrowed by a stale value.
                      if (!/@([^\s@，,。；;：:]*)$/.test(e.target.value)) setPickFilter('')
                    },
                    onKeyDown: function (e) { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send() },
                  }),
                  h('button', { style: styles.sendBtn, onClick: send }, '发送')),
                error !== ''
                  ? h('p', { style: { fontSize: '11px', color: '#E24B4A', margin: '6px 0 0' } }, error)
                  : null),
            ]))
    }

    var exports = {}
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'groupchat',
          order: 30,
          label: function () { return '群聊' },
        }, GroupchatView)
      })
    }
    return exports
  },
})
