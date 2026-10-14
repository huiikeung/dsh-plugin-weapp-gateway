// DSH Weapp Agent Connector —— 运行在 fnOS/电脑上。
//
// 1. 出站 wss 连接中继注册 nodeId（不开任何入站端口，与 dsh-wechat-remote 的
//    outbound-only relay 思路一致）；
// 2. 收到 client-open 后，按客户端请求的子协议拨本地网关
//    ws://127.0.0.1:<port>/ws/mobile（配对码经 Sec-WebSocket-Protocol 透传）；
// 3. E2EE：完成 ClientHello/AgentHello 握手并验签客户端身份后，
//    解密小程序帧转发给本地网关，网关回帧加密后经中继回传。
//
// 用法：node agent-connector.js --relay wss://<你的域名> [--gateway ws://127.0.0.1:16662/ws/mobile]
// 首次运行生成 ~/.dsh-weapp-relay/identity.json（nodeId + Ed25519 身份密钥），
// 并打印配对载荷（Base64URL），可直接做成二维码或粘到小程序手动配对。
//
// 本文件是插件内置副本（dsh-plugin-weapp-gateway/relay/）：当中继模式开启且
// 没有外部连接器注册时，由插件的 relay-connector 托管模块自动拉起，无需手工
// 部署 /vol1/app/dsh-relay 或 systemd。已有的 systemd 安装继续受支持——只要
// 它保持注册，插件就不会重复拉起。身份目录用 STATE_DIR 覆盖，插件会优先指向
// 已存在的身份文件以复用 nodeId。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nacl = require('./vendor/tweetnacl.js');
const WebSocket = require('ws');

// ---------- 配置 ----------

function arg(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const RELAY = process.env.RELAY_URL || arg('relay', '');
const GATEWAY = process.env.GATEWAY_URL || arg('gateway', 'ws://127.0.0.1:16662/ws/mobile');
const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.dsh-weapp-relay');
const GATEWAY_NAME = process.env.GATEWAY_NAME || arg('name', 'fnOS DSH')
let gatewayDeviceId = null;
let phoneDeviceNameCache = null;;
// Plugin management API (/mgw) lives on the DSH web service, loopback only;
// the gateway's own 3081 port does not serve /mgw. The connector runs on the
// same host, so 127.0.0.1 is the right default. Override with --mgmt.
const MGMT = process.env.MGMT_URL || arg('mgmt', 'http://127.0.0.1:2298');

if (!/^wss?:\/\//.test(RELAY)) {
  console.error('用法：node agent-connector.js --relay wss://<中继域名> [--gateway ws://127.0.0.1:16662/ws/mobile]');
  process.exit(1);
}

// ---------- 单实例锁 ----------
// The plugin spawns this copy whenever relay mode is on and nothing has
// registered yet; a separately installed connector (systemd) may already hold
// the same identity. A pid lock file makes the second instance exit instead of
// both dialling the relay under one nodeId. A lock whose pid is gone (crash,
// SIGKILL) is taken over, so a stale lock never wedges the bridge.
const LOCK_FILE = path.join(STATE_DIR, 'connector.lock');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
function releaseLock() {
  try {
    if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.rmSync(LOCK_FILE, { force: true })
  } catch { /* lock already gone or replaced */ }
}
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let held = null
  try { held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) } catch { /* no lock yet */ }
  if (held && Number.isInteger(held.pid) && held.pid !== process.pid && pidAlive(held.pid)) {
    log(`another connector (pid ${held.pid}) already holds ${LOCK_FILE}; exiting`)
    process.exit(0)
  }
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 })
  process.on('exit', releaseLock)
} catch (error) {
  log(`lock setup failed (${error.message}); continuing without the single-instance guard`)
}

// ---------- 身份 ----------

const PROTOCOL = 'dsh-weapp-e2ee-v1';
const PACKET_CLIENT_HELLO = 1;
const PACKET_AGENT_HELLO = 2;
const PACKET_SEALED = 3;
const CLEAR_DATA = 3;

