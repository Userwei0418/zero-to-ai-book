import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  return db;
}

// The route handlers use the same bound statements as the hosted D1 application.
class BoundStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new BoundStatement(this.db, this.sql, values);
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.values);
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column)) throw new Error('Unknown result column: ' + column);
    return row[column];
  }
  execute() {
    const query = this.db.prepare(this.sql);
    const counter = this.db.prepare('SELECT total_changes() AS n');
    const before = counter.get().n;
    const results = query.all(...this.values);
    const changes = counter.get().n - before;
    return { success: true, results, meta: { changes } };
  }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async raw() {
    const query = this.db.prepare(this.sql);
    query.setReturnArrays(true);
    return query.all(...this.values);
  }
}

function d1Binding(db) {
  return {
    prepare(sql) { return new BoundStatement(db, sql); },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => {
          if (!(statement instanceof BoundStatement) || statement.db !== db) throw new Error('Statement belongs to a different database');
          return statement.execute();
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export { openDatabase, d1Binding };
