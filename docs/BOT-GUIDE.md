# 给 Bot 的 Artifact 指南

这份文档是 Bot（虚拟员工）把一个**本地前后端应用**发布成固定公网地址的完整说明。看完应能照着做完，不需要读网关源码。

## 1. 你能得到什么

```text
localhost:20000 上的应用          ← 你写的前端 + 后端 + 本地数据（JSON / JSONL / SQLite）
        ↓  出站连接（不需要 root、不需要公网 IP、不需要开入站端口）
https://artifact.catsco.cc/<你的应用 id>/   ← 固定公网地址
```

应用**不是静态页面**：它有自己的后端，可以读写本地数据，也可以调用模型。数据留在你的机器上，网关不保存业务数据。

## 2. 你的 bot uid

每个应用必须声明归属，否则不会出现在任何 bot 的侧栏里。你的 uid 从环境变量读：

```sh
echo $CATSCOMPANY_BOT_UID     # 例如 365
```

归属的作用只有一个：**你的应用只出现在你的侧栏里**，别人的侧栏看不到。

## 3. 应用要满足什么

| 要求 | 说明 |
|---|---|
| 一个本地 HTTP 服务 | 监听 `127.0.0.1:<端口>`，提供页面和（可选的）`/api/*` |
| 数据自管 | JSON / JSONL / SQLite 都行，放在你自己的可写目录 |
| 只用出站 | 只需要能出站访问 443（含 WebSocket）；不需要 root、不需要系统 nginx、不需要证书 |
| 身份（可选） | 想识别使用者就调 `/_gateway/me`，不想用就完全不写 |

## 4. 使用者身份：三段式，各入口统一

```text
1. 已有凭据      -> 按该身份进入
2. 没有凭据      -> 顶层跳 /_auth/start，自动向平台确认一次身份
3. 确认没成功    -> /_auth/declined 让用户选：登录 / 以访客继续
```

应用侧只需要"转发凭据、读结论"，不要自己解析任何票据：

```js
// 后端任意请求里
const me = await fetch('https://artifact.catsco.cc/_gateway/me?app=<你的应用 id>', {
  headers: {
    cookie: req.headers.cookie || '',                 // 顶层打开时
    authorization: req.headers.authorization || '',   // 页内/兜底时
  },
}).then(r => r.json());
// me = { contract, authenticated, viewer:{id,kind}, app_id, topic_id, expires_at }
```

- `me.viewer.id`（形如 `ap_xxx`）是**按应用派生的稳定伪名**：同一个用户在你的应用里永远是同一个值，在别的应用里对不上。可以直接当本地 ACL 的主键。
- `me.topic_id` 是用户从哪个会话进来的（侧栏进入时有，直接开网址时为 `null`）。
- 访客是 `authenticated: false, viewer: null`。权限策略完全由你在本地决定。

自动握手（第 2 步）应用侧照抄这两行即可：

```js
const params = new URLSearchParams(location.search);
if (params.get('identity') === 'guest') return;      // 用户已经选了访客，别再跳
const me = await fetch('/api/whoami').then(r => r.json());
if (me && me.authenticated === false && window.top === window) {   // 只在顶层跳
  location.replace('/_auth/start?app=<你的应用 id>&next=' + encodeURIComponent(location.pathname));
}
```

在 iframe 里不要发起握手（会把平台页塞进小框）；框里没有凭据时提示用户用「新页面打开」即可。

参考实现：`demo/server.mjs` 的 `/api/whoami`（转发凭据）+ 首页脚本（顶层握手）。

> **页面里的请求一律用相对路径。** 应用被服务在 `/<app-id>/` 下，所以页面里要写 `fetch('api/whoami')` 而不是 `fetch('/api/whoami')`：带前导斜杠会解析成网关根路径，既打到别处、也不在页面 CSP 的 `connect-src .../<app-id>/` 允许范围内（浏览器表现为 `Failed to fetch`）。跳转到 `/_auth/start`、`/_launch/:code` 这类**网关控制面**地址时才用带斜杠的绝对路径。

## 5. 发布四步

```sh
# 1. 生成密钥与登记载荷（普通用户执行，全在用户目录内）
node scripts/init-connector.mjs \
  <你的状态目录> <应用id> artifact.catsco.cc 22443 <远端端口> <本地端口> \
  <网关公钥文件> wss://artifact.catsco.cc/_gateway/tunnel \
  --agent $CATSCOMPANY_BOT_UID --title "我的看板"

# 输出里会有 registration.json —— 这就是交给平台登记的凭据（不含私钥）
# 2. 登记（需要网关配置的写权限；没有就把它交给平台侧执行）
node scripts/register-app.mjs /etc/catsco-artifact-gateway/gateway.json <registration.json>

# 3. 启动
node src/connector.mjs <你的状态目录>/connector.json
```

### 接口对照

| 接口 | 谁用 | 用途 |
|---|---|---|
| `--agent` / `registration.json` | 你（init） | 声明应用归属 |
| `register-app.mjs <gw.json> <reg.json>` | 平台 | 登记一个应用（校验端口/密钥唯一、schema 合法） |
| `register-app.mjs <gw.json> --list` | 平台 | **查看每个应用归属哪个 bot**，未标注的会告警 |
| `register-app.mjs <gw.json> --remove <id>` | 平台 | 下架 |
| `GET /api/apps?agent=<uid>` | 侧栏 | 取**该 bot 的**应用清单（5 字段：id/title/url/status/updated_at） |
| `POST /_gateway/codes` | 平台（控制 token） | 发一次性码 |
| `GET /_launch/:code` | 浏览器 | 兑码 → 会话 Cookie（或 `?format=json` 取 ticket） |
| `GET /_gateway/me` | 你的应用 | 身份 + topic |
| `GET /_auth/start` · `/_auth/declined` | 浏览器 | 自动握手 · 登录/访客选择 |

## 6. 归属如何隔离

- 归属写在网关配置 `gateway.json` 每个应用的 `agent` 字段（由 `registration.json` 带过来，不是手工拼）。
- `GET /api/apps?agent=<uid>` **只返回该 uid 的应用**；未声明归属的应用**不会出现在任何 bot 的侧栏**（这是刻意的严格默认值，避免串号）。
- 归属值有格式校验（正整数 uid），登记时会拒绝非法值。
- 不带 `?agent=` 的调用（运维/未来的总览视图）才能看到全部，且 `--list` 会明确标出哪些应用没有归属。

## 7. 下架

```sh
# 平台侧：从网关移除路由
node scripts/register-app.mjs /etc/catsco-artifact-gateway/gateway.json --remove <应用id>
```

你自己这边：停掉 connector（隧道断开，路径立即不可用），把数据目录移到回收目录保留。**改动 authorized_keys 不会断开已经建立的连接**，所以下架要停 connector，不能只改配置。

## 8. 诚实的边界

- **应用地址本身是公开可达的**：任何拿到 URL 的人都能访问。列表过滤只影响"侧栏里显示什么"，不是权限边界。要控权限请在应用内部用 `viewer.id` 做。
- **列表不是秘密**：不带 `?agent=` 时返回全部应用清单（只有 id/title/url）。
- **同域共享 origin**：应用用路径区分（`/<app-id>/`），共享 localStorage；不要托管互不信任的页面。
- **侧栏内 iframe 的 Cookie 行为**尚未在真浏览器验证：`app.catsco.cc` 与 `artifact.catsco.cc` 同站，预期会带上；没带时以访客展示并提示用「新页面打开」。
- **Windows / macOS 客户端未验证**，目前只验证过 Linux。
