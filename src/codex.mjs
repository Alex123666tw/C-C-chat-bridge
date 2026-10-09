import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class CodexTransportError extends Error {
  constructor(message, { code = 'CODEX_TRANSPORT_ERROR', delivery = 'not_sent', cause } = {}) {
    super(message, { cause });
    this.name = 'CodexTransportError';
    this.code = code;
    this.delivery = delivery;
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexTransportError(`${name} must be a non-empty string`, { code: 'INVALID_INPUT' });
  }
  return value;
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new CodexTransportError('Request exceeds the native 8 MiB frame limit', { code: 'FRAME_TOO_LARGE' });
  }
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

// Each RPC owns one connection: an uncertain request is never retried automatically.
export class NativePipeClient {
  constructor(pipePath, { timeoutMs = 30000 } = {}) {
    this.pipePath = requiredString(pipePath, 'pipePath');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new CodexTransportError('timeoutMs must be an integer from 1 to 2147483647', { code: 'INVALID_INPUT' });
    }
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.active = new Set();
    this.closed = false;
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new CodexTransportError('Pipe client is closed'));
    requiredString(method, 'method');
    const id = this.nextId++;
    const frame = encodeFrame({ id, jsonrpc: '2.0', method, params });
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      let pending = Buffer.alloc(0);
      const socket = net.createConnection(this.pipePath);
      this.active.add(socket);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(socket);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const fail = (message, code, cause) => finish(new CodexTransportError(message, {
        code, delivery: sent ? 'unknown' : 'not_sent', cause,
      }));
      const timer = setTimeout(() => fail(
        sent ? 'Native request timed out; delivery is unknown. Do not resend without checking the destination.'
             : 'Timed out before sending the native request',
        'TIMEOUT',
      ), this.timeoutMs);
      socket.once('connect', () => {
        sent = true;
        socket.write(frame, error => { if (error) fail('Unable to write native request', 'PIPE_WRITE', error); });
      });
      socket.on('error', error => fail(error.message, 'PIPE_ERROR', error));
      socket.once('close', () => fail('Native pipe closed before a response; delivery is not confirmed', 'PIPE_CLOSED'));
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (!settled && pending.length >= 4) {
          const size = pending.readUInt32LE(0);
          if (size > MAX_FRAME_BYTES || size === 0) {
            fail('Native response has an invalid frame size', 'INVALID_RESPONSE');
            return;
          }
          if (pending.length < size + 4) return;
          let response;
          try { response = JSON.parse(pending.subarray(4, size + 4).toString('utf8')); }
          catch (error) { fail('Native response is not valid JSON', 'INVALID_RESPONSE', error); return; }
          pending = pending.subarray(size + 4);
          if (response?.jsonrpc !== '2.0' || (typeof response.id !== 'number' && typeof response.id !== 'string')) {
            fail('Native response is not a JSON-RPC 2.0 response', 'INVALID_RESPONSE');
            return;
          }
          if (String(response.id) !== String(id)) continue;
          if (Object.hasOwn(response, 'error') && Object.hasOwn(response, 'result')) {
            fail('Native RPC response has both result and error', 'INVALID_RESPONSE');
            return;
          }
          if (Object.hasOwn(response, 'error')) {
            if (typeof response.error?.code !== 'number' || typeof response.error?.message !== 'string') {
              fail('Native RPC error response is invalid', 'INVALID_RESPONSE');
              return;
            }
            finish(new CodexTransportError(response.error.message, { code: response.error.code, delivery: 'failed' }));
          } else if (Object.hasOwn(response, 'result')) {
            finish(null, response.result);
          } else {
            fail('Native RPC response has no result or error', 'INVALID_RESPONSE');
          }
        }
      });
    });
  }

  close() {
    this.closed = true;
    for (const socket of this.active) socket.destroy();
  }
}

export class CodexAdapter {
  constructor({ pipePath, ownerThreadId, turnId, timeoutMs = 30000 } = {}) {
    this.ownerThreadId = requiredString(ownerThreadId, 'ownerThreadId (the authorized source chat)');
    if (turnId !== undefined) requiredString(turnId, 'turnId');
    this.turnId = turnId;
    this.client = new NativePipeClient(pipePath, { timeoutMs });
    this.tools = null;
  }

