import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const FIELDS = ['id', 'paperName', 'pdfBytes', 'mode', 'baseUrl', 'model', 'localModelId', 'status', 'createdAt', 'startedAt', 'finishedAt', 'error', 'waitReason', 'rerunOf', 'withdrawn', 'processGroupId'];
const STATUSES = new Set(['Queued', 'Parsing', 'Running Crafter', 'Completed', 'Failed']);

function checkedValues(object, inserting) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new TypeError('A task object is required.');
  for (const field of Object.keys(object)) {
    if (!FIELDS.includes(field)) throw new TypeError(`Task field is not permitted: ${field}`);
    if (!inserting && field === 'id') throw new TypeError('Task IDs cannot be updated.');
  }
  if ('status' in object && !STATUSES.has(object.status)) throw new TypeError('Invalid task status.');
  if ('mode' in object && !['remote', 'local'].includes(object.mode)) throw new TypeError('Invalid model mode.');
  if ('processGroupId' in object && object.processGroupId !== null && (!Number.isSafeInteger(object.processGroupId) || object.processGroupId <= 0)) throw new TypeError('Invalid task process group.');
  return object;
}

function publicRecord(row) {
  if (!row) return undefined;
  return { ...row, withdrawn: Boolean(row.withdrawn) };
}

export class TaskStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('This task database was created by a newer application version.');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      paperName TEXT NOT NULL,
      pdfBytes INTEGER NOT NULL CHECK(pdfBytes > 0),
      mode TEXT NOT NULL CHECK(mode IN ('remote', 'local')),
      baseUrl TEXT NOT NULL,
      model TEXT NOT NULL,
      localModelId TEXT,
      status TEXT NOT NULL CHECK(status IN ('Queued', 'Parsing', 'Running Crafter', 'Completed', 'Failed')),
      createdAt TEXT NOT NULL,
      startedAt TEXT,
      finishedAt TEXT,
      error TEXT,
      waitReason TEXT,
      rerunOf TEXT,
      withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0, 1)),
      processGroupId INTEGER
    );
    CREATE INDEX IF NOT EXISTS tasks_created ON tasks(createdAt);
    PRAGMA user_version = 1;`);
  }

  list() {
    return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC, rowid DESC').all().map(publicRecord);
  }

  get(id) {
    return publicRecord(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  insert(task) {
    checkedValues(task, true);
    const defaults = { localModelId: null, status: 'Queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, waitReason: null, rerunOf: null, withdrawn: false, processGroupId: null };
    const row = { ...defaults, ...task };
    const values = FIELDS.map(field => field === 'withdrawn' ? Number(Boolean(row[field])) : row[field] ?? null);
    this.db.prepare(`INSERT INTO tasks (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`).run(...values);
    return this.get(task.id);
  }

  update(id, patch) {
    checkedValues(patch, false);
    const fields = Object.keys(patch);
    if (fields.length) {
      const values = fields.map(field => field === 'withdrawn' ? Number(Boolean(patch[field])) : patch[field] ?? null);
      this.db.prepare(`UPDATE tasks SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.get(id);
  }

  remove(id) {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  }

  close() {
    this.db.close();
  }
}
