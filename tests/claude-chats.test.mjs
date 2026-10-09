import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import nativeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClaudeChatProvider } from '../src/claude-chats.mjs';
import { keyFileFor, readPeerToken, socketUri } from '../src/claude.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-chats-'));
  const projectsDir = path.join(root, 'projects'), registryDir = path.join(root, 'sessions');
  const project = path.join(projectsDir, 'fixture-project');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(registryDir);
  t.after(async () => {
    const absolute = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), absolute);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('claude-chats-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const sessionId = randomUUID();
  const save = async (records, id = sessionId) => fs.writeFile(path.join(project, id + '.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const provider = createClaudeChatProvider({ projectsDir, registryDir, timeoutMs: 1000 });
  t.after(() => provider.close());
  return { root, project, projectsDir, registryDir, provider, sessionId, save };
}
const msg = (role, content, more = {}) => ({ type: role, uuid: randomUUID(), parentUuid: null, isSidechain: false, message: { role, content }, ...more });

async function transmit(socketPath, frames) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject); socket.once('close', resolve);
    socket.once('connect', () => socket.end(frames.map(f => JSON.stringify(f)).join('\n') + '\n'));
  });
}
async function fakeNative(t, f) {
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\LOCAL\\cc-msg-' + randomBytes(16).toString('hex') : path.join(f.root, 'native.sock');
  const token = randomBytes(16).toString('hex');
  await fs.writeFile(path.join(f.registryDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: f.sessionId, messagingSocketPath: socketPath, name: 'Native fixture', cwd: f.project, peerToken: 'must-never-leak' }));
  await fs.writeFile(keyFileFor(process.pid, socketPath, f.registryDir), JSON.stringify({ peerToken: token }));
  const frames = []; let done;
  const captured = new Promise(resolve => { done = resolve; });
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
      frames.push(...lines.map(line => JSON.parse(line)));
      if (frames.length >= 2) done(frames);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { socketPath, token, captured, frames };
}

test('normal catalog includes saved inactive parent histories, separately identified subagents and live native chats', async t => {
  const f = await fixture(t); await f.save([{ type: 'custom-title', sessionId: f.sessionId, customTitle: 'Saved fixture' }, msg('user', 'saved', { cwd: '/saved' })]);
  const agentDir = path.join(f.project, f.sessionId, 'subagents'); await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'agent-child1.jsonl'), JSON.stringify(msg('assistant', 'child reply', { isSidechain: true })) + '\n');
  const native = await fakeNative(t, f);
  const inactive = randomUUID(); await f.save([msg('user', 'other')], inactive);
  const result = await f.provider.call('claude_list_chats', { limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.chats[0].sessionId, f.sessionId);
  assert.equal(result.chats[0].title, 'Saved fixture'); assert.equal(result.chats[0].sendAvailable, true);
  assert.equal(result.chats[0].cwd, f.project);
  assert.deepEqual(result.chats[0].subagents[0], { agentId: 'child1', parentSessionId: f.sessionId, isSidechain: true });
  assert.equal(result.nextOffset, 1); assert.equal(result.scope.remoteClaude, 'not_connected');
  const page2 = await f.provider.call('claude_list_chats', { offset: result.nextOffset });
  assert.equal(page2.chats[0].historyAvailable, true); assert.equal(page2.chats[0].sendAvailable, false);
  assert.ok(!JSON.stringify(result).includes(native.token)); assert.ok(!JSON.stringify(result).includes('must-never-leak'));
  const child = await f.provider.call('claude_read_chat', { sessionId: f.sessionId, agentId: 'child1' });
  assert.equal(child.messages[0].content[0].text, 'child reply'); assert.equal(child.messages[0].isSidechain, true);
});

test('listing a page of large saved histories preserves latest metadata without reading all transcripts', async t => {
  const f = await fixture(t), ids = [f.sessionId, ...Array.from({ length: 7 }, () => randomUUID())];
  const payload = msg('assistant', '原文'.repeat(180000));
  for (const [i, id] of ids.entries()) {
    await f.save([msg('user', 'first', { cwd: '/old' }), payload,
      { type: 'custom-title', sessionId: id, customTitle: '最新標題 ' + i },
      msg('user', 'last', { cwd: '/latest/' + i, sessionId: id }),
      { type: 'custom-title', sessionId: randomUUID(), customTitle: 'wrong session', cwd: '/wrong' }], id);
    await fs.utimes(path.join(f.project, id + '.jsonl'), new Date(100000 + i * 1000), new Date(100000 + i * 1000));
  }
  // Observe actual filesystem bytes while still performing each real read.
  let bytesRead = 0;
  const open = fs.open.bind(fs), stream = nativeFs.createReadStream;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); bytesRead += result.bytesRead; return result; };
    return handle;
  });
  t.mock.method(nativeFs, 'createReadStream', (...args) => {
    const input = stream(...args); input.on('data', chunk => { bytesRead += Buffer.byteLength(chunk); }); return input;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = await f.provider.call('claude_list_chats', { limit: 1 });
  assert.equal(first.total, ids.length); assert.equal(first.chats[0].sessionId, ids.at(-1));
  assert.equal(first.chats[0].title, '最新標題 7'); assert.equal(first.chats[0].cwd, '/latest/7');
  assert.ok(bytesRead < 128 * 1024, 'one listed chat should not read multi-megabyte transcript bodies');
  const second = await f.provider.call('claude_list_chats', { offset: first.nextOffset, limit: 1 });
  assert.equal(second.chats[0].sessionId, ids.at(-2)); assert.equal(second.chats[0].title, '最新標題 6');
  assert.ok(bytesRead < 256 * 1024, 'the next page should read only its own metadata');
  const history = await f.provider.call('claude_read_chat', { sessionId: ids.at(-1), offset: 1, limit: 1 });
  assert.equal(history.messages[0].content[0].text, payload.message.content);
  assert.ok(!Object.hasOwn(first.chats[0], 'file') && !JSON.stringify(first).includes('/wrong'));
});