function loadIdentity() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, 'identity.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.nodeId && saved.signSecretKey && saved.signPublicKey) {
      // Earlier builds minted the device id lazily per connection and never
      // saved it, so it changed on every restart. The gateway keys paired
      // devices by this id, so re-pairing then produced duplicate rows in the
      // WebUI's trusted-device list. Backfill it once and persist.
      if (!saved.deviceId) {
        saved.deviceId = crypto.randomUUID();
        try {
          fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
          log('deviceId backfilled and persisted (fixes duplicate device rows on re-pair)');
        } catch (e) { /* read-only fs: keep the in-memory value for this run */ }
      }
      return saved;
    }
  } catch (e) { /* 首次运行 */ }
  const keyPair = nacl.sign.keyPair();
  const identity = {
    nodeId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    signPublicKey: Buffer.from(keyPair.publicKey).toString('base64'),
    signSecretKey: Buffer.from(keyPair.secretKey).toString('base64')
  };
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

const identity = loadIdentity();

// 网关长期凭据：E2EE 解密后的 paired 帧中提取，重连拨号时注入 Authorization。
// 仅存于 fnOS 本机（与 iOS 存 Keychain 同一信任边界）。
function loadCreds() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'credentials.json'), 'utf8'));
  } catch (e) { return {}; }
}
function saveCreds(creds) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch (e) { /* 忽略 */ }
}
function captureToken(text) {
  try {
    const frame = JSON.parse(text);
    if (frame && frame.kind === 'paired' && frame.token) {
      const creds = loadCreds();
      if (creds[GATEWAY] !== frame.token) {
        creds[GATEWAY] = frame.token;
        saveCreds(creds);
        log('已保存网关长期凭据（用于重连）');
      }
      // The trusted-device row we own; the phone renames it once it reports its
      // own model (see handleDeviceInfo).
      if (frame.device && frame.device.id && gatewayDeviceId !== frame.device.id) {
        gatewayDeviceId = frame.device.id;
        log(`网关设备 id=${gatewayDeviceId}`);
      }
    }
    // A token-authenticated dial receives `hello` (which carries the device
    // record) rather than `paired`, so learn the id from either frame.
    if (frame && frame.kind === 'hello' && frame.device && frame.device.id
        && gatewayDeviceId !== frame.device.id) {
      gatewayDeviceId = frame.device.id;
      log(`网关设备 id=${gatewayDeviceId}`);
    }
  } catch (e) { /* 非 JSON 帧 */ }
}

// The phone's own model, reported once per connection after the E2EE handshake.
// The relay normalises subprotocols, so this frame is the only channel that
// carries it; the gateway relabels the paired device so the trusted list shows
// the phone instead of this host.
async function handleDeviceInfo(pipe, bridgeId, text) {
  let frame;
  try { frame = JSON.parse(text); } catch (e) { return false; }
  if (!frame || frame.type !== 'device-info') return false;
  const name = typeof frame.model === 'string' ? frame.model.trim() : '';
  if (name === '' || !gatewayDeviceId) return true;
  if (phoneDeviceNameCache === name) return true;
  try {
    const response = await fetch(MGMT.replace(/\/$/, '') + '/mgw/devices/'
      + encodeURIComponent(gatewayDeviceId) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      phoneDeviceNameCache = name;
      log(`管道 ${bridgeId}: 设备已按手机型号重命名为 ${name}`);
    } else {
      log(`管道 ${bridgeId}: 重命名失败 HTTP ${response.status}`);
    }
  } catch (error) {
    log(`管道 ${bridgeId}: 重命名请求失败 ${error.message}`);
  }
  return true;
}

// ---------- E2EE（与小程序端 utils/relay-e2ee.js 镜像） ----------

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function utf8(text) { return new TextEncoder().encode(text); }
function utf8Decode(bytes) { return new TextDecoder().decode(bytes); }

function counterBytes(value) {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i -= 1) { out[i] = v & 255; v = Math.floor(v / 256); }
  return out;
}

function readCounter(bytes, offset) {
  let value = 0;
  for (let i = 0; i < 8; i += 1) value = value * 256 + bytes[offset + i];
  return value;
}

class AgentSession {
  constructor(nodeId, identitySecretKey) {
    this.nodeId = nodeId;
    this.identitySecretKey = identitySecretKey;
    this.ephemeral = nacl.box.keyPair();
    this.rxCounter = 0;
    this.txCounter = 0;
    this.ready = false;
  }

