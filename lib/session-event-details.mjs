// 移动端事件详情：在裁剪 token 级回放与工具正文后保留诊断事实。
// 取自上游 mobile-gateway（v0.11.2）的 session-event-details，字段全部为增量：
// - assistant/message、assistant/attempt: finish（结束原因与失败摘要）
// - tool/result: output/outputTruncated（16KB 摘要，保留首尾）
// - llm/retry: failure 摘要
// - turn/end: reasonDetails（本仓库仍保留原有的 reason 对象形态，mini-program 兼容）

const TOOL_OUTPUT_LIMIT = 16_000

export function failureDetails(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  for (const key of ['message', 'code', 'name', 'reason', 'requestId']) {
    if (typeof value[key] === 'string') result[key] = value[key]
  }
  for (const key of ['status', 'providerRetryAfterMs']) {
    if (Number.isFinite(value[key])) result[key] = value[key]
  }
  return Object.keys(result).length ? result : undefined
}

export function assistantFinish(data) {
  for (let i = (data.stream?.length || 0) - 1; i >= 0; i--) {
    const record = data.stream[i]
    if (record?.type !== 'chunk' || record.chunk?.type !== 'finish') continue
    const reason = record.chunk.reason
    if (typeof reason?.kind !== 'string') return undefined
    const failure = failureDetails(reason.failure ?? reason.error)
    return { kind: reason.kind, ...(failure ? { failure } : {}) }
  }
  return data.finish
}

export function toolResultDetails(data) {
  const texts = []
  const visit = (block) => {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'tool-result' && Array.isArray(block.content)) block.content.forEach(visit)
  }
  for (const block of data.message?.content || []) visit(block)
  const full = texts.join('')
  const outputTruncated = full.length > TOOL_OUTPUT_LIMIT
  // Retain the terminal status and sandbox hints at the end as well as the start.
  const output = outputTruncated
    ? `${full.slice(0, TOOL_OUTPUT_LIMIT / 2)}\n[…]\n${full.slice(-TOOL_OUTPUT_LIMIT / 2)}`
    : full
  return { output, outputTruncated }
}

export function turnReasonDetails(reason) {
  if (!reason || typeof reason.kind !== 'string') return undefined
  const error = failureDetails(reason.error ?? reason.failure)
  return { kind: reason.kind, ...(error ? { error } : {}),
    ...(typeof reason.reason?.kind === 'string' ? { reason: {
      kind: reason.reason.kind,
      ...(typeof reason.reason.reason === 'string' ? { reason: reason.reason.reason } : {}),
    } } : {}),
  }
}
