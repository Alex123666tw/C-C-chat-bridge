import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{32}$/;
const defaultRegistry = () => path.join(os.homedir(), '.claude', 'sessions');

// Claude 2.1.289 dk/b9: normalize Windows pipes before hashing the key name.
export function canonicalSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath) throw new Error('INVALID_SOCKET_PATH');
  const match = socketPath.match(/^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i);
  if (match) {
    if (socketPath.startsWith('\\\\?') && socketPath.includes('/')) throw new Error('INVALID_SOCKET_PATH');
    const name = match[2];
    if (name === '.' || name === '..' || /[. ]$/.test(name)) throw new Error('INVALID_SOCKET_PATH');
    const suffix = match[1] ? 'LOCAL\\' + name : name;
    return '\\\\.\\pipe\\' + suffix.replace(/[A-Z]/g, c => c.toLowerCase());
  }
  // POSIX socket support also permits isolated fake-server tests.
  if (process.platform !== 'win32' && path.isAbsolute(socketPath)) return socketPath;
  throw new Error('INVALID_SOCKET_PATH');
}

export function keyFileFor(pid, socketPath, registryDir = defaultRegistry()) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('INVALID_PID');
  const hash = createHash('sha256').update(canonicalSocketPath(socketPath)).digest('hex');
  return path.join(registryDir, pid + '.' + hash + '.key');
}

export async function readPeerToken(keyPath) {
  try {
    const key = JSON.parse(await fs.readFile(keyPath, 'utf8'));
    if (typeof key.peerToken !== 'string' || !TOKEN.test(key.peerToken)) throw new Error();
    return key.peerToken;
  } catch {
    // Never expose filesystem contents, parser snippets, or transport secrets.
    throw new Error('AUTH_KEY_UNAVAILABLE');
  }
}

export function socketUri(socketPath) {
  canonicalSocketPath(socketPath);
  return 'uds:' + [...socketPath].map(c => /[a-zA-Z0-9:_/.\\-]/.test(c) ? c : encodeURIComponent(c)).join('');
}

function validCallback(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('uds:')) throw new Error('INVALID_CALLBACK_URI');
  let socketPath;
  try { socketPath = decodeURIComponent(uri.slice(4)); } catch { throw new Error('INVALID_CALLBACK_URI'); }
  canonicalSocketPath(socketPath);
  return socketUri(socketPath);
}


// Native Claude Lze/O/U close-tag escaping, copied from the installed 2.1.289 transport.
const nativeInvisible = String.raw`\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{16fe4}\u{e0000}-\u{e0fff}`;
const nativeCombining = String.raw`\u0300-\u0344\u0346-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\u3099\u309a\ufe20-\ufe2f`;
const nativeBetween = nativeInvisible + nativeCombining + String.raw`\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029`;
const nativeWord = String.raw`A-Za-z0-9_\-`;
const nativeDash = String.raw`\p{Pd}\u2212\u207b\u208b\u02d7\u2796\u2043\u30fc\uff70`;
const nativeSeparator = '[_' + String.raw`\p{Pc}\u2017\u02cd\u07fa\u0640` + nativeDash + ']';
const nativeOpen = '<\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6';
const nativeClose = '>\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7';
const nativeSlash = '/\uFF0F\u2215\u2044';
const nativeFiller = '^' + nativeWord + nativeOpen + nativeClose;
function nativeCapture(characters, group) {
  return '(?=([' + characters + ']*))(?:\\' + group + ')';
}
function nativeClosingPattern(tag) {
  let group = 0;
  const prefix = nativeCapture(nativeFiller + nativeSlash, ++group) +
    '[' + nativeSlash + ']' + nativeCapture(nativeFiller, ++group);
  const spelling = [...tag].map((character, index) =>
    (index === 0 ? '' : nativeCapture(nativeBetween, ++group)) +
    (character === '-' || character === '_' ? nativeSeparator : character)).join('');
  return new RegExp('[' + nativeOpen + '](?!\\\\)(?=' + prefix + '(?:' + spelling + ')(?:[^' + nativeWord + ']|$))', 'giu');
}
const nativeWrapperClose = nativeClosingPattern('cross-session-message');

