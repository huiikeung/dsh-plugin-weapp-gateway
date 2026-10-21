/** Acquire only the current host's owner Peer; no peer identity comes from mobile RPC. */
export async function withNativePeer(ctx, signal, run, borrowed) {
  signal?.throwIfAborted();
  const connection = ctx?.get?.('connection');
  const peer = borrowed ?? (typeof connection?.createPeer === 'function'
    ? connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' }) : undefined);
  if (!peer) {
    if (typeof connection?.createPeer === 'function') throw new Error('DSH Connection returned no Peer');
    return run({ signal, dispose: async () => {} });
  }
  if (!peer.signal || typeof peer.signal.throwIfAborted !== 'function' || typeof peer.dispose !== 'function') {
    throw new Error('DSH Connection returned an invalid Peer');
  }
  let disposal;
  const dispose = () => {
    signal?.removeEventListener('abort', abort);
    return disposal ??= borrowed ? Promise.resolve() : Promise.resolve().then(() => peer.dispose()).catch(error => {
      console.warn('[weapp-gateway] ClawBot Peer cleanup failed:', error);
    });
  };
  const abort = () => { void dispose(); };
  if (!borrowed) signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted || peer.signal.aborted) {
    void dispose();
    signal?.throwIfAborted();
    peer.signal.throwIfAborted();
  }
  return await run({ peer, signal: signal ? AbortSignal.any([signal, peer.signal]) : peer.signal, dispose });
}
