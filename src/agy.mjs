import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const string = { type: 'string', minLength: 1 };
const pageSize = { type: 'integer', minimum: 1, maximum: 200 };
const timeout = { type: 'integer', minimum: 1, maximum: 2147483647 };
const definitions = [
  { name: 'agy_list_chats', description: 'Find chats through Antigravity CLI ACP. Use the returned sessionId and cwd to read or continue a chat. Pass nextCursor back for the next native page, if present.',
    inputSchema: { type: 'object', properties: { cwd: string, cursor: string }, additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'agy_read_chat', description: 'Read visible user and assistant text chunks from an Antigravity CLI chat. Use the sessionId and cwd from agy_list_chats, then follow nextOffset for more text.',
    inputSchema: { type: 'object', properties: { sessionId: string, cwd: string, offset: { type: 'integer', minimum: 0 }, limit: pageSize }, required: ['sessionId', 'cwd'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'agy_request', description: 'Continue a saved Antigravity CLI chat through ACP and wait for this turn’s visible reply. Use the sessionId and cwd from agy_list_chats and get user authorization for the destination and prompt. If delivery is unknown, check the chat before retrying.',
    inputSchema: { type: 'object', properties: { sessionId: string, cwd: string, prompt: string, timeoutMs: timeout }, required: ['sessionId', 'cwd', 'prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false } },
];

const problem = (code, message) => Object.assign(new Error(message), { code });

function checkArguments(name, args) {
  const schema = definitions.find(tool => tool.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw problem('INVALID_INPUT', 'Invalid agy tool or arguments');
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw problem('INVALID_INPUT', `${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!Object.hasOwn(schema.properties, key) || (rule.type === 'string' ? typeof value !== 'string' || !value.trim() :
      !Number.isSafeInteger(value) || value < rule.minimum || value > (rule.maximum ?? Number.MAX_SAFE_INTEGER))) {
      throw problem('INVALID_INPUT', `Invalid agy argument: ${key}`);
    }
  }
  if (args.cwd !== undefined && !path.isAbsolute(args.cwd)) throw problem('INVALID_INPUT', 'cwd must be an absolute path from agy');
}

function rpcProblem(error) {
  if (error.code === -32000 && /authenticat|sign in|log in/i.test(error.message ?? '')) {
    return problem('AGY_AUTH_REQUIRED', 'Sign in to Antigravity CLI with agy or agy acp --login, then reconnect');
  }
  if (error.code === -32002) return problem('AGY_SESSION_NOT_FOUND', 'agy cannot find this session. Use a sessionId and cwd from agy_list_chats');
  return problem('AGY_RPC_ERROR', `agy ACP rejected the request${Number.isSafeInteger(error.code) ? ` (${error.code})` : ''}`);
}

class AgyConnection {
  #child;
  #pending;
  #failure;
  #lastId = 0;
  #onUpdate;

  constructor(command, commandArgs, onUpdate) {
    this.#onUpdate = onUpdate;
    this.#child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.#receive(line));
    lines.once('close', () => this.fail(problem('AGY_PIPE_CLOSED', 'agy ACP closed its output')));
    this.#child.once('error', error => this.fail(error.code === 'ENOENT'
      ? problem('AGY_NOT_INSTALLED', 'agy was not found. Install Antigravity CLI and make agy available on PATH')
      : problem('AGY_START_FAILED', 'Could not start agy ACP')));
    this.#child.stdin.on('error', () => this.fail(problem('AGY_PIPE_CLOSED', 'Could not write to agy ACP')));
  }

  #send(message) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  #receive(line) {
    if (!line.trim() || this.#failure) return;
    let message;
    try { message = JSON.parse(line); } catch {
      this.fail(problem('AGY_INVALID_RESPONSE', 'agy ACP sent invalid JSON'));
      return;
    }
    if (message?.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (message.method === 'session/request_permission') {
          this.#send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        } else {
          this.#send({ id: message.id, error: { code: -32601, message: 'Unsupported ACP client method' } });
        }
      } else if (message.method === 'session/update') this.#onUpdate(message.params);
      return;
    }
    if (!this.#pending || message.id !== this.#pending.id) return;
    const waiting = this.#pending;
    this.#pending = undefined;
    if (message.error) waiting.reject(rpcProblem(message.error));
    else if (message.result && typeof message.result === 'object' && !Array.isArray(message.result)) waiting.resolve(message.result);
    else waiting.reject(problem('AGY_INVALID_RESPONSE', 'agy ACP returned an invalid result'));
  }

  request(method, params, onDispatch) {
    if (this.#failure) throw this.#failure;
    return new Promise((resolve, reject) => {
      const id = ++this.#lastId;
      this.#pending = { id, resolve, reject };
      onDispatch?.();
      this.#send({ id, method, params });
    });
  }

  fail(error, sessionId) {
    if (this.#failure) return;
    this.#failure = error;
    if (sessionId) this.#send({ method: 'session/cancel', params: { sessionId } });
    this.#pending?.reject(error);
    this.#pending = undefined;
  }

  async close() {
    const child = this.#child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      let killWait;
      const finish = () => { clearTimeout(grace); clearTimeout(killWait); child.off('exit', finish); resolve(); };
      const grace = setTimeout(() => {
        child.kill('SIGKILL');
        killWait = setTimeout(finish, 1000);
      }, 2000);
      child.once('exit', finish);
      // Closing stdin lets agy flush the saved conversation and shut down normally.
      child.stdin.end();
    });
  }
}

function cwdKey(value) {
  // agy can return an escaped file URL pathname such as /C:/My%20Project on Windows.
  if (process.platform === 'win32' && /^\/[a-z]:\//i.test(value)) {
    try { value = fileURLToPath('file://' + value); } catch { /* Keep unrecognized native paths intact. */ }
  }
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getText(params, sessionId) {
  const update = params?.update;
  if (params?.sessionId !== sessionId || update?.content?.type !== 'text' || typeof update.content.text !== 'string') return;
  if (update.sessionUpdate === 'user_message_chunk') return { role: 'user', text: update.content.text };
  if (update.sessionUpdate === 'agent_message_chunk') return { role: 'assistant', text: update.content.text };
}

async function callAgy(command, commandArgs, timeoutMs, name, args, signal) {
  const isRequest = name === 'agy_request';
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  const messages = [];
  const response = [];
  let observed = 0;
  let bytes = 0;
  let pageFull = false;
  let submitted = false;
  let client;
  let timer;
  const abort = () => client.fail(problem('AGY_CANCELLED', 'agy tool call was cancelled'), submitted ? args.sessionId : undefined);
  try {
    if (signal.aborted) throw problem('AGY_CANCELLED', 'agy tool call was cancelled');
    client = new AgyConnection(command, commandArgs, params => {
      const item = getText(params, args.sessionId);
      if (!item) return;
      if (isRequest && submitted && item.role === 'assistant') {
        bytes += Buffer.byteLength(item.text);
        if (bytes <= 2 * 1024 * 1024) response.push(item.text);
      } else if (name === 'agy_read_chat') {
        if (observed >= offset && messages.length < limit && !pageFull) {
          const size = Buffer.byteLength(item.text);
          if (bytes + size <= 2 * 1024 * 1024) { messages.push(item); bytes += size; }
          else if (messages.length === 0) client.fail(problem('AGY_HISTORY_CHUNK_TOO_LARGE', 'A single agy text chunk exceeds the bridge response size'));
          else pageFull = true;
        }
        observed++;
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => client.fail(problem('AGY_TIMEOUT', 'Timed out waiting for agy ACP'), submitted ? args.sessionId : undefined),
      isRequest ? args.timeoutMs ?? 120000 : timeoutMs);
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'c-c-chat-bridge', version: '0.3.0' } });
    if (init.protocolVersion !== 1) throw problem('AGY_UNSUPPORTED', 'agy does not support ACP protocol version 1');
    const capabilities = init.agentCapabilities ?? {};
    if (name === 'agy_list_chats') {
      if (!capabilities.sessionCapabilities?.list) throw problem('AGY_UNSUPPORTED', 'agy does not advertise ACP session/list');
      const { sessions, nextCursor } = await client.request('session/list', args);
      if (!Array.isArray(sessions)) throw problem('AGY_INVALID_RESPONSE', 'agy did not return a session list');
      const expectedCwd = args.cwd === undefined ? undefined : cwdKey(args.cwd);
      return { status: 'ok', sessions: expectedCwd === undefined ? sessions : sessions.filter(session =>
        typeof session?.cwd === 'string' && path.isAbsolute(session.cwd) && cwdKey(session.cwd) === expectedCwd), nextCursor: nextCursor ?? null };
    }
    const destination = { sessionId: args.sessionId, cwd: args.cwd, mcpServers: [] };
    if (!isRequest) {
      if (!capabilities.loadSession && !capabilities.sessionCapabilities?.load) throw problem('AGY_UNSUPPORTED', 'agy does not advertise ACP session/load');
      await client.request('session/load', destination);
      const nextOffset = offset + messages.length;
      return { status: 'read', sessionId: args.sessionId, messages, offset, nextOffset: nextOffset < observed ? nextOffset : null };
    }
    if (!capabilities.sessionCapabilities?.resume) throw problem('AGY_UNSUPPORTED', 'agy does not advertise ACP session/resume');
    await client.request('session/resume', destination);
    const prompt = [{ type: 'text', text: args.prompt }];
    const { stopReason } = await client.request('session/prompt', { sessionId: args.sessionId, prompt }, () => { submitted = true; });
    if (typeof stopReason !== 'string') throw problem('AGY_INVALID_RESPONSE', 'agy did not acknowledge how the prompt stopped');
    if (bytes > 2 * 1024 * 1024) {
      return { status: 'failed', delivery: 'stopped', sessionId: args.sessionId, stopReason, code: 'AGY_REPLY_TOO_LARGE', error: 'agy reply exceeds the bridge response size; read the chat to retrieve it' };
    }
    const text = response.join('');
    if (stopReason !== 'end_turn' || !text.trim()) {
      return { status: 'failed', delivery: 'stopped', sessionId: args.sessionId, stopReason, text,
        code: 'AGY_NO_COMPLETE_REPLY', error: 'agy stopped without a complete visible reply' };
    }
    return { status: 'completed', delivery: 'completed', sessionId: args.sessionId, stopReason, text };
  } catch (error) {
    return { status: submitted ? 'unknown' : 'failed', delivery: submitted ? 'unknown' : 'not_sent',
      ...(args.sessionId ? { sessionId: args.sessionId } : {}), code: error.code ?? 'AGY_UNAVAILABLE',
      error: error.code ? error.message : 'Could not use agy ACP' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await client?.close();
  }
}

export function createAgyChatProvider({ command = 'agy', commandArgs = ['acp'], timeoutMs = 30000 } = {}) {
  let closed = false;
  const pending = new Set();
  const sending = new Set();
  return {
    tools() { return structuredClone(definitions); },
    async call(name, args = {}, { signal } = {}) {
      const isRequest = name === 'agy_request';
      try {
        if (closed) throw problem('AGY_PROVIDER_CLOSED', 'agy chat provider is closed');
        checkArguments(name, args);
        if (isRequest && sending.has(args.sessionId)) throw problem('AGY_SESSION_BUSY', 'This bridge is already running a prompt in that agy chat');
      } catch (error) {
        return { status: 'failed', delivery: 'not_sent', code: error.code, error: error.message };
      }
      if (isRequest) sending.add(args.sessionId);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const job = { controller, task: callAgy(command, commandArgs, timeoutMs, name, args, controller.signal) };
      pending.add(job);
      try { return await job.task; }
      finally {
        pending.delete(job);
        if (isRequest) sending.delete(args.sessionId);
        signal?.removeEventListener('abort', abort);
      }
    },
    async close() {
      closed = true;
      for (const job of pending) job.controller.abort();
      await Promise.allSettled([...pending].map(job => job.task));
    },
  };
}
