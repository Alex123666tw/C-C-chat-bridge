import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Expand only the public test suite: Windows Node 20 does not expand shell globs,
// and default discovery would also run the opt-in paid CLI probe.
const directory = new URL('../tests/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No automated test files found');
const child = spawn(process.execPath, ['--test', ...files.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' });
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
