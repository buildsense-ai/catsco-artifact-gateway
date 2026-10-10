# Gateway 自动标注 runtime（未部署）

真实链路仍为浏览器 → Nginx 应用 location → SSH loopback forward → Bot 应用。`src/gateway-config.mjs` 在现有 location 配置 `sub_filter`；control-plane 仍负责发布、列表、身份交换，不读取 HTML，也没有新增 HTML proxy。

## 配置：两层 opt-in

管理员在真实 `gateway.json` 中设置全局资源/parent allowlist，再选择应用。缺省完全关闭，应用注册 API 不能自行开启；重复注册会保留管理员的 `annotations` 字段。

```json
{
  "annotationRuntime": {
    "enabled": true,
    "directory": "/opt/catsco-artifact-gateway/public/runtime",
    "parentOrigins": ["https://app.catsco.cc", "https://app.catsco.cn"]
  },
  "apps": [{ "id": "existing-app", "annotations": true }]
}
```

示例 apps 项只是要合并的字段，需保留已有 agent/remotePort/publicKey 等值。现有应用不会自动全开；每个想接入的已存在 app 需管理员设置 `annotations: true`。新平台注册的 app 默认 off：先正常发布取得稳定 app id，再由管理员在 gateway.json 对该 id 添加字段并 render/reload。平台 artifactAppRequest 不需要新增 activation 字段，控制面忽略 caller 的 annotations，并保留已批准 flag。allowlist 是显式精确 origin（最多 32 个、JSON ≤16384 字符），生产只接受 HTTPS；本地 loopback HTTP 可用于 fixture。不能包含通配符、路径、query、credential。配置不从 referrer、URL、shared viewer cookie 推断 parent/topic。

注入固定同 origin classic script：

```html
<script src="/_catsco/runtime/annotations-v1.js"
 data-catsco-parent-origins="[&quot;https://app.catsco.cc&quot;,&quot;https://app.catsco.cn&quot;]"></script>
```

只有 JSON 数据属性，没有 inline JS、open_ref、JWT、控制令牌。open_ref 只在 CatsCo 宿主保存；Gateway 无需知道会话绑定。viewer 的历史 `topic_id` 是旧身份接口的来源提示，不能用于标注路由或授权。

SDK 首个来自 `window.parent` + allowlist origin 的有效 connect 创建 singleton 并立即处理该 connect，回复同一 document session/request。advanced app 可继续 create/revision/getElementId；D SDK 保证重复加载不会重置 API 或多装监听器。standalone 没有 parent，不建立自动通道。

## 实际过滤/缓存/压缩行为

- 请求必须 GET document/iframe，或没有 Fetch Metadata 且 Accept 包含 text/html；无 Accept 的普通 GET 兼容 CLI。明确 script/style/fetch/WS 请求不改变 upstream 压缩/conditional headers。
- 响应必须 200、Content-Type **恰好** text/html（可选 UTF-8/US-ASCII charset），有可信的正整数 Content-Length 且 ≤999999 bytes；Content-Encoding 缺省/identity；无 Content-Disposition、Range/Upgrade、Cache-Control no-transform。
- 注入点是 `</head>`（支持 `<head lang=...>`），大小写不敏感；`</body>` 提供缺 head fallback。Nginx sub_filter 无法条件化“已经出现 head 则不改 body”，所以普通完整 HTML 有两个同一 script tag。每个 marker 只替换一次，SDK 顶层 singleton 保证运行行为只有一个实例。缺两种 closing marker 的 fragment 原样返回。sub_filter 是字节匹配，不是 HTML parser；可信应用若在注释/raw text 中写这些 marker，可能命中，需自行 SDK 接入或关闭 opt-in。
- document 候选请求向上游去掉 Accept-Encoding 与 If-None-Match/If-Modified-Since，防止拿到无法改写的缓存 304。替换后的 Content-Length/ETag/Last-Modified 由 Nginx sub_filter 清理，响应仍遵循现有 gateway no-store。opt-in app 隐藏 upstream Cache-Control/Expires，避免 no-store 与 public/max-age 冲突；no-transform 仍在 upstream header map 判定后跳过。
- 上游按要求返回未压缩 HTML 时自动注入；下游 Nginx gzip（如果已配置）在替换之后执行。若上游无视协商强制 gzip/br，filter map 为空，压缩体/Content-Encoding/Content-Length 原样通过，**没有注入**。不会 gunzip 未知体或添加解压代理。
- chunked HTML、没有 Content-Length 的 HTML/SSE、超限体、非 UTF8/ASCII、下载（任何 Content-Disposition）、JSON/CSS/JS/xhtml、206/range/error/HEAD 均不注入。下载/强制 gzip 的 byte/header 保留；应用 no-store 是已有 gateway 策略。
- 上游 Content-Security-Policy 和 Report-Only 全部保留，与 gateway 原有 CSP 同时生效；没有新增 unsafe-inline/unsafe-eval 或覆盖 CSP。script-src 禁止 self 时 runtime 被浏览器自然阻止，宿主应显示 SDK unavailable。style CSP 仍可限制 SDK affordance；不放宽它。HTTP 测试证明 header 保留，浏览器 CSP enforcement 由联合浏览器验收确认。
- `/_catsco/runtime/annotations-v1.js` 和 `/_catsco/runtime/html2canvas-1.4.1.min.js` 两个 exact location 只 alias 管理员部署的固定文件，不代理 query/用户 URL。SDK 在截图请求时按需加载同源固定 renderer，不使用 CDN。GET/HEAD 可读，其他方法拒绝，其他 runtime 路径 404，manifest 与许可证不公开（许可证保留在部署目录）。Content-Type application/javascript、nosniff、no-referrer，资源 Cache-Control public,max-age=0,must-revalidate + ETag。v1 是协议版本而非内容 hash，不能配置 immutable 长缓存。