  /** 输入 ClientHello，返回 AgentHello 二进制；失败返回 null。 */
  acceptClientHello(packet) {
    if (!packet || packet.length !== 1 + 32 + 16 || packet[0] !== PACKET_CLIENT_HELLO) return null;
    const clientEphPub = packet.subarray(1, 33);
    const agentEphPub = this.ephemeral.publicKey;
    const transcript = nacl.hash(concat(utf8(PROTOCOL + '\0'), utf8(this.nodeId), packet, agentEphPub));
    const signature = nacl.sign.detached(transcript, this.identitySecretKey);
    const shared = nacl.box.before(clientEphPub, this.ephemeral.secretKey);
    const key = nacl.hash(concat(utf8(PROTOCOL + '-KDF\0'), shared, transcript)).subarray(0, 32); // SHA-512 取前 32 字节
    const material = nacl.hash(concat(key, utf8('nonce-prefix')));
    this.txPrefix = material.subarray(16, 32); // agent 发送前缀
    this.rxPrefix = material.subarray(0, 16);  // 客户端发送前缀
    this.key = key;
    this.ready = true;
    return concat(new Uint8Array([PACKET_AGENT_HELLO]), agentEphPub, signature);
  }

  seal(text) {
    if (!this.ready) throw new Error('E2EE 会话未就绪');
    const counter = this.txCounter;
    this.txCounter += 1;
    const clear = concat(new Uint8Array([CLEAR_DATA]), utf8(text));
    const sealed = nacl.secretbox(clear, concat(this.txPrefix, counterBytes(counter)), this.key);
    return concat(new Uint8Array([PACKET_SEALED]), counterBytes(counter), sealed);
  }

  open(packet) {
    if (!this.ready || !packet || packet.length < 9 + 17 || packet[0] !== PACKET_SEALED) return null;
    const counter = readCounter(packet, 1);
    if (counter < this.rxCounter) return null;
    const clear = nacl.secretbox.open(packet.subarray(9), concat(this.rxPrefix, counterBytes(counter)), this.key);
    if (!clear || clear.length < 1 || clear[0] !== CLEAR_DATA) return null;
    this.rxCounter = counter + 1;
    return utf8Decode(clear.subarray(1));
  }
}

// ---------- 中继连接 ----------

let relaySocket = null;
let relayBackoff = 1000;
let relayWants = true;

// ---------- Plugin integration: identity registration + pairing ----------
// The mini-program reaches the gateway only through the relay, so it can never
// see the WebUI QR. Two gaps follow, both closed by talking to the plugin's
// loopback management API:
//   1. the plugin cannot build a relay pairing payload without this node's
//      identity, so the connector registers it on every relay connection;
//   2. requireAuth=true means the first gateway dial needs a one-time
//      dsh-pair.<code> subprotocol, which the connector fetches itself.
// The gateway's extractCredential reads Authorization: Bearer first, so a
// stale pairing subprotocol is ignored once a token exists.
async function registerWithPlugin() {
  try {
    const response = await fetch(MGMT.replace(/\/$/, '') + '/mgw/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relay: RELAY.replace(/\/$/, ''),
        nodeId: identity.nodeId,
        agentPubKey: identity.signPublicKey,
        gatewayName: GATEWAY_NAME,
      }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    log('identity registered with the plugin (pairingMode=' + data.pairingMode + ')');
    return data;
  } catch (error) {
    log('plugin registration failed (relay pairing QR stays unavailable): ' + error.message);
    return null;
  }
}

async function requestPairingCode(deviceName) {
  const name = typeof deviceName === 'string' && deviceName.trim() !== ''
    ? deviceName.trim().slice(0, 80)
    : GATEWAY_NAME;
  try {
    const response = await fetch(MGMT.replace(/\/$/, '') + '/mgw/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const code = data && data.payload && data.payload.pairingCode;
    if (typeof code !== 'string' || code === '') throw new Error('no pairingCode in response');
    return { code, expiresAt: data.payload.expiresAt };
  } catch (error) {
    log('pairing-code request failed (the mini-program cannot pair yet): ' + error.message);
    return null;
  }
}

function connectRelay() {
  if (!relayWants) return;
  log(`连接中继 ${RELAY}/a/${identity.nodeId}`);
  const ws = new WebSocket(`${RELAY.replace(/\/$/, '')}/a/${identity.nodeId}`);
  relaySocket = ws;

  ws.on('open', () => {
    log('已注册到中继');
    relayBackoff = 1000;
    printPairingPayload();
  });
    // Tell the plugin who we are so it can mint a relay pairing payload.
    void registerWithPlugin();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      void handleRelayBinary(data);
      return;
    }
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (frame.kind === 'client-open') handleClientOpen(frame, ws);
    if (frame.kind === 'client-close') handleClientClose(frame);
  });

  ws.on('close', () => {
    log('与中继断开，准备重连');
    setTimeout(connectRelay, relayBackoff);
    relayBackoff = Math.min(relayBackoff * 2, 30000);
  });
  ws.on('error', (err) => log('中继连接错误: ' + err.message));
}

