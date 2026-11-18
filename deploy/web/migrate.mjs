import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './sqlite.mjs';

function migrate(db, directory) {
  const journal = JSON.parse(readFileSync(join(directory, 'meta', '_journal.json'), 'utf8'));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS __course_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
    const find = db.prepare('SELECT sha256 FROM __course_migrations WHERE name = ?');
    const record = db.prepare('INSERT INTO __course_migrations (name, sha256) VALUES (?, ?)');
    for (const { tag } of journal.entries) {
      const sql = readFileSync(join(directory, tag + '.sql'), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const existing = find.get(tag);
      if (existing) {
        if (existing.sha256 !== sha) throw new Error('An applied migration changed: ' + tag);
        continue;
      }
      db.exec(sql);
      record.run(tag, sha);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const db = openDatabase(process.env.SQLITE_PATH || '/data/course.sqlite');
  try {
    migrate(db, join(process.cwd(), 'drizzle'));
    console.log('Course database is ready.');
  } finally { db.close(); }
}

export { migrate };
