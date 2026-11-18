import { readFileSync } from 'node:fs';
import { openDatabase, d1Binding } from './sqlite.mjs';

function secret(name) {
  const file = process.env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : process.env[name];
}

// Each standalone route can load its own module chunk in the same Node process.
const databaseKey = Symbol.for('zero-to-ai-book.sqlite');
const env = {
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  TOKENPLAN_API_KEY: secret('TOKENPLAN_API_KEY'),
  TOKENPLAN_BASE_URL: process.env.TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL: process.env.TOKENPLAN_MODEL,
  AI_DAILY_LIMIT: process.env.AI_DAILY_LIMIT,
  SANDBOX_API_KEY: secret('SANDBOX_API_KEY'),
  SANDBOX_API_URL: process.env.SANDBOX_API_URL,
  SELF_HOSTED_SANDBOX: process.env.SELF_HOSTED_SANDBOX,
  GPU_API_KEY: secret('GPU_API_KEY'),
  GPU_API_URL: process.env.GPU_API_URL,
  get DB() {
    return (globalThis[databaseKey] ??= d1Binding(openDatabase(process.env.SQLITE_PATH || '/data/course.sqlite')));
  },
};
export { env };