Content-Length 是上游提供的界限；Nginx 此方案没有全体 buffering，也无法证明恶意上游声明与实际字节一致。仅用于当前可信应用，路径共享 origin 仍不是安全隔离边界。

## SDK 唯一来源与校验

Gateway `public/runtime` 包含 D canonical export 的 SDK、固定 html2canvas 1.4.1 renderer、MIT 许可证与 provenance manifest，不能手改副本。manifest resources 逐项记录 SHA-256/bytes/MIME；export/check 同时验证 renderer 与 license 的固定 hash。更新通过 CatsCo repo 的 deterministic export：

```sh
node "$CATSCO_REPO/scripts/export-gateway-annotation-runtime.mjs" \
  --out-dir "$GATEWAY_REPO/public/runtime" \
  --expected-sha256 "$SDK_FROZEN_SHA256"
node "$CATSCO_REPO/scripts/export-gateway-annotation-runtime.mjs" \
  --out-dir "$GATEWAY_REPO/public/runtime" --check \
  --expected-sha256 "$SDK_FROZEN_SHA256"
```

`SDK_FROZEN_SHA256` 必须设为当前 D source freeze 报告中的完整 hash。manifest checksum 测试证明本仓库所有 asset 与 manifest 一致；`--check` 则证明与平台 canonical bytes 一致。当前发布资源版本以 `public/runtime/annotations-v1.manifest.json` 为准，避免沿用历史报告的 SDK hash。renderer SHA 固定为 `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb`，许可证 SHA 固定为 `86200ce4e92d9a22c41c8647a55f7a5fddff304ff89b4d36ecc699ed8c123d2c`。

## Render、部署（仅步骤，本轮未执行）

1. 保留现有生产 gateway.json，备份 config、nginx http/location include 与旧 runtime asset。安装当前 gateway source（pnpm 只用于本仓库 deps），把完整导出的 SDK、renderer、license 与 manifest 放到配置 directory，root-owned 文件 0644、目录 0755，Nginx worker 可读。Control-plane 的 config owner 不能写 runtime source 或 directory。
2. 确认生产 Nginx `nginx -V` 有 http_sub_module、版本 ≥1.9.4（支持 variable search）。`node scripts/render.mjs /path/gateway.json /tmp/cag-render`。检查 nginx 和 locations 的 diff；sshd/authorizedKeys 应与旧配置 byte-identical。
3. 将 render 的 nginx 装到 `/etc/nginx/conf.d/catsco-artifact-gateway-p0.conf`（http context），locations 装到 `/etc/catsco-artifact-gateway/artifact-locations.conf`（专用 Artifact vhosts）。保留旧文件用于 rollback。现有 `deploy/apply-config.sh` 使用同一 renderer，无需新增 proxy service；它不安装 SDK 文件，必须先做步骤 1。
4. `nginx -t` 通过再由管理员 reload；不用重启 tunnel/sshd/control-plane。不要在本轮自动执行。
5. 实际打开允许 app，验证 HTML tag、固定 asset/headers、父宿主首次 ready；在 restrictive CSP app 上确认 SDK unavailable。不以注入 HTML 等同 annotations 已完成绑定发送。