test('metadata outside the tail and empty renamed titles retain full-history fallback semantics', async t => {
  const f = await fixture(t);
  const filler = msg('assistant', 'large body '.repeat(10000));
  const scenarios = [
    { records: [{ type: 'summary', summary: 'first summary' }, filler, { type: 'summary', summary: 'later summary', cwd: '/last' }], title: 'first summary' },
    { records: [{ type: 'custom-title', customTitle: 'early title', cwd: '/early' }, filler, { type: 'cost-state' }], title: 'early title', cwd: '/early' },
    { records: [{ type: 'custom-title', customTitle: 'old title' }, filler, { type: 'custom-title', customTitle: '', cwd: '/last' }], title: '' },
    { records: [{ type: 'summary', summary: 'old summary' }, filler, { type: 'custom-title', customTitle: '', cwd: '/last' }, { type: 'summary', summary: 'after empty' }], title: 'after empty' },
  ];
  for (const scenario of scenarios) {
    await f.save(scenario.records);
    await fs.appendFile(path.join(f.project, f.sessionId + '.jsonl'), '{"type":"custom-title"');
    const listed = await f.provider.call('claude_list_chats');
    assert.equal(listed.chats[0].title, scenario.title);
    assert.equal(listed.chats[0].cwd, scenario.cwd ?? '/last');
  }
});