function wrapMessage(message, callbackUri, fromName, fromMode) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('INVALID_MESSAGE');
  if (typeof fromName !== 'string' || /["<>\r\n]/.test(fromName)) throw new Error('INVALID_FROM_NAME');
  if (!['prompting', 'bypass'].includes(fromMode)) throw new Error('INVALID_FROM_MODE');
  // Prevent content from terminating the native cross-session wrapper.
  const body = message.replace(nativeWrapperClose, '<\\');
  return '<cross-session-message from="' + validCallback(callbackUri) + '" from-name="' +
    fromName + '" from-mode="' + fromMode + '">\n' + body + '\n</cross-session-message>';
}

export class ClaudeAdapter {
  constructor({ sessionId, registryDir = defaultRegistry(), timeoutMs = 5000 } = {}) {
    if (!UUID.test(sessionId ?? '')) throw new Error('INVALID_SESSION_ID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_TIMEOUT');
    this.sessionId = sessionId;
    this.registryDir = registryDir;
    this.timeoutMs = timeoutMs;
  }

  static async listSessions({ registryDir = defaultRegistry() } = {}) {
    let names;
    try { names = await fs.readdir(registryDir); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('REGISTRY_UNAVAILABLE');
    }
    const sessions = [];
    for (const filename of names.filter(name => /^\d+\.json$/.test(name))) {
      try {
        const entry = JSON.parse(await fs.readFile(path.join(registryDir, filename), 'utf8'));
        if (!UUID.test(entry.sessionId ?? '') || !Number.isSafeInteger(entry.pid) ||
            entry.pid <= 0 || entry.pid !== Number(filename.slice(0, -5))) continue;
        canonicalSocketPath(entry.messagingSocketPath);
        const safe = { pid: entry.pid, sessionId: entry.sessionId, messagingSocketPath: entry.messagingSocketPath };
        for (const field of ['status', 'name', 'cwd']) {
          if (typeof entry[field] === 'string') safe[field] = entry[field];
        }
        sessions.push(safe);
      } catch { /* A stale, incomplete, or unrelated registry entry is not a session. */ }
    }
    return sessions;
  }

  async sendMessage({ message, callbackUri, from, fromName = 'Codex bridge', fromMode = 'prompting' } = {}) {
    const msgId = randomUUID();
    const base = { sessionId: this.sessionId, msgId };
    let entry, token, frame;
    try {
      const matches = (await ClaudeAdapter.listSessions({ registryDir: this.registryDir }))
        .filter(session => session.sessionId === this.sessionId);
      if (matches.length !== 1) return { ...base, status: 'failed', reason: matches.length ? 'AMBIGUOUS_SESSION' : 'SESSION_NOT_FOUND' };
      entry = matches[0];
      token = await readPeerToken(keyFileFor(entry.pid, entry.messagingSocketPath, this.registryDir));
      const uri = validCallback(callbackUri ?? from);
      frame = { msgV: 1, msg_id: msgId, type: 'user',
        message: { role: 'user', content: wrapMessage(message, uri, fromName, fromMode) },
        session_id: this.sessionId, uuid: randomUUID(), priority: 'next', from: uri };
    } catch (error) {
      const safeReasons = ['AUTH_KEY_UNAVAILABLE', 'REGISTRY_UNAVAILABLE', 'INVALID_MESSAGE',
        'INVALID_CALLBACK_URI', 'INVALID_FROM_NAME', 'INVALID_FROM_MODE', 'INVALID_SOCKET_PATH'];
      return { ...base, status: 'failed', reason: safeReasons.includes(error.message) ? error.message : 'PREPARE_FAILED' };
    }
    return new Promise(resolve => {
      let attempted = false, settled = false;
      const socket = net.createConnection(entry.messagingSocketPath);
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...base, ...result });
      };
      const timer = setTimeout(() => finish({ status: attempted ? 'unknown' : 'failed', reason: 'TRANSPORT_TIMEOUT' }), this.timeoutMs);
      socket.once('error', () => finish({ status: attempted ? 'unknown' : 'failed', reason: 'TRANSPORT_ERROR' }));
      socket.once('close', () => finish({ status: attempted ? 'unknown' : 'failed', reason: 'TRANSPORT_CLOSED' }));
      socket.once('connect', () => {
        attempted = true;
        socket.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify(frame) + '\n', () => {
          // Native direct acceptance has no ACK. A callback can later prove a reply/receipt.
          finish({ status: 'submitted_unconfirmed' });
        });
      });
    });
  }
}

export async function createCallbackReceiver({ registryDir = defaultRegistry(), socketPath,
  timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_TIMEOUT');
  const id = randomBytes(16).toString('hex');
  socketPath ??= process.platform === 'win32'
    ? '\\\\.\\pipe\\LOCAL\\cc-msg-' + id : path.join(os.tmpdir(), 'cc-msg-' + id + '.sock');
  canonicalSocketPath(socketPath);
  const peerToken = randomBytes(16).toString('hex');
  const keyPath = keyFileFor(process.pid, socketPath, registryDir);
  const events = new EventEmitter();
  const sockets = new Set();
  let published = false, closed = false;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => socket.destroy());
    let buffer = '', authenticated = false;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!frame || typeof frame !== 'object') { socket.destroy(); return; }
        if (!authenticated) {
          if (frame.type !== 'auth' || typeof frame.token !== 'string' || !TOKEN.test(frame.token) ||
              !timingSafeEqual(Buffer.from(frame.token), Buffer.from(peerToken))) {
            socket.destroy(); return;
          }
          authenticated = true;
          continue;
        }
        if (frame.type === 'user' && frame.message?.role === 'user' && typeof frame.message.content === 'string') {
          events.emit('message', frame);
          events.emit('frame', frame);
        } else if (frame.type === 'control' && frame.action === 'peer_message_status' &&
                   typeof frame.status === 'string') {
          events.emit('receipt', frame);
          events.emit('frame', frame);
        }
      }
    });
  });
  // Keep error handling attached after listen so an external transport error cannot crash the bridge.
  server.on('error', () => {});
  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (published) {
      try {
        if (await readPeerToken(keyPath) === peerToken) await fs.unlink(keyPath);
      } catch { /* Never remove a replacement or unrelated key. */ }
    }
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify({ peerToken }), { flag: 'wx', mode: 0o600 });
    published = true;
  } catch {
    await close();
    throw new Error('CALLBACK_START_FAILED');
  }
  return {
    socketPath, callbackUri: socketUri(socketPath), keyPath,
    onMessage(listener) { events.on('message', listener); return () => events.off('message', listener); },
    onReceipt(listener) { events.on('receipt', listener); return () => events.off('receipt', listener); },
    onFrame(listener) { events.on('frame', listener); return () => events.off('frame', listener); },
    close
  };
}