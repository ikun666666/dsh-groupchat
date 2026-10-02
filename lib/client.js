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

    /** Remember the group the user looked at last, across tab switches/reloads. */
    function rememberGroup(key) {
      try { window.localStorage.setItem(LAST_GROUP_KEY, key) } catch (e) { /* private mode etc. */ }
    }

    function recalledGroup() {
      try { return window.localStorage.getItem(LAST_GROUP_KEY) } catch (e) { return null }
    }

    var styles = {
      root: { display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.6 },
      sidebar: { width: '180px', flexShrink: 0, borderRight: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)', padding: '10px 8px', overflowY: 'auto' },
      sideTitle: { fontSize: '11px', opacity: 0.55, margin: '0 0 8px 6px' },
      groupItem: { borderRadius: '8px', padding: '8px 10px', marginBottom: '4px', cursor: 'pointer' },
      groupItemActive: { background: 'color-mix(in srgb, currentColor 8%, transparent)' },
      groupName: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupPreview: { fontSize: '11px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '3px 0 0' },
      onlineBadge: { fontSize: '11px', borderRadius: '8px', padding: '1px 7px', border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)', whiteSpace: 'nowrap' },
      main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
      head: { padding: '10px 14px 8px', borderBottom: '0.5px solid color-mix(in srgb, currentColor 15%, transparent)' },
      headRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      groupTitle: { fontSize: '14px', fontWeight: 500 },
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
        h('div', { style: styles.sidebar },
          h('p', { style: styles.sideTitle }, '群（按项目）'),
          data === null
            ? h('p', { style: styles.groupPreview }, '读取中…')
            : data.groups.length === 0
              ? h('p', { style: styles.groupPreview }, '还没有群 —— 有会话跑起来就会自动建。')
              : data.groups.map(function (g) {
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

        // ------------------------------------------------------------- main
        h('div', { style: styles.main },
          group === null
            ? h('div', { style: styles.empty }, data === null ? '读取群聊…' : '左侧选一个群，或等一个会话跑起来。')
            : [
              h('div', { key: 'head', style: styles.head },
                h('div', { style: styles.headRow },
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
