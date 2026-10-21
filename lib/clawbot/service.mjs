import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ClawbotRuntime } from './runtime.mjs';
import { DshClawbotHost } from './dsh-host.mjs';
import { FileClawbotStorage } from './storage.mjs';
import { ClawbotError } from './contracts.mjs';
import { ILinkError } from './ilink-types.mjs';

function dshProfile(ctx) {
  const profile = ctx?.get?.('profileContext');
  if (profile !== undefined && profile !== null) {
    if (!profile || typeof profile !== 'object'
      || typeof profile.name !== 'string' || !profile.name || profile.name.length > 80
      || /[\\/\u0000-\u001f]/.test(profile.name) || ['.', '..', 'node_modules'].includes(profile.name)
      || typeof profile.home !== 'string' || !path.isAbsolute(profile.home) || profile.home.includes('\0')) {
      throw new Error('DSH 运行实例信息不完整，未使用其他实例的配置');
    }
    return { name: profile.name, home: path.normalize(profile.home) };
  }
  if (process.versions.electron) throw new Error('DSH profile facts are unavailable');
  const configured = String(process.env.DSH_HOME || '').trim();
  const home = configured === '~' ? os.homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\')
      ? path.join(os.homedir(), configured.slice(2))
      : configured ? configured : path.join(os.homedir(), '.dsh');
  const explicit = process.argv.find((value, index, argv) => argv[index - 1] === '--profile')
    || process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length);
  const name = explicit || (process.argv[2] === 'web' ? 'web' : 'default');
  return { name, home: path.resolve(home) };
}

export function clawbotStorageDirectory(ctx) {
  const profile = dshProfile(ctx);
  const scope = ['web', 'default'].includes(profile.name.toLowerCase()) ? 'web' : profile.name;
  const key = createHash('sha256').update(`deepseek-harness\0${scope}`).digest('hex').slice(0, 24);
  return path.join(profile.home, 'harness-remote', 'instances', key, 'clawbot');
}

export function createClawbotService(ctx) {
  let storage;
  try {
    storage = new FileClawbotStorage(clawbotStorageDirectory(ctx));
    const runtime = new ClawbotRuntime(storage, new DshClawbotHost(ctx));
    return {
      runtime,
      error: null,
      async control(request, signal = new AbortController().signal) {
        try {
          return { ok: true, value: await runtime.control(request, signal) };
        } catch (cause) {
          signal.throwIfAborted();
          const known = cause instanceof ClawbotError || cause instanceof ILinkError;
          return {
            ok: false,
            error: known
              ? { code: cause.code, message: cause.message }
              : { code: 'clawbot-operation-failed', message: '操作未完成，请刷新核对当前状态后再试。' },
          };
        }
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    try { storage?.close(); } catch { /* Preserve the original startup error. */ }
    const locked = /another|另一个|管理/u.test(String(error?.message || ''));
    return {
      runtime: null,
      async control() {
        return { ok: false, error: this.error };
      },
      error: {
        code: locked ? 'clawbot-owner-conflict' : 'clawbot-startup-failed',
        message: locked
          ? 'ClawBot 本地状态仍由旧服务占用。请先停止旧的私聊接线服务并重启 DSH，再由小程序网关接管。'
          : 'ClawBot 本地状态无法安全读取，原记录未覆盖。请在电脑端核对后重启 DSH。',
      },
      dispose: async () => {},
    };
  }
}
