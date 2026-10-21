import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClawbotService, clawbotStorageDirectory } from '../lib/clawbot/service.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-gateway-clawbot-'));
const ctx = {
  get(key) {
    return key === 'profileContext' ? { name: 'web', home } : undefined;
  },
};

try {
  const directory = clawbotStorageDirectory(ctx);
  assert.deepEqual(path.relative(home, directory).split(path.sep).filter(Boolean).slice(0, 2), ['harness-remote', 'instances']);
  assert.match(path.relative(home, directory), /[\\/]instances[\\/][a-f0-9]{24}[\\/]clawbot$/u);
  assert.equal(clawbotStorageDirectory({ get: key => key === 'profileContext' ? { name: 'default', home } : undefined }), directory,
    'default and web profiles share the existing gateway node identity');
  assert.throws(() => clawbotStorageDirectory({ get: () => ({ name: 'desktop', home: 'relative' }) }), /运行实例信息/u,
    'an invalid desktop profile must not fall back to the web profile');

  const service = createClawbotService(ctx);
  assert.ok(service.runtime, service.error?.message);
  const status = await service.control({ action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.value.supported, true);
  assert.equal(status.value.enabled, false);
  assert.equal(status.value.paired, false);

  const concurrent = createClawbotService(ctx);
  assert.equal(concurrent.runtime, null, 'only one gateway runtime may own the ClawBot store');
  assert.equal((await concurrent.control({ action: 'status' })).error.code, 'clawbot-owner-conflict');

  await service.dispose();
  const restarted = createClawbotService(ctx);
  assert.ok(restarted.runtime, restarted.error?.message);
  assert.equal((await restarted.control({ action: 'status' })).ok, true);
  await restarted.dispose();
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('ClawBot gateway-owned service lifecycle and single-owner storage: PASS');
