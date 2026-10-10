import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { renderGateway } from '../src/gateway-config.mjs';
import { annotationRuntime, runtimeScript } from '../src/annotation-runtime.mjs';

export const runtime = { enabled: true, directory: '/opt/catsco-artifact-gateway/public/runtime', parentOrigins: ['https://app.catsco.cc', 'https://app.catsco.cn'] };
export const gateway = { sshPort: 22443, user: 'cag', publicHosts: ['artifact.catsco.cc'], hostKey: '/etc/cag/key', authorizedKeys: '/etc/cag/keys', apps: [{ id: 'demo', remotePort: 28191, publicKey: 'ssh-ed25519 AAAATEST demo', annotations: true }, { id: 'plain', remotePort: 28192, publicKey: 'ssh-ed25519 AAAAOTHER plain' }] };

test('runtime and each application require independent explicit opt-in', () => {
  for (const config of [gateway, { ...gateway, annotationRuntime: { enabled: false } }]) {
    const out = renderGateway(config);
    assert.ok(!out.locations.includes('sub_filter'));
    assert.ok(!out.locations.includes('/_catsco/runtime/'));
    assert.ok(!out.nginx.includes('cag_annotation'));
  }
  const out = renderGateway({ ...gateway, annotationRuntime: runtime });
  assert.ok(out.locations.includes('location = /_catsco/runtime/annotations-v1.js'));
  assert.ok(out.locations.includes('location = /_catsco/runtime/html2canvas-1.4.1.min.js'));
  assert.ok(out.locations.includes(`alias ${runtime.directory}/html2canvas-1.4.1.min.js;`));
  assert.equal((out.locations.match(/location = \/_catsco\/runtime\//g) || []).length, 2, 'only the two pinned executable assets');
  const [annotated, plain] = out.locations.split('location ^~ /demo/')[1].split('location = /plain');
  assert.ok(annotated.includes('sub_filter'));
  assert.ok(!plain.includes('sub_filter'));
  assert.ok(plain.includes('proxy_pass http://127.0.0.1:28192/'));
});

test('operator default enables existing and future apps while explicit opt-out is retained', () => {
  const config = { ...gateway, annotationRuntime: { ...runtime, defaultEnabled: true },
    apps: [...gateway.apps, { id: 'off', remotePort: 28193, publicKey: 'ssh-ed25519 AAAAOFF off', annotations: false }] };
  const out = renderGateway(config);
  assert.equal((out.locations.match(/sub_filter_once on/g) || []).length, 2);
  assert.ok(out.locations.split('location ^~ /plain/')[1].split('location = /off')[0].includes('sub_filter'));
  assert.ok(!out.locations.split('location ^~ /off/')[1].includes('sub_filter'));
  assert.equal(out.sshd, renderGateway({ ...config, annotationRuntime: undefined }).sshd);
  assert.equal(out.authorizedKeys, renderGateway({ ...config, annotationRuntime: undefined }).authorizedKeys);
  for (const defaultEnabled of ['true', 1, null]) assert.throws(() => annotationRuntime({ annotationRuntime: { ...runtime, defaultEnabled } }));
});

test('parent allowlist and fixed asset paths reject executable/config injection', () => {
  for (const origin of ['*', 'null', 'https://app.catsco.cc/', 'https://app.catsco.cc/path', 'https://user:pass@app.catsco.cc', 'https://app.catsco.cc?x', 'http://app.catsco.cc', "https://evil';foo", 'https://app.catsco.cc\n', 42]) {
    assert.throws(() => annotationRuntime({ annotationRuntime: { ...runtime, parentOrigins: [origin] } }), String(origin));
  }
  for (const directory of ['/tmp/x; return 200;', '/tmp/$host', '/tmp/../secret', 'relative', '/tmp/\n']) assert.throws(() => annotationRuntime({ annotationRuntime: { ...runtime, directory } }));
  for (const patch of [{ enabled: 'true' }, { parentOrigins: [] }, { parentOrigins: undefined }, { src: 'https://evil/runtime.js' }]) assert.throws(() => annotationRuntime({ annotationRuntime: { ...runtime, ...patch } }));
  for (const annotations of ['true', 1, {}, null]) assert.throws(() => renderGateway({ ...gateway, apps: [{ ...gateway.apps[0], annotations }] }));
  assert.deepEqual(annotationRuntime({ annotationRuntime: { ...runtime, parentOrigins: ['http://127.0.0.1:3000', 'https://app.catsco.cc', 'https://app.catsco.cc'] } }).origins, ['http://127.0.0.1:3000', 'https://app.catsco.cc']);
});

test('script is external, JSON config is inert and no conversation credentials exist', () => {
  const script = runtimeScript(annotationRuntime({ annotationRuntime: runtime }));
  assert.match(script, /^<script src="\/_catsco\/runtime\/annotations-v1\.js" data-catsco-parent-origins="\[&quot;/);
  assert.ok(script.endsWith('"></script>'));
  assert.ok(!/open_ref|topic|token|cookie|referrer|document\./i.test(script));
  const out = renderGateway({ ...gateway, annotationRuntime: runtime });
  assert.ok(out.locations.includes('sub_filter $cag_annotation_head'));
  assert.ok(out.locations.includes('sub_filter $cag_annotation_body'));
  assert.ok(out.locations.includes('proxy_set_header Accept-Encoding $cag_annotation_encoding'));
  assert.ok(!out.locations.includes('proxy_hide_header Content-Security-Policy'));
  assert.ok(!out.locations.includes('unsafe-eval'));
  assert.ok(out.nginx.includes('$upstream_http_content_disposition:$http_range:$http_upgrade'));
  assert.ok(out.nginx.includes('default ""; 1 "</head>"'));
  assert.ok(out.locations.includes('max-age=0, must-revalidate'));
});

test('vendored runtime bytes agree with deterministic SDK export manifest', () => {
  const dir = new URL('../public/runtime/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('annotations-v1.manifest.json', dir), 'utf8'));
  const bytes = fs.readFileSync(new URL('annotations-v1.js', dir));
  assert.equal(manifest.runtime_path, '/_catsco/runtime/annotations-v1.js');
  assert.equal(manifest.config_attribute, 'data-catsco-parent-origins');
  assert.equal(manifest.bytes, bytes.length);
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(bytes.toString().includes('bootstrapAttribute'));
  assert.deepEqual(manifest.resources.map(resource => resource.filename), ['annotations-v1.js', 'html2canvas-1.4.1.min.js', 'html2canvas-1.4.1.LICENSE']);
  for (const resource of manifest.resources) {
    const data = fs.readFileSync(new URL(resource.filename, dir));
    assert.equal(resource.runtime_path, '/_catsco/runtime/' + resource.filename);
    assert.equal(resource.bytes, data.length);
    assert.equal(resource.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(resource.mime_type, resource.filename.endsWith('.js') ? 'application/javascript' : 'text/plain');
  }
  assert.equal(manifest.resources[1].sha256, 'e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb');
  assert.equal(manifest.resources[2].sha256, '86200ce4e92d9a22c41c8647a55f7a5fddff304ff89b4d36ecc699ed8c123d2c');
  const renderer = fs.readFileSync(new URL('html2canvas-1.4.1.min.js', dir));
  assert.ok(renderer.toString().includes('html2canvas 1.4.1'));
  const license = fs.readFileSync(new URL('html2canvas-1.4.1.LICENSE', dir), 'utf8');
  assert.ok(license.includes('MIT'));
  assert.ok(bytes.toString().includes('/_catsco/runtime/html2canvas-1.4.1.min.js'), 'SDK loads only the pinned self-host renderer');
  assert.ok(!/cdn\.|unpkg|jsdelivr|cdnjs/i.test(bytes.toString()), 'no CDN renderer URL may appear in the SDK');
  assert.ok(bytes.toString().includes('sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H'), 'renderer SRI pin is part of the served bytes');
  assert.ok(bytes.toString().includes('catsco.gateway.annotation.screenshot.result.v1'));
});
