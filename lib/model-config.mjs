// 小程序「模型 / Provider」页面的三个控制请求：模型发现、模型凭据描述与写入。
//
// 它们与 plugin-* 请求走同一条已配对控制连接。网关只做参数校验、转发和字段
// 白名单化，真正的网络探测与凭据存储都在 Host 侧：
// - llm-discover-models        -> Host llm/discoverModels（apiKey 只用于这一次
//                                 探测，Host 不存储）
// - model-credential-describe  -> Host credentials/describe
// - model-credential-set       -> Host credentials/set（值只上行，没有读路径）
//
// 安全底线：apiKey 与凭据值只允许出现在发往 Host 的调用参数里。响应帧、错误
// message 与日志都不回显它们；失败 message 先脱敏再截断到 500 字符。
//
// 凭据引用只能是当前 llm-pi-ai settings namespace 里 providers[*].apiKeyEnv
// 声明的名字，因此移动端无法写入 Host 从未声明的任意引用。

export const MODEL_CONFIG_REQUEST_TYPES = new Set([
  'llm-discover-models',
  'model-credential-describe',
  'model-credential-set',
])

// pi-ai 多 Provider 双胞胎的 settings namespace；该 namespace 的 value 形如
// { providers: { <route>: { apiKeyEnv?, api, baseURL, models, ... } } }。
const MODEL_SETTINGS_NS = 'llm-pi-ai'
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// 凭据值最终会作为 HTTP header 发出，只接受可打印 ASCII（不含空格）。
const PRINTABLE_HEADER_VALUE = /^[\x21-\x7e]+$/
const MAX_ID = 200
const MAX_NAMESPACE = 200
const MAX_PROVIDER = 200
const MAX_BASE_URL = 2048
const MAX_API = 80
const MAX_API_KEY = 8192
const MAX_CREDENTIAL_VALUE = 8192
const MAX_ERROR_MESSAGE = 500

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function badRequest(type, requestId, message) {
  return { kind: 'error', code: 'bad-request', message, requestType: type,
    ...(requestId === undefined ? {} : { requestId }) }
}

function failure(type, requestId, code, message) {
  return { kind: 'error', code, message, requestType: type,
    ...(requestId === undefined ? {} : { requestId }) }
}

// 宿主错误的可下发文本：先抹掉本次请求携带的密钥，再截断。任何密钥都不允许
// 经由 message 回到移动端或日志里。
function sanitizeError(error, secrets) {
  const raw = error && typeof error.message === 'string' && error.message !== ''
    ? error.message
    : typeof error === 'string' && error !== '' ? error : 'unknown error'
  let message = raw
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') message = message.split(secret).join('[redacted]')
  }
  return message.length > MAX_ERROR_MESSAGE ? message.slice(0, MAX_ERROR_MESSAGE) : message
}

function isHttpURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// llm-discover-models 的请求体：只把校验过的字段交给 Host。
function discoveryRequest(msg, type, requestId) {
  const ns = typeof msg.ns === 'string' ? msg.ns.trim() : ''
  if (ns === '' || ns.length > MAX_NAMESPACE) {
    return { error: badRequest(type, requestId, `ns must be a non-empty namespace of at most ${MAX_NAMESPACE} characters`) }
  }
  const request = {}
  let hasEndpoint = false
  if (msg.provider !== undefined) {
    const provider = typeof msg.provider === 'string' ? msg.provider.trim() : ''
    if (provider === '' || provider.length > MAX_PROVIDER) {
      return { error: badRequest(type, requestId, `provider must be a non-empty route name of at most ${MAX_PROVIDER} characters`) }
    }
    request.provider = provider
    hasEndpoint = true
  }
  if (msg.baseURL !== undefined) {
    const baseURL = typeof msg.baseURL === 'string' ? msg.baseURL.trim() : ''
    if (baseURL === '' || baseURL.length > MAX_BASE_URL || !isHttpURL(baseURL)) {
      return { error: badRequest(type, requestId, 'baseURL must be an absolute HTTP(S) URL') }
    }
    request.baseURL = baseURL
    hasEndpoint = true
  }
  if (!hasEndpoint) {
    return { error: badRequest(type, requestId, `${type} requires a provider or a baseURL`) }
  }
  if (msg.api !== undefined) {
    const api = typeof msg.api === 'string' ? msg.api.trim() : ''
    if (api === '' || api.length > MAX_API) {
      return { error: badRequest(type, requestId, `api must be a non-empty protocol name of at most ${MAX_API} characters`) }
    }
    request.api = api
  }
  if (msg.apiKey !== undefined) {
    if (typeof msg.apiKey !== 'string' || msg.apiKey.length > MAX_API_KEY || CONTROL_CHARACTERS.test(msg.apiKey)) {
      return { error: badRequest(type, requestId, `apiKey must be a string of at most ${MAX_API_KEY} characters without control characters`) }
    }
    // 空串等同于「没有携带一次性凭据」；不要把空 header 传给 Host。
    if (msg.apiKey.length > 0) request.apiKey = msg.apiKey
  }
  return { ns, request }
}

// Host 的发现结果是数组；只保留白名单字段，丢弃非法/重复 id（Host 与移动端
// 之间允许出现旧版本或第三方 adapter 的额外字段）。
function sanitizeModels(value) {
  const models = []
  const seen = new Set()
  for (const entry of Array.isArray(value) ? value : []) {
    if (!record(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || id.length > MAX_ID || seen.has(id)) continue
    seen.add(id)
    const model = { id }
    if (typeof entry.name === 'string' && entry.name.trim() !== '') model.name = entry.name
    if (typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0) {
      model.contextWindow = entry.contextWindow
    }
    if (typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens) && entry.maxTokens > 0) {
      model.maxTokens = entry.maxTokens
    }
    if (Array.isArray(entry.inputModalities)) {
      const modalities = [...new Set(entry.inputModalities.filter(item => item === 'text' || item === 'image'))]
      if (modalities.length > 0) model.inputModalities = modalities
    }
    models.push(model)
  }
  return models
}

// 当前 llm-pi-ai namespace 里被 profile 引用的凭据名（apiKeyEnv）。providers 在
// Host 里是 route -> profile 的字典；数组形状也接受，避免旧 profile 形状差异。
async function modelCredentialScopes(api) {
  if (typeof api.settings?.describe !== 'function') {
    throw Object.assign(new Error('settings are unavailable'), { code: 'model-credentials-unavailable' })
  }
  const described = await api.settings.describe()
  if (!record(described) || !Array.isArray(described.namespaces)) {
    throw Object.assign(new Error('settings/describe returned an invalid response'), { code: 'model-credentials-unavailable' })
  }
  const namespace = described.namespaces.find(item => record(item) && item.ns === MODEL_SETTINGS_NS)
  const providers = namespace?.value?.providers
  const profiles = Array.isArray(providers)
    ? providers
    : record(providers) ? Object.values(providers) : []
  const refs = new Set()
  for (const profile of profiles) {
    if (!record(profile)) continue
    if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') refs.add(profile.apiKeyEnv)
  }
  return { refs }
}

function credentialRefOf(msg, type, requestId) {
  const ref = typeof msg.ref === 'string' ? msg.ref : ''
  if (!CREDENTIAL_REF.test(ref)) {
    return { error: badRequest(type, requestId, 'invalid credential reference') }
  }
  return { ref }
}

