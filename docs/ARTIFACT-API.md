# Artifact 标准接口参考

这份文档是 Artifact 能力的**权威契约**：发布、查询、下架、取访问者身份、验证。Bot（虚拟员工）按这里的接口就能把本地应用发布成固定公网地址，**不需要网关机器的写权限、不需要 root、不需要公网 IP**。

适用版本：2026-09-20 起的部署（双域名 `.cc` / `.cn`）。

## 0. 角色与调用关系

```text
        ① 发布/查询/下架（bot 自己的凭据）
   Bot ─────────────────────────────────▶ 平台  POST/GET/DELETE /api/artifacts/apps
                                             │
                                             │ ② 平台用自己持有的共享令牌
                                             ▼
                                           网关  POST/GET/DELETE /_gateway/apps
                                             │
                                             │ ③ 落配置 + 重渲染 nginx/sshd
                                             ▼
                                        公网地址生效

        ④ 取访问者身份（应用自己的后端）
   应用后端 ────────────────────────────▶ 网关  GET /_gateway/me?app=<id>
```

**两件不同的事，别混：**

| | 平台 `/api/artifacts/apps` | 网关 `/_gateway/me` |
|---|---|---|
| 谁调用 | **发布者**（bot / 人，带登录态） | **应用自己的后端** |
| 用途 | 管理"我有哪些应用" | 每次请求识别"现在是谁在用" |
| 鉴权 | 调用者自己的凭据 | 调用方的浏览器凭据（应用转发） |

## 1. 发布

