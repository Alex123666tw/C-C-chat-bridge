#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CodexAdapter } from './codex.mjs';

const HELP = `Local chat bridge (JSON output)
  node src/cli.mjs codex tools|threads|read|send --owner-thread ID [options]
  --pipe PATH            Native Codex pipe (or CODEX_APP_TOOLS_PIPE_PATH)
  --target-thread ID     Required for read/send
  --message-file PATH    UTF-8 send content; omit to read stdin
  --host-id ID           Optional destination host; omitted uses native default
  --cursor CURSOR        Read older turns of the same chat using the returned cursor
  --turn-id ID           Real caller turn metadata when available
  --timeout-ms N         Default 30000; timeout never triggers an automatic retry
  --limit N              Recent threads 1..50 (no list pagination), or read turns 1..10
  node src/cli.mjs claude sessions
  node src/cli.mjs agy chats [--cwd PATH] [--cursor CURSOR]
  node src/cli.mjs agy read --session-id ID --cwd PATH [--offset N] [--limit N]
  node src/cli.mjs agy request --session-id ID --cwd PATH [--message-file PATH] [--timeout-ms N]
  node src/cli.mjs bridge bind --owner-thread ID --target-thread ID [--session-id ID] [--pipe PATH]
  --target-host-id ID    Explicit destination host for bridge read/send
  --auto-reply true      Callback mode: return exact Codex final to Claude (default false)
  --result-timeout-ms N  Total idle/result wait (default 600000)
  --poll-ms N            Read-only poll interval (default 2000)
  node src/cli.mjs bridge request --config runtime/mac/config.json [--message-file PATH]
  node src/cli.mjs bridge serve --config runtime/config.json --state runtime/state.json
  node src/cli.mjs bridge status|send --state runtime/state.json [--message-file PATH]
`;

function parse(argv) {
  if (argv.includes('--help') || argv.length === 0) return { help: true };
  const [platform, command, ...rest] = argv;
  const options = {};
  const agyOptions = {
    chats: ['cwd', 'cursor'],
    read: ['cwd', 'session-id', 'offset', 'limit'],
    request: ['cwd', 'session-id', 'message-file', 'timeout-ms'],
  };
  const names = new Set(platform === 'agy'
    ? (Object.hasOwn(agyOptions, command) ? agyOptions[command] : [])
    : ['owner-thread', 'pipe', 'target-thread', 'message-file', 'host-id', 'turn-id', 'timeout-ms', 'limit', 'cursor']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (!rest[i]?.startsWith('--') || !names.has(key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error(`Invalid or duplicate option: ${rest[i]}`);
    }
    options[key] = rest[i + 1];
  }
  return { platform, command, options };
}

async function stdinText(command = 'send') {
  if (process.stdin.isTTY) throw new Error(`${command} requires --message-file or piped stdin`);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function numberOption(options, name, { allowZero = false } = {}) {
  if (options[name] === undefined) return undefined;
  if (!(allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(options[name])) {
    throw new Error(`--${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} is too large`);
  return value;
}

async function runAgy(command, options) {
  const tools = { chats: 'agy_list_chats', read: 'agy_read_chat', request: 'agy_request' };
  if (!Object.hasOwn(tools, command)) throw new Error('Expected agy chats|read|request; use --help');
  const args = {};
  if (options.cwd !== undefined) args.cwd = options.cwd;
  if (command === 'chats') {
    if (options.cursor !== undefined) args.cursor = options.cursor;
  } else {
    args.sessionId = options['session-id'];
    if (!args.sessionId?.trim() || !args.cwd?.trim()) throw new Error('agy read and request require --session-id and --cwd');
  }
  if (command === 'read') {
    const offset = numberOption(options, 'offset', { allowZero: true });
    const limit = numberOption(options, 'limit');
    if (offset !== undefined) args.offset = offset;
    if (limit !== undefined) args.limit = limit;
  }
  if (command === 'request') {
    const timeout = numberOption(options, 'timeout-ms');
    if (timeout !== undefined) args.timeoutMs = timeout;
    const message = options['message-file'] === undefined ? await stdinText('agy request') : await readFile(options['message-file'], 'utf8');
    if (!message.trim()) throw new Error('agy request requires a non-empty message');
    args.prompt = '[跨模型橋接工作｜外部 CLI]\n' + message;
  }
  const { createAgyChatProvider } = await import('./agy.mjs');
  const result = await createAgyChatProvider().call(tools[command], args);
  process.stdout.write(JSON.stringify(result) + '\n');
  return ['failed', 'unknown'].includes(result?.status) ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  let adapter;
  try {
    if (argv.includes('--help') || argv.length === 0) { process.stdout.write(HELP); return 0; }
    if (argv[0] === "bridge" || argv[0] === "claude") {
      const bridge = await import("./bridge.mjs");
      await (argv[0] === "bridge" ? bridge.runBridgeCli(argv.slice(1)) : bridge.runClaudeCli(argv.slice(1)));
      return process.exitCode ?? 0;
    }
    const parsed = parse(argv);
    if (parsed.help) { process.stdout.write(HELP); return 0; }
    const { platform, command, options } = parsed;
    if (platform === 'agy') return await runAgy(command, options);
    if (platform !== 'codex' || !['tools', 'threads', 'read', 'send'].includes(command)) throw new Error('Expected codex, claude, agy, or bridge; use --help');
    // Explicit owner configuration is required; environment session IDs are never guessed.
    adapter = new CodexAdapter({
      pipePath: options.pipe ?? process.env.CODEX_APP_TOOLS_PIPE_PATH,
      ownerThreadId: options['owner-thread'],
      turnId: options['turn-id'],
      timeoutMs: numberOption(options, 'timeout-ms'),
    });
    let result;
    if (command === 'tools') result = await adapter.listTools();
    if (command === 'threads') result = await adapter.listThreads({ limit: numberOption(options, 'limit') });
    if (command === 'read') result = await adapter.readThread({
      threadId: options['target-thread'], hostId: options['host-id'], cursor: options.cursor, turnLimit: numberOption(options, 'limit'),
    });
    if (command === 'send') {
      const message = options['message-file'] === undefined ? await stdinText() : await readFile(options['message-file'], 'utf8');
      if (!message.trim()) throw new Error('send requires a non-empty message');
      result = await adapter.sendMessage({
        threadId: options['target-thread'], hostId: options['host-id'],
        prompt: `[跨模型橋接訊息｜外部CLI｜經授權的Codex來源聊天 ${options['owner-thread']}]\n${message}`,
      });
    }
    process.stdout.write(JSON.stringify({ status: command === 'send' ? 'accepted' : 'ok', result }) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      status: error.delivery === 'unknown' ? 'unknown' : 'failed',
      delivery: error.delivery ?? 'not_sent',
      code: error.code ?? 'INVALID_INPUT',
      error: error.message,
    }) + '\n');
    return 1;
  } finally { adapter?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