test('normal history pages preserve native record indices and parent IDs while removing thinking and internal records', async t => {
  const f = await fixture(t); const first = msg('user', 'first');
  await f.save([
    { type: 'queue-operation', content: 'internal-hidden' }, first,
    msg('assistant', [{ type: 'thinking', thinking: 'hidden-reasoning', signature: 'hidden-signature' }]),
    msg('assistant', [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/fixture/project/readme.txt' }, caller: { type: 'direct' } }, { type: 'tool_use', id: 'tool2', name: 'Bash', input: { command: 'printf fixture-output', description: 'Show fixture output' } }], { parentUuid: first.uuid }),
    msg('user', [{ type: 'tool_result', tool_use_id: 'tool1', content: [{ type: 'text', text: 'visible output' }, { type: 'thinking', thinking: 'hidden-tool-thought' }] }]),
    msg('assistant', 'sidechain-hidden', { isSidechain: true }),
    msg('assistant', 'last'), { type: 'cost-state', token: 'metadata-secret' },
  ]);
  const a = await f.provider.call('claude_read_chat', { sessionId: f.sessionId, limit: 2 });
  assert.deepEqual(a.messages.map(m => m.recordIndex), [1, 3]); assert.equal(a.messages[1].parentUuid, first.uuid);
  assert.equal(a.nextOffset, 4);
  assert.deepEqual(a.messages[1].content[1], { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/fixture/project/readme.txt' }, caller: { type: 'direct' } });
  assert.equal(a.messages[1].content[2].input.command, 'printf fixture-output');
  assert.equal(a.messages[1].content[2].input.description, 'Show fixture output');
  assert.equal(a.toolInputs, 'native_visible');
  const b = await f.provider.call('claude_read_chat', { sessionId: f.sessionId, offset: a.nextOffset, limit: 2 });
  assert.deepEqual(b.messages.map(m => m.recordIndex), [4, 6]); assert.equal(b.nextOffset, null);
  assert.equal(b.messages[0].content[0].content[0].text, 'visible output');
  const serialized = JSON.stringify({ a, b });
  for (const hidden of ['hidden-reasoning', 'hidden-signature', 'internal-hidden', 'sidechain-hidden', 'metadata-secret', 'hidden-tool-thought']) assert.ok(!serialized.includes(hidden));
});

test('malformed live tail does not lose prior visible history and exact IDs cannot traverse paths', async t => {
  const f = await fixture(t); await f.save([msg('user', 'kept')]);
  await fs.appendFile(path.join(f.project, f.sessionId + '.jsonl'), '{"type":"assistant"');
  const result = await f.provider.call('claude_read_chat', { sessionId: f.sessionId });
  assert.equal(result.messages[0].content[0].text, 'kept');
  assert.equal((await f.provider.call('claude_read_chat', { sessionId: '../credentials' })).reason, 'INVALID_SESSION_ID');
  assert.equal((await f.provider.call('claude_read_chat', { sessionId: f.sessionId, agentId: '../../credentials' })).reason, 'INVALID_AGENT_ID');
  assert.equal((await f.provider.call('claude_list_chats', { offset: -1 })).reason, 'INVALID_PAGINATION');
  assert.equal((await f.provider.call('claude_read_chat', { sessionId: randomUUID() })).reason, 'HISTORY_NOT_FOUND');
});

test('inactive history cannot be messaged and read-only calls create no native callback files', async t => {
  const f = await fixture(t); await f.save([msg('user', 'old')]);
  await f.provider.call('claude_list_chats'); await f.provider.call('claude_read_chat', { sessionId: f.sessionId });
  const result = await f.provider.call('claude_send_message', { sessionId: f.sessionId, message: 'must not spawn or resume' });
  assert.equal(result.status, 'not_available'); assert.equal(result.delivery, 'not_sent');
  assert.deepEqual(await fs.readdir(f.registryDir), []);
  assert.equal((await f.provider.call('claude_read_inbox')).status, 'pending');
});

test('native send authenticates exact target, genuine source-checked callbacks are readable, and own key is removed on close', async t => {
  const f = await fixture(t); const native = await fakeNative(t, f);
  const before = (await fs.readdir(f.registryDir)).sort();
  const sent = await f.provider.call('claude_send_message', { sessionId: f.sessionId, message: 'fixture message' });
  assert.equal(sent.status, 'submitted_unconfirmed');
  const [auth, frame] = await native.captured;
  assert.deepEqual(auth, { type: 'auth', token: native.token }); assert.equal(frame.session_id, f.sessionId); assert.equal(frame.from, sent.callbackUri);
  assert.ok(frame.message.content.includes('fixture message')); assert.ok(!JSON.stringify(sent).includes(native.token));
  const callbackSocket = decodeURIComponent(sent.callbackUri.slice(4));
  const callbackToken = await readPeerToken(keyFileFor(process.pid, callbackSocket, f.registryDir));
  const from = socketUri(native.socketPath);
  const reply = { type: 'user', msg_id: randomUUID(), session_id: null, from, message: { role: 'user', content: 'genuine fixture reply' } };
  await transmit(callbackSocket, [{ type: 'auth', token: callbackToken }, { ...reply, from: socketUri(callbackSocket) }]);
  assert.equal((await f.provider.call('claude_read_inbox')).status, 'pending');
  await transmit(callbackSocket, [{ type: 'auth', token: randomBytes(16).toString('hex') }, reply]);
  assert.equal((await f.provider.call('claude_read_inbox')).status, 'pending');
  await transmit(callbackSocket, [{ type: 'auth', token: callbackToken }, reply,
    { type: 'control', action: 'peer_message_status', from, session_id: f.sessionId, orig_msg_id: sent.msgId, status: 'accepted' }]);
  const inbox = await f.provider.call('claude_read_inbox', { sessionId: f.sessionId, limit: 1 });
  assert.equal(inbox.status, 'received'); assert.equal(inbox.items[0].content[0].text, 'genuine fixture reply');
  assert.equal(inbox.items[0].correlation, 'source_session_only');
  const receipts = await f.provider.call('claude_read_inbox', { offset: inbox.nextOffset });
  assert.equal(receipts.items[0].originalMsgId, sent.msgId); assert.equal(receipts.items[0].status, 'accepted');
  await f.provider.close(); assert.deepEqual((await fs.readdir(f.registryDir)).sort(), before);
  assert.equal((await f.provider.call('claude_list_chats')).reason, 'PROVIDER_CLOSED');
});

test('closing while a send discovers its target leaves no callback key or native submission', async t => {
  const f = await fixture(t); const native = await fakeNative(t, f);
  const before = (await fs.readdir(f.registryDir)).sort();
  const sending = f.provider.call('claude_send_message', { sessionId: f.sessionId, message: 'must not outlive close' });
  await f.provider.close();
  const result = await sending;
  assert.equal(result.reason, 'PROVIDER_CLOSED');
  assert.deepEqual((await fs.readdir(f.registryDir)).sort(), before);
  assert.deepEqual(native.frames, []);
});

test('copied session IDs require a listed project key, which never becomes a caller-selected path', async t => {
  const f = await fixture(t); await f.save([msg('user', 'original')]);
  const copied = path.join(f.projectsDir, 'second-project'); await fs.mkdir(copied);
  await fs.writeFile(path.join(copied, f.sessionId + '.jsonl'), JSON.stringify(msg('user', 'copy')) + '\n');
  assert.equal((await f.provider.call('claude_read_chat', { sessionId: f.sessionId })).reason, 'AMBIGUOUS_HISTORY');
  const chosen = await f.provider.call('claude_read_chat', { sessionId: f.sessionId, projectKey: 'second-project' });
  assert.equal(chosen.messages[0].content[0].text, 'copy');
  assert.equal((await f.provider.call('claude_read_chat', { sessionId: f.sessionId, projectKey: '../outside' })).reason, 'HISTORY_NOT_FOUND');
});
