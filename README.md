# catsco-artifact-gateway

独立的轻 Artifact **P0 链路原型**：把 Bot 本地 HTTP 应用经出站 443 暴露出来，不要求 Bot 用户拥有 root 或公网 IP。

## 实际链路

```text
浏览器 HTTPS 443 → Nginx 应用路由 → Gateway loopback 转发端口
                                            ↓ SSH remote forward
Bot 本地应用 ← OpenSSH 客户端 ← WSS 443 ← 独立 sshd + WSS adapter
```

采用 OpenSSH 的密钥认证、服务器指纹校验和 remote forwarding，使用 `ws` 的 Node Stream API 承载二进制 SSH 流。没有自造 HTTP 多路复用协议，也不经过 CatsCompany 消息服务或模型 Relay。

- Gateway：独立 sshd 仅绑定 loopback，禁用 shell/password/root/local forwarding。
- WSS adapter：普通服务用户运行，仅能连接这个 sshd，不接受任意 upstream 参数。
- Connector：普通 Agent 用户运行。仅连指定主机、使用固定主机公钥；断线自动退避重连，认证/指纹/端口冲突失败则明确 blocked，不无限重试。
- 每个应用独立密钥，只允许监听分配的一个 loopback 端口。
- JSON/SQLite/应用数据保留在 Bot 本地。Gateway 不保存业务数据。

## 已实测

2026-09-16：Saturday UID 994 与标准内网机器原 Agent 用户 UID 996，两者均经出站 WSS 443 工作。完整记录见 [验收报告](docs/P0-ACCEPTANCE.md)。

## 依赖

- 客户端：Node >=20、OpenSSH client、可写用户目录、出站 HTTPS/WSS 443。
- 服务端：Node >=20、OpenSSH server、Nginx、已有可信 HTTPS 虚拟主机。
- root 只用于服务器侧的系统服务/代理安装；Bot 侧初始化和运行无需 sudo。
- P0 客户端为 Linux；尚未验证 Windows/macOS。

## 本地校验

```sh
npm ci
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
```

## Bot 侧初始化（以 Agent 用户执行）

完整的 Bot 视角说明见 **[给 Bot 的 Artifact 指南](docs/BOT-GUIDE.md)**；下面是命令摘要。

先由管理员通过可信渠道提供 Gateway **公钥**；不得跳过主机验证或静默信任 ssh-keyscan 结果。发布包目录和状态目录都放在用户可写位置。

```sh
node scripts/init-connector.mjs /absolute/user/state demo artifact.example.com \
  22443 28191 20171 /absolute/gateway_host.pub \
  wss://artifact.example.com/_gateway/tunnel \
  --agent "$CATSCOMPANY_BOT_UID" --title "我的看板"
```

`--agent` 声明这个应用属于哪个 bot（从 `CATSCOMPANY_BOT_UID` 读）。它决定应用出现在谁的侧栏里：**没有声明归属的应用不会出现在任何 bot 的侧栏**。初始化会写 `registration.json`，把它交给网关侧登记：

```sh
node scripts/register-app.mjs /etc/catsco-artifact-gateway/gateway.json <registration.json>
node scripts/register-app.mjs /etc/catsco-artifact-gateway/gateway.json --list     # 查看每个应用的归属
node scripts/register-app.mjs /etc/catsco-artifact-gateway/gateway.json --remove <应用id>   # 下架
```

侧栏按 bot 取列表：`GET /api/apps?agent=<bot uid>`，只返回该 bot 的应用。

初始化生成本地私钥（不会上传）、known_hosts、connector.json，只输出登记所需公钥。管理员将公钥与应用 ID/端口绑定后：

```sh
# 普通应用使用现有进程管理器；下面只运行连接器
node src/connector.mjs /absolute/user/state/connector.json

# 测试演示应用可使用这个非 root launcher
node scripts/local-demo.mjs start /absolute/user/state/connector.json
node scripts/local-demo.mjs status /absolute/user/state/connector.json
node scripts/local-demo.mjs stop /absolute/user/state/connector.json
```

`connected` 表示隧道已绑定，不保证应用后端健康；应用健康应另查 `/health`。认证修复后重新启动连接器。`local-demo` 脱离终端运行，但不是开机自启或故障监督器，正式使用应接入已有的用户态进程管理。

## Gateway 配置

见 [部署与回滚](docs/DEPLOYMENT.md)。`scripts/render.mjs CONFIG OUTPUT` 生成 sshd、authorizedKeys、Nginx http 级配置和独立 Artifact vhost 的 location include；部署前必须执行 `sshd -t` 与 `nginx -t`。

## 明确不包含

1. 不包含会话注入、账户身份、Bot 自动注册，未修改 XiaoBa/CatsCompany 核心。
2. 不包含新 Artifact 列表 UI 或旧 Artifact 删除。旧系统保持运行。
3. 目前管理员登记应用，尚不是自助一键发布 API。
4. 独立双域名 `artifact.catsco.cc`、`artifact.catsco.cn` 使用 `/<app-id>/` 路径；两个域名无强制跳转，均可访问全部应用。**不是多应用浏览器安全隔离方案**：共享 origin 的 localStorage 等仍共享。只部署本仓库可信、可丢弃 demo；禁止上传任意 Agent 生成的页面。如需运行互不信任的应用，必须另行解决应用间浏览器隔离；路径本身不是隔离边界。
5. P0 会剥离 Cookie/Set-Cookie，并施加一套 CSP 响应头；请求体上限默认 64MB，应用可自行声明到 256MB。不支持应用登录 Cookie。正式隔离域名完成后再定义这些策略。
6. SSH+WSS 会增加进程数与加密开销，尚未压力测试。每应用一个连接只是两机验证方案。
7. 网络只需出站 443，但仍需允许 WebSocket；强制企业代理/拦截场景未验证。
8. 公网 demo 计数器有意匿名可写，只用于测试，不存用户数据或凭据。

同机隔离只能避免业务依赖，不能消除整机、共享 Nginx、带宽和内核资源的共同故障。服务有资源/连接上限，**不能承诺 Gateway 在任意故障下绝不影响主站**。

## 参考

- [ws 官方 Stream API](https://github.com/websockets/ws#use-the-nodejs-streams-api)：现有双工流适配，不在本仓库实现 WebSocket 协议。
- 本机 `sshd_config(5)` / `ssh_config(5)`：转发限制、主机验证、保活。
