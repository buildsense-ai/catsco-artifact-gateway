# P0 部署与回滚

## Gateway 系统侧

1. 创建仅用于认证的系统用户 `cag_ingress`，不授予 sudo；生成专用 sshd 主机密钥，不复用管理 SSH 密钥。
2. 应用文件安装到 `/opt/catsco-artifact-gateway`，运行 `pnpm install --prod --ignore-scripts --lockfile=false`。
3. 配置和密钥置于 `/etc/catsco-artifact-gateway`。host private key 0600 root-owned，authorized_keys 是公钥文件，0644 root-owned。Bot 私钥绝不复制到网关。
4. 渲染配置，检查后安装 `deploy/gateway.service` 与 `deploy/ws-gateway.service` 为独立 systemd 单元。
5. 在 Nginx http 上下文加载生成的 `nginx`，在独立 Artifact HTTPS server 中 include 生成的 `locations`。配置 `publicHosts` 为全部域名，参考 `deploy/artifact-nginx.conf`；先建立 HTTP ACME challenge 路由，再申请独立 SAN 证书，最后启用 HTTPS。先备份原配置、比较防止覆盖他人变更，再 `nginx -t`，通过才 reload。
6. WSS adapter 监听 `127.0.0.1:22444`，专用 sshd 监听 `127.0.0.1:22443`，应用转发端口只监听 loopback。**不添加公网新端口或修改管理 SSH 22。**
7. `sshd -t -f ...` 校验后启动。网关私钥通过可信运维渠道分发其公钥；每应用登记独立客户端公钥。

P0 服务使用内存、CPU、任务数上限；OpenSSH 按密钥 permitlisten 限定端口；禁用 session channel（MaxSessions 0）、密码、root、local forwarding、Unix socket forwarding、agent forwarding、TTY。

## 隧道并发上限

WSS adapter 同时最多承载 `TUNNEL_MAX_CONNECTIONS` 条隧道，默认 **160**，超出的连接直接收到 `403`，已在跑的隧道不受影响。

这个池是**全局共享的**，不是按 bot 或按应用分配：隧道 URL 不携带身份，adapter 能数的只有它持有的全部连接。所以上限要按「网关上所有应用的总数」来定，而不是某个账号的份额。

定值依据是内存，不是 socket。每条隧道会拉起一对 sshd 进程，实测约 13 MB，所以 160 条约占 2 GB —— 在当前主机（7.5 GB）上是安全的；`/health` 会同时报出 `activeConnections` 与 `maxConnections`，接近上限时应当扩容而不是等用户报连不上。

两条相关的调整：

- **提高上限时要同时确认 `LimitNOFILE`。** 每条隧道占 2 个 fd，`ws-gateway.service` 已从 1024 提到 2048；socket 预算不该先于连接上限被撞到。
- **unit 与代码都由 CI 安装和重启。** `deploy-prod.yml` 在每次合并到 main 时会装 `ws-gateway.service` 并重启 WSS adapter，所以改了 unit 或 `src/ws-gateway.mjs` 都会自动生效，不需要手工上机。重启会断开现有隧道，连接器会在几秒内自动重连。

## 当前试验部署位置

- CatsCompany：`catsco-artifact-gateway-p0.service`、`catsco-artifact-gateway-wss-p0.service`。
- Nginx 新增 `/etc/nginx/conf.d/catsco-artifact-gateway-p0.conf`，独立 vhost 为 `/etc/nginx/sites-enabled/catsco-artifact`，location include 为 `/etc/catsco-artifact-gateway/artifact-locations.conf`。preview 站点不包含本服务路由。
- Saturday：`cag-demo.service`、`cag-connector.service`，运行用户 cag_demo，状态 `/var/lib/cag-demo`。
- 标准服务器：原用户 catsco-agent，自有目录 `/srv/catsco-agent/apps/catsco-artifact-gateway` 与 `/srv/catsco-agent/apps/cag-p0-state`；使用 local-demo launcher，没有安装系统服务，也没有重启 Agent。

最初尝试新增公网端口遇到外层网络阻挡，现已撤回相应 UFW 放行规则，最终只走已有 443。那些端口不是完成方案的依赖。

## 自动应用配置（一次性安装）

发布应用只改 `gateway.json`（`cag_ingress` 拥有，0600），而它驱动的四个文件都是 `/etc` 下的 root 文件。所以配置生效交给一个 root oneshot，一次性安装：

```sh
install -m 755 deploy/apply-config.sh /opt/catsco-artifact-gateway/deploy/apply-config.sh
install -m 644 deploy/cag-apply.service deploy/cag-apply.path /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cag-apply.path
```

`cag-apply.path` 监听 `gateway.json` 变化 → `cag-apply.service` 渲染四个文件：`nginx -t` 通过才 reload nginx，`sshd -t` 通过才 restart `catsco-artifact-gateway-p0`。不通过就不动正在跑的服务，因此不需要回滚框架。`cag_ingress` 仍然没有 sudo，root 侧只对一个「本来就只有它可写」的文件做出反应，攻击面等于原来的 `scripts/register-app.mjs`。

文件名与实际路径映射（2026-09-20 在 catsco-prod 只读确认）：`sshd`→`/etc/catsco-artifact-gateway/sshd`、`authorizedKeys`→`/etc/catsco-artifact-gateway/authorized_keys`、`locations`→`/etc/catsco-artifact-gateway/artifact-locations.conf`、`nginx`→`/etc/nginx/conf.d/catsco-artifact-gateway-p0.conf`。

## 可选自动标注 runtime（本轮未部署）

见 [ANNOTATION-RUNTIME.md](ANNOTATION-RUNTIME.md) 的完整 opt-in、源 SDK export/check、过滤/压缩/CSP、Nginx render/install 和专属回滚步骤。全局 annotationRuntime 与每 app annotations:true 均须管理员明确配置，现有应用及新注册应用缺省不启用。先安装可读且 operator-owned 的固定 runtime asset，再应用两份 Nginx 配置；无需新增 proxy 或重启 SSH 服务。

## 回滚（保留数据）

1. 停止两端的演示应用/连接器，只针对上述测试进程；不要停止 XiaoBa。
2. 移除专用 catsco-artifact vhost；不要覆盖其他站点配置。
3. `nginx -t` 通过后 reload。
4. 停止并禁用两个专用 gateway systemd 服务。
5. 保留 demo JSON、密钥、配置和日志，确认无需继续测试后才删除。旧 Artifact 不涉及回滚。

## 正式化前的门槛

- 已使用独立 Artifact 双域名与证书；同域不同路径仍共享 origin，需要为不可信应用另行设计隔离。
- 复用 Bot 身份的受限公钥登记/撤销接口，不把 Bot 总凭据放进浏览器。
- 配置变更和撤销应准确断开对应连接；P0 更改公钥文件不会自动撤销已有 SSH 连接。
- 标准用户态监督、日志轮换、容量压测、最大上传/流式空闲策略。
- 新 Artifact 展示层独立开发，先灰度再替换旧系统。
