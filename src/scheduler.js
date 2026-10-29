import { TaskLogger } from './logs.js';
import { TaskProcess, recoverProcessGroup } from './runner.js';

const TERMINAL = new Set(['Completed', 'Failed']);
const ACTIVE = new Set(['Parsing', 'Running Crafter']);
const now = () => new Date().toISOString();
const appError = (message, status = 409) => Object.assign(new Error(message), { status, statusCode: status });
const clean = (value, secrets) => secrets.reduce((text, key) => key ? text.split(key).join('[REDACTED]') : text, String(value));

export class Scheduler {
  constructor({ store, files, config, onChange = () => {} }) {
    Object.assign(this, { store, files, config, onChange });
    this.credentials = new Map();
    this.active = null;
    this.draining = false;
    this.stopping = false;
    this.started = false;
    this.recoveryBlocked = null;
    this.interval = null;
  }

  get activeId() { return this.active?.id ?? null; }

  status() {
    const configured = Boolean(this.config.preprocess?.command && this.config.crafter?.command);
    const reason = this.recoveryBlocked || (!configured ? 'Configure both paper preprocessing and the real Crafter command before running tasks.' : null);
    return { ready: configured && !this.recoveryBlocked && !this.stopping, reason, activeId: this.activeId };
  }

  changed() { try { this.onChange(); } catch { /* Notification failures do not change execution. */ } }

  async start() {
    if (this.started) return;
    this.started = true;
    for (const task of this.store.list()) {
      if (task.processGroupId || ACTIVE.has(task.status)) {
        let recovered;
        try { recovered = await recoverProcessGroup(task.id, task.processGroupId ?? null, this.config.terminationGraceMs); }
        catch { recovered = { safe: false, reason: 'Interrupted task termination could not be verified; queue is blocked.' }; }
        if (!recovered.safe) this.recoveryBlocked = recovered.reason;
        if (recovered.safe) {
          await this.files.quarantineInterruptedOutputs?.(task.id).catch(() => {});
          await this.files.cleanupRuntimeTemps?.(task.id).catch(() => {});
        }
        this.store.update(task.id, { status: recovered.safe ? 'Failed' : ACTIVE.has(task.status) ? task.status : 'Running Crafter', finishedAt: recovered.safe ? now() : null,
          error: recovered.safe ? 'Server interruption: the unfinished task was stopped and will not restart automatically.' : recovered.reason,
          processGroupId: recovered.safe ? null : task.processGroupId, waitReason: recovered.safe ? null : recovered.reason });
      } else if (!TERMINAL.has(task.status) && !task.withdrawn) {
        await this.files.cleanupRuntimeTemps?.(task.id).catch(() => {});
        this.store.update(task.id, { status: 'Failed', finishedAt: now(), waitReason: null,
          error: 'Server interruption: this unfinished task cannot be recovered. Rerun it with reviewed configuration and a new API key when required.' });
      } else await this.files.cleanupRuntimeTemps?.(task.id).catch(() => {});
    }
    this.interval = setInterval(() => this.kick(), this.config.monitorIntervalMs ?? 1000);
    this.interval.unref?.();
    this.changed();
    this.kick();
  }

  kick() {
    if (!this.started || this.stopping || this.draining || this.active) return;
    this.draining = true;
    queueMicrotask(() => this.drain().catch(() => {}).finally(() => { this.draining = false; }));
  }

  async drain() {
    if (this.stopping || this.active) return;
    const pending = this.store.list().reverse().filter((task) => task.status === 'Queued' && !task.withdrawn)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const task = pending[0];
    if (!task) return;
    const readiness = this.status();
    if (!readiness.ready) {
      this.store.update(task.id, { waitReason: readiness.reason });
      this.changed();
      return;
    }
    try { await this.files.assertCapacity(0, task.id); }
    catch (error) {
      if (this.store.get(task.id)?.status === 'Queued') {
        this.store.update(task.id, { waitReason: `Waiting for storage: ${clean(error.message, [this.credentials.get(task.id)])}` });
        this.changed();
      }
      return;
    }
    // Deletion gates the record synchronously before it starts any file I/O.
    const current = this.store.get(task.id);
    if (!current || current.withdrawn || current.status !== 'Queued' || this.stopping) return;
    const local = this.config.localModels?.find((model) => model.id === current.localModelId);
    const secret = current.mode === 'local' ? (local?.apiKeyEnv ? process.env[local.apiKeyEnv] ?? '' : '') : this.credentials.get(current.id);
    if ((current.mode === 'local' && !local) || (current.mode !== 'local' && !secret)) {
      this.credentials.delete(current.id);
      this.store.update(current.id, { status: 'Failed', finishedAt: now(), waitReason: null,
        error: current.mode === 'local' ? 'Configured local model is no longer available.' : 'The API key is no longer available in memory; rerun this task and re-enter it.' });
      this.changed();
      return;
    }
    this.store.update(current.id, { status: 'Parsing', startedAt: now(), waitReason: null, error: null });
    this.active = { id: current.id, runner: null, promise: null };
    this.active.promise = this.execute(current, secret || '', local);
    this.changed();
    await this.active.promise;
  }

