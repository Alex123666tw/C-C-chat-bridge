import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

// Read only documented native envelopes. Never interpret summaries as completed replies.
export function threadSnapshot(result) {
  const found = [];
  function visit(value, depth = 0) {
    if (depth > 6 || !value) return;
    if (typeof value === 'string') {
      try { visit(JSON.parse(value), depth + 1); } catch { /* Plain text is not a snapshot. */ }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.turns) && value.thread) {
      if (!found.some(snapshot => isDeepStrictEqual(snapshot, value))) found.push(value);
      return;
    }
    if (value.structuredContent) visit(value.structuredContent, depth + 1);
    const blocks = value.contentItems ?? value.content ?? [];
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (typeof block?.text === 'string') visit(block.text, depth + 1);
    }
  }
  visit(result);
  if (found.length !== 1 || !['active', 'idle'].includes(found[0].thread?.status?.type) ||
      found[0].turns.some(turn => !turn || typeof turn.id !== 'string' || !turn.id || typeof turn.status !== 'string' ||
        (turn.items !== undefined && (!Array.isArray(turn.items) || turn.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))))) ||
      new Set(found[0].turns.map(turn => turn.id)).size !== found[0].turns.length) {
    throw Object.assign(new Error('Native read did not provide an unambiguous thread snapshot'), { code: 'INVALID_THREAD_SNAPSHOT' });
  }
  return found[0];
}

function belongsTo(turn, marker) {
  return (turn.items ?? []).some(item =>
    item.type === 'functionCallOutput' && item.name === 'send_message_to_thread' &&
    item.namespace === 'codex_app' && typeof item.output?.text === 'string' &&
    item.output.text.includes(marker));
}

function relayError(code, delivery, snapshot, turn) {
  return Object.assign(new Error(code), {
    code, delivery, observed: {
      threadStatus: snapshot?.thread?.status?.type ?? 'unknown',
      turnId: turn?.id, turnStatus: turn?.status,
    },
  });
}

