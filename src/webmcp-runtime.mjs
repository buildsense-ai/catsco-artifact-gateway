// Configuration-only integration for the WebMCP browser runtime shim.
// HTML is still served by the existing nginx application proxy; the control
// plane never sees or rewrites app documents, and the gateway never holds
// conversation tokens or open_ref bindings.
export const WEBMCP_RUNTIME_URL = '/_catsco/runtime/webmcp-v1.js';
export const WEBMCP_RUNTIME_FILENAME = 'webmcp-v1.js';

function parentOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid webmcp parent origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid webmcp parent origin'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      !/^[a-zA-Z0-9:/.\[\]-]+$/.test(value)) throw new Error('Invalid webmcp parent origin');
  return value;
}

export function webmcpRuntime(config) {
  const value = config.webmcpRuntime;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid webmcpRuntime');
  if (Object.keys(value).some(key => !['enabled', 'directory', 'parentOrigins', 'defaultEnabled'].includes(key))) {
    throw new Error('Unknown webmcpRuntime setting');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('webmcpRuntime.enabled must be boolean');
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== 'boolean') {
    throw new Error('webmcpRuntime.defaultEnabled must be boolean');
  }
  if (!value.enabled) return null;
  if (typeof value.directory !== 'string' || !/^\/[a-zA-Z0-9/_.-]+$/.test(value.directory) || value.directory.split('/').includes('..')) {
    throw new Error('Invalid webmcp runtime directory');
  }
  if (!Array.isArray(value.parentOrigins) || !value.parentOrigins.length || value.parentOrigins.length > 32) {
    throw new Error('Explicit webmcp parentOrigins required');
  }
  const origins = [...new Set(value.parentOrigins.map(parentOrigin))].sort();
  if (JSON.stringify(origins).length > 16384) throw new Error('WebMCP parentOrigins exceeds SDK config bound');
  const directory = value.directory.replace(/\/+$/, '');
  if (!directory) throw new Error('Invalid webmcp runtime directory');
  return { directory, origins, defaultEnabled: value.defaultEnabled === true };
}

export function validateAppWebMcp(app) {
  if (app.webmcp !== undefined && typeof app.webmcp !== 'boolean') {
    throw new Error('Application webmcp must be boolean');
  }
}

export function webmcpRuntimeScript(runtime) {
  const attr = JSON.stringify(runtime.origins)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
  return `<script src="${WEBMCP_RUNTIME_URL}" data-catsco-parent-origins="${attr}"></script>`;
}

export function webmcpRuntimeAssetLocation(runtime) {
  return `# Fixed vendored asset only. No user-selected path, upstream URL or token.
location = ${WEBMCP_RUNTIME_URL} {
 alias ${runtime.directory}/${WEBMCP_RUNTIME_FILENAME};
 types { } default_type application/javascript;
 limit_except GET { deny all; }
 gzip off;
 etag on;
 add_header Cache-Control "public, max-age=0, must-revalidate" always;
 add_header X-Content-Type-Options "nosniff" always;
 add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
 add_header Referrer-Policy "no-referrer" always;
}
`;
}

export function webmcpRuntimeLocation(runtime) {
  return webmcpRuntimeAssetLocation(runtime) + 'location ^~ /_catsco/runtime/ { return 404; }\n';
}
