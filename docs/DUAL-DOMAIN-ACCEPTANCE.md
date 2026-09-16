# 独立双域名迁移验收（2026-09-16）

本记录取代 P0 报告中的旧 preview 测试入口；原测试记录保留。

## 实际部署

- artifact.catsco.cc 与 artifact.catsco.cn 均解析到 CatsCompany 网关服务器。
- 独立 SAN 证书 artifact-gateway 覆盖两个域名，已配置 Certbot 自动续期及现有 Nginx reload hook。
- 首次 ACME secondary validation 连接超时，第二次签发成功；未关闭防火墙或修改主站证书。
- 应用路径为 /saturday-demo/、/standard-demo/；隧道为 /_gateway/tunnel。
- 两个域名都能访问同一份 Bot 本地数据，不强制跳到另一个域名。
- Saturday 连接 cc，标准服务器连接 cn，均保留原 SSH 客户端私钥与验证过的网关公钥。
- preview 当前配置没有 P0 include，官网预览服务返回 HTTP 200。

## 实测结果

| 应用 | 运行 UID | cc | cn |
|---|---:|---|---|
| saturday-demo | 994 | 全通过 | 全通过 |
| standard-demo | 996（原 Agent 用户） | 全通过 | 全通过 |

四组 probe-http 均通过：健康检查、POST 增长计数、重新读取 JSON、下载附件及内容校验、SSE 两次事件、WebSocket 消息。
Saturday cc 测试后计数为 44，cn 接续测试为 45；标准机分别为 13、14，验证共用本地状态。
这些是程序化协议验收，不代表跨浏览器视觉 QA 或生产压力测试。

7 项本地自动测试通过，包含双域名渲染、配置注入防护、迁移幂等、私钥不变、错误主机公钥拒绝。
Nginx 配置校验通过；网关两服务 active；CatsCompany 主站 HTTP 200；Saturday XiaoBa 与旧 Artifact 服务 active，未重启它们。

## 边界

仍是可信 demo 的 P0。独立域名不等于同域下不同应用隔离；路径共享 origin。
未加入自动登记、用户身份、会话注入、新 Artifact 展示层或旧系统删除。
双域名都可配置为隧道入口，但客户端没有自动跨域故障切换；它只重连所配置入口。
