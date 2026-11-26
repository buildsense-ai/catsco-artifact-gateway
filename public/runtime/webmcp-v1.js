/*
 * CatsCo gateway WebMCP runtime shim.
 *
 * Gateway injects a same-origin external script (no inline config/secrets):
 *   <script src="/_catsco/runtime/webmcp-v1.js"
 *     data-catsco-parent-origins='["https://app.catsco.cc"]'></script>
 *
 * The shim installs/wraps navigator.modelContext immediately on load so
 * Artifact pages can register WebMCP tools during boot, while dual-writing
 * to any pre-existing native browser navigator.modelContext. It waits for
 * the first allowlisted window.parent connect and bridges tools_sync,
 * tool_call, and tool_result exclusively over exact-origin postMessage.
 *
 * The shim never talks to the network, never reads cookies/tokens, and never
 * infers parent origins from document.referrer or URL parameters.
 */
(function initCatsCoWebMcp() {
  'use strict';

  var runtimeScript = document.currentScript;
  var originsAttribute = runtimeScript && runtimeScript.getAttribute('data-catsco-parent-origins');
  // Repeated head/body injection must not install another module or listener.
  if (window.CatsCoWebMcp && window.CatsCoWebMcp.runtimeVersion === 'webmcp-v1') {
    window.CatsCoWebMcp.bootstrapAttribute(originsAttribute);
    return;
  }

  var BRIDGE_CONTRACT = 'catsco.gateway-webmcp-bridge.v1';
  var TYPE_CONNECT = 'catsco.gateway.webmcp.connect.v1';
  var TYPE_READY = 'catsco.gateway.webmcp.ready.v1';
  var TYPE_TOOLS_SYNC = 'catsco.gateway.webmcp.tools_sync.v1';
  var TYPE_TOOL_CALL = 'catsco.gateway.webmcp.tool_call.v1';
  var TYPE_TOOL_RESULT = 'catsco.gateway.webmcp.tool_result.v1';
  var TYPE_PING = 'catsco.gateway.webmcp.ping.v1';
  var TYPE_PONG = 'catsco.gateway.webmcp.pong.v1';

  var CAPABILITIES = ['registerTool', 'unregisterTool', 'provideContext', 'clearContext'];
  var MAX_TOOLS = 64;
  var MAX_ID_CHARS = 128;
  var MAX_DESCRIPTION_CHARS = 1024;
  var MAX_ERROR_MESSAGE_CHARS = 512;
  var MAX_TOOL_NAME_ECHO_CHARS = 128;
  // Aligned across gateway shim, CatsCo webapp host, and CatsCo Hub (64 KiB WS read limit).
  var MAX_RESULT_JSON_BYTES = 48 * 1024;
  var TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
  var CONTROL_FORBIDDEN = /[\u0000-\u001f\u007f]/;
  var textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function utf8ByteLength(str) {
    if (typeof str !== 'string') return 0;
    if (textEncoder) return textEncoder.encode(str).length;
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function truncateText(value, maxChars) {
    var str = typeof value === 'string' ? value : String(value);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars - 3) + '...';
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function exactOrigin(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return null;
    try {
      var url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : null;
    } catch (error) {
      return null;
    }
  }

  function handshakeId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
      && !CONTROL_FORBIDDEN.test(value) ? value : null;
  }

  function validConnect(payload) {
    return isPlainObject(payload)
      && payload.contract_version === BRIDGE_CONTRACT
      && payload.type === TYPE_CONNECT
      && handshakeId(payload.session_id)
      && handshakeId(payload.request_id);
  }

  function cloneJsonSafe(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return undefined;
    }
  }

  function normalizeSchema(schema) {
    if (schema === undefined || schema === null) {
      return { type: 'object', properties: {} };
    }
    var cloned = cloneJsonSafe(schema);
    if (!isPlainObject(cloned)) {
      return { type: 'object', properties: {} };
    }
    return cloned;
  }

  function normalizeAnnotations(annotations) {
    if (!isPlainObject(annotations)) return undefined;
    var out = {};
    if (typeof annotations.title === 'string') out.title = annotations.title.slice(0, 128);
    if (typeof annotations.readOnlyHint === 'boolean') out.readOnlyHint = annotations.readOnlyHint;
    if (typeof annotations.destructiveHint === 'boolean') out.destructiveHint = annotations.destructiveHint;
    if (typeof annotations.idempotentHint === 'boolean') out.idempotentHint = annotations.idempotentHint;
    if (typeof annotations.openWorldHint === 'boolean') out.openWorldHint = annotations.openWorldHint;
    return Object.keys(out).length ? out : undefined;
  }

  function normalizeToolEntry(arg1, arg2, arg3, arg4) {
    var raw = isPlainObject(arg1)
      ? arg1
      : { name: arg1, description: arg2, inputSchema: arg3, execute: arg4 };
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error('Invalid WebMCP tool name: ' + String(raw.name));
    }
    var execute = typeof raw.execute === 'function' ? raw.execute : null;
    if (!execute) {
      throw new Error('WebMCP tool "' + name + '" requires an execute function');
    }
    var description = typeof raw.description === 'string'
      ? raw.description.slice(0, MAX_DESCRIPTION_CHARS)
      : '';
    var entry = {
      name: name,
      description: description,
      inputSchema: normalizeSchema(raw.inputSchema),
      execute: execute,
    };
    var annotations = normalizeAnnotations(raw.annotations);
    if (annotations) entry.annotations = annotations;
    return entry;
  }

  function serializeDescriptor(entry) {
    var desc = {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    };
    if (entry.annotations) desc.annotations = entry.annotations;
    return desc;
  }

  function formatToolResult(value) {
    if (isPlainObject(value) && Array.isArray(value.content)) {
      var safeContent = cloneJsonSafe(value.content);
      var out = {
        is_error: value.isError === true,
        content: Array.isArray(safeContent) ? safeContent : [{ type: 'text', text: '' }],
      };
      if (isPlainObject(value.structuredContent)) {
        var safeStructured = cloneJsonSafe(value.structuredContent);
        if (isPlainObject(safeStructured)) out.structured_content = safeStructured;
      }
      return enforceResultBound(out);
    }
    if (typeof value === 'string') {
      return enforceResultBound({
        is_error: false,
        content: [{ type: 'text', text: value }],
      });
    }
    if (value === undefined || value === null) {
      return {
        is_error: false,
        content: [{ type: 'text', text: '' }],
      };
    }
    var cloned = cloneJsonSafe(value);
    if (cloned === undefined) {
      return {
        is_error: false,
        content: [{ type: 'text', text: String(value) }],
      };
    }
    var res = {
      is_error: false,
      content: [{ type: 'text', text: JSON.stringify(cloned) }],
    };
    if (isPlainObject(cloned)) res.structured_content = cloned;
    return enforceResultBound(res);
  }

  function enforceResultBound(result) {
    try {
      var serialized = JSON.stringify(result);
      if (utf8ByteLength(serialized) <= MAX_RESULT_JSON_BYTES) return result;
    } catch (error) {
      // fall through to structured error
    }
    return {
      is_error: true,
      content: [{ type: 'text', text: 'Tool result exceeds maximum payload size (' + MAX_RESULT_JSON_BYTES + ' bytes)' }],
      error: { code: 'result_too_large', message: 'Tool result exceeds maximum payload size (' + MAX_RESULT_JSON_BYTES + ' bytes)' },
    };
  }

  // Tool registry shared by navigator.modelContext and the parent bridge.
  var tools = new Map();
  var nativeModelContext = null;
  var shimInstalled = false;

  function listDescriptorsBounded() {
    var all = [];
    tools.forEach(function (entry) {
      all.push(serializeDescriptor(entry));
    });
    try {
      if (utf8ByteLength(JSON.stringify(all)) <= MAX_RESULT_JSON_BYTES) {
        return { tools: all, truncated: false };
      }
    } catch (error) {
      return { tools: [], truncated: all.length > 0 };
    }
    var fitted = [];
    for (var i = 0; i < all.length; i++) {
      fitted.push(all[i]);
      try {
        if (utf8ByteLength(JSON.stringify(fitted)) > MAX_RESULT_JSON_BYTES) {
          fitted.pop();
          break;
        }
      } catch (error) {
        fitted.pop();
        break;
      }
    }
    return { tools: fitted, truncated: fitted.length < all.length };
  }

  function listDescriptors() {
    return listDescriptorsBounded().tools;
  }

  function notifyToolsChanged() {
    var bounded = listDescriptorsBounded();
    liveInstances.forEach(function (state) {
      if (state.connected && state.sessionId) {
        var msg = {
          contract_version: BRIDGE_CONTRACT,
          type: TYPE_TOOLS_SYNC,
          session_id: state.sessionId,
          tools: bounded.tools,
        };
        if (bounded.truncated) msg.tools_truncated = true;
        state.post(msg);
      }
    });
  }

  function callNative(method, args) {
    if (!nativeModelContext || typeof nativeModelContext[method] !== 'function') return;
    try {
      nativeModelContext[method].apply(nativeModelContext, args);
    } catch (error) {
      // Never let native browser WebMCP errors break the CatsCo shim.
    }
  }

  function installModelContextShim() {
    if (shimInstalled) return;
    shimInstalled = true;
    var nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav) return;

    var existing = null;
    try { existing = nav.modelContext; } catch (error) { existing = null; }
    if (existing && typeof existing === 'object' && !existing.__catscoWebMcpShim) {
      nativeModelContext = existing;
    }

    var modelContext = {
      __catscoWebMcpShim: true,
      registerTool: function registerTool(arg1, arg2, arg3, arg4) {
        var entry = normalizeToolEntry(arg1, arg2, arg3, arg4);
        if (!tools.has(entry.name) && tools.size >= MAX_TOOLS) {
          throw new Error('Maximum WebMCP tools limit (' + MAX_TOOLS + ') reached');
        }
        tools.set(entry.name, entry);
        callNative('registerTool', arguments);
        notifyToolsChanged();
      },
      unregisterTool: function unregisterTool(name) {
        var key = typeof name === 'string' ? name.trim() : '';
        var removed = tools.delete(key);
        callNative('unregisterTool', arguments);
        if (removed) notifyToolsChanged();
        return removed;
      },
      provideContext: function provideContext(options) {
        var list = options && Array.isArray(options.tools) ? options.tools : [];
        var next = new Map();
        for (var i = 0; i < list.length; i++) {
          var entry = normalizeToolEntry(list[i]);
          if (!next.has(entry.name) && next.size >= MAX_TOOLS) {
            throw new Error('Maximum WebMCP tools limit (' + MAX_TOOLS + ') reached');
          }
          next.set(entry.name, entry);
        }
        tools = next;
        callNative('provideContext', arguments);
        notifyToolsChanged();
      },
      clearContext: function clearContext() {
        var had = tools.size > 0;
        tools.clear();
        callNative('clearContext', arguments);
        if (had) notifyToolsChanged();
      },
    };

    try {
      Object.defineProperty(nav, 'modelContext', {
        value: modelContext,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      try { nav.modelContext = modelContext; } catch (ignore) {}
    }
  }

  var liveInstances = new Map();
  var automaticOrigins = null; // immutable once configured; never infer from URL/referrer
  var singleton = null;
  var bootstrapListening = false;
  var bootstrapStopped = false;

  function stopBootstrap() {
    window.removeEventListener('message', onBootstrapConnect);
    bootstrapListening = false;
  }

  function onBootstrapConnect(event) {
    if (!automaticOrigins || window.parent === window || event.source !== window.parent
      || automaticOrigins.indexOf(event.origin) < 0 || !validConnect(event.data)) return;
    var instance = createConfigured({ parentOrigin: event.origin });
    if (instance) {
      liveInstances.get(instance).onMessage(event);
    }
  }

  function bootstrapAttribute(attribute) {
    if (typeof attribute !== 'string' || attribute.length > 16384) return false;
    var origins;
    try { origins = JSON.parse(attribute); } catch (error) { return false; }
    if (!Array.isArray(origins) || !origins.length || origins.length > 32
      || origins.some(function (origin) { return !exactOrigin(origin); })) return false;
    origins = Array.from(new Set(origins)).sort();
    if (!automaticOrigins) automaticOrigins = origins;
    if (!bootstrapStopped && !singleton && !bootstrapListening && window.parent !== window) {
      window.addEventListener('message', onBootstrapConnect);
      bootstrapListening = true;
    }
    return true;
  }

  function createConfigured(options) {
    var targetOrigin = exactOrigin(options && options.parentOrigin);
    if (!targetOrigin) throw new Error('Explicit exact parentOrigin is required');
    if (singleton && liveInstances.has(singleton)) return singleton;
    stopBootstrap();

    var state = {
      parentOrigin: targetOrigin,
      connected: false,
      sessionId: null,
      disposed: false,
      post: function post(message) {
        if (state.disposed || window.parent === window) return;
        try {
          window.parent.postMessage(message, state.parentOrigin);
        } catch (error) {
          // Host detached or origin mismatch.
        }
      },
      onMessage: function onMessage(event) {
        if (state.disposed) return;
        if (window.parent === window || event.source !== window.parent) return;
        if (event.origin !== state.parentOrigin) return;
        var data = event.data;
        if (!isPlainObject(data) || data.contract_version !== BRIDGE_CONTRACT) return;

        if (data.type === TYPE_CONNECT) {
          if (!validConnect(data)) return;
          state.connected = true;
          state.sessionId = data.session_id;
          var bounded = listDescriptorsBounded();
          var readyMsg = {
            contract_version: BRIDGE_CONTRACT,
            type: TYPE_READY,
            session_id: data.session_id,
            request_id: data.request_id,
            runtime_version: 'webmcp-v1',
            capabilities: CAPABILITIES.slice(),
            tools: bounded.tools,
          };
          if (bounded.truncated) readyMsg.tools_truncated = true;
          state.post(readyMsg);
          return;
        }

        if (!state.connected || data.session_id !== state.sessionId) return;

        if (data.type === TYPE_PING) {
          var pingId = handshakeId(data.request_id);
          state.post({
            contract_version: BRIDGE_CONTRACT,
            type: TYPE_PONG,
            session_id: state.sessionId,
            request_id: pingId || undefined,
          });
          return;
        }

        if (data.type === TYPE_TOOL_CALL) {
          var callId = handshakeId(data.call_id);
          var callSessionId = state.sessionId;
          var toolName = typeof data.name === 'string' ? data.name.trim() : '';
          if (!callId || !toolName) return;
          var entry = tools.get(toolName);
          if (!entry) {
            var notFoundMsg = 'WebMCP tool not found: ' + truncateText(toolName, MAX_TOOL_NAME_ECHO_CHARS);
            state.post({
              contract_version: BRIDGE_CONTRACT,
              type: TYPE_TOOL_RESULT,
              session_id: callSessionId,
              call_id: callId,
              is_error: true,
              content: [{ type: 'text', text: notFoundMsg }],
              error: { code: 'tool_not_found', message: notFoundMsg },
            });
            return;
          }
          var args = isPlainObject(data.arguments) ? data.arguments : {};
          var context = {
            callId: callId,
            sessionId: callSessionId,
            toolName: toolName,
          };
          Promise.resolve().then(function () {
            return entry.execute(args, context);
          }).then(function (result) {
            if (state.disposed || state.sessionId !== callSessionId) return;
            var formatted = formatToolResult(result);
            var reply = {
              contract_version: BRIDGE_CONTRACT,
              type: TYPE_TOOL_RESULT,
              session_id: callSessionId,
              call_id: callId,
              is_error: formatted.is_error,
              content: formatted.content,
            };
            if (formatted.structured_content) reply.structured_content = formatted.structured_content;
            if (formatted.error) reply.error = formatted.error;
            state.post(reply);
          }, function (err) {
            if (state.disposed || state.sessionId !== callSessionId) return;
            var rawMsg = err && typeof err.message === 'string' ? err.message : String(err);
            var msg = truncateText(rawMsg, MAX_ERROR_MESSAGE_CHARS);
            state.post({
              contract_version: BRIDGE_CONTRACT,
              type: TYPE_TOOL_RESULT,
              session_id: callSessionId,
              call_id: callId,
              is_error: true,
              content: [{ type: 'text', text: msg }],
              error: { code: 'tool_execution_error', message: msg },
            });
          });
        }
      },
    };

    var instance = {
      runtimeVersion: 'webmcp-v1',
      getTools: listDescriptors,
      dispose: function dispose() {
        if (state.disposed) return;
        state.disposed = true;
        window.removeEventListener('message', state.onMessage);
        liveInstances.delete(instance);
        if (singleton === instance) {
          singleton = null;
          bootstrapStopped = true;
        }
      },
    };

    liveInstances.set(instance, state);
    singleton = instance;
    window.addEventListener('message', state.onMessage);
    return instance;
  }

  installModelContextShim();

  window.CatsCoWebMcp = {
    runtimeVersion: 'webmcp-v1',
    bridgeContract: BRIDGE_CONTRACT,
    bootstrapAttribute: bootstrapAttribute,
    create: function create(options) {
      bootstrapStopped = false;
      return createConfigured(options);
    },
    getTools: listDescriptors,
  };

  if (originsAttribute) {
    bootstrapAttribute(originsAttribute);
  }
})();