```http
POST /api/artifacts/apps
Authorization: <发布者自己的凭据>
Content-Type: application/json

{
  "id": "my-board",
  "title": "我的看板",
  "publicKey": "ssh-ed25519 AAAA… comment",
  "localPort": 20000
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 应用 id，`^[a-z][a-z0-9_-]{0,47}$`。它就是公网路径段 `/<id>/` |
| `title` | | 侧栏显示名，≤60 字符，默认取 `id` |
| `publicKey` | ✅ | 应用侧连接器的 **ed25519 公钥**（私钥永不外传） |
| `localPort` | | 应用本地监听端口，仅记录/回显 |
| `agent` | ❌ | **不接受**。归属一律取调用者的 uid —— 见下 |

成功 → `201`：

```json
{
  "status": "registered",
  "id": "my-board",
  "title": "我的看板",
  "agent": "365",
  "remote_port": 28201,
  "url": "https://artifact.catsco.cc/my-board/",
  "urls": [
    "https://artifact.catsco.cc/my-board/",
    "https://artifact.catsco.cn/my-board/"
  ],
  "transport_url": "wss://artifact.catsco.cc/_gateway/tunnel",
  "updated_at": "2026-09-20T06:10:00.000Z"
}
```

- **`remote_port` 由网关分配**，调用者不要自己指定。重复发布同一个 `id` 会**保留原端口**（否则正在跑的隧道会断）。
- **`agent` 永远是调用者自己**。请求体里带了也会被忽略：归属决定"这个应用出现在谁的侧栏里"，让调用者自己填等于允许冒充。

### 归属的含义

每个应用必须属于一个 bot。归属的作用只有一个：**它只出现在该 bot 的侧栏里**。没有归属的应用不会出现在任何 bot 的侧栏（刻意的严格默认值）。

## 2. 查询

```http
GET /api/artifacts/apps          # 只返回调用者自己的
GET /api/artifacts/apps/<id>     # 单个；别人的 / 不存在的 → 404
```

```json
{ "apps": [ { "id", "title", "agent", "remote_port", "url", "urls", "status", "updated_at" } ] }
```

响应**不含** `publicKey`。字段是**侧栏那份清单的超集**：侧栏用的 `GET /api/apps?agent=<uid>` 返回 `id` / `title` / `url` / `status` / `updated_at`，这里额外给出 `urls`（双域名）、`agent`、`remote_port`，所以发布者不需要第二个接口就能知道"我发布了什么、地址是什么、在哪个域可用"。

### 和侧栏那个列表的分工

**两个"列应用"的接口，别混**（侧栏现在用的是后者，不是这个）：

| | 平台 `GET /api/artifacts/apps` | 网关 `GET /api/apps?agent=<uid>` |
|---|---|---|
| 调用方 | **发布者**（bot / 人，带登录态） | **侧栏前端**（直接 fetch 网关） |
| 鉴权 | 需要登录；只能看自己的 | **无鉴权**（公网可访问） |
| 返回 | 管理视角：`remote_port` / `agent` / 双域名地址 | 展示视角：`id` / `title` / `url` / `status` / `updated_at` |
| 用途 | "我发布了什么、怎么管理" | "这个 bot 的侧栏里显示什么" |

两者职责**有重叠**（都能列出某个 bot 的应用），但目前是分开的：侧栏不需要登录态去查（它已经知道 bot uid），而发布管理必须鉴权。

**已知的可简化点**（本次不做，需要动前端）：让侧栏也走平台、带上登录态，就能把两处合成一处，顺带让"应用清单可被公网枚举"这件事消失。当前不改前端，所以保留两条路径，但**新代码一律以平台侧为准**。

## 3. 下架

```http
DELETE /api/artifacts/apps/<id>     # 只允许自己的
→ { "status": "removed", "id": "my-board" }
```

下架只移除路由。**正在运行的连接器不会被配置变更断开**，所以要真正停服必须停掉应用侧的连接器进程。

## 4. 取访问者身份（应用侧，核心）

这是"应用知道现在是谁在用"的唯一入口。应用**不解析任何票据**，只把浏览器带来的凭据原样转发，读结论：

```js
// 应用后端（任意请求内）
const me = await fetch(`https://artifact.catsco.cc/_gateway/me?app=${APP_ID}`, {
  headers: {
    cookie: req.headers.cookie || '',                 // 顶层打开 / 侧栏内
    authorization: req.headers.authorization || '',   // 页内 token 兜底
  },
}).then(r => r.json());
```

响应契约 `catsco.artifact-viewer.v1`：

```json
{
  "contract": "catsco.artifact-viewer.v1",
  "authenticated": true,
  "viewer": { "id": "ap_c2lCBwUAH4EPquaUMbXpF-", "uid": 116, "username": "Lin", "kind": "user" },
  "app_id": "my-board",
  "topic_id": "grp_4133",
  "expires_at": "2026-10-20T05:56:00.627Z"
}
```

| 字段 | 含义 |
|---|---|
| `authenticated` | 是否识别到人。`false` 时 `viewer` 为 `null`（游客） |
| `viewer.id` | **按应用派生的稳定伪名**：同一用户在你的应用里永远是同一个值，在别的应用里对不上。**直接当本地 ACL 主键用** |
| `viewer.uid` | 平台数字 uid。缺省/非数字时为 `null` |
| `viewer.username` | **平台账号名**（唯一、不可变）。旧格式凭据下可能为 `null` |
| `viewer.kind` | 实体类型，当前恒为 `user` |
| `topic_id` | 用户从哪个会话进来的；直接开网址时为 `null` |
| `expires_at` | 该身份的到期时间 |

### 该用哪个字段做权限

| 需求 | 用 |
|---|---|
| 只在本应用内区分用户、不跨应用关联 | `viewer.id`（推荐，默认） |
| 要跨应用识别"是同一个人"、或要显示人类可读的账号名 | `viewer.username` / `viewer.uid` |
| 要按来源会话给不同内容 | `topic_id` |

`viewer.id` 与 `viewer.username` 是**同一份身份**的两种视图，不是两个用户：一个用户在你的应用里 `id` 固定、`username` 也固定。选哪个是**你要不要跨应用关联**的取舍。

## 5. 按身份做差异化展示 / 权限（可选，推荐）

**身份不是为了显示出来，而是为了决定给什么。** 典型形态：应用在**后端**按身份分支，前端拿到的是已经分好的内容 —— 这样权限不会被前端绕过。

```js
const me = await fetch(gatewayMeURL, { headers: forwardCredentials(req) }).then(r => r.json());
const viewer = me.authenticated ? me.viewer : null;
const topic = me.topic_id;                    // 来自哪个会话，可做"按会话隔离"

if (!viewer)              return renderGuest();          // 未登录/游客
if (await isOwner(viewer.id))  return renderAdmin(viewer.username);
if (await isEditor(viewer.id)) return renderEditor();
return renderReadOnly();