// ---------- 管道 ----------

const pipes = new Map(); // bridgeId → { session, gateway, agentWs }

// The phone may advertise itself as a `dsh-device.<urlencoded name>` subprotocol
// (WeChat exposes the model via wx.getSystemInfoSync().model). The gateway only
// looks at dsh-auth./dsh-pair. prefixes, so passing it through is harmless, and
// it lets the trusted-device list show the phone instead of this host.
function phoneDeviceName(protocols) {
  if (!Array.isArray(protocols)) return null;
  for (const entry of protocols) {
    if (typeof entry !== 'string' || !entry.startsWith('dsh-device.')) continue;
    try {
      const name = decodeURIComponent(entry.slice('dsh-device.'.length)).trim();
      return name !== '' ? name.slice(0, 80) : null;
    } catch (e) { return null; }
  }
  return null;
}

async function handleClientOpen(frame, agentWs) {
  const bridgeId = frame.bridgeId;
  const session = new AgentSession(identity.nodeId, Buffer.from(identity.signSecretKey, 'base64'));
  const requestedProtocols = Array.isArray(frame.protocols) && frame.protocols.length
    ? frame.protocols.slice()
    : ['dsh-mobile-v1'];
  // Register the pipe before the first await: a ClientHello that arrives while
  // the pairing code is being fetched must still find its pipe.
  const pipe = { session, agentWs, gateway: null, gatewayReady: false, queue: [], retriedWithPairing: false };
  pipes.set(bridgeId, pipe);

  const connect = async (forcePairing) => {
    const token = forcePairing ? null : loadCreds()[GATEWAY];
    const protocols = requestedProtocols.slice();
    // The phone reports its model as a dsh-device.<name> subprotocol. Keep it
    // for the whole pipe lifetime, not just the first pairing: the gateway
    // names the trusted device from this header on every (re)connect, so the
    // device list shows the phone instead of 未命名设备.
    const deviceName = phoneDeviceName(requestedProtocols);
    if (!token) {
      // No usable credential — first pairing, or a revoked one. Take a one-time
      // code so a single scan is enough, naming the device after the phone.
      const pairing = await requestPairingCode(deviceName);
      if (pairing) {
        protocols.push('dsh-pair.' + pairing.code);
        log(`pipe ${bridgeId}: took a one-time pairing code (expires ${new Date(pairing.expiresAt).toLocaleTimeString()})`);
      }
    }
    const headers = {
      'X-DSH-Channel': 'miniprogram',
      'X-DSH-Device-ID': identity.deviceId
    };
    if (deviceName) headers['X-DSH-Device-Name'] = Buffer.from(deviceName, 'utf8').toString('base64');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // ws v8：子协议必须作为第二个位置参数，放 options.protocols 会被忽略
    const gateway = new WebSocket(GATEWAY, protocols.filter(Boolean), { headers });
    pipe.gateway = gateway;
    log(`pipe ${bridgeId}: dial local gateway ${GATEWAY} (subprotocols ${protocols.join(', ')})`);

    gateway.on('open', () => {
      pipe.gatewayReady = true;
      agentWs.send(JSON.stringify({ kind: 'client-ready', bridgeId }), { binary: false });
      log(`pipe ${bridgeId}: local gateway connected, protocol=${gateway.protocol || '(default)'}`);
      for (const text of pipe.queue) gateway.send(text);
      pipe.queue = [];
    });

    gateway.on('message', (data) => {
      const text = data.toString('utf8');
      captureToken(text);
      if (!session.ready) return;
      try {
        agentWs.send(session.seal(text), { binary: true });
      } catch (e) {
        log(`pipe ${bridgeId}: seal/send failed ${e.message}`);
      }
    });

    gateway.on('close', (code, reason) => {
      log(`pipe ${bridgeId}: local gateway closed ${code} ${reason.toString()}`);
      pipes.delete(bridgeId);
      if (agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ kind: 'client-close', bridgeId }), { binary: false });
      }
    });

    gateway.on('error', (err) => log(`pipe ${bridgeId}: gateway error ${err.message}`));

    // A revoked device leaves a dead token in credentials.json. Without this
    // the connector would dial with it forever and never re-pair, because the
    // old code only fetched a pairing code when no token existed at all.
    gateway.on('unexpected-response', (req, res) => {
      if (res.statusCode !== 401 && res.statusCode !== 403) return;
      const stored = loadCreds();
      if (stored[GATEWAY]) {
        delete stored[GATEWAY];
        saveCreds(stored);
        log(`pipe ${bridgeId}: gateway rejected the credential (${res.statusCode}); dropped the stale token`);
      }
      if (pipe.retriedWithPairing) return;
      pipe.retriedWithPairing = true;
      log(`pipe ${bridgeId}: redialing with a fresh pairing code`);
      void connect(true);
    });
  };

  void connect(false);
}