  async listTools() {
    const result = await this.client.request('tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(result?.tools) || result.tools.some(tool =>
      typeof tool?.name !== 'string' || !tool.name.trim() ||
      typeof tool?.namespace !== 'string' || !tool.namespace.trim()
    ) || new Set(result.tools.map(tool => tool.name)).size !== result.tools.length) {
      throw new CodexTransportError('Native tool catalog is invalid', { code: 'INVALID_RESPONSE', delivery: 'unknown' });
    }
    this.tools = new Map(result.tools.map(tool => [tool.name, tool]));
    return result;
  }

  async callTool(toolName, args = {}) {
    requiredString(toolName, 'toolName');
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new CodexTransportError('Tool arguments must be an object', { code: 'INVALID_INPUT' });
    }
    if (!this.tools) {
      try { await this.listTools(); }
      catch (error) {
        // Catalog discovery never invokes the destination tool.
        if (error instanceof CodexTransportError) error.delivery = 'not_sent';
        throw error;
      }
    }
    const tool = this.tools.get(toolName);
    if (!tool) throw new CodexTransportError(`Native tool unavailable: ${toolName}`, { code: 'TOOL_UNAVAILABLE' });
    // These prefixes are the actual MCP wrapper's documented fallback; no executor turn is invented.
    const requestKey = randomUUID();
    const result = await this.client.request('tools/call', {
      arguments: args,
      callerSource: 'codex',
      callId: `mcp-call-${requestKey}`,
      namespace: tool.namespace,
      threadId: this.ownerThreadId,
      tool: tool.name,
      turnId: this.turnId ?? `mcp-turn-${requestKey}`,
    });
    if (typeof result?.success !== 'boolean' || !Array.isArray(result.contentItems) ||
        result.contentItems.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.type !== 'string' || (item.type === 'inputText' && typeof item.text !== 'string'))) {
      throw new CodexTransportError('Native tool response is invalid; outcome is unknown', { code: 'INVALID_RESPONSE', delivery: 'unknown' });
    }
    if (!result.success) {
      const detail = result.contentItems.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
      throw new CodexTransportError(detail || 'Native tool rejected the request', { code: 'TOOL_FAILED', delivery: 'failed' });
    }
    return result;
  }

  listThreads({ limit } = {}) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 50)) {
      throw new CodexTransportError('limit must be an integer from 1 to 50', { code: 'INVALID_INPUT' });
    }
    return this.callTool('list_threads', limit === undefined ? {} : { limit });
  }

  readThread({ threadId, hostId, cursor, turnLimit, includeOutputs, maxOutputCharsPerItem } = {}) {
    requiredString(threadId, 'threadId');
    const args = { threadId };
    if (hostId !== undefined) args.hostId = requiredString(hostId, 'hostId');
    if (cursor !== undefined) args.cursor = requiredString(cursor, 'cursor');
    if (turnLimit !== undefined) {
      if (!Number.isSafeInteger(turnLimit) || turnLimit <= 0 || turnLimit > 10) throw new CodexTransportError('turnLimit must be an integer from 1 to 10', { code: 'INVALID_INPUT' });
      args.turnLimit = turnLimit;
    }
    if (includeOutputs !== undefined) {
      if (typeof includeOutputs !== 'boolean') throw new CodexTransportError('includeOutputs must be boolean', { code: 'INVALID_INPUT' });
      args.includeOutputs = includeOutputs;
    }
    if (maxOutputCharsPerItem !== undefined) {
      if (!Number.isSafeInteger(maxOutputCharsPerItem) || maxOutputCharsPerItem <= 0 || maxOutputCharsPerItem > 20000) throw new CodexTransportError('maxOutputCharsPerItem must be an integer from 1 to 20000', { code: 'INVALID_INPUT' });
      args.maxOutputCharsPerItem = maxOutputCharsPerItem;
    }
    return this.callTool('read_thread', args);
  }

  sendMessage({ threadId, prompt, hostId } = {}) {
    requiredString(threadId, 'threadId');
    requiredString(prompt, 'prompt');
    const args = { threadId, prompt };
    if (hostId !== undefined) args.hostId = requiredString(hostId, 'hostId');
    return this.callTool('send_message_to_thread', args);
  }

  close() { this.client.close(); }
}