// ACL 存在你自己的本地数据里（JSON / JSONL / SQLite）
// 键用 viewer.id：稳定、按应用隔离、不暴露平台 uid
```

要点：

1. **判定放后端**。同一份 `/_gateway/me` 结论在前端也能拿到，但前端可被改；权限分支必须在**返回内容之前**的后端完成。
2. **未知身份一律降级**，不要"识别失败就当管理员"。`authenticated:false` 是正常状态（游客），不是错误。
3. **网关卡顿不是"没身份"**。网关对平台不可达时**返回游客**；如果你的应用把"游客"和"身份服务故障"混为一谈，会误把人降级。应用侧读 `authenticated` 即可，`error` 字段存在时按故障处理。
4. **别把 `username` 当唯一本地键**。它是平台账号名、可变性低但语义是"平台侧标识"；应用内 ACL 用 `viewer.id` 更干净，需要显示账号名时再取 `username`。
5. **侧栏内不要发起握手**（第 6 节）。iframe 里拿不到身份就提示用户用「新页面打开」，不要把小框变成登录页。

## 6. 三条入口

| 入口 | 凭据从哪来 | 效果 |
|---|---|---|
| 侧栏点击 | 平台发一次性码 → 网关换会话 Cookie | 有身份 + `topic_id` |
| 直接粘网址 | 平台域 Cookie（`Domain=.catsco.cc/.cn`） | 有身份，`topic_id` 为 `null` |
| 都没有 | 应用顶层跳 `/_auth/start` 握手一次 | 有身份；失败则 `/_auth/declined` 让用户选登录/访客 |

应用侧照抄这两行即可：

```js
const params = new URLSearchParams(location.search);
if (params.get('identity') === 'guest') return;                     // 用户已选访客
// 只在顶层跳，不要在 iframe 里跳
if (!me.authenticated && window.top === window) {
  location.replace('/_auth/start?app=' + APP_ID + '&next=' + encodeURIComponent(location.pathname));
}
```

> **页面里的请求一律用相对路径。** 应用被服务在 `/<id>/` 下：写 `fetch('api/whoami')`，不要写 `fetch('/api/whoami')`（会打到网关根，且不在页面 CSP 的 `connect-src` 范围内，浏览器报 `Failed to fetch`）。只有跳转到 `/_auth/start`、`/_launch/:code` 这类**网关控制面**地址时才用绝对路径。

## 7. 验证

发布之后应能确认四件事。最低限度的检查：

```bash
APP=my-board

# 1) 路由在、且两个域名都可达
for H in artifact.catsco.cc artifact.catsco.cn; do
  printf '%s → %s\n' "$H" "$(curl -s -o /dev/null -w '%{http_code}' "https://$H/$APP/")"
done

# 2) 身份端点通，且未带凭据时**如实回答游客**（不是报错）
curl -s "https://artifact.catsco.cc/_gateway/me?app=$APP"

# 3) 已识别的身份能拿到账号名（用真实浏览器的已登录会话验证）
#    预期: {"authenticated":true,"viewer":{"id":"ap_…","uid":…,"username":"…"},…}

# 4) 差异化展示生效：同一 URL，未登录与已登录看到的内容不同
#    这一条要在浏览器里用两个状态各看一次（或用两份不同凭据各请求一次）
```

**第 4 条是这套能力的真正验收点**：如果已登录和未登录看到的是同一份内容，说明身份只被显示、没被用于权限。

## 8. 诚实的边界

- **应用地址本身是公开可达的**：任何拿到 URL 的人都能访问。`GET /api/artifacts/apps` 的归属过滤只影响"侧栏里显示什么"，**不是权限边界**。要控权限，请在应用内部用 `viewer.id` 做（第 5 节）。
- **同域共享 origin**：所有应用用路径区分（`/<id>/`），共享 localStorage。不要托管互不信任的页面。
- **侧栏内 iframe 的 Cookie 行为**依赖"平台与应用同站"：`.cn` 用 `.cn`、`.cc` 用 `.cc`。跨站组合会静默降级为游客。
- **`username` 是平台账号名**，等同你在平台内的公开标识（同一会话里别人也看得到），不是机密；但它是**跨应用可关联**的，若不需要请用 `viewer.id`。
