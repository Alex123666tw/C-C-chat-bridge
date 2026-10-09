import os from 'node:os';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ClaudeAdapter, createCallbackReceiver, canonicalSocketPath } from './claude.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT = /^[a-zA-Z0-9_-]{1,128}$/;
const scope = {
  source: 'local_native_claude_code',
  inventory: 'Native live-session registry plus saved parent and subagent JSONL transcripts across local projects.',
  remoteClaude: 'not_connected',
  otherClaudeApps: 'not_connected',
  sending: 'Existing live exact session only; never starts or resumes a chat.',
  history: 'Visible user/assistant text, tool calls with native inputs, and tool results; internal events, hidden thinking and auth keys are excluded.',
};
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const idSchema = { type: 'string', pattern: UUID.source };
const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const definitions = [
  { name: 'claude_list_chats', description: 'List local native Claude Code chats, including saved history and separately identified subagents. Remote Claude and other Claude apps are not connected.', inputSchema: schema(paging), annotations: { readOnlyHint: true } },
  { name: 'claude_read_chat', description: 'Read visible native transcript records, including tool calls with native inputs and tool results, by exact parent session ID, optionally a listed agentId and projectKey to disambiguate copied histories. Offset is the zero-based source JSONL record index; nextOffset preserves position across filtered internal records. No hidden thinking or auth keys.', inputSchema: { ...schema({ sessionId: idSchema, agentId: { type: 'string', pattern: AGENT.source }, projectKey: { type: 'string', minLength: 1 }, ...paging }), required: ['sessionId'] }, annotations: { readOnlyHint: true } },
  { name: 'claude_send_message', description: 'Send an explicitly user-authorized message to an existing live exact Claude session. Native authenticated pipe submission is unconfirmed until native evidence arrives. Starts only this provider own callback receiver, never a Claude chat. Read claude_read_inbox for genuine replies or receipts.', inputSchema: { ...schema({ sessionId: idSchema, message: { type: 'string', minLength: 1 } }), required: ['sessionId', 'message'] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  { name: 'claude_read_inbox', description: 'Read authenticated native replies/receipts received by this MCP process from exact contacted Claude session pipes. No reply returns pending. Replies are attributed to source session, not falsely correlated to a request. Inbox is process-local and disappears on close.', inputSchema: schema({ sessionId: idSchema, ...paging }), annotations: { readOnlyHint: true } },
];
function checkArgs(name, args) {
  const def = definitions.find(d => d.name === name);
  if (!def) throw new Error('UNKNOWN_TOOL');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
  if (Object.keys(args).some(k => !Object.hasOwn(def.inputSchema.properties, k))) throw new Error('INVALID_ARGUMENTS');
  for (const k of def.inputSchema.required ?? []) if (!Object.hasOwn(args, k)) throw new Error('INVALID_ARGUMENTS');
  if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !UUID.test(args.sessionId))) throw new Error('INVALID_SESSION_ID');
  if (args.agentId !== undefined && (typeof args.agentId !== 'string' || !AGENT.test(args.agentId))) throw new Error('INVALID_AGENT_ID');
  if (args.projectKey !== undefined && (typeof args.projectKey !== 'string' || !args.projectKey.trim())) throw new Error('INVALID_ARGUMENTS');
  for (const k of ['offset', 'limit']) {
    if (args[k] !== undefined && (!Number.isSafeInteger(args[k]) || args[k] < (k === 'offset' ? 0 : 1) || (k === 'limit' && args[k] > 100))) throw new Error('INVALID_PAGINATION');
  }
  if (name === 'claude_send_message' && (typeof args.message !== 'string' || !args.message.trim())) throw new Error('INVALID_MESSAGE');
}
async function directoryEntries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('HISTORY_UNAVAILABLE'); }
}
async function boundFile(root, file) {
  const [base, target] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('HISTORY_PATH_OUTSIDE_ROOT');
  if (!(await fs.stat(target)).isFile()) throw new Error('HISTORY_NOT_FOUND');
  return target;
}
async function* records(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { /* Live writes can leave a partial trailing line. */ }
      yield { recordIndex: index++, record };
    }
  } finally { lines.close(); stream.destroy(); }
}
function visibleContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
    else if (block?.type === 'tool_use' && typeof block.name === 'string') blocks.push({ type: 'tool_use', id: block.id, name: block.name,
      ...(Object.hasOwn(block, 'input') ? { input: block.input } : {}), ...(Object.hasOwn(block, 'caller') ? { caller: block.caller } : {}) });
    else if (block?.type === 'tool_result') blocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error === true, content: visibleContent(block.content).filter(b => b.type === 'text') });
  }
  return blocks;
}
function visibleMessage(record, recordIndex, sidechain) {
  if (!record || !['user', 'assistant'].includes(record.type) || !record.message || (record.isSidechain === true && !sidechain)) return null;
  const content = visibleContent(record.message.content);
  if (!content.length) return null;
  return { recordIndex, role: record.type, content, ...(typeof record.uuid === 'string' ? { uuid: record.uuid } : {}),
    ...(typeof record.parentUuid === 'string' ? { parentUuid: record.parentUuid } : {}),
    ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}), isSidechain: sidechain || record.isSidechain === true };
}
function canonicalUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('uds:')) return null;
  try { return canonicalSocketPath(decodeURIComponent(uri.slice(4))); } catch { return null; }
}
async function liveSessions(registryDir) {
  return (await ClaudeAdapter.listSessions({ registryDir })).filter(s => {
    try { process.kill(s.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
  });
}
async function historyIndex(projectsDir, metadata = true, targetSessionId) {
  const entries = [];
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const file of await directoryEntries(dir)) {
      const sessionId = file.name.slice(0, -6);
      if (!file.isFile() || !file.name.endsWith('.jsonl') || !UUID.test(sessionId) || (targetSessionId && sessionId !== targetSessionId)) continue;
      const full = await boundFile(projectsDir, path.join(dir, file.name));
      const stat = await fs.stat(full);
      const item = { sessionId, projectKey: project.name, historyAvailable: true, modifiedAt: stat.mtime.toISOString(), subagents: [], file: full };
      for (const agent of await directoryEntries(path.join(dir, sessionId, 'subagents'))) {
        const match = agent.name.match(/^agent-([a-zA-Z0-9_-]{1,128})\.jsonl$/);
        if (agent.isFile() && match) {
          const agentFile = await boundFile(projectsDir, path.join(dir, sessionId, 'subagents', agent.name));
          item.subagents.push({ agentId: match[1], parentSessionId: sessionId, isSidechain: true, file: agentFile });
        }
      }
      if (metadata) for await (const { record } of records(full)) {
        if (record?.sessionId && record.sessionId !== sessionId) continue;
        if (typeof record?.customTitle === 'string') item.title = record.customTitle;
        if (!item.title && typeof record?.summary === 'string') item.title = record.summary;
        if (typeof record?.cwd === 'string') item.cwd = record.cwd;
      }
      entries.push(item);
    }
  }
  return entries;
}

