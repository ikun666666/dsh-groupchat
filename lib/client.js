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

    /**
     * 每个发言人一种配色。背景 tint + 左侧色条 + 名字着色都用它 —— 群里人一多，
     * 光靠左右对齐分不清谁是谁，颜色是最快的区分手段。用户固定用品牌蓝（和
     * @提及 的高亮同色系，右对齐一眼认出「我」），成员则按昵称哈希取色：同一个
     * 名字永远同一个颜色，改名才变。
     */
    var SPEAKER_COLORS = ['#378ADD', '#1D9E75', '#BA7517', '#7F77DD', '#D4537E', '#2AA1B3']

    function speakerColorOf(name) {
      var s = String(name)
      var hash = 0
      for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
      return SPEAKER_COLORS[hash % SPEAKER_COLORS.length]
    }

    /**
     * 长消息自动折叠。成员们习惯发长文（总结、报告、日志），一条占满整屏，
     * 别人发的就看不见了 —— 超过阈值先折成预览，点「展开全文」看全部。
     * 阈值给得比"一屏"小得多：群里同时有多个人在发言，预览只需要够判断
     * "这条要不要读"，不需要替人读完。
     */
    var FOLD_CHARS = 120
    var FOLD_LINES = 4

    function isFoldableText(text) {
      var s = String(text)
      if (s.length > FOLD_CHARS) return true
      var lines = 1
      for (var i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) {
          lines += 1
          if (lines > FOLD_LINES) return true
        }
      }
      return false
    }

    /** 按码点计数，别把 emoji 算成两个字。 */
    function codePoints(text) {
      return Array.from(String(text)).length
    }

    /**
     * 未读红点。数据层：每个群存一个「已读到哪」的水位（消息时间戳，落
     * localStorage，刷新不丢）；只要最新的非系统消息比水位新，就把 群聊 标签
     * 点红。用户点进 群聊 页 = 全部已读，红点消失。
     *
     * 这个循环必须在**视图卸载时也活着**（视图切走就 unmount，组件里的轮询
     * 全停），所以整个机制放在模块作用域，视图只在挂载/卸载时接管与交还。
     * 红点本身画不进 DSH 的标签按钮（label 是纯字符串，React 渲染），
     * 直接在 DOM 上补一个 span —— 和 dsh-oasis-brand 改 hero 文案同一路数，
     * MutationObserver 负责补回被 React 重渲染冲掉的节点。
     */
    var READ_AT_PREFIX = 'dsh-groupchat.readAt.'

    function readWatermark(key) {
      try {
        var raw = window.localStorage.getItem(READ_AT_PREFIX + key)
        if (raw === null) return null
        var value = Number(raw)
        return Number.isFinite(value) ? value : null
      } catch (e) { return null }
    }

    function writeWatermark(key, at) {
      try { window.localStorage.setItem(READ_AT_PREFIX + key, String(at)) } catch (e) { /* private mode etc. */ }
    }

    /** 红点的模块状态与 DOM 注入。`viewMounted` 由视图挂载/卸载维护。 */
    var unreadActive = false
    var viewMounted = false
    var watchTimer = null
    var badgeBtn = null
    var badgeSpan = null
    var badgeScheduled = false
    var badgeObserver = null

    /**
     * 把红点补到「群聊」标签按钮里（没有就建，有就只更新显隐）。缓存按钮与
     * span 两个节点，正常路径只做 isConnected 检查 + 一次 display 写入；
     * 节点失效（React 重建了标签栏）才重新全量找一遍。
     */
    function ensureBadge() {
      if (badgeBtn === null || !badgeBtn.isConnected || badgeSpan === null || !badgeSpan.isConnected) {
        badgeBtn = null
        badgeSpan = null
        var strip = document.querySelector('[data-conversation-tabs]')
        if (strip !== null) {
          var buttons = strip.querySelectorAll('button')
          for (var i = 0; i < buttons.length; i++) {
            // 只认文字精确等于「群聊」的那个 —— 红点 span 自身没有文本，
            // 不会破坏这个匹配。
            if (buttons[i].textContent.trim() === '群聊') { badgeBtn = buttons[i]; break }
          }
        }
        if (badgeBtn !== null) {
          badgeSpan = badgeBtn.querySelector('[data-groupchat-unread]')
          if (badgeSpan === null) {
            badgeSpan = document.createElement('span')
            badgeSpan.setAttribute('data-groupchat-unread', '')
            badgeSpan.title = '群聊里有新消息'
            badgeSpan.style.cssText =
              'display:inline-block;width:7px;height:7px;border-radius:50%;' +
              'background:#E24B4A;margin-left:5px;vertical-align:1px;'
            badgeBtn.appendChild(badgeSpan)
          }
        }
      }
      if (badgeSpan !== null) badgeSpan.style.display = unreadActive ? 'inline-block' : 'none'
    }

    /** 同一帧里的多次触发只做一次 DOM 工作。 */
    function scheduleBadge() {
      if (badgeScheduled) return
      badgeScheduled = true
      var run = function () {
        badgeScheduled = false
        try { ensureBadge() } catch (e) { /* 红点不值得让页面崩 */ }
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else setTimeout(run, 16)
    }

    function setUnread(next) {
      unreadActive = next
      scheduleBadge()
    }

    /** 标签栏会被 React 整块重建，观察者负责把红点补回去。 */
    function installBadgeObserver() {
      if (badgeObserver !== null || typeof MutationObserver !== 'function') return
      if (document.body === null || document.body === undefined) return
      badgeObserver = new MutationObserver(function () { scheduleBadge() })
      badgeObserver.observe(document.body, { childList: true, subtree: true })
    }

    /**
     * 用一份 /groupchat 载荷算未读。`markRead` 是用户正在看着群聊页时的模式：
     * 水位直接推进到最新（进页面 = 全已读）。
     *
     * 第一次见到某个群时水位直接初始化为当前最新、**不点红点** —— 否则装上新
     * 版本的第一眼，所有历史消息都算未读，红点永远亮着。系统消息（上线/下线）
     * 推进水位但本身不算未读：那类广播不值得点红点。
     */
    function notePayload(payload, markRead) {
      if (!payload || payload.ok !== true || !Array.isArray(payload.groups)) return
      var anyUnread = false
      for (var i = 0; i < payload.groups.length; i++) {
        var g = payload.groups[i]
        var messages = g.messages || []
        var newest = 0
        var newestChat = 0
        for (var j = 0; j < messages.length; j++) {
          var at = Number(messages[j].at) || 0
          if (at > newest) newest = at
          if (messages[j].kind !== 'system' && at > newestChat) newestChat = at
        }
        var key = String(g.key)
        var watermark = readWatermark(key)
        if (watermark === null) {
          writeWatermark(key, newest)
          watermark = newest
        }
        if (markRead) {
          writeWatermark(key, newest)
          watermark = newest
        }
        if (newestChat > watermark) anyUnread = true
      }
      setUnread(anyUnread)
    }

    /** 视图不在时的一次未读巡检（视图在时它自己轮询并标记已读）。 */
    function watchRefresh() {
      if (viewMounted) return
      fetch('/groupchat', { cache: 'no-store' })
        .then(function (r) {
          if (r.status === 404) { stopWatch(true); return null }
          return r.json()
        })
        .then(function (payload) {
          if (payload === null) return
          if (!payload || payload.ok !== true) return
          if (payload.active === false) { stopWatch(true); return }
          if (viewMounted) return
          notePayload(payload, false)
        })
        .catch(function () { /* 网络抖动：下一拍重试 */ })
    }

    function startWatch() {
      if (viewMounted || watchTimer !== null) return
      installBadgeObserver()
      scheduleBadge()
      watchRefresh()
      watchTimer = setInterval(watchRefresh, POLL_MS)
    }

    function stopWatch(clear) {
      if (watchTimer !== null) {
        clearInterval(watchTimer)
        watchTimer = null
      }
      if (clear === true) setUnread(false)
    }

    // 页面在后台时计时器会被压到很慢，回到前台先立刻补一次巡检。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && watchTimer !== null) watchRefresh()
    })

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
    var DRAFT_KEY_PREFIX = 'dsh-groupchat.draft.'

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

    /**
     * The composer draft, remembered per group.
     *
     * The view is UNMOUNTED on every tab switch (and on reload), so component
     * state dies with it — a half-typed message used to be gone the moment the
     * user glanced at another tab. The draft therefore lives in localStorage,
     * keyed per group, which makes group switches keep each one's own text too.
     */
    function readDraft(key) {
      if (key === null || key === undefined) return ''
      try { return window.localStorage.getItem(DRAFT_KEY_PREFIX + key) || '' } catch (e) { return '' }
    }

    function writeDraft(key, value) {
      if (key === null || key === undefined) return
      try {
        if (value === '') window.localStorage.removeItem(DRAFT_KEY_PREFIX + key)
        else window.localStorage.setItem(DRAFT_KEY_PREFIX + key, value)
      } catch (e) { /* private mode etc. */ }
    }

    /** The panel-toggle glyph: a rounded frame with its left column filled. */
    function PanelIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, style: { display: 'block', flexShrink: 0 } },
        h('rect', { x: 1.4, y: 2.6, width: 13.2, height: 10.8, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M3.4 2.6h3.1v10.8H3.4a2 2 0 0 1-2-2V4.6a2 2 0 0 1 2-2z', fill: 'currentColor', opacity: 0.9 }))
    }

    /**
     * The supervisor's nick, fixed and reserved on the host side. The tab needs
     * it in two places — the always-present entry in the @ popup, and filtering
     * it out of the ordinary candidate list so it cannot be listed twice.
     * Must match `SUPERVISOR_NAME` in lib/index.js.
     */
    var SUPERVISOR_NAME = '群管理'

    /**
     * Per-message cap, in characters. Must match TEXT_CAP in lib/index.js: the
     * input refuses character 251 here, so the user is never typing text the
     * host would silently clip on the way out.
     */
    var MESSAGE_CHARS = 250

    /**
     * The app's own navigation service (`ui-workspace`), the same one a click on
     * a sidebar row goes through: `openSession(id)` selects that session and
     * shows its Conversation. Filled in from `apply` when the service is
     * available; null means "this build cannot navigate", and the chips simply
     * stop being clickable targets rather than throwing on click.
     */
    var workspaceNav = null

    function openMemberSession(m) {
      if (!m || typeof m.id !== 'string' || m.id === '') return
      if (workspaceNav === null || typeof workspaceNav.openSession !== 'function') return
      try {
        workspaceNav.openSession(m.id)
      } catch (error) {
        // A session the navigation owner does not know (archived, stale list)
        // is refused there; a click that does nothing is the right outcome.
      }
    }

    var styles = {
      root: { display: 'flex', height: '100%', width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.6 },
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
      // The supervisor's chip. Bordered in the same blue the global group uses
      // for its own item, because both mean "this one is not an ordinary
      // member" — and it is the only member the user created by hand.
      chipSupervisor: { borderColor: 'color-mix(in srgb, #378ADD 55%, transparent)' },
      chipClickable: { cursor: 'pointer' },
      chipRole: { fontSize: '10px', lineHeight: '14px', padding: '0 5px', borderRadius: '6px', color: '#378ADD', background: 'color-mix(in srgb, #378ADD 14%, transparent)' },
      dot: { width: '6px', height: '6px', borderRadius: '50%', background: '#1D9E75', display: 'inline-block' },
      headHint: { fontSize: '11px', opacity: 0.45, margin: '6px 0 0' },
      // The requirement board. One line, always visible: the user must be able
      // to see "需求现在到哪一步了" without asking — that IS the plan-mode
      // surface. No buttons: the verdict is read from the conversation by the
      // judge, so a click target here would only invite a second source of truth.
      reqBar: {
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px',
        padding: '6px 16px', minHeight: '26px', boxSizing: 'border-box',
        borderBottom: '0.5px solid color-mix(in srgb, currentColor 12%, transparent)',
        fontSize: '11px',
      },
      reqId: { fontWeight: 600, opacity: 0.7, flexShrink: 0 },
      reqStatus: { flexShrink: 0, fontWeight: 500 },
      reqText: {
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', opacity: 0.55,
      },
      // 认可按钮只在「手工认可 + 待你认可」时出现；方式开关常驻，随时能切。
      reqApprove: {
        flexShrink: 0, fontSize: '11px', padding: '2px 10px', borderRadius: '6px',
        border: '0.5px solid color-mix(in srgb, #3FA34D 55%, transparent)',
        background: 'color-mix(in srgb, #3FA34D 18%, transparent)',
        color: 'inherit', cursor: 'pointer', fontWeight: 600,
      },
      reqMode: {
        flexShrink: 0, fontSize: '10px', padding: '1px 6px', borderRadius: '6px',
        border: '0.5px solid color-mix(in srgb, currentColor 25%, transparent)',
        background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.6,
      },
      feed: { flex: 1, width: '100%', minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box' },
      sysLine: { textAlign: 'center', fontSize: '11px', opacity: 0.45, margin: 0 },
      // 气泡的底色/色条/名字颜色由 speakerColorOf 逐条算出来（见 bubbleStyleOf），
      // 这两个只负责左右对齐：人靠右、成员靠左。
      bubble: { maxWidth: '80%', width: 'fit-content', minWidth: 0, borderRadius: '8px', padding: '8px 12px', boxSizing: 'border-box' },
      // 一条消息占满一行，气泡在行内靠左/靠右。百分比宽度只有相对一个"确定的"
      // 父宽度才生效——直接把气泡放在滚动列里，`maxWidth: 80%` 会因为父宽度
      // 不定而失效，长文本按 max-content 撑开，整块跑出可视区。行容器补上
      // `width: 100%` 后，气泡的 80% 才有参照。
      msgRow: { display: 'flex', width: '100%', minWidth: 0, boxSizing: 'border-box' },
      bubbleHuman: { marginLeft: 'auto' },
      bubbleAgent: { marginRight: 'auto' },
      bubbleMeta: { fontSize: '11px', margin: '0 0 3px' },
      bubbleName: { fontWeight: 500 },
      bubbleTime: { opacity: 0.55 },
      bubbleText: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', minWidth: 0 },
      // 折起来的样子：6 行后截断（-webkit-line-clamp 会自己在末尾打省略号）。
      bubbleClamp: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: FOLD_LINES, overflow: 'hidden' },
      foldBtn: { marginTop: '4px', padding: 0, border: 'none', background: 'transparent', color: 'inherit', opacity: 0.55, fontSize: '11px', lineHeight: '16px', cursor: 'pointer' },
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

    /**
     * Render message text with @mentions highlighted.
     *
     * A nick can contain SPACES (a session titled "Sum of 1 and 1" carries that
     * title as its nick), so whitespace cannot be the boundary — the boundary is
     * the LONGEST known nick starting at the `@`, with the same
     * whitespace-delimited fallback the host uses for reserved commands.
     *
     * Keep this in step with `parseMentions` in the host half: if the two cut
     * differently, the tab highlights one name while the host resolves another.
     */
    function renderText(text, nicks) {
      var src = String(text)
      var known = (nicks || [])
        .filter(function (n) { return typeof n === 'string' && n !== '' })
        .sort(function (a, b) { return b.length - a.length })
      var parts = []
      var plain = ''
      function flush(mention) {
        if (plain !== '') { parts.push(plain); plain = '' }
        if (mention !== null) parts.push({ mention: mention })
      }
      var i = 0
      while (i < src.length) {
        if (src.charAt(i) !== '@') { plain += src.charAt(i); i += 1; continue }
        var rest = src.slice(i + 1)
        var hit = null
        for (var k = 0; k < known.length; k++) {
          if (rest.indexOf(known[k]) === 0) { hit = known[k]; break }
        }
        if (hit === null) {
          var token = rest.match(/^([^\s@，,。；;：:]{1,32})/)
          hit = token === null ? null : token[1]
        }
        if (hit === null) { plain += '@'; i += 1; continue }
        flush('@' + hit)
        i += 1 + hit.length
      }
      flush(null)
      return parts.map(function (part, idx) {
        return typeof part === 'string'
          ? part
          : h('span', { key: idx, style: styles.mention }, part.mention)
      })
    }

    /** 一条消息的配色：人固定品牌蓝，成员按昵称取色。 */
    function speakerColorFor(msg) {
      return msg.kind === 'human' ? '#378ADD' : speakerColorOf(msg.name)
    }

    /**
     * 气泡的完整样式：底色 tint + 左侧色条，色值来自发言人颜色。
     * `color-mix(..., transparent)` 叠在页面底色上，深浅两套主题都成立。
     */
    function bubbleStyleOf(msg) {
      var color = speakerColorFor(msg)
      return Object.assign(
        {},
        styles.bubble,
        msg.kind === 'human' ? styles.bubbleHuman : styles.bubbleAgent,
        {
          background: 'color-mix(in srgb, ' + color + ' 13%, transparent)',
          borderLeft: '2px solid color-mix(in srgb, ' + color + ' 55%, transparent)',
        },
      )
    }

    /**
     * 一条气泡消息。长文本默认折成 FOLD_LINES 行（4 行 / 120 字起折），点「展开全文」看全部；
     * 折叠状态是组件态，切走标签页再回来重新折叠 —— 默认折叠本来就是这里的规矩。
     */
    function MessageBubble(props) {
      var msg = props.msg
      var color = speakerColorFor(msg)
      var _expanded = useState(false), expanded = _expanded[0], setExpanded = _expanded[1]
      var foldable = isFoldableText(msg.text)
      var clamped = foldable && !expanded
      return h('div', { style: styles.msgRow },
        h('div', { style: bubbleStyleOf(msg) },
        h('p', { style: styles.bubbleMeta },
          h('span', { style: Object.assign({}, styles.bubbleName, { color: color }) }, msg.name),
          h('span', { style: styles.bubbleTime }, ' · ' + fmtTime(msg.at))),
        h('p', { style: clamped ? Object.assign({}, styles.bubbleText, styles.bubbleClamp) : styles.bubbleText },
          renderText(msg.text, props.nicks)),
        foldable
          ? h('button', {
              style: styles.foldBtn,
              onClick: function () { setExpanded(!expanded) },
            }, expanded ? '收起' : '展开全文 · ' + codePoints(msg.text) + ' 字')
          : null))
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

      /** Set the composer text AND remember it for the current group. */
      function updateDraft(next) {
        setDraft(next)
        writeDraft(selected, next)
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
            // 人正看着群聊页 —— 这就是「已读」的定义：水位推平，红点熄灭。
            notePayload(payload, true)
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
        // 视图挂载 = 用户进了群聊页：接管轮询，未读红点立刻熄灭。卸载时把这个
        // 职责交还给模块级巡检（startWatch）——标签切走后红点还得有人管。
        viewMounted = true
        stopWatch(false)
        setUnread(false)
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
          viewMounted = false
          startWatch()
        }
      }, [])

      // Keep the feed pinned to the bottom unless the user scrolled up.
      useEffect(function () {
        var el = feedRef.current
        if (el && stickBottom.current) el.scrollTop = el.scrollHeight
      }, [data, selected])

      // Restore this group's own draft when the selection changes — mount, tab
      // switch and group switch all land here. Writing is done by
      // `updateDraft`, so the text survives the view unmounting entirely.
      // The popup filter is per-popup state and must not leak across groups.
      useEffect(function () {
        setDraft(readDraft(selected))
        setPickFilter('')
      }, [selected])

      var group = data && data.groups.find(function (g) { return g.key === selected }) || null
      // The global group invites from EVERY workspace, so its candidate list is
      // the flat one the host builds for it; project groups stay scoped to
      // their own directory. Both feed the same popup.
      var candidates = (data && group)
        ? (group.global ? (data.allMentionables || []) : (data.mentionables[group.key] || []))
        : []
      // Members are deliberately NOT filtered out of the candidates. @ means
      // "call someone": an existing member is addressed (online) or woken
      // (offline), and anyone not in the group yet is additionally pulled in.
      // This used to hide members — back when @ meant INVITE only — which made
      // every member addressable exactly once: the moment they joined, their
      // name vanished from the popup for good.
      // Does this group already have a supervisor? Read off the roster rather
      // than a separate flag: the supervisor is deliberately kept as a member
      // even when idle, so `members` is the reliable place to look.
      var hasSupervisor = group !== null && group.members.some(function (m) {
        return m.role === 'supervisor'
      })
      // …and because it IS a member, it would otherwise show up among the
      // ordinary candidates too. It gets its own always-present entry below, so
      // drop it here to avoid listing the same name twice.
      if (group && group.global !== true) {
        candidates = candidates.filter(function (c) { return String(c.nick) !== SUPERVISOR_NAME })
      }
      // Everything addressable in this group, for the @-highlighter. It has to be
      // the same set the host parses with — roster plus known sessions in scope —
      // or a name with spaces gets highlighted here and missed there (or worse,
      // the other way round). Built once per render, cheap, and only used when a
      // message actually contains an `@`.
      var nickList = (function () {
        var out = []
        var seen = {}
        function add(n) {
          var s = String(n)
          if (s === '' || seen[s] === true) return
          seen[s] = true
          out.push(s)
        }
        if (group !== null) {
          group.members.forEach(function (m) { add(m.nick) })
          if (group.global === true) {
            ;(data.allMentionables || []).forEach(function (c) { add(c.nick) })
          } else {
            ;((data.mentionables || {})[group.key] || []).forEach(function (c) { add(c.nick) })
          }
        }
        return out
      })()
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
      //
      // One chip builder shared by both branches, so the supervisor badge can
      // never end up on one path and be forgotten on the other. `key` is only
      // passed where a bare nick is not unique (the global group).
      function memberChip(m, key) {
        var isSupervisor = m.role === 'supervisor'
        var base = isSupervisor ? Object.assign({}, styles.chip, styles.chipSupervisor) : styles.chip
        return h('span', {
          key: key === undefined ? m.nick : key,
          title: '点它：切到这个成员的会话（在底部输入框直接跟它说话）',
          onClick: function () { openMemberSession(m) },
          style: Object.assign({}, base, styles.chipClickable),
        },
          h('i', { style: Object.assign({}, styles.dot, m.online === false ? { background: '#B4B2A9' } : {}) }),
          m.nick,
          isSupervisor ? h('span', { style: styles.chipRole }, '管理') : null)
      }

      /**
       * The requirement strip — the visible half of plan mode.
       *
       * 待转化 = 群管理还没把用户这句话变成需求；待你认可 = 转化贴出来了，等你
       * 一句话；已认可 = 可以开工。认可是模型从对话里读出来的，所以这里没有
       * 按钮：多一个点击入口就多一个真相来源。
       */
      function requirementBar(g) {
        var list = (g && g.requirements) || []
        if (list.length === 0) return null
        var latest = list[list.length - 1]
        var manual = g.approvalMode === 'manual'
        var label = latest.kind === 'chat' ? '闲聊'
          : latest.kind === 'auto' ? '已放行'
            : latest.status === 'approved' ? '已认可'
              : latest.status === 'awaiting' ? '待你认可'
                : latest.status === 'closed' ? '无需处理' : '待转化'
        var color = (latest.kind === 'chat' || latest.kind === 'auto') ? '#3FA34D'
          : latest.status === 'approved' ? '#3FA34D'
            : latest.status === 'awaiting' ? '#C08A2E'
              : latest.status === 'closed' ? '#8A8A8A' : '#D2673A'
        var text = latest.goal || latest.raw || ''
        var open = list.filter(function (x) { return x.status === 'new' || x.status === 'awaiting' }).length
        return h('div', { style: styles.reqBar, title: text },
          h('span', { style: styles.reqId }, '需求 ' + latest.id),
          h('span', { style: Object.assign({}, styles.reqStatus, { color: color }) }, label),
          h('span', { style: styles.reqText }, text),
          open > 1 ? h('span', { style: { flexShrink: 0, opacity: 0.4 } }, '+' + (open - 1)) : null,
          // 手工认可：只有这里点一下才算通过，群管理读不懂「认可啊」也没关系。
          manual && latest.status === 'awaiting'
            ? h('button', {
                style: styles.reqApprove,
                title: '通过这份需求，群管理可以开工',
                onClick: function () { approveTicket(latest.id) },
              }, '认可')
            : null,
          h('button', {
            style: styles.reqMode,
            title: manual ? '当前：手工认可（点按钮才算）' : '当前：自动认可（模型从你的回复判断）',
            onClick: function () { setApprovalMode(manual ? 'auto' : 'manual') },
          }, manual ? '认可方式：手工' : '认可方式：自动'))
      }

      /** 手工通过一张待认可的单。 */
      function approveTicket(ticketId) {
        if (group === null) return
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'approve', group: group.key, ticket: ticketId }),
        })
          .then(function (r) { return r.json().then(function (v) { return { status: r.status, v: v } }) })
          .then(function (res) {
            if (res.v.ok === false) setError(res.v.error === 'not-awaiting' ? '这张单现在不是「待认可」' : (res.v.error || '认可失败'))
            refresh()
          })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      /** 切换认可方式：自动（模型读你的回复）/ 手工（只认按钮）。 */
      function setApprovalMode(mode) {
        if (group === null) return
        fetch('/groupchat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'approval-mode', group: group.key, mode: mode }),
        })
          .then(function () { refresh() })
          .catch(function (e) { setError(String(e && e.message || e)) })
      }

      var memberChips = (function () {
        if (group === null) return null
        var chips = []
        if (group.global !== true) {
          return group.members.map(function (m) { return memberChip(m) })
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
            chips.push(memberChip(m, where + '/' + m.nick))
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
            updateDraft('')
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
        updateDraft(draft.replace(/@([^\s@，,。；;：:]*)$/, '@' + nick + ' '))
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
                  : '成员 = 正在运行的会话，上下线全自动；@名字 可唤醒不在线的会话；@创建成员 新建'),
                ),

              // Plan mode's surface: where the latest requirement stands.
              group.global ? null : requirementBar(group),

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
                      return h(MessageBubble, { key: msg.id, msg: msg, nicks: nickList })
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
                            ? '筛选名字 / 工作区 —— @ 成员，或拉人进群'
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
                                ? '没有可 @ 的会话。'
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
                      // One note for the whole list instead of repeating
                      // "offline" on every row — only the count is worth saying.
                      // No claim about what an @ does: that sentence ("@ 会唤醒
                      // 它") is true for the human and a lie for an agent, and
                      // nobody reading the popup needs it.
                      (function () {
                        var off = popupItems.filter(function (c) { return !c.online }).length
                        var msg = group.global
                          ? '灰点不在线；没进群的一并拉进来'
                          : '灰点不在线'
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
                            h('span', { style: styles.popupWhere }, '发送后新建一个会话进本群')),
                      // The supervisor's entry, ALWAYS present in a project group.
                      // The host creates the session on demand (and re-attaches
                      // the stored one on a fresh boot), so the entry never
                      // disappears and there is never a second 群管理. Only the
                      // hint changes with the state.
                      group.global
                        ? null
                        : h('div', {
                            key: '__supervisor__',
                            style: Object.assign({}, styles.popupItem, styles.popupCreate),
                            onMouseDown: function (e) { e.preventDefault(); pickCandidate(SUPERVISOR_NAME) },
                          },
                            SUPERVISOR_NAME,
                            h('span', { style: styles.popupWhere },
                              hasSupervisor ? '已在群里 —— 点它把它叫过来' : '还没有 —— 发送后自动创建'))
                    )
                  : null,
                h('div', { style: styles.composerRow },
                  h('input', {
                    style: styles.input,
                    maxLength: MESSAGE_CHARS,
                    placeholder: group.global
                      ? '通报给 ' + group.members.length + ' 个成员（@名字 拉人进来，每条最多 ' + MESSAGE_CHARS + ' 字）'
                      : '发言给 ' + group.members.length + ' 个在线成员…（@名字 点名，每条最多 ' + MESSAGE_CHARS + ' 字）',
                    value: draft,
                    onChange: function (e) {
                      updateDraft(e.target.value)
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
      // Clicking a member chip hands the session id to the app's own navigation
      // service — the same call a sidebar row makes. Deferred injection on
      // purpose: on a build without ui-workspace the tab must still load, just
      // with chips that do nothing.
      try {
        ctx.inject(['uiWorkspace'], function (scoped) {
          workspaceNav = scoped.uiWorkspace ?? null
        })
      } catch (error) {
        workspaceNav = null
      }
      // If the service is already mounted, take it now — `inject` only fires
      // when it appears later, and on a normal boot it is already there.
      try {
        if (ctx.uiWorkspace !== undefined) workspaceNav = ctx.uiWorkspace
      } catch (error) {
        // No ui-workspace in this build: chips stay inert.
      }
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'groupchat',
          order: 30,
          label: function () { return '群聊' },
        }, GroupchatView)
      })
      // 未读巡检从模块加载就启动：用户可能一直待在别的标签页，标签栏上的
      // 红点得有人盯着。群聊视图一旦挂载，接管方换成它（见 groupchat 视图）。
      startWatch()
    }
    return exports
  },
})
