import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClaudeAdapter, canonicalSocketPath, keyFileFor, readPeerToken,
  socketUri, createCallbackReceiver } from '../src/claude.mjs';

async function fixture(t) {
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapter-'));
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\LOCAL\\cc-msg-' + randomBytes(16).toString('hex')
    : path.join(registryDir, 'fake.sock');
  const sessionId = randomUUID();
  const token = randomBytes(16).toString('hex');
  await fs.writeFile(path.join(registryDir, process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId, messagingSocketPath: socketPath, name: 'Fixture',
    status: 'idle', cwd: registryDir, processStartToken: 'must-not-be-exposed', arbitrary: 'not-metadata'
  }));
  await fs.writeFile(keyFileFor(process.pid, socketPath, registryDir), JSON.stringify({ peerToken: token }));
  t.after(() => fs.rm(registryDir, { recursive: true, force: true }));
  return { registryDir, socketPath, sessionId, token };
}

async function fakeServer(t, socketPath, onFrames) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.length) onFrames(lines.map(line => JSON.parse(line)), socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server;
}

async function transmit(socketPath, frames) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('close', resolve);
    socket.once('connect', () => socket.end(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'));
  });
}

function nextEvent(register, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('FIXTURE_EVENT_TIMEOUT')); }, timeoutMs);
    const remove = register(frame => { clearTimeout(timer); remove(); resolve(frame); });
  });
}

test('native Windows key canonicalization matches the installed transport', () => {
  const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-094efffa732705b16169ba0997de0911';
  assert.equal(canonicalSocketPath(pipe), '\\\\.\\pipe\\local\\cc-msg-094efffa732705b16169ba0997de0911');
  assert.equal(path.basename(keyFileFor(54908, pipe, 'registry')),
    '54908.c7095c64d114e9bb4c45557c61d18c2d5b1a66a0200e43db7848c06d04f20ae2.key');
  assert.throws(() => canonicalSocketPath('\\\\.\\pipe\\LOCAL\\bad.'), /INVALID_SOCKET_PATH/);
});

test('existing session sends native auth + user envelope and reports only unconfirmed submission', async t => {
  const f = await fixture(t);
  const receiver = await createCallbackReceiver({ registryDir: f.registryDir });
  t.after(() => receiver.close());
  const framesSeen = [];
  let resolveFrames;
  const receivedFrames = new Promise(resolve => { resolveFrames = resolve; });
  await fakeServer(t, f.socketPath, frames => {
    framesSeen.push(...frames);
    if (framesSeen.length === 2) resolveFrames(framesSeen);
  });
  const adapter = new ClaudeAdapter(f);
  const sessions = await ClaudeAdapter.listSessions({ registryDir: f.registryDir });
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['cwd', 'messagingSocketPath', 'name', 'pid', 'sessionId', 'status']);
  const result = await adapter.sendMessage({ message: 'Reply to the bridge.', callbackUri: receiver.callbackUri });
  assert.equal(result.status, 'submitted_unconfirmed');
  const [auth, message] = await receivedFrames;
  assert.deepEqual(auth, { type: 'auth', token: f.token });
  assert.equal(message.session_id, f.sessionId);
  assert.equal(message.msg_id, result.msgId);
  assert.equal(message.priority, 'next');
  assert.equal(message.msgV, 1);
  assert.equal(message.from, receiver.callbackUri);
  assert.equal(message.message.content,
    '<cross-session-message from="' + receiver.callbackUri + '" from-name="Codex bridge" from-mode="prompting">\nReply to the bridge.\n</cross-session-message>');
  assert.ok(!message.message.content.includes('from-session='));
});

test('native wrapper escapes closing tags and Unicode lookalikes while preserving ordinary text', async t => {
  const f = await fixture(t);
  const received = [];
  let resolveFrame;
  const complete = new Promise(resolve => { resolveFrame = resolve; });
  await fakeServer(t, f.socketPath, frames => {
    received.push(...frames);
    if (received.length === 2) resolveFrame(received[1]);
  });
  const result = await new ClaudeAdapter(f).sendMessage({
    message: 'one </cross-session-message> two \uFF1C /cross_session_message> three <\\/cross-session-message> four <ordinary>',
    callbackUri: socketUri(f.socketPath)
  });
  assert.equal(result.status, 'submitted_unconfirmed');
  const frame = await complete;
  assert.ok(frame.message.content.includes('one <\\/cross-session-message> two <\\ /cross_session_message>'));
  assert.ok(frame.message.content.includes('three <\\/cross-session-message> four <ordinary>'));
});

test('authenticated native callbacks return user and receipt frames; wrong auth is silent', async t => {
  const f = await fixture(t);
  const receiver = await createCallbackReceiver({ registryDir: f.registryDir });
  t.after(() => receiver.close());
  const token = await readPeerToken(receiver.keyPath);
  let leaked = false;
  receiver.onFrame(() => { leaked = true; });
  await transmit(receiver.socketPath, [{ type: 'auth', token: randomBytes(16).toString('hex') },
    { type: 'user', message: { role: 'user', content: 'rejected' } }]);
  assert.equal(leaked, false);
  const user = { msgV: 1, msg_id: randomUUID(), type: 'user', message: { role: 'user', content: 'Claude reply' } };
  const reply = nextEvent(listener => receiver.onMessage(listener));
  await transmit(receiver.socketPath, [{ type: 'auth', token }, user]);
  assert.deepEqual(await reply, user);
  const receiptFrame = { msgV: 1, msg_id: randomUUID(), type: 'control', action: 'peer_message_status',
    orig_msg_id: randomUUID(), status: 'expired', status_detail: 'refused' };
  const receipt = nextEvent(listener => receiver.onReceipt(listener));
  await transmit(receiver.socketPath, [{ type: 'auth', token }, receiptFrame]);
  assert.deepEqual(await receipt, receiptFrame);
  await receiver.close();
  await assert.rejects(fs.stat(receiver.keyPath), { code: 'ENOENT' });
  assert.ok(await fs.stat(keyFileFor(process.pid, f.socketPath, f.registryDir)));
});

test('unavailable session/key/pipe fail safely without exposing registry secrets', async t => {
  const f = await fixture(t);
  const adapter = new ClaudeAdapter({ ...f, timeoutMs: 100 });
  const callbackUri = socketUri(f.socketPath);
  const noPipe = await adapter.sendMessage({ message: 'test', callbackUri });
  assert.equal(noPipe.status, 'failed');
  assert.equal(noPipe.reason, 'TRANSPORT_ERROR');
  await fs.writeFile(keyFileFor(process.pid, f.socketPath, f.registryDir), '{"peerToken":"sensitive-invalid-value"');
  const badKey = await adapter.sendMessage({ message: 'test', callbackUri });
  assert.equal(badKey.reason, 'AUTH_KEY_UNAVAILABLE');
  assert.ok(!JSON.stringify(badKey).includes('sensitive'));
  const absent = await new ClaudeAdapter({ ...f, sessionId: randomUUID() }).sendMessage({ message: 'test', callbackUri });
  assert.equal(absent.reason, 'SESSION_NOT_FOUND');
});

test('callback startup collision preserves another listener and its key', async t => {
  const f = await fixture(t);
  await fakeServer(t, f.socketPath, () => {});
  await assert.rejects(createCallbackReceiver({ registryDir: f.registryDir, socketPath: f.socketPath }), /CALLBACK_START_FAILED/);
  assert.equal(await readPeerToken(keyFileFor(process.pid, f.socketPath, f.registryDir)), f.token);
});