  async execute(task, secret, local) {
    const paths = this.files.paths(task.id);
    const secrets = [secret].filter(Boolean);
    const logger = new TaskLogger(paths.log, { maxBytes: this.config.logMaxBytes, secrets });
    const runner = new TaskProcess({ taskId: task.id, logger, terminationGraceMs: this.config.terminationGraceMs,
      credentialEnvNames: (this.config.localModels ?? []).map((model) => model.apiKeyEnv).filter(Boolean),
      onSpawn: (pgid) => this.store.update(task.id, { processGroupId: pgid }),
      onClear: () => this.store.update(task.id, { processGroupId: null }) });
    this.active.runner = runner;
    const context = { input: paths.input, work: paths.work, output: paths.output,
      model: local?.model ?? task.model, baseUrl: local?.baseUrl ?? task.baseUrl, taskId: task.id };
    let stopReason = null;
    let checking = false;
    let flushing = false;
    let finished = false;
    const stop = (reason) => {
      stopReason ||= reason;
      logger.write(`\n[server] ${stopReason}; stopping all task processes.\n`);
      return runner.stop(stopReason);
    };
    const deadline = setTimeout(() => { void stop('timeout').catch(() => {}); }, this.config.taskTimeoutMs);
    const monitor = setInterval(async () => {
      if (checking || stopReason || finished) return;
      checking = true;
      try { const reason = await this.files.runtimeReason(task.id); if (reason && !finished) await stop(`Storage limit: ${reason}`); }
      catch (error) { await stop(`Storage monitoring failed: ${clean(error.message, secrets)}`).catch(() => {}); }
      finally { checking = false; }
    }, this.config.monitorIntervalMs ?? 1000);
    const logMonitor = setInterval(async () => {
      if (flushing || finished) return;
      flushing = true;
      try { await logger.flush(); }
      catch { await stop('Log storage failed; execution was stopped to preserve retained task information.'); }
      finally { flushing = false; }
    }, 1000);
    try {
      logger.write('[server] Parsing paper.\n');
      await runner.run(this.config.preprocess, context, secret);
      if (stopReason || this.stopping) throw new Error(stopReason || 'Server shutdown interrupted this task.');
      this.store.update(task.id, { status: 'Running Crafter' });
      this.changed();
      logger.write('[server] Running Crafter.\n');
      await runner.run(this.config.crafter, context, secret);
      if (stopReason || this.stopping) throw new Error(stopReason || 'Server shutdown interrupted this task.');
      const reason = await this.files.runtimeReason(task.id);
      if (reason) throw new Error(`Storage limit: ${reason}`);
      await this.files.sanitizeOutputs(task.id, secrets);
      const outputs = await this.files.listOutputs(task.id);
      const published = new Set(outputs.map((file) => typeof file === 'string' ? file : file.path));
      const expected = this.config.expectedOutputs ?? [];
      if (!outputs.length || expected.some((file) => !published.has(file))) {
        throw new Error('Crafter exited successfully but the expected output files are missing.');
      }
      if (stopReason || this.stopping) throw new Error(stopReason || 'Server shutdown interrupted this task.');
      logger.write('[server] Completed: expected output files verified.\n');
      await logger.flush();
      if (stopReason || this.stopping) throw new Error(stopReason || 'Server shutdown interrupted this task.');
      await logger.close();
      if (stopReason || this.stopping) throw new Error(stopReason || 'Server shutdown interrupted this task.');
      finished = true;
      this.store.update(task.id, { status: 'Completed', finishedAt: now(), error: null, processGroupId: null });
    } catch (error) {
      // Includes spawn/persistence failures: never publish terminal state while a
      // previously started child could still be writing into task directories.
      await runner.stop(stopReason || (this.stopping ? 'Server shutdown interrupted this task.' : error.message));
      const reason = clean(stopReason || (this.stopping ? 'Server shutdown interrupted this task.' : error.message), secrets);
      logger.write(`\n[server] Failed: ${reason}\n`);
      try { await this.files.sanitizeOutputs(task.id, secrets); }
      catch { logger.write('[server] Output protection failed; output access remains restricted to safe files.\n'); }
      await logger.flush().catch(() => {});
      this.store.update(task.id, { status: 'Failed', finishedAt: now(), error: reason, processGroupId: null });
    } finally {
      finished = true;
      clearTimeout(deadline);
      clearInterval(monitor);
      clearInterval(logMonitor);
      this.credentials.delete(task.id);
      await logger.close().catch(() => {});
      this.active = null;
      this.changed();
    }
  }

  async withdrawAndDelete(id) {
    const task = this.store.get(id);
    if (!task) throw appError('Task not found.', 404);
    if (ACTIVE.has(task.status) || task.processGroupId || this.activeId === id) throw appError('Tasks cannot be deleted while task processes may still be running.');
    this.store.update(id, { withdrawn: true, waitReason: null });
    this.credentials.delete(id);
    this.changed();
    try {
      await this.files.removeTask(id);
      this.store.remove(id);
      this.changed();
    } catch (error) {
      this.store.update(id, { status: 'Failed', withdrawn: true, finishedAt: now(),
        error: `Deletion could not finish. The task is withdrawn and will not run. Retry deletion: ${error.message}` });
      this.changed();
      throw appError('File cleanup failed. The withdrawn task was retained so deletion can be retried.', 500);
    }
    this.kick();
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.interval);
    if (this.active?.runner) await this.active.runner.stop('Server shutdown interrupted this task.');
    if (this.active?.promise) await this.active.promise;
    this.credentials.clear();
  }
}
