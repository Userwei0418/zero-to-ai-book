import { provision } from './accounts.mjs';

const args = process.argv.slice(2);
const reset = args[0] === '--reset';
if (args.length !== (reset ? 2 : 1) || process.stdin.isTTY) {
  console.error('Usage: supply the password on stdin to node deploy/identity/provision.mjs [--reset] READER_NAME');
  process.exit(2);
}
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 258) throw Error('密码过长。');
    chunks.push(chunk);
  }
  const password = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
  if (/[\r\n\0]/.test(password)) throw Error('密码须为单行。');
  const id = await provision(process.env.BOOK_IDENTITY_DIR || '/var/lib/book-identity', args.at(-1), password, reset);
  console.log(`读者账号 ${args.at(-1)} · ${id}`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