export async function dispatchAndWait({ codex, threadId, hostId, prompt, marker,
  timeoutMs = 600000, pollMs = 2000, onAccepted = async () => {},
  now = Date.now, sleep = pause }) {
  const deadline = now() + timeoutMs;
  const read = async () => {
    const snapshot = threadSnapshot(await codex.readThread({
      threadId, ...(hostId === undefined ? {} : { hostId }), turnLimit: 3,
      includeOutputs: true, maxOutputCharsPerItem: 20000,
    }));
    const returnedId = snapshot.thread.id ?? snapshot.thread.threadId;
    if (returnedId !== undefined && returnedId !== threadId) {
      throw relayError('TARGET_THREAD_MISMATCH', 'unknown', snapshot);
    }
    return snapshot;
  };
  let snapshot, ownTurn, accepted = false, dispatchAttempted = false;
  try {
    // Do not inject work into an existing active turn, whose final could be unrelated.
    while (true) {
      snapshot = await read();
      if (snapshot.thread.status.type === 'idle' && !snapshot.turns.some(t => t.status === 'inProgress')) break;
      if (now() >= deadline) throw relayError('TARGET_BUSY_TIMEOUT', 'not_sent', snapshot);
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    if (now() >= deadline) throw relayError('PRE_DISPATCH_TIMEOUT', 'not_sent', snapshot);
    const baseline = new Set(snapshot.turns.map(turn => turn.id));
    dispatchAttempted = true;
    const result = await codex.sendMessage({ threadId, ...(hostId === undefined ? {} : { hostId }), prompt });
    accepted = true;
    await onAccepted(result);
    while (true) {
      snapshot = await read();
      const matches = snapshot.turns.filter(turn => !baseline.has(turn.id) && belongsTo(turn, marker));
      if (matches.length > 1 || (ownTurn && matches.some(turn => turn.id !== ownTurn.id))) {
        throw relayError('AMBIGUOUS_WORK_TURN', 'accepted', snapshot, ownTurn);
      }
      if (matches.length === 1) ownTurn = matches[0];
      if (ownTurn) ownTurn = snapshot.turns.find(turn => turn.id === ownTurn.id) ?? ownTurn;
      if (ownTurn?.status === 'completed') {
        const finals = (ownTurn.items ?? []).filter(item =>
          item.type === 'agentMessage' && ['final_answer', 'final'].includes(item.phase));
        if (finals.length && finals.every(item => typeof item.text === 'string' &&
            (item.truncated === undefined || item.truncated === false))) {
          const text = finals.map(item => item.text).join('\n');
          if (text.trim()) return { status: 'completed', turnId: ownTurn.id, text };
        }
        throw relayError('COMPLETED_WITHOUT_FINAL', 'accepted', snapshot, ownTurn);
      }
      if (ownTurn && !['inProgress', 'completed'].includes(ownTurn.status)) {
        throw relayError('WORK_TURN_NOT_COMPLETED', 'accepted', snapshot, ownTurn);
      }
      if (now() >= deadline) throw relayError('RESULT_TIMEOUT', 'accepted', snapshot, ownTurn);
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  } catch (error) {
    error.delivery = accepted ? 'accepted' : (dispatchAttempted ? (error.delivery ?? 'unknown') : 'not_sent');
    error.observed ??= { threadStatus: snapshot?.thread?.status?.type ?? 'unknown',
      turnId: ownTurn?.id, turnStatus: ownTurn?.status };
    throw error;
  }
}

// The same FIFO handler is used by the daemon and fake-transport tests.
export function createBridgeRouter({ config, codex, claude, callbackUri, expectedClaudeFrom,
  record = async () => {}, output = () => {}, waitOptions = {} }) {
  let queue = Promise.resolve();
  const seen = new Set();
  async function returnToClaude(id, body, extra = {}) {
    const message = `[跨模型結果｜Codex → Claude｜原訊息 ${id}｜目標 ${config.codexTargetHostId ?? 'native default'}/${config.codexTargetThreadId}]\n${body}\n\n此為結果回傳，無需確認回信；只有新工作才再用 SendMessage 傳至橋接。`;
    const result = await claude.sendMessage({ message, callbackUri, fromName: 'Codex bridge result', fromMode: 'prompting' });
    await record({ event: 'claude_result_return', msgId: id, ...extra, result });
    output({ status: result.status, direction: 'codex_result_to_claude', msgId: id, ...extra });
  }
  async function handle(frame, id) {
    let content = frame.message?.content ?? frame.content ?? frame.message;
    if (Array.isArray(content)) content = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (typeof content !== 'string' || !content.trim()) { await record({ event: 'invalid_claude_message', msgId: id }); return; }
    const marker = `[跨模型訊息｜Claude → Codex｜來源 Claude session ${config.claudeSessionId}｜訊息 ${id}]`;
    const prompt = marker + '\n' + content;
    await record({ event: 'claude_message_received', msgId: id, content });
    const accepted = async result => {
      await record({ event: 'codex_native_accepted', msgId: id, result });
      output({ status: 'accepted', direction: 'claude_to_codex', msgId: id });
    };
    let completed;
    try {
      if (config.autoReply) {
        completed = await dispatchAndWait({ codex, threadId: config.codexTargetThreadId,
          hostId: config.codexTargetHostId, prompt, marker,
          timeoutMs: config.resultTimeoutMs, pollMs: config.resultPollMs, onAccepted: accepted, ...waitOptions });
      } else {
        await accepted(await codex.sendMessage({ threadId: config.codexTargetThreadId, prompt,
          ...(config.codexTargetHostId === undefined ? {} : { hostId: config.codexTargetHostId }) }));
      }
    } catch (error) {
      const failure = { delivery: error.delivery ?? 'unknown', code: error.code ?? 'ERROR',
        error: error.message, observed: error.observed };
      await record({ event: 'codex_forward_failed', msgId: id, ...failure });
      output({ status: failure.delivery === 'not_sent' || failure.delivery === 'failed' ? 'failed' : 'unknown',
        direction: 'claude_to_codex', msgId: id, ...failure });
      if (config.autoReply) {
        await returnToClaude(id, `未取得可確認的工作結果。狀態：${failure.delivery}；原因：${failure.code}。\n${JSON.stringify(failure.observed ?? {})}\n不會自動重送，請先核對目的聊天。`, { outcome: 'unknown' });
      }
      return;
    }
    if (completed) {
      await record({ event: 'codex_work_completed', msgId: id, turnId: completed.turnId });
      // Return failures must not be reported as a failed Codex dispatch or retried.
      await returnToClaude(id, completed.text, { outcome: 'completed', turnId: completed.turnId });
    }
  }
  return {
    receive(frame) {
      if (frame.from !== expectedClaudeFrom) {
        queue = queue.then(() => record({ event: 'source_mismatch', msgId: frame.msg_id }));
      } else {
        const id = frame.msg_id ?? frame.uuid;
        if (typeof id !== 'string' || !id) {
          queue = queue.then(() => record({ event: 'missing_message_id' }));
        } else if (!seen.has(id)) {
          seen.add(id);
          queue = queue.then(() => handle(frame, id));
        }
      }
      queue = queue.catch(error => output({ status: 'error', code: 'BRIDGE_HANDLER_FAILED', error: error.message }));
      return queue;
    },
    drained: () => queue,
  };
}