async function discoverModels(api, msg, type, requestId, log) {
  const built = discoveryRequest(msg, type, requestId)
  if (built.error) return built.error
  const { ns, request } = built
  const secrets = request.apiKey === undefined ? [] : [request.apiKey]
  try {
    if (typeof api.llm?.discoverModels !== 'function') {
      throw new Error('the Host does not expose model discovery')
    }
    const discovered = await api.llm.discoverModels(ns, request)
    const models = sanitizeModels(discovered)
    log?.(`llm discovery: ns=${ns}${request.provider === undefined ? '' : ` provider=${request.provider}`} models=${models.length}`)
    return { kind: type, requestId, models }
  } catch (error) {
    const message = sanitizeError(error, secrets)
    log?.(`llm discovery failed: ns=${ns} -> ${message}`)
    return failure(type, requestId, 'llm-discovery-failed', message)
  }
}

async function describeCredential(api, msg, type, requestId, log) {
  const checked = credentialRefOf(msg, type, requestId)
  if (checked.error) return checked.error
  const { ref } = checked
  try {
    const scopes = await modelCredentialScopes(api)
    if (!scopes.refs.has(ref)) {
      return badRequest(type, requestId, 'reference is not used by a model provider')
    }
    const described = await api.pluginConfiguration.credentialDescribe(ref)
    const view = record(described) ? described[ref] : undefined
    const configured = record(view) && view.configured === true
    // 可写性来自凭据库本身（credentials/describe 的 writable），不是 settings
    // 文档的可写位：凭据值存在凭据库里，与 settings 是否只读无关。
    const writable = record(view) && view.writable === true
    log?.(`model credential described: ref=${ref} configured=${configured} writable=${writable}`)
    return {
      kind: type,
      requestId,
      configured,
      writable,
      // source 只是凭据来源层名称（env/file 等），不是凭据值；有就透传。
      ...(record(view) && typeof view.source === 'string' && view.source !== '' ? { source: view.source } : {}),
    }
  } catch (error) {
    const message = sanitizeError(error, [])
    log?.(`model credential describe failed: ref=${ref} -> ${message}`)
    return failure(type, requestId, (error && typeof error.code === 'string' && error.code) || 'model-credentials-unavailable', message)
  }
}

async function setCredential(api, msg, type, requestId, log) {
  const checked = credentialRefOf(msg, type, requestId)
  if (checked.error) return checked.error
  const { ref } = checked
  const value = typeof msg.value === 'string' ? msg.value : ''
  if (value === '' || value.length > MAX_CREDENTIAL_VALUE || !PRINTABLE_HEADER_VALUE.test(value) || value.trim() === '') {
    return badRequest(type, requestId, `value must be non-empty printable ASCII of at most ${MAX_CREDENTIAL_VALUE} characters`)
  }
  try {
    const scopes = await modelCredentialScopes(api)
    if (!scopes.refs.has(ref)) {
      return badRequest(type, requestId, 'reference is not used by a model provider')
    }
    await api.pluginConfiguration.credentialSet(ref, value)
    log?.(`model credential saved: ref=${ref}`)
    return { kind: type, requestId, saved: true }
  } catch (error) {
    // 值本身也要脱敏：宿主错误里可能回显它。
    const message = sanitizeError(error, [value])
    log?.(`model credential write failed: ref=${ref} -> ${message}`)
    return failure(type, requestId, 'model-credential-write-failed', message)
  }
}

/**
 * The mobile wire owns its request names and correlation ids; the Host adapter
 * owns Remote endpoint names. Every request here requires a paired device and a
 * non-empty requestId (the caller enforces pairing before dispatching).
 */
export async function handleModelConfigQuery(api, msg, { log } = {}) {
  const type = msg?.type
  if (!MODEL_CONFIG_REQUEST_TYPES.has(type)) return null
  const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() !== '' && msg.requestId.length <= 128
    ? msg.requestId.trim()
    : undefined
  if (requestId === undefined) return { kind: 'error', code: 'bad-request',
    message: `${type} requires a requestId`, requestType: type }
  if (type === 'llm-discover-models') return discoverModels(api, msg, type, requestId, log)
  if (type === 'model-credential-describe') return describeCredential(api, msg, type, requestId, log)
  return setCredential(api, msg, type, requestId, log)
}
