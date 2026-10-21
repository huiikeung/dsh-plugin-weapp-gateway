/** Check a cold Session's recorded mode without acquiring a writer or changing it. */
export async function assertColdSessionPresetAvailable(ctx, sessionId, signal) {
  signal?.throwIfAborted();
  const agents = ctx.get('agents');
  const presets = ctx.get('agentPresets');
  const query = ctx.get('sessionQuery');
  if (typeof agents?.get !== 'function' || agents.get(sessionId)
    || typeof presets?.resolve !== 'function' || typeof query?.observeSession !== 'function') return;

  const observation = await query.observeSession(sessionId, { signal, projectionMode: 'all' });
  try {
    signal?.throwIfAborted();
    const selected = observation.projections?.values?.agentPreset;
    if (selected !== null && typeof selected !== 'string') return;
    try {
      const mode = await presets.resolve(selected ?? undefined);
      signal?.throwIfAborted();
      if (mode.broken === undefined) return;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code !== 'agent-preset/not-found' && error?.code !== 'agent-preset/invalid') throw error;
    }
    if (agents.get(sessionId)) return;
    throw Object.assign(new Error('此会话的模式未启用或暂不可用；请在电脑上检查对应模式，或选择其他会话。未发送本次消息。'), {
      code: 'adapter/session-preset-unavailable',
      details: { sessionId, ...(typeof selected === 'string' ? { agentPreset: selected } : {}) },
    });
  } finally {
    observation[Symbol.dispose]();
  }
}
