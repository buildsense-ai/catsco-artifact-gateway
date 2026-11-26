# Gateway 自动 WebMCP Runtime

与 [ANNOTATION-RUNTIME.md](./ANNOTATION-RUNTIME.md) 采用完全一致的无侵入 Nginx `sub_filter` 注入模式：真实链路仍为浏览器 → Nginx 应用 location → SSH loopback forward → Bot 应用；control-plane 仍不读取 HTML、不保存 `open_ref` 或会话绑定，也不新增 HTML proxy。

## 配置：全局默认与应用覆盖

管理员在 `gateway.json` 中独立配置 `webmcpRuntime`（可与 `annotationRuntime` 独立开启或同时开启）：

```json
{
  "webmcpRuntime": {
    "enabled": true,
    "defaultEnabled": true,
    "directory": "/opt/catsco-artifact-gateway/public/runtime",
    "parentOrigins": ["https://app.catsco.cc", "https://app.catsco.cn"]
  },
  "apps": [
    { "id": "my-canvas", "webmcp": true },
    { "id": "excluded-app", "webmcp": false }
  ]
}
```

- `enabled` 为总开关；`defaultEnabled: true` 时所有未显式关闭的现有与新注册应用自动注入，`webmcp: false` 显式关闭单个应用。
- 应用注册 API（`/_gateway/apps`）与 `scripts/register-app.mjs` 无权修改 `webmcp` 开关，重复注册保留管理员既有设置。
- 同时开启 `annotationRuntime` 与 `webmcpRuntime` 时，同一应用 location 内合并为单组 `sub_filter`，不产生重复指令或冲突。

注入的固定同源脚本标签：

```html
<script src="/_catsco/runtime/webmcp-v1.js"
 data-catsco-parent-origins="[&quot;https://app.catsco.cc&quot;,&quot;https://app.catsco.cn&quot;]"></script>
```

只有纯 JSON 数据属性，没有 inline JS、`open_ref`、JWT 或任何令牌。

## 页面侧使用方式（标准 WebMCP API）

页面无需引入任何专有 SDK，直接调用标准 `navigator.modelContext` 即可（若浏览器原生支持 WebMCP，shim 自动双写透传）：

```js
navigator.modelContext.registerTool({
  name: 'set_layout',
  description: '调整画布节点布局',
  inputSchema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['grid', 'row', 'column'] } },
    required: ['mode'],
  },
  execute: async ({ mode }) => {
    applyLayout(mode);
    return { ok: true, mode };
  },
});
```

支持：`registerTool`、`unregisterTool`、`provideContext({ tools })`、`clearContext`。

## 宿主 `postMessage` 桥接契约（`catsco.gateway-webmcp-bridge.v1`）

iframe 内 shim 只与 `window.parent` 且 `event.origin` 命中 `parentOrigins` 白名单的宿主通信（standalone 模式下仅本地工作，不发任何消息、不发起网络请求）：

| 方向 | `type` | 核心字段 | 说明 |
|---|---|---|---|
| Host → iframe | `catsco.gateway.webmcp.connect.v1` | `session_id`, `request_id` | 宿主建立会话握手 |
| iframe → Host | `catsco.gateway.webmcp.ready.v1` | `session_id`, `request_id`, `runtime_version`, `capabilities`, `tools` | 确认就绪并上报当前工具列表 |
| iframe → Host | `catsco.gateway.webmcp.tools_sync.v1` | `session_id`, `tools` | 页面增删工具时实时同步 |
| Host → iframe | `catsco.gateway.webmcp.tool_call.v1` | `session_id`, `call_id`, `name`, `arguments` | 宿主代 Bot 下发工具调用 |
| iframe → Host | `catsco.gateway.webmcp.tool_result.v1` | `session_id`, `call_id`, `is_error`, `content`, `structured_content?`, `error?` | 返回标准 MCP 结果（上限 512 KiB） |
| Host → iframe | `catsco.gateway.webmcp.ping.v1` | `session_id`, `request_id?` | 探活，iframe 回复 `pong.v1` |

## 安全边界

- **无网络请求**：`webmcp-v1.js` 不调用 `fetch` / `WebSocket`，只经 exact-origin `postMessage` 与 `window.parent` 通信。
- **不破 CSP**：静态脚本同源于 `/_catsco/runtime/webmcp-v1.js`，不修改上游 CSP 响应头。
- **单实例幂等**：同时命中 `</head>` 与 `</body>` 注入点时，`window.CatsCoWebMcp` 顶层单例确保不重复包装 `navigator.modelContext` 或重复注册 `message` 监听。
- **数量与载荷限制**：最多注册 64 个工具，单次 `tool_result` JSON 上限 512 KiB。
