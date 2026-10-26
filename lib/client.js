// Browser half of dsh-plugin-mobile-gateway. The package manifest makes this
// bundle part of DSH's client-module graph; it contributes one Settings
// section that opens the management dialog, without replacing shipped UI seats.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-weapp-gateway',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    let open = false
    const listeners = new Set()
    const setOpen = (value) => {
      open = value
      for (const listener of listeners) listener()
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const getOpen = () => open

    // Shared Web UI / Desktop semantic tokens update with the host theme.
    const restartNoticeStorageKey = 'mobile-gateway-dismissed-restart-notice'
    let dismissedRestartInstance = null
    try { dismissedRestartInstance = window.localStorage.getItem(restartNoticeStorageKey) } catch { /* storage unavailable */ }

    const colors = {
      panel: 'var(--dsw-alias-bg-layer-2, var(--color-bg, Canvas))',
      card: 'var(--dsw-alias-bg-module-platform, var(--color-bg-elevated, Canvas))',
      text: 'var(--dsw-alias-label-primary, var(--color-text, CanvasText))',
      muted: 'var(--dsw-alias-label-secondary, var(--color-text-muted, GrayText))',
      border: 'var(--dsw-alias-border-l3, var(--color-border, rgba(127,127,127,.24)))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--color-primary, #4f7cff))',
      accentText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #dc4c64)',
      success: 'var(--dsw-alias-state-success-primary, #2fb171)',
    }
    const styles = {
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 1200, pointerEvents: 'auto',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.32))', display: 'flex',
        justifyContent: 'center', alignItems: 'center',
        padding: 'max(16px, var(--dsh-frame-overlay-top, 16px)) 16px', boxSizing: 'border-box',
      },
      panel: {
        width: 'clamp(640px, 84vw, 1120px)', maxWidth: '100%', maxHeight: '100%', minHeight: 0, height: 'min(780px, calc(100dvh - 48px))', overflow: 'hidden',
        scrollbarWidth: 'none', msOverflowStyle: 'none',
        display: 'flex', flexDirection: 'column',
        background: colors.panel, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 'var(--dsw-radius-panel, 16px)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 20px 60px rgba(0,0,0,.22))', padding: 24,
        fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)', fontSize: 13, boxSizing: 'border-box',
      },
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexShrink: 0 },
      title: { margin: 0, fontSize: 22, fontWeight: 650 },
      card: { background: 'transparent', border: 0, borderBottom: `1px solid ${colors.border}`, borderRadius: 0, padding: '16px 0', marginBottom: 0, flexShrink: 0 },
      label: { display: 'block', color: colors.muted, fontSize: 12, marginBottom: 6 },
      input: { width: '100%', boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '8px 12px', marginBottom: 8, background: colors.card, color: 'inherit', outline: 'none' },
      pairingText: { width: '100%', minHeight: 86, boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${colors.border}`, borderRadius: 8, padding: '9px 10px', margin: '10px 0', background: 'transparent', color: 'inherit', outline: 'none', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.45, overflowWrap: 'anywhere' },
      button: { cursor: 'pointer', border: `1px solid ${colors.border}`, background: 'transparent', borderRadius: 8, padding: '7px 11px', color: 'inherit', font: 'inherit' },
      headerButton: { width: 34, height: 34, boxSizing: 'border-box', border: 0, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      primary: { background: colors.accent, color: colors.accentText, borderColor: colors.accent, width: '100%' },
      muted: { color: colors.muted, fontSize: 12, lineHeight: 1.45 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 12, alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${colors.border}` },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, marginLeft: 8, color: colors.muted },
      dot: { width: 7, height: 7, borderRadius: 99, display: 'inline-block' },
      error: { color: colors.danger, background: 'rgba(220,76,100,.12)', borderRadius: 8, padding: 10, marginBottom: 12 },
      qr: { display: 'block', width: 220, height: 220, margin: '12px auto', background: '#fff', borderRadius: 10, padding: 8 },
      helpButton: { width: 20, height: 20, boxSizing: 'border-box', padding: 0, borderRadius: '50%', border: 0, background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1))', color: 'var(--dsw-alias-label-tertiary, #888)', cursor: 'help', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 12, fontWeight: 600, lineHeight: 1 },
      helpBubble: { position: 'absolute', top: '100%', left: 0, zIndex: 20, width: 'min(300px, calc(100vw - 88px))', maxHeight: 'min(440px, calc(100vh - 160px))', overflowY: 'auto', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text, boxShadow: '0 12px 28px rgba(0,0,0,.35)', fontSize: 12, lineHeight: 1.5 },
      toolsMenu: { position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30, width: 250, maxWidth: 'calc(100vw - 48px)', border: `1px solid ${colors.border}`, borderRadius: 10, padding: 5, background: colors.panel, boxShadow: '0 12px 28px rgba(0,0,0,.35)' },
      toolsItem: { display: 'block', width: '100%', padding: '9px 10px', textAlign: 'left', border: 0, borderRadius: 7, background: 'transparent', color: colors.text, font: 'inherit', cursor: 'pointer' },
      switch: { position: 'relative', display: 'inline-flex', width: 42, height: 24, flexShrink: 0 },
      switchInput: { position: 'absolute', opacity: 0, width: 1, height: 1 },
      switchTrack: { position: 'absolute', inset: 0, borderRadius: 99, transition: 'background .18s ease', cursor: 'pointer' },
      switchKnob: { position: 'absolute', top: 3, width: 18, height: 18, borderRadius: 99, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.35)', transition: 'left .18s ease', pointerEvents: 'none' },
      version: { flexShrink: 0, marginTop: 'auto', padding: '18px 2px 0', color: colors.muted, fontSize: 11, lineHeight: 1.4, textAlign: 'right', letterSpacing: '.02em' },
    }

    const panelCss = `
      @keyframes mgw-pairing-enter {
        from { opacity: 0; transform: scale(.82); }
        to { opacity: 1; transform: scale(1); }
      }
      .mgw-pairing-dialog {
        transform-origin: center;
        animation: mgw-pairing-enter 240ms cubic-bezier(.2, .8, .2, 1);
      }
      @keyframes mgw-pairing-exit {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0; transform: scale(.82); }
      }
      .mgw-pairing-dialog[data-closing="true"] {
        animation: mgw-pairing-exit 180ms ease-in forwards;
        pointer-events: none;
      }
      @media (prefers-reduced-motion: reduce) {
        .mgw-pairing-dialog { animation: none; }
      }
      .mobile-gateway-panel, .mobile-gateway-panel *, .mgw-pairing-dialog, .mgw-pairing-dialog *, .mgw-select-menu {
        scrollbar-width: none !important;
        -ms-overflow-style: none;
      }
      .mobile-gateway-panel::-webkit-scrollbar, .mobile-gateway-panel *::-webkit-scrollbar,
      .mgw-pairing-dialog::-webkit-scrollbar, .mgw-pairing-dialog *::-webkit-scrollbar, .mgw-select-menu::-webkit-scrollbar {
        display: none !important;
        width: 0;
        height: 0;
      }
      .mobile-gateway-panel .mgw-body { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 28px; flex: 1; min-height: 0; }
      .mobile-gateway-panel .mgw-nav { display: flex; flex-direction: column; gap: 4px; }
      .mobile-gateway-panel .mgw-nav button { text-align: left; border: 0; padding: 12px 14px; border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      .mobile-gateway-panel .mgw-nav button[aria-current="page"] { background: var(--dsw-alias-bg-overlay, rgba(127,127,127,.12)); font-weight: 500; }
      .mobile-gateway-panel .mgw-nav button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
      .mobile-gateway-panel .mgw-content { min-width: 0; overflow-y: auto; scrollbar-width: none; padding-right: 4px; }
      .mobile-gateway-panel .mgw-content::-webkit-scrollbar { display: none; }
      .mobile-gateway-panel .mgw-content p { margin: 6px 0 10px; }
      .mobile-gateway-panel strong { font-weight: 550; }
      .mobile-gateway-panel .mgw-section-title { margin: 0 0 10px; font-size: 17px; line-height: 1.4; font-weight: 650; color: inherit; }
      .mobile-gateway-panel .mgw-setting-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-bottom: 12px; }
      .mobile-gateway-panel .mgw-setting-row select { width: auto !important; max-width: 100%; min-width: 150px; margin-bottom: 0 !important; flex-shrink: 1; }
      .mobile-gateway-panel .mgw-cloudflare-block input, .mobile-gateway-panel .mgw-cloudflare-block .mgw-select-trigger { background: var(--dsw-alias-bg-layer-2, Canvas) !important; }
      .mobile-gateway-panel .mgw-setting-label { font-size: 14px; font-weight: 550; color: inherit; }

      .mobile-gateway-panel input:focus-visible, .mobile-gateway-panel select:focus-visible, .mobile-gateway-panel button:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, currentColor); outline-offset: 2px; }
      @media (max-width: 640px) {
        .mobile-gateway-panel .mgw-body { grid-template-columns: minmax(0, 1fr); gap: 8px; }
        /* Fork: the dialog nav is not the settings rail — keep it a tab strip.
           dsh-settings-mobile-nav collapses the first <nav> of any settings
           dialog, which used to swallow ours and leave a lone expand button.
           A stable height plus the marker below opts out. */
        .mobile-gateway-panel .mgw-nav { flex-direction: row; flex-wrap: nowrap; }
        .mobile-gateway-panel .mgw-nav button {
          flex: 1 1 0; min-width: 0; min-height: 40px; height: 40px;
          padding: 8px 6px; text-align: center; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
      }
    `

    function GatewaySelect({ style, children, value, onChange, disabled, ...props }) {
      const options = React.Children.toArray(children).filter((child) => React.isValidElement(child))
      const [menu, setMenu] = React.useState(null)
      const [active, setActive] = React.useState(0)
      const buttonRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const menuId = React.useId()
      const selected = options.find((option) => option.props.value === value)
      const enabled = options.map((option, index) => option.props.disabled ? -1 : index).filter((index) => index >= 0)
      const close = (restoreFocus = false) => {
        setMenu(null)
        if (restoreFocus) buttonRef.current?.focus()
      }
      const openMenu = () => {
        if (disabled) return
        const rect = buttonRef.current.getBoundingClientRect()
        const computed = window.getComputedStyle(buttonRef.current)
        const fontSize = parseFloat(computed.fontSize) || 14
        const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.5
        const measure = document.createElement('canvas').getContext('2d')
        if (measure) measure.font = computed.font || `${fontSize}px sans-serif`
        const longest = Math.max(...options.map((option) => measure
          ? measure.measureText(String(option.props.children)).width : String(option.props.children).length * fontSize))
        const height = Math.min(options.length * Math.max(40, lineHeight + 16) + 14, window.innerHeight - 24)
        const width = Math.min(Math.max(rect.width, longest + 72, 200), window.innerWidth - 24)
        setActive(Math.max(0, options.findIndex((option) => option.props.value === value && !option.props.disabled)))
        setMenu({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
          top: Math.max(12, rect.bottom + height + 6 <= window.innerHeight - 12 ? rect.bottom + 6 : rect.top - height - 6), width, maxHeight: window.innerHeight - 24 })
      }
      const choose = (index) => {
        const option = options[index]
        if (!option || option.props.disabled) return
        onChange?.({ target: { value: option.props.value } })
        close(true)
      }
      React.useEffect(() => {
        if (!menu) return
        menuRef.current?.focus()
        const outside = (event) => {
          if (!buttonRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close()
        }
        const scrolled = (event) => { if (!menuRef.current?.contains(event.target)) close() }
        const resized = () => close()
        document.addEventListener('pointerdown', outside)
        document.addEventListener('scroll', scrolled, true)
        window.addEventListener('resize', resized)
        return () => {
          document.removeEventListener('pointerdown', outside)
          document.removeEventListener('scroll', scrolled, true)
          window.removeEventListener('resize', resized)
        }
      }, [menu])
      React.useEffect(() => {
        if (menu) document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: 'nearest' })
      }, [active, menu])
      return React.createElement('span', { style: { display: 'inline-flex', maxWidth: '100%', minWidth: 0 } },
        React.createElement('button', { ...props, className: 'mgw-select-trigger', ref: buttonRef, type: 'button', disabled,
          'aria-haspopup': 'listbox', 'aria-expanded': !!menu, 'aria-controls': menu ? menuId : undefined,
          onClick: () => menu ? close() : openMenu(),
          onKeyDown: (event) => {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openMenu() }
          },
          style: { ...style, width: 'auto', maxWidth: '100%', marginBottom: 0, border: 0, borderRadius: 12,
            padding: '10px 16px', background: colors.card, color: colors.text, font: 'inherit', cursor: disabled ? 'default' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 18, opacity: disabled ? .5 : 1 } },
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected?.props.children || value),
          React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } },
            React.createElement('path', { d: 'M6 9l6 6 6-6' }))),
        menu ? React.createElement('div', { className: 'mgw-select-menu', ref: menuRef, id: menuId, role: 'listbox', tabIndex: -1,
          'aria-label': props['aria-label'], 'aria-activedescendant': `${menuId}-${active}`,
          style: { ...menu, position: 'fixed', zIndex: 1250, boxSizing: 'border-box', overflowY: 'auto', padding: 6,
            background: colors.panel, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 14,
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.12))', outline: 'none' },
          onKeyDown: (event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
            else if (event.key === 'Tab') close()
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const index = enabled.indexOf(active)
              setActive(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1]
                : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length])
            }
          } }, options.map((option, index) => React.createElement('div', { key: option.props.value,
            id: `${menuId}-${index}`, role: 'option', 'aria-selected': option.props.value === value, 'aria-disabled': !!option.props.disabled,
            onPointerMove: () => { if (!option.props.disabled) setActive(index) }, onClick: () => choose(index),
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, minHeight: 40, whiteSpace: 'nowrap',
              boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8, cursor: option.props.disabled ? 'default' : 'pointer',
              opacity: option.props.disabled ? .4 : 1, background: active === index ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))' : 'transparent' } },
            React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, title: String(option.props.children) }, option.props.children), option.props.value === value ? React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24',
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } },
              React.createElement('path', { d: 'M5 12l4 4L19 6' })) : null))) : null)
    }

    // --------------------------------------------------------------------------
    // Settings-nav glyph, pinned by the plugin itself.
    //
    // The `settings.section` contract carries no icon field — the core reads
    // only id/label/order and `navIcon(id)` falls back to the gear for every
    // unknown id. Patching that core bundle is not durable: a DSH runtime
    // re-extract, or any other plugin installing/removing its own patch, wipes
    // it. So this plugin pins its own glyph at runtime instead.
    //
    // It finds its nav cell by label text and rewrites the existing <svg> in
    // place, keeping the shell's element, class and box — nothing here depends
    // on the shell's hashed class names, so a DSH upgrade cannot break it. A
    // MutationObserver re-applies the glyph whenever the shell re-renders the
    // nav and restores the gear.
    //
    // `glyph()` is pure and returns the markup: it runs BEFORE any DOM mutation,
    // so a throwing glyph leaves the shell's own icon in place rather than
    // blanking the cell.
    // --------------------------------------------------------------------------
    const NAV_LABEL = '鲸尾移动网关'
    const NAV_ICON_MARK = 'data-mgw-nav-icon'

    function navGlyph() {
      return {
        viewBox: '0 0 24 24',
        stroke: 'currentColor',
        markup: '<rect x="6" y="2" width="12" height="20" rx="2.5"></rect><path d="M10 18h4"></path>',
      }
    }

    function pinNavGlyph(labels, mark, glyph) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      const apply = () => {
        // Cheap guard: the nav only exists while the settings panel is open.
        if (document.querySelector('[role="dialog"]') === null) return
        const cells = document.querySelectorAll('[role="dialog"] nav button')
        for (const cell of cells) {
          // An <svg> contributes no text, so this is exactly the nav label.
          if (labels.indexOf(cell.textContent.trim()) < 0) continue
          const svg = cell.querySelector('svg')
          if (svg === null || svg.getAttribute(mark) === '1') continue
          let spec
          try {
            spec = glyph()
          } catch (error) {
            console.warn('[dsh-plugin-weapp-gateway] nav glyph failed; keeping the shell icon', error)
            continue
          }
          svg.setAttribute('viewBox', spec.viewBox)
          svg.setAttribute('fill', 'none')
          if (spec.stroke) {
            svg.setAttribute('stroke', spec.stroke)
            svg.setAttribute('stroke-width', spec.strokeWidth || '1.8')
            svg.setAttribute('stroke-linecap', 'round')
            svg.setAttribute('stroke-linejoin', 'round')
          }
          svg.innerHTML = spec.markup
          svg.setAttribute('aria-hidden', 'true')
          svg.setAttribute(mark, '1')
        }
      }
      apply()
      // The shell re-renders the nav on ledger/locale changes; without this the
      // gear would come back on the next re-render.
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true })
    }

    // Fork: management RPC must resolve against the document base, not the
    // origin root. Behind the fnOS gateway the whole WebUI is served under
    // /app/deepseek-harness/fngateway/, where an absolute /mgw/... request
    // hits the gateway's own router and 404s. DSH serves its own assets
    // document-relative for exactly this reason.
    function apiPath(path) {
      let base = '/'
      try { base = new URL('.', document.baseURI).pathname } catch { base = '/' }
      if (!base.endsWith('/')) base += '/'
      return base + String(path).replace(/^\/+/, '')
    }

    async function request(path, options) {
      const response = await fetch(apiPath(path), { credentials: 'same-origin', ...options })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`)
      return body
    }

    function inferredUrl(wsPath) {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${scheme}//${window.location.host}${wsPath || '/ws/mobile'}`
    }

    function lanPairingUrl(status) {
      const urls = status?.lan?.listening && Array.isArray(status.lan.urls) ? status.lan.urls : []
      return urls.find((url) => !/^ws:\/\/169\.254\./.test(url)) || urls[0] || ''
    }

    function pairingUrlFor(route, status) {
      const lanUrl = lanPairingUrl(status)
      const tunnelUrl = status.cloudflare?.enabled && status.cloudflare.publicReady === true
        ? status.cloudflare.publicUrl || '' : ''
      if (route === 'lan') return lanUrl
      if (route === 'relay') return status.relay?.relay || ''
      if (route === 'cloudflare') return tunnelUrl
      const statusUrl = status.cloudflare?.enabled && status.cloudflare.publicReady !== true &&
        status.publicUrl === status.cloudflare.publicUrl ? '' : status.publicUrl
      return tunnelUrl || statusUrl || lanUrl || inferredUrl(status.wsPath)
    }

    function connectionAdvice(status, publicSetup) {
      if (!status) return { detected: '正在读取网关环境…', local: '', remote: '' }
      const system = status.platform === 'darwin' ? 'macOS 电脑' : status.platform === 'win32' ? 'Windows 电脑' : status.platform === 'linux' ? 'Linux 服务器' : '当前设备'
      const lanReady = !!lanPairingUrl(status)
      const tunnel = status.cloudflare
      const tunnelReady = !!(tunnel?.enabled && tunnel.publicReady === true && tunnel.publicUrl)
      const statusUrlIsUnreadyTunnel = !!(tunnel?.enabled && tunnel.publicReady !== true &&
        status.publicUrl === tunnel.publicUrl)
      const serverReady = status.platform === 'linux' && !!(
        (publicSetup?.configured && publicSetup.publicUrl) || (!statusUrlIsUnreadyTunnel && /^wss:\/\//.test(status.publicUrl || '')))
      const detected = `当前检测：${system}；局域网入口${lanReady ? '已就绪' : '未就绪'}；${serverReady ? '公网服务器入口已配置' : tunnelReady ? `${tunnel.mode === 'quick' ? 'Quick' : '命名'} Tunnel 已连接` : tunnel?.enabled ? (tunnel.state === 'online' ? '隧道已连接，公网入口未验证或检测失败' : 'Cloudflare Tunnel 连接中') : '外网入口未连接'}。`
      const local = lanReady
        ? 'DSH App 和小程序都可以通过局域网或 VPN 连接；手机与 DSH 同网时可使用局域网地址。'
        : '两种客户端都可使用局域网连接；先确认局域网入口已开启并监听成功。'
      let remote
      if (serverReady) remote = '两种客户端在外网时都可使用已配置的公网 WSS；自动选择会同时保留局域网候选地址。'
      else if (tunnelReady && tunnel.mode === 'named') remote = '两种客户端在外网时都可使用固定域名的 Cloudflare Tunnel；自动选择也会保留局域网候选地址。'
      else if (tunnelReady) remote = '两种客户端在外网时都可使用 Cloudflare Quick Tunnel；地址变化后需重新配对。'
      else if (status.platform === 'darwin' || status.platform === 'win32') remote = '外网使用可开启 Quick Tunnel；需要固定地址时可配置命名 Tunnel。'
      else if (status.platform === 'linux') remote = '外网使用可配置 Linux 公网入口或 Cloudflare Tunnel。'
      else remote = '外网连接需要可访问的 wss:// 公网地址；两种客户端都支持公网或局域网。'
      return { detected, local, remote }
    }

    function DeviceRow({ device, onRevoke, revoking }) {
      const triggerRevoke = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!revoking) onRevoke(device)
      }
      return React.createElement('div', { style: styles.row },
        React.createElement('div', { style: { minWidth: 0, overflow: 'hidden' } },
          React.createElement('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            device.displayName || device.name,
            React.createElement('span', { style: styles.badge },
              React.createElement('span', { style: { ...styles.dot, background: device.online ? colors.success : colors.muted } }),
              device.online ? '在线' : '离线')),
          React.createElement('div', { style: { ...styles.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3 } },
            device.lastSeenAt ? `最近连接：${new Date(device.lastSeenAt).toLocaleString()}` : '尚未连接')),
        React.createElement('button', {
          type: 'button',
          disabled: revoking,
          style: {
            ...styles.button,
            color: colors.danger,
            background: 'transparent',
            borderColor: 'rgba(220,76,100,.55)',
            flexShrink: 0,
            minWidth: 54,
            opacity: revoking ? .6 : 1,
          },
          title: `吊销 ${device.displayName || device.name}`,
          // Pointer-up is more reliable than click inside the management dialog on
          // touch devices. The click handler remains for keyboard activation.
          onPointerUp: triggerRevoke,
          onClick: (event) => {
            if (event.detail === 0) triggerRevoke(event)
          },
        }, revoking ? '吊销中…' : '吊销'))
    }

    function DevicePanel() {
      const [activeSection, setActiveSection] = React.useState('general')
      const [devices, setDevices] = React.useState(null)
      const [showAllDevices, setShowAllDevices] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [dismissedNotice, setDismissedNotice] = React.useState(() => dismissedRestartInstance)
      const [publicUrl, setPublicUrl] = React.useState('')
      const [pairingRoute, setPairingRoute] = React.useState('auto')
      const [connectionHelpOpen, setConnectionHelpOpen] = React.useState(false)
      const [toolsOpen, setToolsOpen] = React.useState(false)
      const [toolBusy, setToolBusy] = React.useState(false)
      const [toolNotice, setToolNotice] = React.useState('')
      const stoppedRef = React.useRef(false)
      const [publicIp, setPublicIp] = React.useState('')
      const [publicSetup, setPublicSetup] = React.useState(null)
      const [publicSetupBusy, setPublicSetupBusy] = React.useState(false)
      const [cloudflareHost, setCloudflareHost] = React.useState('')
      const [cloudflareToken, setCloudflareToken] = React.useState('')
      const [cloudflareMode, setCloudflareMode] = React.useState('quick')
      const [cloudflareBusy, setCloudflareBusy] = React.useState(false)
      const [qr, setQr] = React.useState(null)
      const pairingDialogRef = React.useRef(null)
      const navRef = React.useRef(null)
      // Fork: id of the pairing code currently shown as a QR. The panel polls
      // the server's pending list and closes the dialog as soon as this id is
      // gone — a successful scan consumes the code immediately.
      const pairingIdRef = React.useRef(null)
      const [pairingClosing, setPairingClosing] = React.useState(false)
      const pairingCloseTimer = React.useRef(null)
      const closePairingDialog = () => {
        pairingIdRef.current = null
        setCopyNotice(null)
        if (pairingCloseTimer.current !== null) return
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setQr(null)
          return
        }
        setPairingClosing(true)
        pairingCloseTimer.current = window.setTimeout(() => {
          pairingCloseTimer.current = null
          setQr(null)
          setPairingClosing(false)
        }, 180)
      }
      React.useEffect(() => {
        setPairingClosing(false)
        return () => {
          if (pairingCloseTimer.current !== null) {
            window.clearTimeout(pairingCloseTimer.current)
            pairingCloseTimer.current = null
          }
        }
      }, [qr])
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [updateInfo, setUpdateInfo] = React.useState(null)
      const [updateChecking, setUpdateChecking] = React.useState(true)
      const [updateBusy, setUpdateBusy] = React.useState(false)
      const [updateNotice, setUpdateNotice] = React.useState('')
      const [updateError, setUpdateError] = React.useState('')
      const [refreshing, setRefreshing] = React.useState(false)
      const [refreshNotice, setRefreshNotice] = React.useState(null)
      const [pairingTokenCopied, setPairingTokenCopied] = React.useState(false)
      // Copy feedback that must live inside the QR dialog: the panel's error
      // banner is behind the modal, so a clipboard failure looked like "the
      // button does nothing".
      const [copyNotice, setCopyNotice] = React.useState(null)
      const [deviceNotice, setDeviceNotice] = React.useState(null)
      const [deviceNoticeError, setDeviceNoticeError] = React.useState(false)
      const [revokingIds, setRevokingIds] = React.useState(() => new Set())
      const revokingIdsRef = React.useRef(new Set())
      const automaticUrlRef = React.useRef('')
      const pairingRouteRef = React.useRef('auto')
      const pairingRouteSelectedRef = React.useRef(false)
      const cloudflareModeLoadedRef = React.useRef(false)

      const refresh = React.useCallback(async () => {
        try {
          const [deviceData, statusData] = await Promise.all([
            request('/mgw/devices'),
            request('/mgw/status'),
          ])
          const nextDevices = deviceData.devices || []
          // Keep existing DOM rows alive when polling returns identical data.
          // Replacing them every three seconds can swallow a pointer/click that
          // started on the old button and ended after React replaced the row.
          if (revokingIdsRef.current.size === 0) {
            setDevices((current) => JSON.stringify(current) === JSON.stringify(nextDevices) ? current : nextDevices)
          }
          setStatus((current) => JSON.stringify(current) === JSON.stringify(statusData) ? current : statusData)
          // Fork: the QR dialog closes itself once the code is consumed. The
          // server drops a redeemed code from its pending list, so the poll
          // sees our id disappear and dismisses the dialog (with animation).
          if (pairingIdRef.current !== null && Array.isArray(statusData.pendingPairings)
            && !statusData.pendingPairings.includes(pairingIdRef.current)) {
            pairingIdRef.current = null
            setQr(null)
          }
          if (statusData.cloudflare && statusData.cloudflare.hostname) {
            setCloudflareHost((current) => current || statusData.cloudflare.hostname)
          }
          if (statusData.cloudflare && !cloudflareModeLoadedRef.current) {
            cloudflareModeLoadedRef.current = true
            setCloudflareMode(statusData.cloudflare.mode || 'quick')
          }
          // Adopt the saved legacy mode only until the operator makes a choice;
          // polling must not overwrite an in-progress route change.
          if (!pairingRouteSelectedRef.current) {
            const savedRoute = statusData.pairingMode === 'relay' ? 'relay' : 'auto'
            pairingRouteRef.current = savedRoute
            setPairingRoute(savedRoute)
          }
          if (pairingRouteRef.current !== 'custom') {
            const preferredUrl = pairingUrlFor(pairingRouteRef.current, statusData)
            if (automaticUrlRef.current && preferredUrl !== automaticUrlRef.current) setQr(null)
            automaticUrlRef.current = preferredUrl
            setPublicUrl(preferredUrl)
          }
          return true
        } catch (cause) {
          setError(cause.message)
          return false
        }
      }, [])

      const manualRefresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        setRefreshNotice(null)
        const succeeded = await refresh()
        setRefreshing(false)
        if (succeeded) {
          setError(null)
          setRefreshNotice(`已刷新 · ${new Date().toLocaleTimeString()}`)
          window.setTimeout(() => setRefreshNotice(null), 2200)
        }
      }

      const checkForPluginUpdate = async () => {
        setUpdateChecking(true)
        setUpdateError('')
        try {
          setUpdateInfo(await request('/mgw/update-check'))
        } catch (cause) {
          setUpdateError(cause.message)
        } finally {
          setUpdateChecking(false)
        }
      }

      const upgradePlugin = async () => {
        if (updateBusy || !updateInfo?.updateAvailable) return
        setUpdateBusy(true)
        setUpdateNotice('')
        setUpdateError('')
        try {
          const result = await request('/mgw/update', { method: 'POST' })
          if (result.reason === 'plugin-manager-unavailable') {
            setUpdateNotice(`当前 DSH 不支持面板内更新。请在 Terminal 执行：${result.command}`)
          } else if (result.reason === 'already-current') {
            setUpdateInfo(result)
            setUpdateNotice('插件已是最新版本。')
          } else if (result.installed) {
            const application = result.installation?.application
            const pendingBuilds = result.installation?.pendingBuilds
            if (Array.isArray(pendingBuilds) && pendingBuilds.length > 0) {
              setUpdateNotice(`更新等待构建脚本审核（${pendingBuilds.join('、')}）；未自动批准。请到 DSH 插件管理中审核。`)
            } else if (application === 'restart-required') {
              setUpdateInfo({ ...result, currentVersion: result.latestVersion, updateAvailable: false })
              setUpdateNotice(`已安装 v${result.latestVersion}，需要重启 DSH 后生效。`)
            } else if (application === 'failed' || application === 'cancelled' || application === 'refused') {
              const installError = result.installation?.error
              const detail = result.installation?.errorMessage
                || (typeof installError === 'string' ? installError : '')
                || (typeof installError?.message === 'string' ? installError.message : '')
                || (typeof installError?.code === 'string' ? installError.code : '')
                || '请在 DSH 插件管理中查看安装详情。'
              setUpdateNotice(`安装未完成：${application}（${detail}）`)
            } else {
              setUpdateInfo({ ...result, currentVersion: result.latestVersion, updateAvailable: false })
              setUpdateNotice(`已安装 v${result.latestVersion}。如界面尚未更新，请重启 DSH。`)
            }
          }
        } catch (cause) {
          setUpdateError(cause.message)
        } finally {
          setUpdateBusy(false)
        }
      }

      const runTool = async (tool) => {
        if (toolBusy) return
        setToolsOpen(false)
        setToolBusy(true)
        setToolNotice('')
        setError(null)
        try {
          const oldPid = status?.webPid
          await request(`/mgw/tools/${tool}`, { method: 'POST' })
          if (tool === 'stop-web') {
            stoppedRef.current = true
            setToolNotice('DSH Web 已收到停止指令。需要时可在 Terminal 运行 dsh web 重新启动。')
            return
          }
          if (tool === 'restart-web') {
            setToolNotice('正在重启 DSH Web，当前连接会短暂中断…')
            const deadline = Date.now() + 60_000
            while (Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 700))
              try {
                const next = await request('/mgw/status')
                if (next.webPid && next.webPid !== oldPid) {
                  window.location.reload()
                  return
                }
              } catch { /* old process is shutting down */ }
            }
            throw new Error('DSH Web 重启超时，请检查 /tmp/mobile-gateway.log')
          }
        } catch (cause) {
          setError(cause.message)
          setToolNotice('')
        } finally {
          setToolBusy(false)
        }
      }

      // Fork: dsh-settings-mobile-nav collapses the first <nav> of any settings
      // dialog on narrow viewports (it assumes the settings rail). Our dialog nav
      // is that first nav, so tapping a section used to hide the whole strip and
      // leave a lone ☰ button. Never intercept the click itself — React delegates
      // onClick at the document root, so stopPropagation in the capture phase
      // would kill our own handler. Instead, make the nav un-collapsible: a
      // MutationObserver reverts the display/aria-hidden edits (and drops the
      // stray expand button) the moment they land.
      React.useEffect(() => {
        const nav = navRef.current
        if (nav === null || typeof MutationObserver === 'undefined') return undefined
        const restore = () => {
          if (nav.style.display === 'none') nav.style.display = ''
          if (nav.getAttribute('aria-hidden') === 'true') nav.removeAttribute('aria-hidden')
          const stray = nav.closest('[role="dialog"]')?.querySelector('[data-dsh-settings-nav-expand]')
          if (stray !== null && stray !== undefined) stray.remove()
        }
        const observer = new MutationObserver(restore)
        observer.observe(nav, { attributes: true, attributeFilter: ['style', 'aria-hidden'] })
        const dialog = nav.closest('[role="dialog"]')
        if (dialog !== null) observer.observe(dialog, { childList: true })
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        let active = true
        refresh()
        request('/mgw/update-check').then((data) => {
          if (active) setUpdateInfo(data)
        }).catch((cause) => {
          if (active) setUpdateError(cause.message)
        }).finally(() => {
          if (active) setUpdateChecking(false)
        })
        request('/mgw/public-setup').then((data) => {
          if (!active) return
          setPublicSetup(data)
          if (data.publicUrl) {
            const match = /^wss:\/\/([^/]+)\/ws\/mobile$/.exec(data.publicUrl)
            if (match) setPublicIp(match[1])
          }
        }).catch((cause) => active && setPublicSetup({ installed: false, configured: false, error: cause.message }))
        const timer = window.setInterval(() => { if (!stoppedRef.current) refresh() }, 3000)
        return () => { active = false; window.clearInterval(timer) }
      }, [refresh])

      React.useEffect(() => {
        if (!qr) return
        const previousFocus = document.activeElement
        pairingDialogRef.current?.querySelector('button')?.focus()
        return () => previousFocus?.focus()
      }, [qr])

      const changePairingMode = async (mode) => {
        setBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          })
          setStatus((current) => ({ ...(current || {}), pairingMode: data.pairingMode, relay: data.relay }))
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const choosePairingRoute = (route) => {
        setQr(null)
        const previousRoute = pairingRouteRef.current
        pairingRouteSelectedRef.current = true
        pairingRouteRef.current = route
        setPairingRoute(route)
        if (route === 'custom') {
          automaticUrlRef.current = ''
        } else if (status) {
          const nextUrl = pairingUrlFor(route, status)
          automaticUrlRef.current = nextUrl
          setPublicUrl(nextUrl)
        }
        const targetMode = route === 'relay' ? 'relay' : 'direct'
        if (status && status.pairingMode !== targetMode &&
            (route === 'relay' || previousRoute === 'relay')) {
          void changePairingMode(targetMode)
        }
      }

      const configurePublicAccess = async () => {
        if (publicSetupBusy) return
        setPublicSetupBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/public-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicIp }),
          })
          setPublicSetup(data)
          if (data.publicUrl && pairingRouteRef.current === 'auto') {
            automaticUrlRef.current = data.publicUrl
            setPublicUrl(data.publicUrl)
          }
        } catch (cause) {
          setError(cause.message)
        } finally {
          setPublicSetupBusy(false)
        }
      }

      const configureCloudflare = async (enabled, mode = cloudflareMode) => {
        if (cloudflareBusy) return
        setCloudflareBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/cloudflare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, ...(enabled ? {
              mode,
              ...(mode === 'named' ? { hostname: cloudflareHost, token: cloudflareToken } : {}),
            } : {}) }),
          })
          setCloudflareToken('')
          setStatus((current) => ({ ...(current || {}), cloudflare: data, gatewayEnabled: data.gatewayEnabled, gatewayMode: data.gatewayMode, publicUrl: data.publicUrl || null }))
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setCloudflareBusy(false)
        }
      }

      const checkCloudflare = async () => {
        if (cloudflareBusy) return
        setCloudflareBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/cloudflare/check', { method: 'POST' })
          setStatus((current) => ({ ...(current || {}), cloudflare: data }))
        } catch (cause) { setError(cause.message) }
        finally { setCloudflareBusy(false) }
      }

      const restartCloudflare = async () => {
        if (cloudflareBusy) return
        setCloudflareBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/cloudflare/restart', { method: 'POST' })
          if (data.mode === 'quick') setQr(null)
          setStatus((current) => ({ ...(current || {}), cloudflare: data }))
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setCloudflareBusy(false)
        }
      }

      const createPairing = async (endpoint) => request('/mgw/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicUrl: endpoint,
          route: pairingRoute,
          lanUrl: lanPairingUrl(status),
        }),
      })

      const pair = async () => {
        setBusy(true)
        setError(null)
        setPairingTokenCopied(false)
        try {
          if (pairingRoute === 'relay' && status?.pairingMode !== 'relay') {
            const modeData = await request('/mgw/mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: 'relay' }),
            })
            setStatus((current) => ({ ...(current || {}), pairingMode: modeData.pairingMode, relay: modeData.relay }))
          }
          const data = await createPairing(publicUrl)
          pairingIdRef.current = data.pairing?.id || null
          setQr(data)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      // Fork: the pairing payload must be copyable wherever the WebUI is
      // opened. navigator.clipboard only exists in a secure context, and the
      // fnOS gateway embedding is plain http — there the async API is simply
      // missing. Fall back to the deprecated-but-universal execCommand path
      // before giving up, and report failures inside the QR dialog (the
      // panel's error banner sits behind the modal and is invisible).
      const writeClipboard = (text) => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text)
        }
        return new Promise((resolve, reject) => {
          const holder = document.createElement('textarea')
          holder.value = text
          holder.setAttribute('readonly', '')
          holder.style.position = 'fixed'
          holder.style.top = '-1000px'
          holder.style.opacity = '0'
          document.body.appendChild(holder)
          holder.select()
          holder.setSelectionRange(0, text.length)
          let copied = false
          try {
            copied = document.execCommand('copy')
          } catch (error) {
            copied = false
          }
          document.body.removeChild(holder)
          if (copied) resolve()
          else reject(new Error('浏览器拒绝写入剪贴板'))
        })
      }

      const copyPairingText = async () => {
        if (!qr || !qr.qrPayload) return
        try {
          await writeClipboard(qr.qrPayload)
          setError(null)
          setCopyNotice(null)
          setPairingTokenCopied(true)
          window.setTimeout(() => setPairingTokenCopied(false), 2200)
        } catch (cause) {
          setPairingTokenCopied(false)
          setCopyNotice(`${cause.message || '复制失败'}，请选中上面文本后按 Ctrl/Cmd+C`)
          window.setTimeout(() => setCopyNotice(null), 6000)
          // Leave the payload selected so the manual copy is one keystroke away.
          const area = pairingDialogRef.current && pairingDialogRef.current.querySelector('textarea')
          if (area) { area.focus(); area.select() }
        }
      }

      const changeGatewayMode = async (mode) => {
        setBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/gateway', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          })
          setStatus((current) => ({ ...(current || {}), ...data }))
          if (mode === 'disabled') setQr(null)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const toggleAuth = async () => {
        const enabled = !(status && status.requireAuth)
        if (!enabled && !window.confirm('关闭设备鉴权后，任何能访问移动网关的人都可以控制 DSH。此选项仅限 Debug 阶段使用，确定继续吗？')) return
        setBusy(true)
        setError(null)
        try {
          const data = await request('/mgw/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          })
          setStatus((current) => ({ ...(current || {}), requireAuth: data.requireAuth }))
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const revoke = async (device) => {
        if (revokingIdsRef.current.has(device.id)) return
        setDeviceNotice(null)
        setDeviceNoticeError(false)
        setError(null)
        revokingIdsRef.current.add(device.id)
        setRevokingIds((current) => new Set(current).add(device.id))
        try {
          await request(`/mgw/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST' })
          setDevices((current) => Array.isArray(current) ? current.filter((item) => item.id !== device.id) : current)
          setDeviceNotice(`已吊销 ${device.displayName || device.name}`)
          window.setTimeout(() => setDeviceNotice(null), 2200)
        } catch (cause) {
          setDeviceNoticeError(true)
          setDeviceNotice(`吊销失败：${cause.message}`)
          setError(cause.message)
        } finally {
          revokingIdsRef.current.delete(device.id)
          setRevokingIds((current) => {
            const next = new Set(current)
            next.delete(device.id)
            return next
          })
          await refresh()
        }
      }

      const restartNoticeInstance = status?.gatewayInstanceId || (status?.webPid ? String(status.webPid) : null)
      const dismissRestartNotice = () => {
        dismissedRestartInstance = restartNoticeInstance
        setDismissedNotice(restartNoticeInstance)
        try { window.localStorage.setItem(restartNoticeStorageKey, restartNoticeInstance) } catch { /* keep in-memory dismissal */ }
      }

      const onlineDevices = (devices || []).filter((device) => device.online)
      const offlineDevices = (devices || []).filter((device) => !device.online)
      const visibleDevices = showAllDevices ? [...onlineDevices, ...offlineDevices] : onlineDevices

      // The same v2 QR is native-app compatible; mini-program-only public
      // routing is carried in an optional field that older apps ignore.
      const relayInfo = status && status.relay ? status.relay : null
      const relayConnector = status && status.relayConnector ? status.relayConnector : null
      const effectiveRoute = pairingRoute
      const cloudflareReady = !!(status?.cloudflare?.enabled && status.cloudflare.publicReady === true && status.cloudflare.publicUrl)

      const advice = connectionAdvice(status, publicSetup)
      const helpLine = (name, description) => React.createElement('div', { style: { marginTop: 7 } },
        React.createElement('strong', null, name), '：', description)

      return React.createElement('div', { style: styles.backdrop, onMouseDown: () => setOpen(false) },
        qr ? React.createElement('div', { style: { ...styles.backdrop, zIndex: 1201 },
          onMouseDown: (event) => { event.stopPropagation(); closePairingDialog() } },
          React.createElement('div', { className: 'mgw-pairing-dialog', 'data-closing': pairingClosing, ref: pairingDialogRef, role: 'dialog', 'aria-modal': true, 'aria-label': '设备配对二维码', tabIndex: -1,
            style: { ...styles.panel, width: 'min(520px, 100%)', height: 'auto', overflowY: 'auto', scrollbarWidth: 'none' },
            onMouseDown: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              if (event.key === 'Escape') { event.stopPropagation(); closePairingDialog() }
              if (event.key === 'Tab') {
                const items = [...event.currentTarget.querySelectorAll('button, textarea')]
                const first = items[0], last = items[items.length - 1]
                if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
              }
            } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              React.createElement('button', { type: 'button', style: { ...styles.button, ...styles.headerButton }, 'aria-label': '关闭配对窗口', onClick: closePairingDialog }, '✕')),
          React.createElement('section', { style: { textAlign: 'center' } },
            React.createElement('strong', null, qr.payload?.version === 3 && qr.payload?.mode === 'relay'
              ? '使用鲸尾小程序扫码（此二维码仅适用于小程序）'
              : '使用 DSH App 或鲸尾小程序扫码'),
            React.createElement('img', { style: styles.qr, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`, alt: '一次性设备配对二维码' }),
            qr.payload?.version === 3 && qr.payload?.mode === 'relay'
              ? React.createElement('p', { style: { ...styles.muted, textAlign: 'left' } }, '这是小程序专用的鲸尾公网中继二维码，DSH App 不能使用。需要同时配对 DSH App 和小程序时，请改选“自动选择”。')
              : qr.payload?.miniProgramRoute?.mode === 'direct'
              ? React.createElement('p', { style: { ...styles.muted, textAlign: 'left' } }, '此二维码为 DSH App 和小程序提供公网与局域网候选地址；客户端会自动尝试可达线路。')
              : qr.payload?.miniProgramRoute?.mode === 'relay'
                ? React.createElement('p', { style: { ...styles.muted, textAlign: 'left' } }, '当前没有可用公网 WSS：DSH App 使用局域网，小程序使用鲸尾公网中继。选择“局域网直连”时，两端都直接使用局域网。')
                : React.createElement('p', { style: { ...styles.muted, textAlign: 'left' } }, '此二维码含当前可用的连接地址；DSH App 和小程序均可通过公网或局域网连接。'),
            React.createElement('label', { style: { ...styles.label, textAlign: 'left' } }, 'Base64URL 配对字符串'),
            React.createElement('textarea', { style: styles.pairingText, value: qr.qrPayload, readOnly: true, spellCheck: false, onFocus: (event) => event.target.select() }),
            React.createElement('button', { type: 'button', style: { ...styles.button, width: '100%', marginBottom: 8, borderColor: pairingTokenCopied ? colors.success : colors.border, color: pairingTokenCopied ? colors.success : colors.text }, onClick: copyPairingText }, pairingTokenCopied ? '✓ 已复制' : '复制配对 Token'),
            pairingTokenCopied ? React.createElement('div', { style: { ...styles.muted, color: colors.success, marginBottom: 8 } }, '已复制到剪贴板') : null,
            copyNotice ? React.createElement('div', { role: 'alert', style: { ...styles.muted, color: colors.danger, marginBottom: 8 } }, copyNotice) : null,
            React.createElement('div', { style: styles.muted }, `有效期至 ${new Date(qr.pairing.expiresAt).toLocaleTimeString()}；扫码成功后此二维码立即失效。`)))) : null,
        React.createElement('aside', { className: 'mobile-gateway-panel', inert: qr ? true : undefined, 'aria-hidden': qr ? true : undefined, style: styles.panel, onMouseDown: (event) => { event.stopPropagation(); setToolsOpen(false) }, role: 'dialog', 'aria-modal': true, 'aria-label': '鲸尾移动网关管理' },
          React.createElement('div', { style: styles.header },
            React.createElement('div', null,
              React.createElement('h2', { style: styles.title }, '鲸尾移动网关'),
              React.createElement('div', { style: styles.muted }, !status ? '正在加载网关状态…' : status.gatewayEnabled ? `移动网关已开启 · ${status.requireAuth ? '设备鉴权已开启' : '本机设备鉴权已关闭'}` : '移动网关已关闭 · 普通 WebUI 模式')),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('div', { style: { position: 'relative' }, onMouseDown: (event) => event.stopPropagation() },
                React.createElement('button', {
                  type: 'button', style: { ...styles.button, ...styles.headerButton, borderRadius: '50%' }, title: '工具', 'aria-label': '工具',
                  'aria-haspopup': 'menu', 'aria-expanded': toolsOpen,
                  onClick: () => setToolsOpen((value) => !value),
                }, React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                  React.createElement('path', { d: 'M10.3 2.8h3.4l.5 2.2a7.6 7.6 0 0 1 1.7.7l1.9-1.2 2.4 2.4L19 8.8c.3.5.5 1.1.7 1.7l2.2.5v3.4l-2.2.5a7.6 7.6 0 0 1-.7 1.7l1.2 1.9-2.4 2.4-1.9-1.2a7.6 7.6 0 0 1-1.7.7l-.5 2.2h-3.4l-.5-2.2a7.6 7.6 0 0 1-1.7-.7l-1.9 1.2-2.4-2.4L5 16.6a7.6 7.6 0 0 1-.7-1.7l-2.2-.5V11l2.2-.5A7.6 7.6 0 0 1 5 8.8L3.8 6.9l2.4-2.4 1.9 1.2a7.6 7.6 0 0 1 1.7-.7l.5-2.2Z' }),
                  React.createElement('circle', { cx: 12, cy: 12.7, r: 3.1 }))),
                toolsOpen ? React.createElement('div', { style: styles.toolsMenu, role: 'menu', 'aria-label': '网关工具' },
                  React.createElement('button', {
                    type: 'button', role: 'menuitem', disabled: toolBusy || stoppedRef.current || !status?.tools?.restartWeb,
                    style: { ...styles.toolsItem, opacity: status?.tools?.restartWeb ? 1 : .5 },
                    onClick: () => runTool('restart-web'),
                  }, '重启当前网关',
                  React.createElement('span', { style: { ...styles.muted, display: 'block', marginTop: 2 } }, '结束当前进程并重新启动 DSH Web')),
                  React.createElement('button', {
                    type: 'button', role: 'menuitem', disabled: toolBusy || stoppedRef.current || !status?.tools?.stopWeb,
                    style: { ...styles.toolsItem, color: colors.danger, opacity: status?.tools?.stopWeb ? 1 : .5 },
                    onClick: () => runTool('stop-web'),
                  }, '停止 DSH Web',
                  React.createElement('span', { style: { ...styles.muted, display: 'block', marginTop: 2 } }, '结束后台进程，所有连接将断开')))
                  : null),
              React.createElement('button', { style: { ...styles.button, ...styles.headerButton }, onClick: () => setOpen(false), 'aria-label': '关闭' },
                React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', 'aria-hidden': true },
                  React.createElement('path', { d: 'M6 6l12 12M18 6L6 18' }))))),
          React.createElement('div', { className: 'mgw-body' },
            React.createElement('nav', { ref: navRef, className: 'mgw-nav', 'aria-label': '鲸尾移动网关设置分组' },
              [['general', '通用设置'], ['pairing', '连接与配对'], ['devices', '可信设备']].map(([id, label]) =>
                React.createElement('button', { key: id, type: 'button', 'aria-current': activeSection === id ? 'page' : undefined,
                  onClick: () => { setActiveSection(id); setConnectionHelpOpen(false); setToolsOpen(false) } }, label))),
            React.createElement('div', { className: 'mgw-content', key: activeSection },
          restartNoticeInstance && dismissedNotice !== restartNoticeInstance ? React.createElement('section', { style: { ...styles.card, position: 'relative', padding: '10px 40px 10px 12px', border: '1px solid', borderRadius: 10, marginBottom: 8, background: 'var(--dsw-alias-state-warn-tertiary, #fff7df)', borderColor: 'color-mix(in srgb, #d99a16 35%, transparent)', fontSize: 12, lineHeight: 1.6 }, role: 'note' },
            React.createElement('button', { type: 'button', 'aria-label': '关闭重启提醒', title: '关闭提醒',
              style: { ...styles.button, position: 'absolute', right: 8, top: 8, border: 0, width: 24, height: 24, padding: 0, color: colors.muted },
              onClick: dismissRestartNotice }, '✕'),
            React.createElement('strong', null, '若安装或更新后连接异常，请重启应用'),
            React.createElement('div', { style: { color: colors.muted, marginTop: 4 } },
              '完全退出并重启 APP／Desktop；Web UI 请重启 DSH Web 服务。'),
            React.createElement('div', { style: { color: colors.muted, marginTop: 4 } },
              '端口仍被占用时，请关闭其他 Harness 实例。')) : null,
          toolNotice ? React.createElement('div', { style: { ...styles.muted, marginBottom: 10 } }, toolNotice) : null,
          error ? React.createElement('div', { style: styles.error }, error) : null,
          React.createElement('div', { hidden: activeSection !== 'general' },
          React.createElement('section', { style: styles.card },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center' } },
              React.createElement('div', null,
                React.createElement('strong', null, '网关运行模式'),
                React.createElement('div', { style: { ...styles.muted, marginTop: 4 } }, status && status.gatewayEnabled
                  ? status.gatewayMode === 'persistent'
                    ? '重启后保持开启'
                    : status.waitExpiresAt
                      ? `等待可信设备连接，约 ${Math.max(1, Math.ceil((status.waitExpiresAt - Date.now()) / 60000))} 分钟后自动关闭`
                      : '设备已连接过，本次运行保持开启；重启后重新计时'
                  : '不接受移动设备连接')),
              React.createElement('span', { style: { position: 'relative', display: 'inline-flex', flexShrink: 0 } },
                React.createElement(GatewaySelect, {
                  style: { ...styles.input, width: 'auto', marginBottom: 0, padding: '8px 40px 8px 12px', appearance: 'none', WebkitAppearance: 'none' },
                  'aria-label': '网关运行模式',
                  value: status ? status.gatewayMode || (status.gatewayEnabled ? 'temporary' : 'disabled') : 'disabled',
                  disabled: busy || !status,
                  onChange: (event) => changeGatewayMode(event.target.value),
                },
                React.createElement('option', { value: 'disabled' }, '关闭'),
                React.createElement('option', { value: 'temporary' }, '临时开启'),
                React.createElement('option', { value: 'persistent' }, '常驻开启')),
              )),
            status && status.gatewayId ? React.createElement('div', { style: { ...styles.muted, marginTop: 12, overflowWrap: 'anywhere' } },
              status.gatewayName) : null),
          React.createElement('section', { style: styles.card },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center' } },
              React.createElement('div', null,
                React.createElement('strong', null, '设备鉴权'),
                React.createElement('div', { style: { ...styles.muted, marginTop: 4 } }, status && status.requireAuth ? '已开启，仅允许可信设备连接' : '已关闭，仅影响本机 Debug 入口')),
              React.createElement('label', { style: { ...styles.switch, opacity: busy || !status ? .55 : 1 }, title: status && status.requireAuth ? '关闭设备鉴权' : '开启设备鉴权' },
                React.createElement('input', {
                  type: 'checkbox',
                  role: 'switch',
                  'aria-label': '设备鉴权',
                  'aria-checked': !!(status && status.requireAuth),
                  checked: !!(status && status.requireAuth),
                  disabled: busy || !status,
                  onChange: toggleAuth,
                  style: styles.switchInput,
                }),
                React.createElement('span', { style: { ...styles.switchTrack, background: status && status.requireAuth ? colors.success : colors.danger } }),
                React.createElement('span', { style: { ...styles.switchKnob, left: status && status.requireAuth ? 21 : 3 } }))),
            status && !status.requireAuth
              ? React.createElement('p', { style: { ...styles.error, margin: '12px 0 0' } }, 'Debug 模式：本机 DSH 入口将跳过设备凭证校验；独立局域网入口仍强制鉴权。')
              : null),
          React.createElement('section', { style: styles.card },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start' } },
              React.createElement('div', null,
                React.createElement('strong', null, '插件在线更新'),
                React.createElement('div', { style: { ...styles.muted, marginTop: 4 } }, updateChecking
                  ? '正在检查 npm 最新版本…'
                  : updateInfo
                    ? `当前版本 v${updateInfo.currentVersion} · npm 最新 v${updateInfo.latestVersion}`
                    : '暂时无法获取版本信息'),
                updateInfo?.updateAvailable
                  ? React.createElement('div', { style: { marginTop: 6, color: colors.success, fontWeight: 600 } }, '发现新版本，可直接升级安装。')
                  : null,
                updateInfo && !updateInfo.updateAvailable
                  ? React.createElement('div', { style: { marginTop: 6, color: colors.success } }, '当前已是最新版本。')
                  : null,
                updateNotice
                  ? React.createElement('div', { style: { ...styles.muted, marginTop: 6, overflowWrap: 'anywhere' }, role: 'status' }, updateNotice)
                  : null,
                updateError
                  ? React.createElement('div', { style: { ...styles.muted, marginTop: 6, color: colors.danger, overflowWrap: 'anywhere' }, role: 'status' }, `检查失败：${updateError}`)
                  : null),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 100 } },
                React.createElement('button', {
                  type: 'button',
                  style: { ...styles.button, ...styles.primary, opacity: updateBusy || !updateInfo?.updateAvailable ? .55 : 1 },
                  disabled: updateBusy || updateChecking || !updateInfo?.updateAvailable,
                  onClick: upgradePlugin,
                }, updateBusy ? '正在升级…' : '立即升级'),
                React.createElement('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: updateChecking || updateBusy,
                  onClick: checkForPluginUpdate,
                }, updateChecking ? '检查中…' : '重新检查')))),
          ),
          React.createElement('div', { hidden: activeSection !== 'pairing' },
          React.createElement('section', { style: styles.card },
            React.createElement('div', { className: 'mgw-setting-row' },
            React.createElement('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }, onMouseLeave: () => setConnectionHelpOpen(false) },
              React.createElement('h3', { className: 'mgw-section-title', style: { marginBottom: 0 } }, '配对连接方式'),
              React.createElement('button', {
                type: 'button',
                style: styles.helpButton,
                'aria-label': '连接方式说明与场景建议',
                'aria-expanded': connectionHelpOpen,
                'aria-describedby': connectionHelpOpen ? 'mgw-route-help' : undefined,
                onMouseEnter: () => setConnectionHelpOpen(true),
                onFocus: () => setConnectionHelpOpen(true),
                onBlur: () => setConnectionHelpOpen(false),
                onClick: () => setConnectionHelpOpen(true),
                onKeyDown: (event) => { if (event.key === 'Escape') setConnectionHelpOpen(false) },
              }, '?'),
              connectionHelpOpen ? React.createElement('div', { id: 'mgw-route-help', role: 'tooltip', style: styles.helpBubble },
                React.createElement('strong', null, '怎么选连接方式'),
                helpLine('局域网直连', 'DSH App 和鲸尾小程序都可使用 ws:// 私有地址；手机与 DSH 位于可互访的局域网或 VPN 时可直连。'),
                helpLine('Cloudflare Tunnel（命名）', 'PC 主动连接 Cloudflare，DSH App 和小程序都可通过固定域名的 wss:// 公网入口连接；需要 Cloudflare 账户和域名。'),
                helpLine('Quick Tunnel', '无需账户或域名，两种客户端都可通过临时 wss:// 地址连接；隧道重建后地址可能变化。'),
                helpLine('公网服务器连接', '配置 Linux 服务器公网 WSS 入口，DSH App 和小程序都可使用。'),
                helpLine('鲸尾公网 · 小程序', '生成仅供小程序使用的鲸尾中继二维码；要同时配对 DSH App 和小程序，请选“自动选择”。'),
                React.createElement('div', { style: { borderTop: `1px solid ${colors.border}`, marginTop: 10, paddingTop: 8 } },
                  React.createElement('strong', null, '结合当前环境'),
                  React.createElement('div', { style: { color: colors.muted, marginTop: 4 } }, advice.detected),
                  React.createElement('div', { style: { marginTop: 6 } }, advice.local),
                  React.createElement('div', { style: { marginTop: 6 } }, advice.remote),
                  React.createElement('div', { style: { color: colors.muted, marginTop: 6 } }, '面板无法判断手机当前网络；请按手机所在位置选择，提示不会替你修改选择。')))
                : null),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 14px', maxWidth: '100%' } },
            React.createElement(GatewaySelect, { style: styles.input, value: effectiveRoute, onChange: (event) => choosePairingRoute(event.target.value), disabled: !status, 'aria-label': '配对连接方式' },
              React.createElement('option', { value: 'auto' }, '自动选择'),
              React.createElement('option', { value: 'relay', disabled: !status?.relay }, status?.relay
                ? '鲸尾公网 · 小程序' : '鲸尾公网 · 尚未注册'),
              lanPairingUrl(status) || pairingRoute === 'lan'
                ? React.createElement('option', { value: 'lan', disabled: !lanPairingUrl(status) }, lanPairingUrl(status)
                  ? '局域网直连'
                  : '局域网直连 · 当前不可用')
                : null,
              status?.cloudflare?.supported
                ? React.createElement('option', {
                  value: 'cloudflare',
                }, status.cloudflare.enabled && status.cloudflare.publicReady === true && status.cloudflare.publicUrl
                  ? 'Cloudflare 外网' : 'Cloudflare 外网 · 尚未就绪') : null,
              React.createElement('option', { value: 'custom' }, '手动输入地址')),
              status?.cloudflare?.supported && pairingRoute === 'auto'
                ? React.createElement('span', { style: { fontSize: 12, lineHeight: 1.5, fontWeight: 500,
                    color: 'var(--dsw-alias-link, #4176e6)' } }, '自动选择会优先尝试已就绪的公网入口，并同时保留局域网地址；DSH App 和小程序都可使用两类地址。配置 Cloudflare 请切换到“Cloudflare 外网”。')
                : status?.cloudflare?.supported && pairingRoute === 'cloudflare'
                  ? React.createElement('span', { style: { fontSize: 12, lineHeight: 1.5, fontWeight: 500,
                      color: 'var(--dsw-alias-link, #4176e6)' } }, cloudflareReady
                    ? 'Cloudflare 外网已就绪；DSH App 和小程序都可使用公网入口，也会保留局域网候选地址。'
                    : 'Cloudflare 尚未就绪，可在本页 Cloudflare 设置中开启并完成连通性检测。')
                  : null),
          React.createElement('p', { style: { ...styles.muted, margin: '-6px 0 10px' } }, pairingRoute === 'relay'
            ? '此模式生成仅供鲸尾小程序使用的中继二维码；DSH App 请选“自动选择”或“局域网直连”。'
            : '公网 WSS 就绪时，DSH App 和小程序都会尝试公网与局域网地址；没有公网入口时，App 使用局域网，小程序优先使用已注册的鲸尾中继，否则也使用局域网。生成新二维码不会断开已连接设备。'),
              // Fork: 中继模式下展示连接器状态与已注册中继信息
              (relayInfo || relayConnector?.running || relayConnector?.delegatedTo || relayConnector?.lastError)
                ? (relayInfo
                    ? React.createElement('div', { style: { ...styles.muted, margin: '2px 0 0', fontWeight: 500 } },
                        '鲸尾公网服务 · 已注册', ' · ',
                        React.createElement('span', { style: { opacity: .8 } }, `设备 ID ${relayInfo.nodeId.slice(0, 8)}… · ${relayInfo.gatewayName}`),
                        React.createElement('div', { style: { marginTop: 6, padding: '9px 11px', borderRadius: 10, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d98324) 26%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d98324) 9%, transparent)', fontWeight: 400 } },
                          React.createElement('div', null, '公网 WSS 就绪时，DSH App 和小程序都会获得公网与局域网候选地址；没有公网入口时，App 使用局域网，小程序优先使用已注册的鲸尾公网中继，否则使用局域网。也可单独选择“鲸尾公网 · 小程序”强制生成专用中继二维码。'),
                          React.createElement('div', { style: { marginTop: 5 } }, relayConnector?.running || relayConnector?.delegatedTo
                            ? '中继连接保持运行；切换配对方式不会断开已配对设备。'
                            : relayConnector?.lastError ? '中继连接器暂不可用，请检查网络或重新开启公网连接。'
                              : '中继身份已保存，连接器正在恢复…'),
                          React.createElement('div', { style: { marginTop: 5 } }, '设备配对与公网有效期独立；公网到期不影响局域网。已注册不代表手机端完整链路已通过验证。')))
                    : relayConnector && relayConnector.running
                      ? React.createElement('div', { style: { ...styles.muted, margin: '2px 0 0', fontWeight: 500,
                          color: 'var(--dsw-alias-link, #4176e6)' } }, '内置连接器已自动启动，正在连接中继并上报身份…')
                      : relayConnector && relayConnector.lastError
                        ? React.createElement('div', { style: { ...styles.muted, margin: '2px 0 0', fontWeight: 500, color: colors.danger } },
                            '公网连接器暂时不可用，请检查网络或重新开启公网连接。', ' ',
                            React.createElement('span', { style: { opacity: .8 } }, '如已自行部署连接器，请执行 systemctl restart dsh-connector。'))
                        : React.createElement('div', { style: { ...styles.muted, margin: '2px 0 0' } }, '正在启动内置连接器…（中继模式需要一个本地连接器把小程序流量桥接进来，插件会自动准备）'))
                : null),
            pairingRoute === 'custom' ? React.createElement('label', { style: styles.label }, 'DSH App / 小程序连接地址') : null,
            pairingRoute === 'custom' ? React.createElement('input', { style: styles.input, value: publicUrl, onChange: (event) => setPublicUrl(event.target.value), placeholder: 'ws://192.168.1.10:3081/ws/mobile 或 wss://gateway.example.com/ws/mobile', spellCheck: false }) : null,
            status && status.lan && status.lan.enabled
              ? React.createElement('div', { style: { ...styles.muted, margin: '-7px 0 10px', fontWeight: 500, color: status.lan.error ? colors.danger : status.lan.listening ? colors.success : 'var(--dsw-alias-link, #4176e6)' } },
                  status.lan.error
                    ? `局域网监听失败：${status.lan.error}`
                    : status.lan.listening
                      ? `局域网入口已开启${status.lan.urls && status.lan.urls.length ? `：${status.lan.urls.join('、')}` : `，端口 ${status.lan.port}`}`
                      : '局域网入口启动中…')
              : null,
            React.createElement('button', {
              style: { ...styles.button, ...styles.primary, opacity: busy || !(status && status.gatewayEnabled) || (pairingRoute === 'custom' && !publicUrl.trim()) || (pairingRoute === 'cloudflare' && !cloudflareReady) ? .65 : 1 },
              disabled: busy || !(status && status.gatewayEnabled) ||
                (pairingRoute === 'custom' && !publicUrl.trim()) ||
                (pairingRoute === 'cloudflare' && !cloudflareReady) ||
                (pairingRoute === 'relay' && !status?.relay),
              onClick: pair,
            }, busy ? '正在生成…' : !(status && status.gatewayEnabled) ? '请先开启移动网关'
              : pairingRoute === 'cloudflare' && !cloudflareReady
                ? status?.cloudflare?.enabled ? '等待 Cloudflare 外网就绪' : '先开启 Cloudflare Tunnel'
                : (pairingRoute === 'custom' && !publicUrl.trim()) ? '等待连接地址' : '生成配对二维码'),
            React.createElement('p', { style: { ...styles.muted, margin: '10px 0 0' } }, '配对码仅可使用一次，5 分钟内有效。')),
          pairingRoute === 'cloudflare' && status?.cloudflare?.supported
            ? React.createElement('section', { className: 'mgw-cloudflare-block', style: { ...styles.card, background: colors.card, border: 0, borderRadius: 16, padding: 18, marginTop: 16 } },
                React.createElement('h3', { className: 'mgw-section-title' }, 'Cloudflare Tunnel · 外网接入'),
                React.createElement('p', { style: styles.muted }, status.platform === 'linux'
                  ? 'Linux 服务器不自动下载：请先安装 cloudflared（Cloudflare 官方源 pkg.cloudflare.com 的 cloudflared 包），或将插件配置 cloudflaredPath 指向已有可执行文件。DSH App 和小程序均可使用已配置的公网入口，并且仍要求设备鉴权。'
                  : '首次开启自动准备 Tunnel 组件。'),
                React.createElement('div', { className: 'mgw-setting-row' },
                React.createElement('span', { className: 'mgw-setting-label' }, '接入方式'),
                React.createElement(GatewaySelect, { style: styles.input, value: cloudflareMode, 'aria-label': 'Cloudflare 接入方式', onChange: (event) => {
                    const mode = event.target.value
                    setCloudflareMode(mode)
                    if (status.cloudflare.enabled && mode !== status.cloudflare.mode &&
                        (mode === 'quick' || (status.cloudflare.configured && cloudflareHost === status.cloudflare.hostname && !cloudflareToken))) {
                      void configureCloudflare(true, mode)
                    }
                  }, disabled: cloudflareBusy },
                  React.createElement('option', { value: 'quick' }, 'Quick Tunnel · 无需域名'),
                  React.createElement('option', { value: 'named' }, '命名 Tunnel · 固定域名'))),
                cloudflareMode === 'quick'
                  ? React.createElement('p', { style: styles.muted }, '临时地址可能变化，变化后需重新扫码。')
                  : React.createElement(React.Fragment, null,
                      React.createElement('p', { style: styles.muted }, '先在 Cloudflare 创建命名 Tunnel，把公开域名的 Service URL 设为 ', React.createElement('code', null, `http://127.0.0.1:${status.cloudflare.port}`), '。Tunnel Token 仅授权连接，不能自动创建公开主机名或 DNS；还需确认域名存在指向 Tunnel UUID.cfargotunnel.com 的已代理 CNAME 记录。'),
                      React.createElement('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', margin: '2px 0 4px' } },
                        React.createElement('a', { href: 'https://dash.cloudflare.com/?to=/:account/tunnels', target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-link, #4176e6)', fontSize: 12, fontWeight: 500, textDecoration: 'none' } }, 'Cloudflare 控制台 → 隧道 ↗'),
                        React.createElement('a', { href: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/', target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-link, #4176e6)', fontSize: 12, fontWeight: 500, textDecoration: 'none' } }, '官方创建教程 ↗')),
                      React.createElement('p', { style: styles.muted }, 'Token 在控制台建好 Tunnel 后选择操作系统给出的安装命令里，是 eyJ… 开头的一段（只用它，不需要在 NAS 上执行该命令）。'),
                      React.createElement('label', { style: styles.label }, '公开域名'),
                      React.createElement('input', { style: styles.input, value: cloudflareHost, onChange: (event) => setCloudflareHost(event.target.value.trim()), placeholder: 'gateway.example.com', spellCheck: false }),
                      React.createElement('label', { style: styles.label }, 'Tunnel Token'),
                      React.createElement('input', { style: styles.input, type: 'password', value: cloudflareToken, onChange: (event) => setCloudflareToken(event.target.value.trim()), placeholder: status.cloudflare.configured ? '已保存；留空则保持原 Token' : '粘贴 eyJ… Token', autoComplete: 'off', spellCheck: false })),
                (!status.cloudflare.enabled || (cloudflareMode === 'named' &&
                  (status.cloudflare.mode !== 'named' || cloudflareHost !== status.cloudflare.hostname || !!cloudflareToken)))
                  ? React.createElement('button', {
                  style: { ...styles.button, ...styles.primary, opacity: cloudflareBusy || (cloudflareMode === 'named' && (!cloudflareHost || (!cloudflareToken && !status.cloudflare.configured))) ? .65 : 1 },
                  disabled: cloudflareBusy || (cloudflareMode === 'named' && (!cloudflareHost || (!cloudflareToken && !status.cloudflare.configured))),
                  onClick: () => configureCloudflare(true),
                }, cloudflareBusy ? '正在处理…' : status.cloudflare.enabled ? '保存并连接' : cloudflareMode === 'quick' ? '一键开启 Quick Tunnel' : '开启命名 Tunnel') : null,
                status.cloudflare.enabled
                  ? React.createElement(React.Fragment, null,
                      React.createElement('button', { style: { ...styles.button, width: '100%', marginTop: 8 }, disabled: cloudflareBusy || status.cloudflare.state !== 'online', onClick: checkCloudflare }, '检测公网 DNS / TLS / WebSocket'),
                      React.createElement('button', { style: { ...styles.button, width: '100%', marginTop: 8 }, disabled: cloudflareBusy || !status.gatewayEnabled, onClick: restartCloudflare }, '重启 Tunnel'),
                      React.createElement('button', { style: { ...styles.button, width: '100%', marginTop: 8 }, disabled: cloudflareBusy, onClick: () => configureCloudflare(false) }, '关闭 Cloudflare Tunnel'),
                      React.createElement('p', { style: styles.muted }, '重启会短暂断开连接。'))
                  : null,
                React.createElement('div', { style: { ...styles.muted, marginTop: 9, overflowWrap: 'anywhere', fontWeight: 500, color: status.cloudflare.error ? colors.danger : status.cloudflare.state === 'online' ? colors.success : ['starting', 'preparing', 'connecting'].includes(status.cloudflare.state) ? 'var(--dsw-alias-link, #4176e6)' : colors.muted } },
                  status.cloudflare.error || ({ disabled: '未开启', starting: '正在启动本机入口…', preparing: '正在准备 cloudflared（首次需下载）…', connecting: '正在连接 Cloudflare…', online: '隧道传输已连接（不等于公网入口可达）', 'waiting-for-gateway': '等待移动网关开启' }[status.cloudflare.state] || status.cloudflare.state),
                  status.cloudflare.publicUrl ? ` · ${status.cloudflare.publicUrl}` : ''),
                 status.cloudflare.enabled && status.cloudflare.endpointHealth
                   ? React.createElement('p', { style: { ...styles.muted, overflowWrap: 'anywhere', fontWeight: 500, color: status.cloudflare.endpointHealth.state === 'reachable' ? colors.success : status.cloudflare.endpointHealth.state === 'checking' ? 'var(--dsw-alias-link, #4176e6)' : status.cloudflare.endpointHealth.state === 'unchecked' ? colors.muted : colors.danger } },
                       status.cloudflare.endpointHealth.message,
                       status.cloudflare.endpointHealth.checkedAt ? `（检测时间：${status.cloudflare.endpointHealth.checkedAt}）` : '')
                   : null)
              : null,
          status && status.platform === 'linux' ? React.createElement('section', { style: styles.card },
            React.createElement('h3', { className: 'mgw-section-title' }, '公网接入'),
            publicSetup === null
              ? React.createElement('p', { style: styles.muted }, '正在检查系统组件…')
              : publicSetup.installed
                ? React.createElement(React.Fragment, null,
                    React.createElement('div', { style: { ...styles.muted, margin: '5px 0 12px' } }, publicSetup.configured
                      ? publicSetup.backendPort && status && status.webPort && publicSetup.backendPort !== status.webPort
                        ? `端口需要更新：Nginx 当前为 ${publicSetup.backendPort}，DSH 当前为 ${status.webPort}`
                        : `已配置${publicSetup.backendPort ? `，Nginx 转发至 DSH 端口 ${publicSetup.backendPort}` : ''}`
                      : `Helper 已就绪，将自动使用当前 DSH 端口${status && status.webPort ? ` ${status.webPort}` : ''}`),
                    React.createElement('label', { style: styles.label }, '服务器公网 IPv4'),
                    React.createElement('input', {
                      style: styles.input,
                      value: publicIp,
                      onChange: (event) => setPublicIp(event.target.value.trim()),
                      placeholder: '203.0.113.10',
                      inputMode: 'decimal',
                      spellCheck: false,
                    }),
                    React.createElement('button', {
                      style: { ...styles.button, ...styles.primary, opacity: publicSetupBusy || !publicIp ? .65 : 1 },
                      disabled: publicSetupBusy || !publicIp,
                      onClick: configurePublicAccess,
                    }, publicSetupBusy ? '正在配置 Nginx 与证书…' : publicSetup.configured ? '更新公网配置' : '配置公网接入'),
                    publicSetup.publicUrl
                      ? React.createElement('div', { style: { ...styles.muted, marginTop: 9, overflowWrap: 'anywhere' } }, publicSetup.publicUrl)
                      : null)
                : React.createElement(React.Fragment, null,
                    React.createElement('p', { style: { ...styles.muted, marginBottom: 8 } }, '尚未安装系统 Helper。请在服务器执行一次初始化：'),
                    React.createElement('code', { style: { display: 'block', fontSize: 10, lineHeight: 1.5, overflowWrap: 'anywhere', userSelect: 'all' } }, 'npx --yes dsh-plugin-mobile-gateway@latest init'))) : null,

          ),
          React.createElement('div', { hidden: activeSection !== 'devices' },
          React.createElement('section', { style: styles.card },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              React.createElement('h3', { className: 'mgw-section-title', style: { marginBottom: 0 } }, '可信设备'),
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                deviceNotice || refreshNotice ? React.createElement('span', {
                  style: { ...styles.muted, color: deviceNoticeError ? colors.danger : colors.success },
                }, deviceNotice || refreshNotice) : null,
                React.createElement('button', {
                  style: { ...styles.button, opacity: refreshing ? .6 : 1 },
                  disabled: refreshing,
                  onClick: manualRefresh,
                }, refreshing ? '刷新中…' : '刷新'))),
            devices === null
              ? React.createElement('p', { style: styles.muted }, '加载中…')
              : devices.length === 0
                ? React.createElement('p', { style: styles.muted }, '暂无已配对设备。')
                : React.createElement(React.Fragment, null,
                  visibleDevices.length === 0 ? React.createElement('p', { style: styles.muted }, '当前没有在线设备。') : null,
                  visibleDevices.map((device) => React.createElement(DeviceRow, {
                    key: device.id,
                    device,
                    onRevoke: revoke,
                    revoking: revokingIds.has(device.id),
                  })),
                  offlineDevices.length > 0 ? React.createElement('button', {
                    type: 'button',
                    style: { ...styles.button, marginTop: 10, color: colors.muted },
                    'aria-expanded': showAllDevices,
                    onClick: () => setShowAllDevices((value) => !value),
                  }, showAllDevices ? '收起离线设备' : `展开其他已配对设备（${offlineDevices.length}）`) : null)),
          )),
          ),
          status && status.version
            ? React.createElement('div', { style: styles.version, 'aria-label': `插件版本 ${status.version}` }, `v${status.version}`)
            : null))
    }

    // Fork: the entry is a Settings section instead of a sidebar footer button.
    // Tapping the Settings nav item opens the management dialog directly — the
    // dialog itself is upstream's unchanged shell.
    function SettingsEntry() {
      const isOpen = React.useSyncExternalStore(subscribe, getOpen, () => false)
      React.useEffect(() => { setOpen(true) }, [])
      return isOpen ? React.createElement(DevicePanel) : null
    }

    const inject = ['slots']
    function apply(ctx) {
      // Upstream 0.10.1: the panel stylesheet is injected once through an
      // effect instead of being re-rendered inside the component tree.
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = panelCss
        document.head.appendChild(style)
        return () => style.remove()
      }, 'mobile-gateway: panel styles')
      pinNavGlyph([NAV_LABEL], NAV_ICON_MARK, navGlyph)
      // Fork: the entry is a Settings section, not the upstream sidebar footer
      // button. The id deliberately stays 'mobile-gateway' (not the package
      // name): it is a slot key that pinned-section state and the settings
      // plugin-hub map against, so renaming it would drop existing pins.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'mobile-gateway', order: 35, label: () => NAV_LABEL },
        () => React.createElement(SettingsEntry, null),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.pinNavGlyph = pinNavGlyph
    // Exposed for tests: the Settings entry and the dialog body render separately.
    exports.SettingsEntry = SettingsEntry
    exports.DevicePanel = DevicePanel
    return module.exports
  },
})