回滚：把 `annotationRuntime.enabled` 改 false，或某 app annotations false；render/install http/location 两文件，nginx -t 后 reload。关闭全局会移除 runtime route/filter/maps；关闭单 app 保留资源但不改该 app HTML。既有已打开 document 需刷新。若回滚 source，连同旧 nginx/http maps、asset 一并恢复，避免 references/maps 不一致。viewer state、Bot 数据与 SSH keys 保留。

## 测试

```sh
pnpm install --ignore-scripts --lockfile=false
pnpm test
CAG_NGINX_TEST=1 pnpm test
```

最后命令需要已有 Docker engine 与 `nginx:alpine` image；可设 CAG_NGINX_IMAGE 使用已批准版本。默认 Node suite 显式 skip 容器 test；启用后缺 Docker 会失败，不伪装通过。test 创建无 SDK 的真实 HTTP upstream，并用本仓库 renderer 生成 Nginx（只将容器 loopback target 改成 host.docker.internal）；执行 nginx -t 和实际 HTTP/WS 验证，最后清理其容器。first connect 测试执行该 HTTP asset 的真实 bytes（VM 最小 DOM harness），不是完整浏览器 DOM/CSP test。联合 Go persist 测试见下文。

## 主会话联合 fixture

`testdata/open-binding-gateway-fixture.mjs` 导出 `startGatewayFixture()`：真实 createControlPlane + ViewerStore（本地 state）+ 未手工 SDK app + renderer output，不新增 HTML proxy。

```sh
CAG_FIXTURE_PARENT_ORIGIN=http://127.0.0.1:3080 \
 CAG_FIXTURE_AGENT=365 \
 node testdata/open-binding-gateway-fixture.mjs /tmp/cag-open-binding-joint
# 在另一终端，启动真实 nginx（仅本地）：
docker run --rm --name cag-joint-nginx -p 127.0.0.1:3081:3081 \
 --entrypoint nginx \
 -v /tmp/cag-open-binding-joint/nginx.conf:/etc/nginx/nginx.conf:ro \
 -v "$PWD/public/runtime:/runtime:ro" nginx:alpine -t
docker run --rm --name cag-joint-nginx -p 127.0.0.1:3081:3081 \
 --entrypoint nginx \
 -v /tmp/cag-open-binding-joint/nginx.conf:/etc/nginx/nginx.conf:ro \
 -v "$PWD/public/runtime:/runtime:ro" nginx:alpine -g 'daemon off;'
```

fixture 输出 control_url、app_id joint-app、agent_uid、runtime_directory；测试 control token 默认 `joint-fixture-control-token-0123456789abcdef`，可通过 CAG_FIXTURE_CONTROL_TOKEN 改。它是本地专用凭据，不能使用生产 token。

Go launch fixture 的 canonical registry 使用 app_id joint-app、owner UID 365、gateway origin https://artifact.catsco.cc，配置 codes endpoint 到 fixture 输出的 control_url/_gateway/codes，并注入仅本地 HTTPS→HTTP fetch mapping（保持生产 URL validation）。由于 launch_url 是 canonical HTTPS artifact origin，联合测试 transport 映射到本地 nginx_url，open_binding 中的 origin 始终 canonical；不要将 fixture 协议映射变成产品逻辑。

联合步骤：真实 Go authenticated launch 取 parent-only open_ref 与 launch code → 真实 gateway /_launch/code 换身份 cookie → 无 SDK fixture HTML 经 Nginx 注入 → 载入固定外部 asset、first parent connect/ready、DOM element/text/region → 宿主带 open_ref bound POST 到真实 Go ingestion → 查询实际 message store/目标 agent 的文本。wrong auth、A/B 两个 open refs、多 tab 覆盖同名 viewer cookie 要分别断言 failclosed/原 topic 持久化。Gateway 不 resolve open_ref；此端单独通过不能声称 Go actual persist 已验收。
