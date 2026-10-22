// Local shim for @deepseek-ai/dsh-credentials' credentialRef branding helper.
// The vendored quota adapters only need name validation; secrets are resolved
// through the gateway host context, never stored here.
export function credentialRef(value) {
  const ref = String(value || '')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new TypeError(`credential ref "${ref}" must be an environment variable name`)
  return ref
}
