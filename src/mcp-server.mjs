#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { CodexAdapter } from './codex.mjs';
import { dispatchAndWait } from './result-relay.mjs';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Seeing tools is not authorization for arbitrary mutations. Only explicitly requested chat sends are exposed.
const READ_ONLY = new Set(['list_threads', 'list_archived_threads', 'read_thread', 'wait_threads']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 1 };
const emptySchema = { type: 'object', additionalProperties: false };
const requestSchema = { type: 'object', properties: {
  threadId: string, hostId: string, prompt: string, timeoutMs: integer, pollMs: { ...integer, maximum: 2147483647 },
}, required: ['prompt'], additionalProperties: false };
class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// Native schemas remain authoritative. Native calls also validate all arguments; this catches common mistakes locally.
function validate(value, expected, path = 'arguments') {
  if (expected.type === 'object') {
    if (!object(value)) throw new Error(path + ' must be an object');
    for (const key of expected.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(path + '.' + key + ' is required');
    for (const [key, item] of Object.entries(value)) {
      const child = expected.properties?.[key];
      if (!child && expected.additionalProperties === false) throw new Error('Unknown argument: ' + key);
      if (child) validate(item, child, path + '.' + key);
    }
  } else if (expected.type === 'string' && (typeof value !== 'string' || (expected.minLength > 0 && !value.trim()))) {
    throw new Error(path + ' must be a non-empty string');
  } else if (expected.type === 'integer' && (!Number.isSafeInteger(value) ||
    (expected.minimum !== undefined && value < expected.minimum) ||
    (expected.maximum !== undefined && value > expected.maximum))) {
    throw new Error(path + ' is outside its integer range');
  } else if (expected.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(path + ' must be boolean');
  }
  if (expected.enum && !expected.enum.includes(value)) throw new Error(path + ' is not an allowed value');
}
export function mcpResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function failure(error) {
  const delivery = error.delivery ?? 'not_sent';
  return mcpResult({ status: ['not_sent', 'failed'].includes(delivery) ? 'failed' : 'unknown',
    delivery, code: error.code ?? 'INVALID_INPUT', error: error.message,
    ...(error.observed ? { observed: error.observed } : {}) }, true);
}
export async function loadMcpConfig(argv, env = process.env) {
  const options = {};
  const allowed = ['owner-thread', 'pipe', 'config', 'timeout-ms', 'target-thread', 'host-id', 'result-timeout-ms', 'poll-ms'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || argv[i + 1] === undefined ||
        argv[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid MCP startup option');
    options[key] = argv[i + 1];
  }
  const stored = options.config ? JSON.parse((await readFile(options.config, 'utf8')).replace(/^\uFEFF/, '')) : {};
  if (!object(stored)) throw new Error('MCP config must be an object');
  const config = {
    ownerThreadId: options['owner-thread'] ?? stored.codexOwnerThreadId ?? env.CODEX_OWNER_THREAD_ID,
    pipePath: options.pipe ?? stored.codexPipePath ?? env.CODEX_APP_TOOLS_PIPE_PATH,
    targetThreadId: options['target-thread'] ?? stored.codexTargetThreadId,
    targetHostId: options['host-id'] ?? stored.codexTargetHostId,
    timeoutMs: Number(options['timeout-ms'] ?? stored.timeoutMs ?? 30000),
    resultTimeoutMs: Number(options['result-timeout-ms'] ?? stored.resultTimeoutMs ?? 600000),
    pollMs: Number(options['poll-ms'] ?? stored.resultPollMs ?? 2000),
  };
  validate(config.ownerThreadId, string, 'owner-thread');
  validate(config.pipePath, string, 'pipe');
  for (const key of ['targetThreadId', 'targetHostId']) if (config[key] !== undefined) validate(config[key], string, key);
  for (const key of ['timeoutMs', 'resultTimeoutMs', 'pollMs']) validate(config[key], integer, key);
  for (const key of ['timeoutMs', 'pollMs']) validate(config[key], { ...integer, maximum: 2147483647 }, key);
  return config;
}
// Providers contribute { tools(): Promise<Tool[]>, call(name,args): Promise<JSON object>, close?() }.
// The executable loads the Claude cross-chat provider; tests and embedded consumers may inject providers.
export async function serveMcp(config, { input = process.stdin, output = process.stdout, providers = [] } = {}) {
  const codex = new CodexAdapter(config);
  let phase = 'new';
  let catalog;
  const targetQueues = new Map();
  const active = new Map();
  const pending = new Set();
  const send = value => output.write(JSON.stringify(value) + '\n');
  const nativeCatalog = () => {
    catalog ??= codex.listTools().catch(error => {
      catalog = undefined;
      if (['PIPE_ERROR', 'PIPE_CLOSED', 'TIMEOUT'].includes(error.code)) {
        throw new RpcError(-32603, 'Cannot connect to Codex. Update the current Codex pipe in your bridge configuration, then reconnect c-c-chat-bridge.');
      }
      throw error;
    });
    return catalog;
  };
  async function tools() {
    const native = (await nativeCatalog()).tools;
    const exposed = native.filter(tool => READ_ONLY.has(tool.name) || tool.name === 'send_message_to_thread')
      .map(tool => ({
        name: 'codex_' + tool.name,
        description: tool.description + (tool.name === 'send_message_to_thread'
          ? '\nRequires user authorization to message this chat. Accepted means dispatched; read the chat to confirm its reply.'
          : '\nUse the native host IDs and cursors as returned. Visibility follows the Codex source chat.'),
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: READ_ONLY.has(tool.name) },
      }));
    if (native.some(tool => tool.name === 'send_message_to_thread') && native.some(tool => tool.name === 'read_thread')) {
      exposed.push({ name: 'codex_request',
        description: 'Ask a Codex chat to do a user-authorized task and wait for its full final answer. Use a threadId and hostId from codex_list_threads, or omit them to use configured defaults. An unconfirmed result is unknown; check the chat before retrying.',
        inputSchema: requestSchema, annotations: { readOnlyHint: false } });
    }
    for (const provider of providers) for (const tool of await provider.tools()) {
      if (exposed.some(existing => existing.name === tool.name)) throw new Error('Duplicate provider tool');
      exposed.push(tool);
    }
    return exposed;
  }
  function queued(key, action) {
    const next = (targetQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    targetQueues.set(key, next);
    next.finally(() => { if (targetQueues.get(key) === next) targetQueues.delete(key); }).catch(() => {});
    return next;
  }
  async function call(params, cancellation) {
    if (!object(params) || typeof params.name !== 'string' ||
        (params.arguments !== undefined && !object(params.arguments))) throw new RpcError(-32602, 'Invalid tools/call parameters');
    const tool = (await tools()).find(tool => tool.name === params.name);
    if (!tool) throw new RpcError(-32602, 'Unknown tool: ' + params.name);
    const args = { ...(params.arguments ?? {}) };
    try {
      validate(args, tool.inputSchema);
      if (!params.name.startsWith('codex_')) {
        for (const provider of providers) if ((await provider.tools()).some(item => item.name === params.name)) {
          if (params.name === 'claude_send_message') {
            args.message = '[跨模型橋接工作｜外部 MCP｜來源 Codex owner ' + config.ownerThreadId + '｜訊息 ' + randomUUID() + ']\n' + args.message;
          }
          const value = await provider.call(params.name, args);
          return mcpResult(value, ['failed', 'unknown'].includes(value?.status));
        }
        throw new Error('Provider unavailable');
      }
      const nativeName = params.name.slice('codex_'.length);
      if (READ_ONLY.has(nativeName)) return mcpResult(await codex.callTool(nativeName, args));
      const threadId = args.threadId ?? config.targetThreadId;
      const hostId = args.hostId ?? config.targetHostId;
      validate(threadId, string, 'threadId (or configured target)');
      validate(args.prompt, string, 'prompt');
      const msgId = randomUUID();
      const marker = '[跨模型橋接工作｜外部 MCP｜來源 Codex owner ' + config.ownerThreadId + '｜訊息 ' + msgId + ']';
      const prompt = marker + '\n' + args.prompt;
      return await queued(JSON.stringify([hostId ?? null, threadId]), async () => {
        const check = () => { if (cancellation.signal.aborted) throw Object.assign(new Error('MCP request cancelled; no automatic resend'), { code: 'REQUEST_CANCELLED' }); };
        check();
        if (params.name === 'codex_send_message_to_thread') {
          const native = await codex.callTool('send_message_to_thread', { ...args, threadId, ...(hostId === undefined ? {} : { hostId }), prompt });
          return mcpResult({ status: 'accepted', msgId, threadId, ...(hostId === undefined ? {} : { hostId }), native });
        }
        const guarded = {
          readThread: args => { check(); return codex.readThread(args); },
          sendMessage: args => { check(); return codex.sendMessage(args); },
        };
        const completed = await dispatchAndWait({ codex: guarded, threadId, hostId, prompt, marker,
          timeoutMs: args.timeoutMs ?? config.resultTimeoutMs, pollMs: args.pollMs ?? config.pollMs,
          sleep: ms => pause(ms, undefined, { signal: cancellation.signal }) });
        return mcpResult({ ...completed, msgId, threadId, ...(hostId === undefined ? {} : { hostId }) });
      });
    } catch (error) { return failure(error); }
  }
  async function handle(message) {
    const hasId = object(message) && Object.hasOwn(message, 'id');
    const validId = hasId && (typeof message.id === 'string' || Number.isSafeInteger(message.id));
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (hasId && !validId) || (message.params !== undefined && !object(message.params))) {
      send({ jsonrpc: '2.0', id: validId ? message.id : null, error: { code: -32600, message: 'Invalid JSON-RPC request' } }); return;
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      if (message.method === 'notifications/cancelled') active.get(message.params?.requestId)?.abort();
      return;
    }
    if (active.has(message.id)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Request ID is already in use' } }); return;
    }
    const cancellation = new AbortController();
    active.set(message.id, cancellation);
    try {
      let value;
      if (message.method === 'initialize') {
        if (phase !== 'new') throw new RpcError(-32600, 'Already initialized');
        if (typeof message.params?.protocolVersion !== 'string' || !object(message.params?.capabilities) ||
            !object(message.params?.clientInfo) || typeof message.params.clientInfo.name !== 'string' ||
            typeof message.params.clientInfo.version !== 'string') throw new RpcError(-32602, 'Invalid initialize parameters');
        phase = 'initializing';
        value = { protocolVersion: VERSIONS.includes(message.params.protocolVersion) ? message.params.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'c-c-chat-bridge', version: '0.2.2' },
          instructions: 'Local owner-scoped tools. External MCP messages are attributed and sends require user authorization. Native chat visibility and host limitations apply.' };
      } else if (message.method === 'ping') value = {};
      else {
        if (phase !== 'ready') throw new RpcError(-32000, 'Initialize and notify initialized before using tools');
        if (message.method === 'tools/list') {
          if (message.params?.cursor !== undefined) throw new RpcError(-32602, 'This tool catalog has no additional pages');
          value = { tools: await tools() };
        } else if (message.method === 'tools/call') value = await call(message.params, cancellation);
        else throw new RpcError(-32601, 'Method not found');
      }
      if (!cancellation.signal.aborted) send({ jsonrpc: '2.0', id: message.id, result: value });
    } catch (error) {
      if (!cancellation.signal.aborted) send({ jsonrpc: '2.0', id: message.id,
        error: error instanceof RpcError ? { code: error.code, message: error.message }
          : { code: -32603, message: 'Native or provider tool catalog unavailable' } });
    } finally { active.delete(message.id); }
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try {
      if (Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024) throw new Error();
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON message' } }); return;
    }
    const task = handle(message);
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  await new Promise(resolve => lines.once('close', resolve));
  for (const cancellation of active.values()) cancellation.abort();
  codex.close();
  // Provider calls may still be creating their own callback receiver. Drain them before cleanup.
  await Promise.allSettled(pending);
  for (const provider of providers) await provider.close?.();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { createClaudeChatProvider } = await import('./claude-chats.mjs');
    await serveMcp(await loadMcpConfig(process.argv.slice(2)), { providers: [createClaudeChatProvider()] });
  }
  catch { process.stderr.write('MCP_STARTUP_FAILED: check explicit owner, native pipe, and config options.\n'); process.exitCode = 1; }
}
