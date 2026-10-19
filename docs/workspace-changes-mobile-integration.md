# 文件变更接入（v0.8.7）

## 能力与鉴权

本版本收录已安装插件中的文件变更桥接补丁。宿主的可选 `workspaceChanges` 服务就绪时，WebSocket `hello.capabilities` 包含 `workspace-changes-v1`。服务缺席不影响会话、文件交付及其他网关功能。服务卸载后现有连接的查询返回 `workspace-changes-unavailable`，重新连接可刷新能力列表。

摘要与差异请求均要求已配对设备。即使调试模式关闭常规连接鉴权，未配对连接也不能读取变更内容。

## 请求与响应

从会话持久事件 `workspace/changes` 取得该轮最新公告的事件 `seq`，不要使用轮次号代替。

```json
{"type":"workspace-changes-summary","requestId":"changes-1","sessionId":"session-id","seq":42}
{"type":"workspace-changes-diff","requestId":"diff-1","sessionId":"session-id","seq":42,"index":0}
```

成功响应的 `kind` 与请求 `type` 一致，回传 `requestId`、`sessionId`、`seq`；差异响应还回传 `index`。`value` 为宿主记录的结果，快照不存在/过期时为 `null`，不会凭工具参数重新构造变更。

- 摘要：`turn`、`total`、`added`、`deleted`、`files`。每个文件含 `path`、`display`、`added`、`deleted`，可能含 `binary: true` 或 `oversized: true`。不暴露宿主工作目录字段或内部快照路径。
- 差异：宿主返回的文本 hunks，或二进制/超大文件类型标记。请求带 15 秒中止信号。
- 错误：`authentication-required`、`bad-request`、`workspace-changes-unavailable` 或 `workspace-changes-failed`，保留请求关联信息。

## 客户端显示规则

与 DSH 保持一致：摘要加载中、缺失、失效、无文件或能力不支持时，不显示空的“已编辑文件”占位卡片，也不回退到旧工具调用路径。明确交付的文件卡片和正文链接仍保留。

单文件直接显示“已编辑 文件名”；多文件显示总数，并逐项列出真实文件名/路径和增删行数。二进制/超大文件显示实际状态，不伪造文本差异。所有响应均需校验会话、事件序号、文件索引，切换会话或重连后不得套用旧响应。

## 升级

更新此插件后重新加载插件或重启 DSH，再让小程序重新连接。无需清空设备注册表、重新配对、迁移数据或重新部署公网中继。宿主必须自带并启用 `workspaceChanges` 服务；仅升级网关不能恢复已经失效的快照。
