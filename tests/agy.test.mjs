import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createAgyChatProvider } from '../src/agy.mjs';

// Exercise real child-process JSON-RPC framing. Only the `agy acp` executable is faked.
const fixture = String.raw`
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = (sessionId, sessionUpdate, text) => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate, content: { type: 'text', text } } } });
let promptId, resumed;
createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params, result } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true,
    sessionCapabilities: { list: {}, resume: {} } } } });
  if (method === 'session/list') {
    const project = path.resolve(cwd, '測試工作區');
    const target = process.platform === 'win32' ? pathToFileURL(project.toUpperCase()).pathname : project + '/';
    const sessions = params.cursor === 'second-page' ? [{ sessionId: 'second', cwd: target }] :
      [{ sessionId: 'other', cwd: path.resolve(cwd, 'other') }, { sessionId: 'original', cwd: target }];
    send({ id, result: { sessions, ...(params.cursor ? {} : { nextCursor: 'second-page' }) } });
  }
  if (method === 'session/load') {
    update('other', 'agent_message_chunk', 'Other chat');
    update(params.sessionId, 'user_message_chunk', 'User question');
    update(params.sessionId, 'agent_thought_chunk', 'Hidden reasoning');
    update(params.sessionId, 'agent_message_chunk', 'Old reply');
    update(params.sessionId, 'user_message_chunk', 'Another question');
    send({ id, result: {} });
  }
  if (method === 'session/resume') {
    if (params.sessionId === 'missing') {
      send({ id, error: { code: -32002, message: 'Missing chat' } });
      return;
    }
    if (params.mcpServers.length || params.cwd !== cwd) process.exit(2);
    resumed = params.sessionId;
    update(resumed, 'agent_message_chunk', 'Old replay must be ignored');
    send({ id, result: {} });
  }
  if (method === 'session/prompt') {
    if (params.sessionId !== resumed || params.prompt[0].text !== 'Hello') process.exit(3);
    if (resumed === 'disconnect') process.exit(0);
    promptId = id;
    update('other', 'agent_message_chunk', 'Other chat');
    update(resumed, 'agent_thought_chunk', 'Hidden reasoning');
    update(resumed, 'agent_message_chunk', 'Fresh ');
    send({ id: 'permission', method: 'session/request_permission', params: { sessionId: resumed } });
  }
  if (id === 'permission') {
    if (result?.outcome?.outcome !== 'cancelled') process.exit(4);
    update(resumed, 'agent_message_chunk', 'reply');
    send({ id: promptId, result: { stopReason: resumed === 'truncated' ? 'max_tokens' : 'end_turn' } });
  }
});`;

function testProvider(t) {
  const provider = createAgyChatProvider({ command: process.execPath, commandArgs: ['--input-type=module', '-e', fixture] });
  t.after(() => provider.close());
  return provider;
}

test('agy lists the native cursor and applies the requested cwd while preserving native paths', async t => {
  const provider = testProvider(t);
  const args = { cwd: path.resolve(process.cwd(), '測試工作區') };
  const first = await provider.call('agy_list_chats', args);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.sessions.map(session => session.sessionId), ['original']);
  if (process.platform === 'win32') assert.match(first.sessions[0].cwd, /^\/[A-Z]:\/.*%E6%B8%AC/);
  assert.equal(first.nextCursor, 'second-page');
  const second = await provider.call('agy_list_chats', { ...args, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map(session => session.sessionId), ['second']);
  assert.equal(second.nextCursor, null);
});

test('agy history pages show only the requested session’s visible text', async t => {
  const provider = testProvider(t);
  const args = { cwd: process.cwd(), sessionId: 'original', limit: 2 };
  const first = await provider.call('agy_read_chat', args);
  assert.deepEqual(first.messages, [{ role: 'user', text: 'User question' }, { role: 'assistant', text: 'Old reply' }]);
  assert.equal(first.nextOffset, 2);
  const second = await provider.call('agy_read_chat', { ...args, offset: first.nextOffset });
  assert.deepEqual(second.messages, [{ role: 'user', text: 'Another question' }]);
  assert.equal(second.nextOffset, null);
});

test('agy resumes the chosen session and returns only the current reply after rejecting a permission prompt', async t => {
  const provider = testProvider(t);
  const args = { cwd: process.cwd(), sessionId: 'original', prompt: 'Hello' };
  const first = provider.call('agy_request', args);
  const duplicate = await provider.call('agy_request', args);
  assert.equal(duplicate.code, 'AGY_SESSION_BUSY');
  assert.equal(duplicate.delivery, 'not_sent');
  assert.deepEqual(await first, { status: 'completed', delivery: 'completed', sessionId: 'original', stopReason: 'end_turn', text: 'Fresh reply' });
});

test('agy distinguishes a pre-send failure, a disconnected send and an incomplete turn', async t => {
  const provider = testProvider(t);
  const args = { cwd: process.cwd(), prompt: 'Hello' };
  const missing = await provider.call('agy_request', { ...args, sessionId: 'missing' });
  assert.equal(missing.delivery, 'not_sent');
  assert.equal(missing.code, 'AGY_SESSION_NOT_FOUND');
  const disconnected = await provider.call('agy_request', { ...args, sessionId: 'disconnect' });
  assert.equal(disconnected.status, 'unknown');
  assert.equal(disconnected.delivery, 'unknown');
  const truncated = await provider.call('agy_request', { ...args, sessionId: 'truncated' });
  assert.equal(truncated.status, 'failed');
  assert.equal(truncated.delivery, 'stopped');
  assert.equal(truncated.stopReason, 'max_tokens');
  assert.equal(truncated.text, 'Fresh reply');
});