function handleClientClose(frame) {
  const pipe = pipes.get(frame.bridgeId);
  // Close a socket that is still connecting too: leaving it half-open leaks the
  // handle until the gateway times out, and its late 'open' would re-create a
  // pipe the peer already considers gone.
  if (pipe && pipe.gateway && (pipe.gateway.readyState === WebSocket.OPEN || pipe.gateway.readyState === WebSocket.CONNECTING)) {
    try { pipe.gateway.close(1000, 'peer-closed'); } catch (e) { /* ignore */ }
  }
  pipes.delete(frame.bridgeId);
}

// 中继二进制消息路由：绑定的管道处理握手与密文
async function handleRelayBinary(data) {
  const bytes = new Uint8Array(data);
  // 找到尚未完成握手或匹配的管道（单客户端场景只有一个活动管道；多客户端按顺序尝试）
  for (const [bridgeId, pipe] of pipes) {
    if (bytes.length && bytes[0] === PACKET_CLIENT_HELLO && pipe.session.ready === false) {
      const hello = pipe.session.acceptClientHello(bytes);
      if (hello) {
        pipe.agentWs.send(hello, { binary: true });
        log(`管道 ${bridgeId}: E2EE 握手完成`);
      } else {
        log(`管道 ${bridgeId}: ClientHello 无效`);
      }
      return;
    }
    if (pipe.session.ready && bytes[0] === PACKET_SEALED) {
      const text = pipe.session.open(bytes);
      if (text === null) {
        log(`管道 ${bridgeId}: 密文解密失败，关闭管道`);
        try { pipe.gateway.close(4002, 'e2ee-decrypt-failed'); } catch (e) { /* 忽略 */ }
        pipes.delete(bridgeId);
        return;
      }
      captureToken(text);
      if (await handleDeviceInfo(pipe, bridgeId, text)) return;
      if (pipe.gatewayReady && pipe.gateway.readyState === WebSocket.OPEN) {
        pipe.gateway.send(text);
      } else {
        pipe.queue.push(text);
      }
      return;
    }
  }
}

// ---------- 配对载荷 ----------

function pairingPayload() {
  const payload = {
    version: 3,
    mode: 'relay',
    relay: RELAY.replace(/\/$/, ''),
    nodeId: identity.nodeId,
    agentPubKey: identity.signPublicKey,
    gatewayName: GATEWAY_NAME,
    gatewayUrl: GATEWAY
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function printPairingPayload() {
  // Printed on every successful registration, as documented: the payload is
  // derived from the (stable) identity, so re-printing after a reconnect costs
  // nothing and saves hunting for the last occurrence.
  console.log('\n===== 配对载荷（Base64URL，可直接粘到小程序手动配对）=====');
  console.log(pairingPayload());
  console.log('=========================================================\n');
}

function log(message) {
  console.log(`[connector ${new Date().toISOString()}] ${message}`);
}

// ---------- 主流程 ----------

// SIGTERM matters for the plugin-supervised copy: the supervisor stops it by
// signal, and the exit handler must run to release the single-instance lock.
const shutdown = (signal) => {
  relayWants = false;
  log(`退出 (${signal})`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connectRelay();
