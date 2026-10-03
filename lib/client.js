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
      groupItem: { borderRadius: '8px', padding: '8px 10px', marginBottom: '4px', cursor: 'pointer' },
      groupItemActive: { background: 'color-mix(in srgb, currentColor 8%, transparent)' },
      groupName: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupPreview: { fontSize: '11px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '3px 0 0' },
      modelRowWrap: { flexShrink: 0, position: 'relative', marginTop: '8px', paddingTop: '8px', borderTop: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)' },
      // The card and rows copy DSH's own model selector (ModelSelect.module.css):
      // 20px card, 4px padding, 40px root cells, 38px options, 10px radii.
      modelCard: { position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: '8px', zIndex: 20, display: 'flex', flexDirection: 'column', maxHeight: '280px', overflow: 'hidden', padding: '4px', borderRadius: '20px', background: 'var(--dsw-specific-menu, color-mix(in srgb, currentColor 8%, transparent))', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,0.28))', color: 'var(--dsw-alias-label-primary, inherit)' },
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
      onlineBadge: { fontSize: '11px', borderRadius: '8px', padding: '1px 7px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', whiteSpace: 'nowrap' },
      main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
      head: { padding: '10px 14px 8px', borderBottom: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)' },
      headRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      groupTitle: { fontSize: '14px', fontWeight: 500 },
      toggleBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', padding: 0, borderRadius: '6px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', flexShrink: 0, opacity: 0.75 },
      renameBtn: { fontSize: '11px', opacity: 0.55, border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '8px', padding: '1px 8px', cursor: 'pointer', background: 'transparent', color: 'inherit' },
      chips: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '10px', padding: '2px 9px' },
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
      popupTitle: { fontSize: '11px', opacity: 0.5, margin: '2px 10px 4px' },
      popupItem: { padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
      empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.45, fontSize: '13px' },
    }

    function fmtTime(at) {
      var d = new Date(at)
      var p = function (n) { return String(n).padStart(2, '0') }
      return p(d.getHours()) + ':' + p(d.getMinutes())
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
      var stickBottom = useRef(true)
      var _collapsed = useState(readCollapsed), collapsed = _collapsed[0], setCollapsed = _collapsed[1]
      var _modelOpen = useState(false), modelOpen = _modelOpen[0], setModelOpen = _modelOpen[1]
      var _modelPane = useState('root'), modelPane = _modelPane[0], setModelPane = _modelPane[1]
      var _query = useState(''), query = _query[0], setQuery = _query[1]

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

      var refresh = function () {
        fetch('/groupchat', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (payload) {
            if (!payload || payload.ok !== true) throw new Error('bad payload')
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

      useEffect(function () {
        refresh()
        var timer = setInterval(refresh, POLL_MS)
        return function () { clearInterval(timer) }
      }, [])

      // Keep the feed pinned to the bottom unless the user scrolled up.
      useEffect(function () {
        var el = feedRef.current
        if (el && stickBottom.current) el.scrollTop = el.scrollHeight
      }, [data, selected])

      var group = data && data.groups.find(function (g) { return g.key === selected }) || null
      var candidates = (data && group && data.mentionables[group.key]) || []
      // Group list filter: group name, its online members, AND its @ candidates
      // (mentionables carries the offline-but-known sessions too — with every
      // group dormant, `members` alone would make member search look broken).
      var needle = query.trim().toLowerCase()
      var shownGroups = (data ? data.groups : []).filter(function (g) {
        if (needle === '') return true
        if (String(g.name).toLowerCase().indexOf(needle) !== -1) return true
        var nicks = g.members.map(function (m) { return String(m.nick) })
        var candidates = ((data.mentionables || {})[g.key] || []).map(function (m) { return String(m.nick) })
        return nicks.concat(candidates).some(function (n) { return n.toLowerCase().indexOf(needle) !== -1 })
      })

      // The @-fragment at the caret end of the draft drives the popup.
      var atMatch = draft.match(/@([^\s@，,。；;：:]*)$/)
      var popupItems = atMatch
        ? candidates.filter(function (c) { return c.nick.indexOf(atMatch[1]) !== -1 })
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

      function submitRename() {
        var name = renameVal.trim()
        if (name === '' || !group) { setRenaming(false); return }
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'rename', group: group.key, name: name }),
        })
          .then(function () { setRenaming(false); refresh() })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      function pickCandidate(nick) {
        setDraft(draft.replace(/@([^\s@，,。；;：:]*)$/, '@' + nick + ' '))
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
          h('div', { style: styles.sideList },
            h('p', { style: Object.assign({}, styles.sideTitle, query === '' ? {} : { display: 'flex', alignItems: 'baseline' }) },
              '群（按项目）',
              query === ''
                ? null
                : h('span', { style: styles.sideCount }, shownGroups.length + '/' + (data ? data.groups.length : 0))),
            data === null
              ? h('p', { style: styles.groupPreview }, '读取中…')
              : data.groups.length === 0
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
          renderModelRow()
        ),

        // ------------------------------------------------------------- main
        h('div', { style: styles.main },
          group === null
            ? h('div', { style: styles.empty }, data === null ? '读取群聊…' : (collapsed ? '群列表已收起 —— 点左上角的按钮展开，或等一个会话跑起来。' : '左侧选一个群，或等一个会话跑起来。'))
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
                  renaming
                    ? null
                    : h('button', {
                        style: styles.renameBtn,
                        title: '改名',
                        onClick: function () { setRenameVal(group.name); setRenaming(true) },
                      }, '改名'),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: { fontSize: '11px', opacity: 0.45 } }, '内存保留 ' + 200 + ' 条 · 重启 DSH 清空')),
                h('div', { style: styles.chips },
                  h('span', { style: Object.assign({}, styles.chip, { opacity: 0.65 }) }, '用户（人 · 界面发言）'),
                  group.members.map(function (m) {
                    return h('span', { key: m.nick, style: styles.chip }, h('i', { style: styles.dot }), m.nick)
                  })),
                h('p', { style: styles.headHint }, '成员 = 正在运行的会话，上下线全自动；@名字 可唤醒不在线的会话，@创建成员 新建一个')),

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
                      h('p', { style: styles.popupTitle }, '@ 候选'),
                      popupItems.map(function (c) {
                        return h('div', {
                          key: c.nick,
                          style: styles.popupItem,
                          onMouseDown: function (e) { e.preventDefault(); pickCandidate(c.nick) },
                        },
                          h('i', { style: Object.assign({}, styles.dot, c.online ? {} : { background: '#B4B2A9' }) }),
                          c.nick,
                          h('span', { style: { fontSize: '11px', opacity: 0.55 } },
                            c.online ? '· 在线' : '· 不在线，@ 将唤醒它'))
                      }),
                      h('div', {
                        key: '__create__',
                        style: Object.assign({}, styles.popupItem, { borderTop: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)', marginTop: '2px', color: '#378ADD' }),
                        onMouseDown: function (e) { e.preventDefault(); pickCandidate('创建成员') },
                      },
                        '＋ 创建成员',
                        h('span', { style: { fontSize: '11px', opacity: 0.55 } }, '· 发送后新建一个会话进本群，它会自己取名'))
                    )
                  : null,
                h('div', { style: styles.composerRow },
                  h('input', {
                    style: styles.input,
                    placeholder: '发言给 ' + group.members.length + ' 个在线成员…（@名字 可唤醒不在线的会话）',
                    value: draft,
                    onChange: function (e) { setDraft(e.target.value) },
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
