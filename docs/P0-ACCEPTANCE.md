# P0 真实验收 · 2026-09-16

## 范围

本次验证“普通用户 + 出站 443 + 本地真实前后端可达”，不是新 Artifact 产品全部上线。

| 场景 | 结果 |
|---|---|
| Saturday 普通用户初始化、应用和连接器运行 | UID 994，通过 |
| 标准内网机器原 Agent 用户初始化和运行 | catsco-agent UID 996，网卡 192.168.2.4，通过 |
| 两个应用独立固定 HTTPS 路由 | saturday-demo、standard-demo，均返回自己的 appId |
| GET/POST 与 JSON 刷新持久化 | 两端通过 |
| Saturday 应用进程重启后的数据 | 计数保持为 1，通过 |
| 下载 JSON 与内容哈希 | 两端通过，probe-http 输出 SHA256 |
| SSE 持续多条数据 | 两端通过 |
| WebSocket 101 与文本帧 | 两端通过 |
| Gateway WSS 进程停止 | 演示页 502，无虚假成功 |
| WSS 服务恢复后重连 | Saturday 10:50:43.914 断开，10:50:46.305 connected，约 2.4 秒 |
| 故障期间 CatsCompany 主站 HTTP | 200；未调用模型，因此不声称做过模型端到端验收 |
| 故障期间旧 Artifact / XiaoBa 服务 | active，未重启 |
| 密钥尝试执行 shell | 两端均拒绝 |
| 密钥尝试 local forward 到网关 SSH 22 | 两端均拒绝 |
| 密钥尝试未分配 remote port | 两端均拒绝 |
| 标准机器密钥尝试占用 Saturday 端口 | 先释放 Saturday 端口，仍被拒绝，排除“只是端口占用”假阳性 |
| 未登记客户端公钥 | 拒绝 |
| Gateway 主机公钥不匹配 | 拒绝，没有绕过校验 |
| npm 配置单测 | 5/5 |
| npm audit（官方 registry） | 0 vulnerabilities（当时检查结果） |

## 访问地址

- https://preview.catsco.cc/_cag_p0/saturday-demo/
- https://preview.catsco.cc/_cag_p0/standard-demo/

仅测试用公开计数器，可被其他访问者改变，不存真实用户数据。

## 可复现命令

```sh
npm test
node scripts/probe-http.mjs https://preview.catsco.cc/_cag_p0/saturday-demo/ saturday-demo
node scripts/probe-http.mjs https://preview.catsco.cc/_cag_p0/standard-demo/ standard-demo
# 在客户端以 Agent 用户执行：
node scripts/probe-ssh-boundary.mjs /absolute/connector.json
node scripts/probe-auth.mjs /absolute/connector.json
```

尚未验收：机器重启后标准用户自动启动、长期稳定性、负载/大文件压力、正式独立 origin、移动端视觉、新 Artifact 列表集成、模型调用隔离端到端测试。
