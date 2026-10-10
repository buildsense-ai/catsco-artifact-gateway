// Configuration-only integration. HTML is still served by the existing nginx
// application proxy; the control plane never sees or rewrites app documents.
export const RUNTIME_URL = '/_catsco/runtime/annotations-v1.js';
export const RUNTIME_FILENAME = 'annotations-v1.js';
export const RENDERER_URL = '/_catsco/runtime/html2canvas-1.4.1.min.js';
export const RENDERER_FILENAME = 'html2canvas-1.4.1.min.js';
export const MAX_HTML_BYTES = 999999;

function parentOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid annotation parent origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid annotation parent origin'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      !/^[a-zA-Z0-9:/.\[\]-]+$/.test(value)) throw new Error('Invalid annotation parent origin');
  return value;
}

export function annotationRuntime(config) {
  const value = config.annotationRuntime;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid annotationRuntime');
  if (Object.keys(value).some(key => !['enabled', 'directory', 'parentOrigins', 'defaultEnabled'].includes(key))) throw new Error('Unknown annotationRuntime setting');
  if (typeof value.enabled !== 'boolean') throw new Error('annotationRuntime.enabled must be boolean');
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== 'boolean') throw new Error('annotationRuntime.defaultEnabled must be boolean');
  if (!value.enabled) return null;
  if (typeof value.directory !== 'string' || !/^\/[a-zA-Z0-9/_.-]+$/.test(value.directory) || value.directory.split('/').includes('..')) throw new Error('Invalid annotation runtime directory');
  if (!Array.isArray(value.parentOrigins) || !value.parentOrigins.length || value.parentOrigins.length > 32) throw new Error('Explicit annotation parentOrigins required');
  const origins = [...new Set(value.parentOrigins.map(parentOrigin))].sort();
  if (JSON.stringify(origins).length > 16384) throw new Error('Annotation parentOrigins exceeds SDK config bound');
  const directory = value.directory.replace(/\/+$/, '');
  if (!directory) throw new Error('Invalid annotation runtime directory');
  return { directory, origins, defaultEnabled: value.defaultEnabled === true };
}

export function validateAppAnnotations(app) {
  if (app.annotations !== undefined && typeof app.annotations !== 'boolean') throw new Error('Application annotations must be boolean');
}

// First encode JSON as HTML attribute text, then quote the complete directive
// for nginx. No variable expansion or executable inline configuration.
function nginxQuote(text) {
  return '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$') + '"';
}
export function runtimeScript(runtime) {
  const attr = JSON.stringify(runtime.origins).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;');
  return `<script src="${RUNTIME_URL}" data-catsco-parent-origins="${attr}"></script>`;
}

export function runtimeHttpConfig() {
  // Restrict to bounded, complete, ordinary HTML documents. Missing length
  // (chunked/streaming HTML), forced compression and no-transform fail closed.
  // Maps are evaluated at response-filter time when upstream headers exist.
  return `# Annotation injection: fixed upper bound ${MAX_HTML_BYTES} bytes, no buffering proxy.
map "$request_method:$http_sec_fetch_dest:$http_accept:$http_upgrade" $cag_annotation_document {
 default 0;
 "GET:::" 1;
 ~^GET:(?:document|iframe):.*:$ 1;
 ~*^GET::.*text/html.*:$ 1;
}
map $cag_annotation_document $cag_annotation_encoding { default $http_accept_encoding; 1 ""; }
map $cag_annotation_document $cag_annotation_etag { default $http_if_none_match; 1 ""; }
map $cag_annotation_document $cag_annotation_modified { default $http_if_modified_since; 1 ""; }
map $upstream_http_content_length $cag_annotation_bounded { default 0; "~^[1-9][0-9]{0,5}$" 1; }
map $upstream_http_content_type $cag_annotation_html { default 0; "~*^text/html(?:\\s*;\\s*charset=(?:utf-8|us-ascii))?\\s*$" 1; }
map $upstream_http_content_encoding $cag_annotation_plain { default 0; '' 1; ~*^identity$ 1; }
map $upstream_http_cache_control $cag_annotation_transform { default 1; ~*no-transform 0; }
map "$cag_annotation_document:$request_method:$status:$cag_annotation_bounded:$cag_annotation_html:$cag_annotation_plain:$cag_annotation_transform:$upstream_http_content_disposition:$http_range:$http_upgrade" $cag_annotation_eligible {
 default 0;
 "1:GET:200:1:1:1:1:::" 1;
}
map $cag_annotation_eligible $cag_annotation_head { default ""; 1 "</head>"; }
map $cag_annotation_eligible $cag_annotation_body { default ""; 1 "</body>"; }
`;
}

export function runtimeLocation(runtime) {
  // Keep the executable resource set explicit, independent of request/query or
  // manifest data. Renderer is loaded on demand by the canonical SDK.
  return [[RUNTIME_URL, RUNTIME_FILENAME], [RENDERER_URL, RENDERER_FILENAME]].map(([url, filename]) => `# Fixed vendored asset only. No user-selected path, upstream URL or token.
location = ${url} {
 alias ${runtime.directory}/${filename};
 types { } default_type application/javascript;
 limit_except GET { deny all; }
 gzip off;
 etag on;
 add_header Cache-Control "public, max-age=0, must-revalidate" always;
 add_header X-Content-Type-Options "nosniff" always;
 add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
 add_header Referrer-Policy "no-referrer" always;
}
`).join('') + 'location ^~ /_catsco/runtime/ { return 404; }\n';
}

export function runtimeAppConfig(runtime) {
  const tag = runtimeScript(runtime);
  return ` # Opt-in external runtime; upstream CSP headers remain untouched.
 proxy_set_header Accept-Encoding $cag_annotation_encoding;
 # Do not negotiate a 304 for a response whose bytes we may transform.
 proxy_set_header If-None-Match $cag_annotation_etag;
 proxy_set_header If-Modified-Since $cag_annotation_modified;
 proxy_hide_header Cache-Control;
 proxy_hide_header Expires;
 # Downstream nginx gzip (if configured) runs after substitution. Forced
 # upstream gzip is never searched/re-written by the empty filter map.
 # sub_filter_types defaults to text/html (adding it duplicates nginx's default).
 sub_filter_once on;
 sub_filter_last_modified off;
 # nginx cannot make the body fallback conditional on seeing a head. Both
 # markers are safe: the SDK's top-level singleton prevents double listeners.
 sub_filter $cag_annotation_head ${nginxQuote(tag + '</head>')};
 sub_filter $cag_annotation_body ${nginxQuote(tag + '</body>')};
`;
}
