import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const FIELDS = ['id', 'paperName', 'pdfBytes', 'mode', 'baseUrl', 'model', 'localModelId', 'status', 'createdAt', 'startedAt', 'finishedAt', 'error', 'waitReason', 'rerunOf', 'withdrawn', 'processGroupId', 'failedStage'];
const STATUSES = new Set(['Queued', 'Parsing', 'Running Crafter', 'Completed', 'Failed']);
// Stages a task can fail in; recorded so the interface can show where a failed task stopped.
const FAILED_STAGES = new Set(['Queued', 'Parsing', 'Running Crafter']);

function checkedValues(object, inserting) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new TypeError('A task object is required.');
  for (const field of Object.keys(object)) {
    if (!FIELDS.includes(field)) throw new TypeError(`Task field is not permitted: ${field}`);
    if (!inserting && field === 'id') throw new TypeError('Task IDs cannot be updated.');
  }
  if ('status' in object && !STATUSES.has(object.status)) throw new TypeError('Invalid task status.');
  if ('failedStage' in object && object.failedStage !== null && !FAILED_STAGES.has(object.failedStage)) throw new TypeError('Invalid failed stage.');
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
    if (version > 2) throw new Error('This task database was created by a newer application version.');
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
      processGroupId INTEGER,
      failedStage TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_created ON tasks(createdAt);
    `);
    // Version 2 adds failedStage to databases created before it existed.
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
    if (!columns.includes('failedStage')) this.db.exec('ALTER TABLE tasks ADD COLUMN failedStage TEXT');
    this.db.exec('PRAGMA user_version = 2');
  }

  list() {
    return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC, rowid DESC').all().map(publicRecord);
  }

  get(id) {
    return publicRecord(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  insert(task) {
    checkedValues(task, true);
    const defaults = { localModelId: null, status: 'Queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, waitReason: null, rerunOf: null, withdrawn: false, processGroupId: null, failedStage: null };
    const row = { ...defaults, ...task };
    const values = FIELDS.map(field => field === 'withdrawn' ? Number(Boolean(row[field])) : row[field] ?? null);
    this.db.prepare(`INSERT INTO tasks (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`).run(...values);
    return this.get(task.id);
  }

  update(id, patch) {
    checkedValues(patch, false);
    if (patch.status === 'Failed' && !('failedStage' in patch)) {
      const previous = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)?.status;
      if (FAILED_STAGES.has(previous)) patch = { ...patch, failedStage: previous };
    }
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
