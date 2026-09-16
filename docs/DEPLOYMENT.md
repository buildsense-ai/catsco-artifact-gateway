# P0 部署与回滚

## Gateway 系统侧

1. 创建仅用于认证的系统用户 `cag_ingress`，不授予 sudo；生成专用 sshd 主机密钥，不复用管理 SSH 密钥。
2. 应用文件安装到 `/opt/catsco-artifact-gateway`，运行 `npm ci --omit=dev`。
3. 配置和密钥置于 `/etc/catsco-artifact-gateway`。host private key 0600 root-owned，authorized_keys 是公钥文件，0644 root-owned。Bot 私钥绝不复制到网关。
4. 渲染配置，检查后安装 `deploy/gateway.service` 与 `deploy/ws-gateway.service` 为独立 systemd 单元。
5. 在 Nginx http 上下文加载生成的 `nginx`，在独立 Artifact HTTPS server 中 include 生成的 `locations`。配置 `publicHosts` 为全部域名，参考 `deploy/artifact-nginx.conf`；先建立 HTTP ACME challenge 路由，再申请独立 SAN 证书，最后启用 HTTPS。先备份原配置、比较防止覆盖他人变更，再 `nginx -t`，通过才 reload。
6. WSS adapter 监听 `127.0.0.1:22444`，专用 sshd 监听 `127.0.0.1:22443`，应用转发端口只监听 loopback。**不添加公网新端口或修改管理 SSH 22。**
7. `sshd -t -f ...` 校验后启动。网关私钥通过可信运维渠道分发其公钥；每应用登记独立客户端公钥。

P0 服务使用内存、CPU、任务数上限；OpenSSH 按密钥 permitlisten 限定端口；禁用 session channel（MaxSessions 0）、密码、root、local forwarding、Unix socket forwarding、agent forwarding、TTY。

## 当前试验部署位置

- CatsCompany：`catsco-artifact-gateway-p0.service`、`catsco-artifact-gateway-wss-p0.service`。
- Nginx 新增 `/etc/nginx/conf.d/catsco-artifact-gateway-p0.conf`，独立 vhost 为 `/etc/nginx/sites-enabled/catsco-artifact`，location include 为 `/etc/catsco-artifact-gateway/artifact-locations.conf`。preview 站点不包含本服务路由。
- Saturday：`cag-demo.service`、`cag-connector.service`，运行用户 cag_demo，状态 `/var/lib/cag-demo`。
- 标准服务器：原用户 catsco-agent，自有目录 `/srv/catsco-agent/apps/catsco-artifact-gateway` 与 `/srv/catsco-agent/apps/cag-p0-state`；使用 local-demo launcher，没有安装系统服务，也没有重启 Agent。

最初尝试新增公网端口遇到外层网络阻挡，现已撤回相应 UFW 放行规则，最终只走已有 443。那些端口不是完成方案的依赖。

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
