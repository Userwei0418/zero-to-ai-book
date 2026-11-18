import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, d1Binding } from '../deploy/web/sqlite.mjs';
import { migrate } from '../deploy/web/migrate.mjs';

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));

test('course migrations, bound statements and transaction rollback survive a restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'course-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db', 'test.sqlite');
  let db = openDatabase(file);
  t.after(() => db.close());
  migrate(db, migrations);
  const d1 = d1Binding(db);
  const increment = d1.prepare('UPDATE request_quota SET count = count + 1 WHERE key = ?').bind('student-a');
  const insert = d1.prepare('INSERT INTO request_quota (key, count, expires_at) VALUES (?, ?, ?)').bind('student-a', 1, 100);
  const select = d1.prepare('SELECT count FROM request_quota WHERE key = ?').bind('student-a');
  const operations = await d1.batch([insert, increment, select]);
  assert.deepEqual(operations.map(x => x.meta.changes), [1, 1, 0]);
  assert.equal(operations[2].results[0].count, 2);
  await assert.rejects(d1.batch([increment, insert]), /UNIQUE/);
  assert.equal(await select.first('count'), 2);
  assert.deepEqual(await select.raw(), [[2]]);
  assert.equal((await d1.prepare('UPDATE request_quota SET count = 3 RETURNING count').first()).count, 3);
  db.close();
  db = openDatabase(file);
  migrate(db, migrations);
  assert.equal(db.prepare('SELECT count FROM request_quota').get().count, 3);
  assert.ok(db.prepare('SELECT user_id FROM guide_cache'));
});

test('SQL errors roll back the whole migration and leave the database retryable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'course-sql-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  mkdirSync(join(directory, 'meta'));
  writeFileSync(join(directory, 'meta', '_journal.json'), '{"entries":[{"tag":"first"}]}');
  const path = join(directory, 'first.sql');
  writeFileSync(path, 'CREATE TABLE trial (number INTEGER); BAD SQL');
  assert.throws(() => migrate(db, directory));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = ?').get('trial').n, 0);
  writeFileSync(path, 'CREATE TABLE trial (number INTEGER);');
  migrate(db, directory);
  writeFileSync(path, 'CREATE TABLE trial (label TEXT);');
  assert.throws(() => migrate(db, directory), /applied migration changed/);
});
