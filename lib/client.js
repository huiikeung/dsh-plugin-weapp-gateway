// Browser half of dsh-plugin-weapp-gateway. The package manifest makes this
// bundle part of DSH's client-module graph; it contributes ONE Settings page
// ("移动设备") through the `settings.section` slot.
//
// The management surface deliberately lives in Settings like every other
// plugin: the sidebar footer action and the shell overlay drawer were removed,
// so nothing floats over the app and the sidebar keeps its shipped seats.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-weapp-gateway',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    // --------------------------------------------------------------------------
    // Settings-page stylesheet. Uses the host design tokens (--dsw-alias-*) so
    // the page follows light/dark and the shipped settings chrome. Injected
    // once; HMR re-evaluation is a no-op because the id is already present.
    // --------------------------------------------------------------------------
    const STYLE_ID = 'dsh-plugin-weapp-gateway-settings'
    const CSS = `
.mgw-page{display:flex;flex-direction:column;gap:20px;width:100%;box-sizing:border-box}
.mgw-group{display:flex;flex-direction:column;gap:8px}
.mgw-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;min-height:22px}
.mgw-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:normal}
.mgw-card{display:flex;flex-direction:column;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));overflow:hidden;box-sizing:border-box}
.mgw-card>*:not(:last-child){border-bottom:1px solid var(--dsw-alias-border-l2)}
.mgw-row{display:flex;align-items:center;gap:12px;padding:14px 16px;box-sizing:border-box}
.mgw-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mgw-row-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px;min-width:0}
.mgw-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.mgw-row-trailing{display:inline-flex;align-items:center;gap:6px;flex:none}
.mgw-field{display:flex;flex-direction:column;gap:8px;padding:14px 16px;box-sizing:border-box}
.mgw-field-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.mgw-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none}
.mgw-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.mgw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mgw-textarea{width:100%;box-sizing:border-box;min-height:84px;resize:vertical;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;outline:none}
.mgw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;cursor:pointer;box-sizing:border-box;white-space:nowrap}
.mgw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mgw-btn:disabled{cursor:not-allowed;opacity:.6}
.mgw-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.mgw-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}
.mgw-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mgw-btn-ghost{border-color:transparent}
.mgw-btn-block{width:100%}
.mgw-seg{display:inline-flex;align-items:center;height:32px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-sizing:border-box;max-width:100%}
.mgw-seg-btn{display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 12px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.mgw-seg-btn:hover:not(:disabled):not(.selected){color:var(--dsw-alias-label-primary)}
.mgw-seg-btn.selected{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-business-primary);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)}
.mgw-seg-btn:disabled{cursor:not-allowed;opacity:.6}
.mgw-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:none;border:none;padding:0;background:transparent;cursor:pointer}
.mgw-switch:disabled{cursor:not-allowed;opacity:.55}
.mgw-switch-track{position:absolute;inset:0;border-radius:99px;transition:background .18s ease}
.mgw-switch-knob{position:absolute;top:3px;width:18px;height:18px;border-radius:99px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:left .18s ease}
.mgw-dot{width:7px;height:7px;border-radius:99px;display:inline-block;flex:none}
.mgw-dot-on{background:var(--dsw-alias-state-success-primary,#2fb171)}
.mgw-dot-off{background:var(--dsw-alias-label-tertiary)}
.mgw-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mgw-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.mgw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.mgw-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-radius:8px;padding:10px 12px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.mgw-ok{color:var(--dsw-alias-state-success-primary)}
.mgw-danger{color:var(--dsw-alias-state-error-primary)}
.mgw-notice{font-size:12px;line-height:18px;white-space:nowrap}
.mgw-qr{display:block;width:200px;height:200px;margin:0 auto;background:#fff;border-radius:10px;padding:8px;box-sizing:border-box}
.mgw-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 2px 0}
.mgw-version{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.mgw-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:14px 16px}
.mgw-callout{display:flex;gap:9px;align-items:flex-start;padding:11px 13px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d98324) 10%,var(--dsw-alias-bg-layer-1));border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d98324) 26%,transparent);font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);box-sizing:border-box}
.mgw-callout-icon{flex:none;width:15px;height:15px;margin-top:2px;color:var(--dsw-alias-state-warning-primary,#d98324)}
.mgw-callout-text{min-width:0;flex:1}
.mgw-callout-text b{color:var(--dsw-alias-label-primary);font-weight:600}
`

    function adoptStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
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
    const NAV_LABEL = '移动设备'
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

    async function request(path, options) {
      const response = await fetch(path, { credentials: 'same-origin', ...options })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`)
      return body
    }

    function inferredUrl(wsPath) {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${scheme}//${window.location.host}${wsPath || '/ws/mobile'}`
    }

    function DeviceRow({ device, onRevoke, revoking }) {
      const triggerRevoke = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!revoking) onRevoke(device)
      }
      return React.createElement('div', { className: 'mgw-row' },
        React.createElement('div', { className: 'mgw-row-main' },
          React.createElement('div', { className: 'mgw-row-title' },
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.name),
            React.createElement('span', { className: 'mgw-badge' },
              React.createElement('span', { className: `mgw-dot ${device.online ? 'mgw-dot-on' : 'mgw-dot-off'}` }),
              device.online ? `在线${device.connections > 1 ? ` · ${device.connections} 个连接` : ''}` : '离线')),
          React.createElement('div', { className: 'mgw-row-desc' },
            device.lastSeenAt ? `最近连接：${new Date(device.lastSeenAt).toLocaleString()}` : '尚未连接')),
        React.createElement('button', {
          type: 'button',
          className: 'mgw-btn mgw-btn-danger',
          disabled: revoking,
          title: `吊销 ${device.name}`,
          // Pointer-up is more reliable than click on touch devices; the click
          // handler remains for keyboard activation (detail === 0).
          onPointerUp: triggerRevoke,
          onClick: (event) => {
            if (event.detail === 0) triggerRevoke(event)
          },
        }, revoking ? '吊销中…' : '吊销'))
    }

    function Switch({ checked, disabled, label, onChange }) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': !!checked,
        'aria-label': label,
        className: 'mgw-switch',
        disabled,
        onClick: onChange,
      },
      React.createElement('span', {
        className: 'mgw-switch-track',
        style: { background: checked ? 'var(--dsw-alias-state-success-primary,#2fb171)' : 'var(--dsw-alias-state-error-primary,#dc4c64)' },
      }),
      React.createElement('span', { className: 'mgw-switch-knob', style: { left: checked ? 21 : 3 } }))
    }

    function Segmented({ value, options, disabled, label, onChange }) {
      return React.createElement('div', { className: 'mgw-seg', role: 'group', 'aria-label': label },
        options.map((option) => React.createElement('button', {
          key: option.value,
          type: 'button',
          className: `mgw-seg-btn${option.value === value ? ' selected' : ''}`,
          'aria-pressed': option.value === value,
          disabled,
          onClick: () => {
            if (option.value !== value) onChange(option.value)
          },
        }, option.label)))
    }

    function modeDescription(status) {
      if (!status || !status.gatewayEnabled) return '关闭时不会接受移动设备连接，重启后保持关闭'
      if (status.gatewayMode === 'persistent') return '常驻开启，重启后保持；无需设备在线'
      if (status.waitExpiresAt) return `等待可信设备连接，约 ${Math.max(1, Math.ceil((status.waitExpiresAt - Date.now()) / 60000))} 分钟后自动关闭`
      return '设备已连接过，本次运行保持开启；重启后重新计时'
    }

    // --------------------------------------------------------------------------
    // The Settings page body. Mounted by the settings shell while the
    // "移动设备" section is active, so polling starts and stops with the page.
    // --------------------------------------------------------------------------
    function MobileGatewaySection(props) {
      const close = props && typeof props.close === 'function' ? props.close : null
      const [devices, setDevices] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [publicUrl, setPublicUrl] = React.useState('')
      const [publicIp, setPublicIp] = React.useState('')
      const [publicSetup, setPublicSetup] = React.useState(null)
      const [publicSetupBusy, setPublicSetupBusy] = React.useState(false)
      const [deviceName, setDeviceName] = React.useState('iPhone')
      const deviceNameTouched = React.useRef(false)
      const [qr, setQr] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [refreshNotice, setRefreshNotice] = React.useState(null)
      const [pairingTokenCopied, setPairingTokenCopied] = React.useState(false)
      const [deviceNotice, setDeviceNotice] = React.useState(null)
      const [deviceNoticeError, setDeviceNoticeError] = React.useState(false)
      const [revokingIds, setRevokingIds] = React.useState(() => new Set())
      const revokingIdsRef = React.useRef(new Set())
      const automaticUrlRef = React.useRef('')

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
          const lanUrl = statusData.lan && Array.isArray(statusData.lan.urls) ? statusData.lan.urls[0] : ''
          const preferredUrl = statusData.publicUrl || lanUrl || inferredUrl(statusData.wsPath)
          setPublicUrl((current) => {
            if (!current || current === automaticUrlRef.current) {
              automaticUrlRef.current = preferredUrl
              return preferredUrl
            }
            return current
          })
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

      React.useEffect(() => {
        let active = true
        refresh()
        request('/mgw/public-setup').then((data) => {
          if (!active) return
          setPublicSetup(data)
          if (data.publicUrl) {
            const match = /^wss:\/\/([^/]+)\/ws\/mobile$/.exec(data.publicUrl)
            if (match) setPublicIp(match[1])
          }
        }).catch((cause) => active && setPublicSetup({ installed: false, configured: false, error: cause.message }))
        const timer = window.setInterval(refresh, 3000)
        return () => { active = false; window.clearInterval(timer) }
      }, [refresh])

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
          if (data.publicUrl) {
            automaticUrlRef.current = data.publicUrl
            setPublicUrl(data.publicUrl)
          }
        } catch (cause) {
          setError(cause.message)
        } finally {
          setPublicSetupBusy(false)
        }
      }

      const createPairing = async (endpoint) => request('/mgw/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: deviceName.trim(), publicUrl: endpoint }),
      })

      const pair = async () => {
        setBusy(true)
        setError(null)
        setPairingTokenCopied(false)
        try {
          const data = await createPairing(publicUrl)
          setQr(data)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const copyPairingText = async () => {
        if (!qr || !qr.qrPayload) return
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('当前浏览器不允许直接写入剪贴板，请选中文本后手动复制')
          }
          await navigator.clipboard.writeText(qr.qrPayload)
          setError(null)
          setPairingTokenCopied(true)
          window.setTimeout(() => setPairingTokenCopied(false), 2200)
        } catch (cause) {
          setPairingTokenCopied(false)
          setError(cause.message)
        }
      }

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
          setDeviceNotice(`已吊销 ${device.name}`)
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

      const gatewayEnabled = !!(status && status.gatewayEnabled)
      const requireAuth = !!(status && status.requireAuth)
      const modeValue = status ? (status.gatewayMode || (status.gatewayEnabled ? 'temporary' : 'disabled')) : 'disabled'
      const pairingMode = status && status.pairingMode ? status.pairingMode : 'direct'
      // 'iPhone' only makes sense for the iOS direct client. In relay mode the
      // device is named after the phone that actually connects, so the field
      // starts empty unless the operator has typed something.
      React.useEffect(() => {
        if (deviceNameTouched.current) return
        setDeviceName(pairingMode === 'relay' ? '' : 'iPhone')
      }, [pairingMode])
      const relayInfo = status && status.relay ? status.relay : null
      const publicAccessLabel = pairingMode === 'relay'
        ? '公网接入（中继模式下只影响上面透传的网关地址）'
        : '公网接入'
      const publicKeyFingerprint = (key) => (typeof key === 'string' && key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-10)}` : String(key || ''))

      return React.createElement('div', { className: 'mgw-page' },
        error ? React.createElement('div', { className: 'mgw-error', role: 'alert' }, error) : null,

        // ---- 网关 -------------------------------------------------------------
        React.createElement('section', { className: 'mgw-group' },
          React.createElement('div', { className: 'mgw-group-header' },
            React.createElement('span', { className: 'mgw-group-title' }, '网关')),
          React.createElement('div', { className: 'mgw-card' },
            React.createElement('div', { className: 'mgw-row' },
              React.createElement('div', { className: 'mgw-row-main' },
                React.createElement('div', { className: 'mgw-row-title' }, '网关运行模式'),
                React.createElement('div', { className: 'mgw-row-desc' }, modeDescription(status))),
              React.createElement('div', { className: 'mgw-row-trailing' },
                React.createElement(Segmented, {
                  value: modeValue,
                  disabled: busy || !status,
                  label: '网关运行模式',
                  options: [
                    { value: 'disabled', label: '关闭' },
                    { value: 'temporary', label: '临时开启' },
                    { value: 'persistent', label: '常驻开启' },
                  ],
                  onChange: changeGatewayMode,
                }))),
            status && status.gatewayId
              ? React.createElement('div', { className: 'mgw-field' },
                  React.createElement('div', { className: 'mgw-note' }, '网关标识'),
                  React.createElement('div', { className: 'mgw-mono' }, `${status.gatewayName} · ${status.gatewayId}`))
              : null,
            React.createElement('div', { className: 'mgw-row' },
              React.createElement('div', { className: 'mgw-row-main' },
                React.createElement('div', { className: 'mgw-row-title' }, '设备鉴权'),
                React.createElement('div', { className: 'mgw-row-desc' }, requireAuth ? '已开启，仅允许可信设备连接' : '已关闭，仅影响本机 Debug 入口')),
              React.createElement('div', { className: 'mgw-row-trailing' },
                React.createElement(Switch, {
                  checked: requireAuth,
                  disabled: busy || !status,
                  label: '设备鉴权',
                  onChange: toggleAuth,
                }))),
            !requireAuth && status
              ? React.createElement('div', { className: 'mgw-field' },
                  React.createElement('div', { className: 'mgw-note mgw-danger' }, 'Debug 模式：本机 DSH 入口将跳过设备凭证校验；独立局域网入口仍强制鉴权。'))
              : null)),

        // ---- 连接模式 ---------------------------------------------------------
        React.createElement('section', { className: 'mgw-group' },
          React.createElement('div', { className: 'mgw-group-header' },
            React.createElement('span', { className: 'mgw-group-title' }, '连接模式')),
          React.createElement('div', { className: 'mgw-card' },
            React.createElement('div', { className: 'mgw-row' },
              React.createElement('div', { className: 'mgw-row-main' },
                React.createElement('div', { className: 'mgw-row-title' }, '配对码指向'),
                React.createElement('div', { className: 'mgw-row-desc' }, pairingMode === 'relay'
                  ? '中继模式：二维码指向 VPS 中继，小程序经中继和本机 connector 接入，适合外网/无端口映射'
                  : '直连模式：二维码指向网关自己的地址（局域网或你的域名反代），适合同一网络')),
              React.createElement('div', { className: 'mgw-row-trailing' },
                React.createElement(Segmented, {
                  value: pairingMode,
                  disabled: busy || !status,
                  label: '连接模式',
                  options: [
                    { value: 'direct', label: '直连' },
                    { value: 'relay', label: '中继' },
                  ],
                  onChange: changePairingMode,
                }))),
            pairingMode === 'relay'
              ? (relayInfo
                  ? React.createElement('div', { className: 'mgw-field' },
                      // One callout carrying both sentences — why relay is the
                      // only external option, and what to check if pairing
                      // still fails. No bare coloured text on this page.
                      React.createElement('div', { className: 'mgw-callout' },
                        React.createElement('svg', { className: 'mgw-callout-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                          React.createElement('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4 }),
                          React.createElement('path', { d: 'M8 5.2v3.2M8 10.6v.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
                        React.createElement('div', { className: 'mgw-callout-text' },
                          React.createElement('div', null,
                            '外网必须走中继：小程序只能连接已配置的域名、且基本限于 443 端口，带端口的公网地址它连不上。'),
                          React.createElement('div', { style: { marginTop: 5 } },
                            '中继链路已验证可用。若扫码后仍报「地址未经此主机确认」，请确认小程序版本支持中继协议（v3 载荷）。'))),
                      React.createElement('div', { className: 'mgw-note' }, '已注册的中继（本机 connector 自动上报）'),
                      React.createElement('div', { className: 'mgw-mono' }, relayInfo.relay),
                      React.createElement('div', { className: 'mgw-mono' }, `nodeId ${relayInfo.nodeId}`),
                      React.createElement('div', { className: 'mgw-mono' }, `agentPubKey ${publicKeyFingerprint(relayInfo.agentPubKey)}`),
                      React.createElement('div', { className: 'mgw-note' }, `网关名 ${relayInfo.gatewayName} · 上报于 ${new Date(relayInfo.updatedAt).toLocaleString()}`))
                  : React.createElement('div', { className: 'mgw-field' },
                      React.createElement('div', { className: 'mgw-callout' },
                        React.createElement('svg', { className: 'mgw-callout-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                          React.createElement('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4 }),
                          React.createElement('path', { d: 'M8 5.2v3.2M8 10.6v.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
                        React.createElement('div', { className: 'mgw-callout-text' },
                          '尚未收到 connector 注册。请确认 /vol1/app/dsh-relay 的 dsh-connector 正在运行——它连上中继后会自动上报身份。'))))
              : React.createElement('div', { className: 'mgw-field' },
                  React.createElement('div', { className: 'mgw-note' }, '扫码后客户端直连下列地址（dsh-weapp 已验证可用）：'),
                  status && Array.isArray(status.endpoints) && status.endpoints.length
                    ? status.endpoints.map((endpoint) => React.createElement('div', { className: 'mgw-mono', key: endpoint }, endpoint))
                    : React.createElement('div', { className: 'mgw-note mgw-danger' }, '暂无可用地址，请在下方「WebSocket 地址」填写')))),

        // ---- 连接地址 ---------------------------------------------------------
        React.createElement('section', { className: 'mgw-group' },
          React.createElement('div', { className: 'mgw-group-header' },
            React.createElement('span', { className: 'mgw-group-title' }, '连接地址')),
          React.createElement('div', { className: 'mgw-card' },
            // The QR points at different things per mode, so this group leads
            // with whichever address actually carries the connection.
            pairingMode === 'relay'
              ? React.createElement('div', { className: 'mgw-field' },
                  React.createElement('div', { className: 'mgw-field-label' }, '连接地址（二维码指向这里）'),
                  relayInfo
                    ? React.createElement('div', { className: 'mgw-mono', style: { fontSize: 14 } }, relayInfo.relay)
                    : React.createElement('div', { className: 'mgw-note mgw-danger' }, '尚未收到 connector 注册，暂无法生成中继配对码'),
                  React.createElement('div', { className: 'mgw-note' }, '小程序经 VPS 中继 + 本机 connector 接入，不直连本机；防火墙无需开放任何入站端口。'))
              : null,
            React.createElement('div', { className: 'mgw-field' },
              React.createElement('label', {
                className: 'mgw-field-label',
                htmlFor: 'mgw-ws-url',
              }, pairingMode === 'relay' ? '网关地址（仅透传给小程序）' : 'WebSocket 地址（二维码指向这里）'),
              React.createElement('input', {
                id: 'mgw-ws-url',
                className: 'mgw-input',
                value: publicUrl,
                onChange: (event) => { automaticUrlRef.current = ''; setPublicUrl(event.target.value) },
                placeholder: 'ws://192.168.1.10:3081/ws/mobile',
                spellCheck: false,
              }),
              pairingMode === 'relay'
                ? React.createElement('div', { className: 'mgw-note' }, '中继模式下小程序不直连它；它只作为 gatewayUrl 出现在配对载荷里，供客户端展示。')
                : null,
              status && status.lan && status.lan.enabled
                ? React.createElement('div', { className: `mgw-note${status.lan.error ? ' mgw-danger' : ''}` },
                    status.lan.error
                      ? `局域网监听失败：${status.lan.error}`
                      : status.lan.listening
                        ? `局域网入口已开启${status.lan.urls && status.lan.urls.length ? `：${status.lan.urls.join('、')}` : `，端口 ${status.lan.port}`}`
                        : '局域网入口启动中…')
                : null,
              React.createElement('div', { className: 'mgw-note' }, '同一局域网可直接使用私有地址的 ws://；公网地址仍必须使用 wss://。配对码只能使用一次，并在 5 分钟内过期。')),
            publicSetup === null
              ? React.createElement('div', { className: 'mgw-field' },
                  React.createElement('div', { className: 'mgw-note' }, '正在检查系统组件…'))
              : publicSetup.installed
                ? React.createElement('div', { className: 'mgw-field' },
                    React.createElement('div', { className: 'mgw-field-label' }, publicAccessLabel),
                    React.createElement('div', { className: 'mgw-note' }, publicSetup.configured
                      ? publicSetup.backendPort && status && status.webPort && publicSetup.backendPort !== status.webPort
                        ? `端口需要更新：Nginx 当前为 ${publicSetup.backendPort}，DSH 当前为 ${status.webPort}`
                        : `已配置${publicSetup.backendPort ? `，Nginx 转发至 DSH 端口 ${publicSetup.backendPort}` : ''}`
                      : `Helper 已就绪，将自动使用当前 DSH 端口${status && status.webPort ? ` ${status.webPort}` : ''}`),
                    React.createElement('label', { className: 'mgw-note', htmlFor: 'mgw-public-ip' }, '服务器公网 IPv4'),
                    React.createElement('input', {
                      id: 'mgw-public-ip',
                      className: 'mgw-input',
                      value: publicIp,
                      onChange: (event) => setPublicIp(event.target.value.trim()),
                      placeholder: '203.0.113.10',
                      inputMode: 'decimal',
                      spellCheck: false,
                    }),
                    React.createElement('button', {
                      className: 'mgw-btn mgw-btn-primary',
                      disabled: publicSetupBusy || !publicIp,
                      onClick: configurePublicAccess,
                    }, publicSetupBusy ? '正在配置 Nginx 与证书…' : publicSetup.configured ? '更新公网配置' : '配置公网接入'),
                    publicSetup.publicUrl
                      ? React.createElement('div', { className: 'mgw-mono' }, publicSetup.publicUrl)
                      : null)
                : React.createElement('div', { className: 'mgw-field' },
                    React.createElement('div', { className: 'mgw-field-label' }, publicAccessLabel),
                    React.createElement('div', { className: 'mgw-note' }, '尚未安装系统 Helper。请在服务器执行一次初始化：'),
                    React.createElement('code', { className: 'mgw-mono', style: { userSelect: 'all' } }, 'npx --yes dsh-plugin-weapp-gateway@latest init')))),

        // ---- 配对 -------------------------------------------------------------
        React.createElement('section', { className: 'mgw-group' },
          React.createElement('div', { className: 'mgw-group-header' },
            React.createElement('span', { className: 'mgw-group-title' }, '配对')),
          React.createElement('div', { className: 'mgw-card' },
            React.createElement('div', { className: 'mgw-field' },
              React.createElement('label', { className: 'mgw-field-label', htmlFor: 'mgw-device-name' }, '设备名称'),
              React.createElement('input', {
                id: 'mgw-device-name',
                className: 'mgw-input',
                value: deviceName,
                onChange: (event) => { deviceNameTouched.current = true; setDeviceName(event.target.value) },
                maxLength: 80,
                placeholder: pairingMode === 'relay' ? '留空自动识别手机型号' : 'iPhone',
              }),
              pairingMode === 'relay'
                ? React.createElement('div', { className: 'mgw-note' }, '留空时由本机连接器按所连接手机的型号自动命名；也可以手动指定。')
                : null),
            React.createElement('div', { className: 'mgw-field' },
              React.createElement('button', {
                className: 'mgw-btn mgw-btn-primary mgw-btn-block',
                disabled: busy || !gatewayEnabled,
                onClick: pair,
              }, busy ? '正在生成…' : gatewayEnabled ? '生成配对二维码' : '请先开启移动网关')),
            qr ? React.createElement('div', { className: 'mgw-field' },
              React.createElement('div', { className: 'mgw-field-label' }, '使用 iOS 客户端扫码'),
              React.createElement('img', { className: 'mgw-qr', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`, alt: '一次性设备配对二维码' }),
              React.createElement('label', { className: 'mgw-note', htmlFor: 'mgw-pairing-token' }, 'Base64URL 配对字符串'),
              React.createElement('textarea', {
                id: 'mgw-pairing-token',
                className: 'mgw-textarea',
                value: qr.qrPayload,
                readOnly: true,
                spellCheck: false,
                onFocus: (event) => event.target.select(),
              }),
              React.createElement('button', {
                className: `mgw-btn${pairingTokenCopied ? ' mgw-ok' : ''}`,
                onClick: copyPairingText,
              }, pairingTokenCopied ? '✓ 已复制' : '复制配对 Token'),
              pairingTokenCopied ? React.createElement('div', { className: 'mgw-note mgw-ok' }, '已复制到剪贴板') : null,
              React.createElement('div', { className: 'mgw-note' }, `有效期至 ${new Date(qr.pairing.expiresAt).toLocaleTimeString()}；扫码成功后此二维码立即失效。`)) : null)),

        // ---- 可信设备 ---------------------------------------------------------
        React.createElement('section', { className: 'mgw-group' },
          React.createElement('div', { className: 'mgw-group-header' },
            React.createElement('span', { className: 'mgw-group-title' }, '可信设备'),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              deviceNotice || refreshNotice ? React.createElement('span', {
                className: `mgw-notice${deviceNoticeError ? ' mgw-danger' : ' mgw-ok'}`,
              }, deviceNotice || refreshNotice) : null,
              React.createElement('button', {
                className: 'mgw-btn mgw-btn-ghost',
                disabled: refreshing,
                onClick: manualRefresh,
              }, refreshing ? '刷新中…' : '刷新'))),
          React.createElement('div', { className: 'mgw-card' },
            devices === null
              ? React.createElement('div', { className: 'mgw-empty' }, '加载中…')
              : devices.length === 0
                ? React.createElement('div', { className: 'mgw-empty' }, '暂无已配对设备。')
                : devices.map((device) => React.createElement(DeviceRow, {
                    key: device.id,
                    device,
                    onRevoke: revoke,
                    revoking: revokingIds.has(device.id),
                  })))),

        // ---- 页脚 -------------------------------------------------------------
        React.createElement('div', { className: 'mgw-footer' },
          status && status.version
            ? React.createElement('div', { className: 'mgw-version', 'aria-label': `插件版本 ${status.version}` }, `v${status.version}`)
            : React.createElement('span', null),
          close ? React.createElement('button', { type: 'button', className: 'mgw-btn', onClick: close }, '完成') : null))
    }

    const inject = ['slots']
    function apply(ctx) {
      adoptStyles()
      pinNavGlyph([NAV_LABEL], NAV_ICON_MARK, navGlyph)
      // One Settings page ("移动设备"). No sidebar entry, no shell overlay: the
      // management surface is reached through the Settings panel like every
      // other plugin.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        // The section id deliberately stays 'mobile-gateway' (not the package
        // name): it is a slot key that pinned-section state and the settings
        // plugin-hub map against, so renaming it would drop existing pins.
        { name: 'settings.section', id: 'mobile-gateway', order: 35, label: () => '移动设备' },
        (props) => React.createElement(MobileGatewaySection, props),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for the nav-glyph unit test; the host only uses apply/inject.
    exports.pinNavGlyph = pinNavGlyph
    return module.exports
  },
})
