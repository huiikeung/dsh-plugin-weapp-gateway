import crypto from 'node:crypto'
import os from 'node:os'
import { Readable } from 'node:stream'

function requireRecord(value, endpoint) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${endpoint} returned an invalid object`)
  }
  return value
}

function requireArray(value, endpoint) {
  if (!Array.isArray(value)) throw new Error(`${endpoint} returned an invalid array`)
  return value
}

// The current session address, upload and Peer routes are provided by this
// Host baseline. Keep the hello value truthful so clients can gate features.
export const DSH_VERSION = '0.2.1-rc.2'
export const SESSION_FORMAT_VERSION = 4

export function readHistoryRecords(records) {
  return requireArray(records, 'session history').map(record => {
    const value = requireRecord(record, 'session history record')
    if (value.type !== 'event') throw new Error('DSH Session V4 history requires event records')
    const event = requireRecord(value.event, 'session history event')
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('invalid history sequence')
    return event
  })
}

export function readSessionSnapshot(frame, sessionId) {
  requireRecord(frame, 'session/follow')
  if (frame.type !== 'snapshot' || !Number.isSafeInteger(frame.cursor) || frame.cursor < -1
    || frame.header?.id !== sessionId) throw new Error('session/follow returned an invalid snapshot')
  if (frame.header.version !== SESSION_FORMAT_VERSION) {
    throw Object.assign(new Error(`weapp-gateway requires Session format ${SESSION_FORMAT_VERSION}; received ${frame.header.version}`), {
      code: 'unsupported-session-format',
    })
  }
  return {
    events: readHistoryRecords(frame.records).map(event => ({ event })),
    hasMore: frame.hasMore === true,
    projections: requireRecord(frame.projections, 'session/follow projections'),
    historyFormatVersion: frame.header.version,
    cursor: frame.cursor,
  }
}

async function firstStreamFrame(gateway, namespace, method, args, signal, peer) {
  const ownedAbort = new AbortController()
  const streamSignal = signal ? AbortSignal.any([signal, ownedAbort.signal]) : ownedAbort.signal
  let iterator
  try {
    const iterable = await gateway.stream({ namespace, method, args, signal: streamSignal, peer })
    const iteratorFactory = iterable?.[Symbol.asyncIterator] ?? iterable?.[Symbol.iterator]
    if (typeof iteratorFactory !== 'function') throw new Error(`${namespace}/${method} returned an invalid stream`)
    iterator = iteratorFactory.call(iterable)
    const first = await iterator.next()
    if (first.done) throw new Error(`${namespace}/${method} ended before its opening frame`)
    return first.value
  } finally {
    ownedAbort.abort()
    if (typeof iterator?.return === 'function') await iterator.return()
  }
}

function requestArgs(request) {
  return { request }
}

// The SessionController names its reserved list argument
// `_request`. Typert descriptors preserve that source parameter name exactly,
// so this endpoint cannot share the normal `{ request }` wrapper.
function sessionListArgs(request) {
  return { _request: request }
}

/**
 * The only module allowed to know DSH Remote endpoint names and argument
 * descriptors. Its public methods intentionally match weapp-gateway domain
 * operations, not the upstream transport envelope.
 */
export function createDshHostAdapter(typertGateway, connection) {
  if (!typertGateway || typeof typertGateway.invoke !== 'function' || typeof typertGateway.stream !== 'function') {
    throw new Error('weapp-gateway requires the DSH Remote Gateway host service')
  }

  // DSH 0.2.1-alpha made the Peer explicit for in-process Remote calls:
  // InvokeRemoteRequest.peer is required, the Gateway reads peer.signal (both
  // assertPeerLive and methodSignal) and peer.principal for the remote-access
  // decision, and omitting it fails every call with
  // "Cannot read properties of undefined (reading 'signal')". Hosts up to
  // 0.2.0-rc.2 ignore the field, so always naming it works on both. The plugin
  // speaks as the Host itself — an owner Peer living as long as this adapter,
  // so disposing the plugin ends every stream it opened.
  const peerLifetime = new AbortController()
  const hostPeer = typeof connection?.createPeer === 'function'
    ? connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    : {
      id: `weapp-gateway:${crypto.randomUUID()}`,
      principal: Object.freeze({ kind: 'owner' }),
      interactions: 'none',
      signal: peerLifetime.signal,
      dispose: async () => { peerLifetime.abort(new Error('weapp-gateway host adapter disposed')) },
    }
  if (!(hostPeer?.signal instanceof AbortSignal)) throw new Error('DSH Connection.createPeer returned an invalid Peer')

  // Reuse DSH's authenticated in-process route for binary file admission.
  // Older hosts without this route remain usable; the capability is omitted.
  const uploadHandler = connection?.createSharedFetchHandler?.('/api')
  const uploadUrl = new URL('http://localhost/api/session/uploadFileBinary')
  const uploadsAvailable = () => uploadHandler?.requestBodyMode?.({ method: 'POST', url: uploadUrl }) === 'streaming'

  const invoke = (namespace, method, args, signal) => typertGateway.invoke({
    namespace,
    method,
    args,
    ...(signal === undefined ? {} : { signal }),
    peer: hostPeer,
  })

  // 子智能体（subagent）会话必须带持久父地址寻址：host 对裸 sessionId 的
  // 子会话读历史会直接以 session/agent-busy 拒绝（"subagent Sessions require
  // their durable parent address"）。父会话 id 由调用方（小程序协作面板）从
  // subagentCatalog 投影里带入。
  const historyAddress = (payload) => {
    const parentSessionId = typeof payload.parentSessionId === 'string' ? payload.parentSessionId.trim() : ''
    if (!parentSessionId) return { kind: 'session', sessionId: payload.sessionId }
    const requestedMode = payload.subagentMode ?? payload.mode
    const mode = ['one-shot', 'continuable', 'unknown'].includes(requestedMode) ? requestedMode : 'unknown'
    return { kind: 'subagent', parentSessionId, childSessionId: payload.sessionId, mode }
  }
  const addressSessionId = (address) => (address.kind === 'session' ? address.sessionId : address.childSessionId)

  const sessionSnapshot = async (request, signal) => {
    const frame = requireRecord(await firstStreamFrame(
      typertGateway,
      'session',
      'follow',
      requestArgs(request),
      signal,
      hostPeer,
    ), 'session/follow')
    return readSessionSnapshot(frame, addressSessionId(request.address))
  }

  const history = async (payload, signal) => {
    const request = {
      address: historyAddress(payload),
      // Older-page requests need only the opening cursor/projections, not another large latest page.
      ...(payload.beforeSeq !== undefined ? { maxMessages: 1 }
        : payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
    }
    const snapshot = await sessionSnapshot(request, signal)
    let events = snapshot.events
    let hasMore = snapshot.hasMore
    if (payload.beforeSeq !== undefined) {
      const page = requireRecord(await invoke('session', 'page', requestArgs({
        address: request.address,
        throughSeq: Number.isSafeInteger(payload.throughSeq) ? payload.throughSeq : snapshot.cursor,
        beforeSeq: payload.beforeSeq,
        ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
      }), signal), 'session/page')
      events = readHistoryRecords(page.records).map(event => ({ event }))
      hasMore = page.hasMore === true
    }
    return {
      ...snapshot,
      events,
      hasMore,
    }
  }

  const modelCatalog = async (signal) => requireRecord(
    await invoke('session', 'modelCatalog', {}, signal),
    'session/modelCatalog',
  )

  // Control and conversation sockets share this adapter. Admit a prompt only
  // after an earlier preset switch finishes, and re-check later switches.
  const sessionOperations = new Map()
  const admittedPrompts = new Set()
  const serializeSession = (sessionId, operation) => {
    const task = (sessionOperations.get(sessionId) ?? Promise.resolve()).then(operation)
    const guard = task.catch(() => {})
    sessionOperations.set(sessionId, guard)
    return task.finally(() => {
      if (sessionOperations.get(sessionId) === guard) sessionOperations.delete(sessionId)
    })
  }
  const sessionPreset = async (sessionId, signal) => {
    const snapshot = await sessionSnapshot({ address: { kind: 'session', sessionId }, maxMessages: 1 }, signal)
    const values = snapshot.projections.values
    const metadata = values?.sessionListMetadata
    if (typeof values?.agentPreset !== 'string' || !metadata || typeof metadata.blank !== 'boolean'
      || !(metadata.lastPromptAt === null || Number.isFinite(metadata.lastPromptAt))) {
      throw Object.assign(new Error('session preset state is unavailable'), { code: 'agent-preset/unavailable' })
    }
    const durableLock = !metadata.blank || metadata.lastPromptAt !== null
    if (durableLock) admittedPrompts.delete(sessionId)
    return { sessionId, agentPreset: values.agentPreset, locked: durableLock || admittedPrompts.has(sessionId) }
  }

  const commands = {
    list: (sessionId, signal) => invoke('commands', 'list', { agentId: sessionId }, signal),
    // DSH accepts `submittedAttachments`. The parsed
    // wire images already carry the { type: 'image', ... } shape it expects, so
    // only the field name changes.
    execute: (sessionId, line, attachments, signal) => invoke(
      'commands',
      'execute',
      { agentId: sessionId, line, submittedAttachments: attachments },
      signal,
    ),
  }

  const goalRefValue = (value, endpoint) => {
    const goal = requireRecord(value, endpoint)
    if (typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision)) {
      throw new Error(`${endpoint} returned an invalid goal`)
    }
    return { ref: { id: goal.id, revision: goal.revision } }
  }

  const describeHost = async (signal) => {
    const [sessions, catalog, canOpenPath] = await Promise.all([
      invoke('session', 'list', sessionListArgs({}), signal),
      modelCatalog(signal),
      invoke('session', 'canOpenWorkspacePath', {}, signal).catch(() => false),
    ])
    return {
      // 真实 DSH 版本。客户端（host-info.normalizeHostInfo）优先读 dshVersion，
      // 但 settings / session-settings 直接读 host.version 作为账号 API 的版本门控，
      // 所以这里必须给真版本，不能放占位标记。
      version: DSH_VERSION,
      dshVersion: DSH_VERSION,
      historyFormatVersion: SESSION_FORMAT_VERSION,
      cwd: os.homedir(),
      attachedSessions: Array.isArray(sessions?.items) ? sessions.items.length : 0,
      canOpenPath: canOpenPath === true,
      defaultProvider: catalog.default?.provider,
      defaultModel: catalog.default?.model,
    }
  }

  return {
    files: {
      available: uploadsAvailable,
      async upload({ sessionId, name, data }, signal) {
        if (!uploadsAvailable()) throw Object.assign(new Error('The official file upload service is unavailable'), { code: 'file-upload-unavailable' })
        const url = new URL(uploadUrl)
        url.searchParams.set('sessionId', sessionId)
        url.searchParams.set('name', name)
        const uploadSignal = signal ? AbortSignal.any([signal, hostPeer.signal]) : hostPeer.signal
        uploadSignal.throwIfAborted()
        const source = Readable.from(data, { objectMode: false })
        try {
          const response = await uploadHandler.fetch(new Request(url, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' },
            body: Readable.toWeb(source), duplex: 'half', signal: uploadSignal,
          }), hostPeer)
          if (!response.ok) throw Object.assign(new Error(`Official file upload returned HTTP ${response.status}`), { code: 'file-upload-unavailable' })
          const result = await response.json()
          if (result.ok !== true) throw Object.assign(new Error(result.error?.message || 'Official file upload failed'),
            { code: result.error?.code || 'file-upload-failed' })
          return requireRecord(result.value, 'file upload')
        } catch (error) {
          uploadSignal.throwIfAborted()
          throw error
        } finally { source.destroy() }
      },
    },
    speech: {
      catalog: (signal) => invoke('speech', 'catalog', {}, signal),
      follow: (signal) => typertGateway.stream({ namespace: 'speech', method: 'follow', args: {}, signal, peer: hostPeer }),
      configure: (patch, signal) => invoke('speech', 'configure', { patch }, signal),
      prepare: (providerId, options, signal) => invoke('speech', 'prepare', {
        providerId, ...(options === undefined ? {} : { options }),
      }, signal),
      cancelPreparation: (providerId, signal) => invoke('speech', 'cancelPreparation', { providerId }, signal),
      transcribe: (request, signal) => invoke('speech', 'transcribe', { request }, signal),
    },
    sessions: {
      list: (payload = {}, signal) => invoke('session', 'list', sessionListArgs(payload), signal),
      projections: (payload, signal) => invoke('session', 'projections', requestArgs(payload), signal),
      search: (payload, signal) => invoke('session', 'search', requestArgs(payload), signal),
      create: (payload, signal) => invoke('session', 'create', requestArgs(payload), signal),
      prompt: (payload, signal) => serializeSession(payload.sessionId, async () => {
        if (payload.parentSessionId !== undefined) {
          if (payload.subagentMode !== 'continuable') {
            throw Object.assign(new Error('only continuable subagents accept messages'), { code: 'subagent/not-resumable' })
          }
          return invoke('subagents', 'prompt', requestArgs({
            requestId: payload.requestId ?? crypto.randomUUID(),
            parentSessionId: payload.parentSessionId,
            childSessionId: payload.sessionId,
            mode: 'continuable',
            delivery: payload.mode,
            content: payload.content,
            ...(payload.clientTimeZone === undefined ? {} : { clientTimeZone: payload.clientTimeZone }),
          }), signal)
        }
        // Accepted input may not have reached turn/start yet. Keep that gap
        // locked; the persistent event or a subsequent read retires the marker.
        const alreadyAdmitted = admittedPrompts.has(payload.sessionId)
        admittedPrompts.add(payload.sessionId)
        try {
          return await invoke('session', 'prompt', requestArgs({ requestId: crypto.randomUUID(), ...payload }), signal)
        } catch (error) {
          if (!alreadyAdmitted) admittedPrompts.delete(payload.sessionId)
          throw error
        }
      }),
      attachment: (payload, signal) => invoke('session', 'attachment', requestArgs(payload), signal),
      fork: (payload, signal) => invoke('session', 'fork', requestArgs(payload), signal),
      cancel: (payload, signal) => payload.parentSessionId === undefined
        ? invoke('session', 'cancel', requestArgs(payload), signal)
        : payload.subagentMode !== 'continuable'
          ? Promise.reject(Object.assign(new Error('only continuable subagents accept interrupts'), { code: 'subagent/not-resumable' }))
          : invoke('subagents', 'interruptByParent', {
            parentSessionId: payload.parentSessionId,
            childSessionId: payload.sessionId,
            mode: 'continuable',
          }, signal),
      updateQueue: (payload, signal) => invoke('session', 'updateQueue', requestArgs(payload), signal),
      rename: (payload, signal) => invoke('session', 'rename', requestArgs(payload), signal),
      selectModel: (payload, signal) => invoke('session', 'selectModel', requestArgs(payload), signal),
      history,
      async models(payload, signal) {
        const [catalog, snapshot] = await Promise.all([
          modelCatalog(signal),
          sessionSnapshot({ address: { kind: 'session', sessionId: payload.sessionId }, maxMessages: 1 }, signal),
        ])
        const current = snapshot.projections?.values?.modelSelection?.next ?? catalog.default
        return {
          current,
          routable: typeof current?.provider === 'string'
            && requireArray(catalog.routableProviders, 'session/modelCatalog routableProviders').includes(current.provider),
          groups: requireArray(catalog.groups, 'session/modelCatalog groups'),
          failures: requireArray(catalog.failures, 'session/modelCatalog failures'),
        }
      },
    },
    workspace: {
      async list(_payload = {}, signal) {
        const frame = requireRecord(await firstStreamFrame(typertGateway, 'workspace', 'follow', {}, signal, hostPeer), 'workspace/follow')
        if (frame.type !== 'baseline') throw new Error('workspace/follow returned an invalid opening baseline')
        return requireRecord(frame.value, 'workspace/follow baseline')
      },
      create: (payload, signal) => invoke('workspace', 'create', requestArgs(payload), signal),
      archiveSession: (payload, signal) => invoke('workspace', 'archiveSession', requestArgs(payload), signal),
    },
    pluginConfiguration: {
      credentialDescribe: (ref) => invoke('credentials', 'describe', { refs: [ref] }),
      credentialSet: (ref, value) => invoke('credentials', 'set', { ref, value }),
      translationLimits: () => invoke('cotTranslation', 'limits', {}),
    },
    settings: {
      describe: (_payload = {}, signal) => invoke('settings', 'describe', {}, signal),
      mutate: (payload, signal) => invoke('settings', 'mutate', {
        ns: payload.ns,
        ops: payload.ops,
        expectedRevision: payload.expectedRevision,
      }, signal),
      update: (payload, signal) => invoke('settings', 'update', {
        ns: payload.ns,
        patch: payload.patch,
        ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
      }, signal),
    },
    pluginMarket: {
      listIndexes: () => invoke('pluginMarket', 'listIndexes', {}),
      setIndexes: (urls) => invoke('pluginMarket', 'setIndexes', { urls }),
      search: (url, query) => invoke('pluginMarket', 'search', { url, query }),
    },
    plugins: {
      inventory: (_payload = {}, signal) => invoke('pluginInventory', 'list', {}, signal),
      listBundles: (signal) => invoke('pluginManager', 'listBundles', {}, signal),
      listPlugins: (signal) => invoke('pluginManager', 'listPlugins', {}, signal),
      registries: (signal) => invoke('pluginManager', 'registries', {}, signal),
      inspect: (spec, options, signal) => invoke('pluginManager', 'inspect', {
        spec, ...(options === undefined ? {} : { options }),
      }, signal),
      installBundle: (spec, options) => invoke('pluginManager', 'installBundle', { spec, options }),
      waitForInstall: (requestId) => invoke('pluginManager', 'waitForInstall', { requestId }),
      cancelInstall: (requestId) => invoke('pluginManager', 'cancelInstall', { requestId }),
      setBundleEnabled: (name, enabled) => invoke('pluginManager', 'setBundleEnabled', { name, enabled }),
      setPluginEnabled: (id, enabled) => invoke('pluginManager', 'setPluginEnabled', { id, enabled }),
      removeBundle: (name) => invoke('pluginManager', 'removeBundle', { name }),
      listVersionExemptions: () => invoke('pluginManager', 'listVersionExemptions', {}),
      setVersionExemption: (packageVersion, runtimeVersion, enabled, acceptRisk) => invoke(
        'pluginManager', 'setVersionExemption', {
          packageVersion, runtimeVersion, enabled,
          ...(acceptRisk === undefined ? {} : { acceptRisk }),
        },
      ),
    },
    permissionPresets: {
      catalog: (_payload = {}, signal) => invoke('permissionPresets', 'catalog', {}, signal),
    },
    schedule: {
      async catalog(_payload = {}, signal) {
        return { items: requireArray(await invoke('schedule', 'catalog', {}, signal), 'schedule/catalog') }
      },
      async list(payload, signal) {
        return { items: requireArray(await invoke('schedule', 'list', requestArgs(payload), signal), 'schedule/list') }
      },
      history: (payload, signal) => invoke('schedule', 'history', requestArgs(payload), signal),
      update: (payload, signal) => invoke('schedule', 'update', requestArgs(payload), signal),
      delete: (payload, signal) => invoke('schedule', 'delete', requestArgs(payload), signal),
    },
    skills: {
      list: (payload, signal) => invoke('skills', 'list', requestArgs(payload), signal),
    },
    agentPresets: {
      list: (_payload = {}, signal) => invoke('agentPresets', 'list', {}, signal),
      session: (payload, signal) => serializeSession(payload.sessionId, () => sessionPreset(payload.sessionId, signal)),
      select: (payload, signal) => serializeSession(payload.sessionId, async () => {
        const state = await sessionPreset(payload.sessionId, signal)
        if (state.locked) {
          throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' })
        }
        // Host validates the live catalog, mounts the composition, checks its
        // own turn boundary and persists agent-preset/selected on this ID.
        const selected = await invoke('agentPresets', 'select', {
          agentId: payload.sessionId, agentPreset: payload.agentPreset,
        }, signal)
        if (typeof selected !== 'string' || !selected) throw new Error('agentPresets/select returned an invalid preset')
        return { sessionId: payload.sessionId, agentPreset: selected }
      }),
    },
    llm: {
      async models(_payload = {}, signal) {
        const catalog = await modelCatalog(signal)
        return { groups: catalog.groups, failures: catalog.failures }
      },
      async providers(_payload = {}, signal) {
        const providers = await invoke('llm', 'listConfigurableProviders', {}, signal)
        return { providers: requireArray(providers, 'llm/listConfigurableProviders') }
      },
    },
    goals: {
      async edit(payload) {
        return goalRefValue(await invoke('goals', 'edit', {
          agentId: payload.sessionId,
          ref: payload.ref,
          request: {
            ...(payload.objective === undefined ? {} : { objective: payload.objective }),
            ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }),
          },
        }), 'goals/edit')
      },
      async pause(payload) {
        return goalRefValue(
          await invoke('goals', 'pause', { agentId: payload.sessionId, ref: payload.ref }),
          'goals/pause',
        )
      },
      async resume(payload) {
        return goalRefValue(
          await invoke('goals', 'resume', { agentId: payload.sessionId, ref: payload.ref }),
          'goals/resume',
        )
      },
      clear: async payload => {
        await invoke('goals', 'clear', { agentId: payload.sessionId, ref: payload.ref })
        return { cleared: true }
      },
    },
    commands,
    host: {
      describe: (_payload = {}, signal) => describeHost(signal),
    },
    describeHost,
    observeSessionEvent(sessionId, event) {
      if (event.type === 'turn/start') admittedPrompts.delete(sessionId)
    },
    openSessionStream(target, signal) {
      const sessionId = typeof target === 'string' ? target : target?.sessionId
      const parentSessionId = typeof target === 'object' && target ? target.parentSessionId : undefined
      const mode = typeof target === 'object' && target ? (target.subagentMode ?? target.mode) : undefined
      const address = parentSessionId
        ? { kind: 'subagent', parentSessionId, childSessionId: sessionId,
          mode: ['continuable', 'one-shot', 'unknown'].includes(mode) ? mode : 'unknown' }
        : { kind: 'session', sessionId }
      return typertGateway.stream({
        namespace: 'session', method: 'follow',
        // Bound the opening window at the Host; older records remain available via session.page.
        args: requestArgs({ address, maxMessages: 12, assistantStream: true }),
        signal,
        peer: hostPeer,
      })
    },
    openControlStream(signal) {
      return typertGateway.stream({ namespace: 'session', method: 'control', args: {}, signal, peer: hostPeer })
    },
    openWorkspaceStream(signal) {
      return typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal, peer: hostPeer })
    },
    // Ends every stream this adapter opened: the host Peer's signal is joined
    // into each one by the 0.2.1 Gateway.
    dispose() {
      if (typeof hostPeer.dispose === 'function') return hostPeer.dispose()
      peerLifetime.abort(new Error('weapp-gateway host adapter disposed'))
    },
  }
}