export function createClaudeChatProvider({ projectsDir = path.join(os.homedir(), '.claude', 'projects'), registryDir = path.join(os.homedir(), '.claude', 'sessions'), timeoutMs = 5000, fromName = 'Codex chat bridge' } = {}) {
  let closed = false, receiverPromise;
  const contacts = new Map(), requests = new Map(), inbox = [], seen = new Set(), pendingReceipts = [];
  let nextIndex = 0;
  function enqueue(item) { inbox.push({ index: nextIndex++, receivedAt: new Date().toISOString(), ...item }); if (inbox.length > 1000) inbox.shift(); }
  async function receiver() {
    // A send can still be discovering its session when close() finishes.
    // Never open a new native receiver after that lifecycle boundary.
    if (closed) throw new Error('PROVIDER_CLOSED');
    if (!receiverPromise) {
      receiverPromise = createCallbackReceiver({ registryDir, timeoutMs }).then(value => {
        value.onFrame(frame => {
          if (closed) return;
          const source = canonicalUri(frame.from);
          const matches = [...contacts.entries()].filter(([, socket]) => socket === source);
          if (matches.length !== 1) return;
          const sessionId = matches[0][0];
          let item;
          if (frame.type === 'control' && frame.action === 'peer_message_status') {
            if (requests.get(frame.orig_msg_id) !== sessionId) {
              if (typeof frame.orig_msg_id === 'string') { pendingReceipts.push({ sessionId, frame }); if (pendingReceipts.length > 100) pendingReceipts.shift(); }
              return;
            }
            item = { type: 'receipt', sessionId, originalMsgId: frame.orig_msg_id, status: frame.status };
          } else if (frame.type === 'user') {
            if (typeof frame.msg_id !== 'string' || seen.has(frame.msg_id)) return;
            seen.add(frame.msg_id);
            item = { type: 'message', sessionId, msgId: frame.msg_id, content: visibleContent(frame.message?.content), correlation: 'source_session_only' };
          }
          if (item) enqueue(item);
        });
        return value;
      }).catch(error => { receiverPromise = undefined; throw error; });
    }
    return receiverPromise;
  }
  return {
    async tools() { return definitions.map(d => structuredClone(d)); },
    async call(name, args = {}) {
      try {
        if (closed) throw new Error('PROVIDER_CLOSED');
        checkArgs(name, args);
        const offset = args.offset ?? 0, limit = args.limit ?? 20;
        if (name === 'claude_read_inbox') {
          const matches = inbox.filter(item => item.index >= offset && (!args.sessionId || item.sessionId === args.sessionId));
          const items = matches.slice(0, limit);
          return { status: items.length ? 'received' : 'pending', items, nextOffset: matches.length > limit ? items.at(-1).index + 1 : nextIndex, retainedFrom: inbox[0]?.index ?? nextIndex, processLocal: true };
        }
        if (name === 'claude_send_message') {
          const matches = (await liveSessions(registryDir)).filter(s => s.sessionId === args.sessionId);
          if (matches.length !== 1) return { status: 'not_available', delivery: 'not_sent', reason: matches.length ? 'AMBIGUOUS_SESSION' : 'LIVE_SESSION_NOT_FOUND', sessionId: args.sessionId };
          const callback = await receiver();
          if (closed) throw new Error('PROVIDER_CLOSED');
          contacts.set(args.sessionId, canonicalSocketPath(matches[0].messagingSocketPath));
          const result = await new ClaudeAdapter({ sessionId: args.sessionId, registryDir, timeoutMs }).sendMessage({ message: args.message, callbackUri: callback.callbackUri, fromName });
          requests.set(result.msgId, args.sessionId);
          for (let i = pendingReceipts.length - 1; i >= 0; i--) {
            const pending = pendingReceipts[i];
            if (pending.sessionId === args.sessionId && pending.frame.orig_msg_id === result.msgId) {
              pendingReceipts.splice(i, 1);
              enqueue({ type: 'receipt', sessionId: args.sessionId, originalMsgId: result.msgId, status: pending.frame.status });
            }
          }
          return { ...result, callbackUri: callback.callbackUri, delivery: result.status === 'submitted_unconfirmed' ? 'submitted_unconfirmed' : result.status === 'failed' ? 'not_sent' : 'unknown' };
        }
        const history = await historyIndex(projectsDir, name === 'claude_list_chats', name === 'claude_read_chat' ? args.sessionId : undefined);
        if (name === 'claude_list_chats') {
          const live = await liveSessions(registryDir);
          const list = history.map(({ file, subagents, ...entry }) => ({ ...entry, subagents: subagents.map(({ file, ...agent }) => agent), live: live.some(s => s.sessionId === entry.sessionId), sendAvailable: live.filter(s => s.sessionId === entry.sessionId).length === 1 }));
          for (const session of live) {
            const entries = list.filter(e => e.sessionId === session.sessionId);
            if (!entries.length) list.push({ sessionId: session.sessionId, historyAvailable: false, live: true, sendAvailable: live.filter(s => s.sessionId === session.sessionId).length === 1, subagents: [] });
            for (const entry of list.filter(e => e.sessionId === session.sessionId)) {
              for (const key of ['name', 'cwd', 'status']) if (session[key] !== undefined) entry[key] = session[key];
            }
          }
          list.sort((a, b) => Number(b.live) - Number(a.live) || String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')) || a.sessionId.localeCompare(b.sessionId));
          return { scope, chats: list.slice(offset, offset + limit), total: list.length, offset, nextOffset: offset + limit < list.length ? offset + limit : null };
        }
        const found = history.filter(e => e.sessionId === args.sessionId && (!args.projectKey || e.projectKey === args.projectKey));
        if (found.length !== 1) return { status: 'not_available', reason: found.length ? 'AMBIGUOUS_HISTORY' : 'HISTORY_NOT_FOUND', sessionId: args.sessionId };
        const source = args.agentId ? found[0].subagents.find(a => a.agentId === args.agentId) : found[0];
        if (!source) return { status: 'not_available', reason: 'AGENT_HISTORY_NOT_FOUND', sessionId: args.sessionId, agentId: args.agentId };
        const messages = []; let nextOffset = null, sourceRecords = 0;
        for await (const { record, recordIndex } of records(source.file)) {
          sourceRecords = recordIndex + 1;
          if (recordIndex < offset) continue;
          if (!args.agentId && record?.sessionId && record.sessionId !== args.sessionId) continue;
          const message = visibleMessage(record, recordIndex, Boolean(args.agentId));
          if (!message) continue;
          if (messages.length === limit) { nextOffset = messages.at(-1).recordIndex + 1; break; }
          messages.push(message);
        }
        return { status: 'read', scope, sessionId: args.sessionId, ...(args.agentId ? { agentId: args.agentId, parentSessionId: args.sessionId } : {}), projectKey: found[0].projectKey, messages, offset, nextOffset, scannedSourceRecords: sourceRecords, ordering: 'native_jsonl_record_order_with_parent_uuid', toolInputs: 'native_visible', hiddenThinking: 'omitted' };
      } catch (error) {
        const safe = ['UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'INVALID_SESSION_ID', 'INVALID_AGENT_ID', 'INVALID_PAGINATION', 'INVALID_MESSAGE', 'PROVIDER_CLOSED', 'HISTORY_UNAVAILABLE', 'HISTORY_PATH_OUTSIDE_ROOT', 'HISTORY_NOT_FOUND', 'REGISTRY_UNAVAILABLE', 'CALLBACK_START_FAILED'];
        return { status: 'failed', reason: safe.includes(error.message) ? error.message : 'CLAUDE_CHAT_UNAVAILABLE' };
      }
    },
    async close() { closed = true; if (receiverPromise) await receiverPromise.then(r => r.close()).catch(() => {}); },
  };
}
