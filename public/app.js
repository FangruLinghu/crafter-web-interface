/* Vanilla browser client. Credentials never enter persistent browser storage. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const activeStatuses = new Set(['Parsing', 'Running Crafter']);
  const finalStatuses = new Set(['Completed', 'Failed']);
  const state = {
    config: null, tasks: [], selectedId: null, selectionVersion: 0,
    rerunId: null, deleteId: null, refreshing: false, submitting: false,
    polling: null, toastTimer: null, lastLog: '', listSignature: '', previewVersion: 0,
  };

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes))) return '—';
    const value = Number(bytes);
    if (value < 1000) return `${value} B`;
    if (value < 1e6) return `${(value / 1e3).toFixed(1)} KB`;
    if (value < 1e9) return `${(value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1)} MB`;
    return `${(value / 1e9).toFixed(1)} GB`;
  }

  function date(value, compact = false) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      ...(compact ? {} : { year: 'numeric' }), month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(parsed);
  }

  function elapsed(task) {
    if (!task.startedAt) return 'Not started';
    const start = new Date(task.startedAt).getTime();
    const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
  }

  function statusBadge(status) {
    const styles = { Queued: 'queued', Parsing: 'parsing', 'Running Crafter': 'running', Completed: 'completed', Failed: 'failed' };
    return node('span', `status ${styles[status] || ''}`, status);
  }

  function notice(id, message, className) {
    const el = $(id);
    el.textContent = message || '';
    el.hidden = !message;
    if (className) el.className = className;
  }

  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', error);
    el.hidden = false;
    state.toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3500);
  }

  function connection(online) {
    $('connection').className = `connection ${online ? 'online' : 'offline'}`;
    $('connection-text').textContent = online ? 'Connected' : 'Disconnected';
  }

  async function api(path, { timeout = 15000, ...options } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        ...options, signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await response.json() : null;
      if (!response.ok) {
        const error = new Error(body?.error?.message || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      connection(true);
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request timed out. Please try again.');
      if (error instanceof TypeError) {
        connection(false);
        throw new Error('Cannot reach the server. Check your connection and try again.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function taskUrl(id, suffix = '') {
    return `/api/tasks/${encodeURIComponent(id)}${suffix}`;
  }

  function readHash() {
    const candidate = new URLSearchParams(location.hash.slice(1)).get('task');
    return candidate && /^[a-zA-Z0-9-]{1,64}$/.test(candidate) ? candidate : null;
  }

  function setSelection(id, updateHash = true) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    state.selectionVersion += 1;
    state.lastLog = '';
    $('logs').textContent = 'Loading logs…';
    $('output-files').replaceChildren();
    delete $('output-files').dataset.signature;
    $('output-count').textContent = '0';
    $('log-truncated').hidden = true;
    if (updateHash) {
      history.replaceState(null, '', id ? `#task=${encodeURIComponent(id)}` : location.pathname + location.search);
    }
    showTask(state.tasks.find((task) => task.id === id));
    renderList();
  }

  function renderList() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const filter = $('status-filter').value;
    const filtered = state.tasks.filter((task) => {
      const matchesStatus = filter === 'all' || (filter === 'active' ? activeStatuses.has(task.status) : task.status === filter);
      return matchesStatus && (!query || `${task.paperName} ${task.id} ${task.model}`.toLocaleLowerCase().includes(query));
    });
    $('history-count').textContent = String(state.tasks.length);
    $('stat-total').textContent = String(state.tasks.length);
    $('stat-queued').textContent = String(state.tasks.filter((task) => task.status === 'Queued').length);
    $('stat-running').textContent = String(state.tasks.filter((task) => activeStatuses.has(task.status)).length);
    $('stat-completed').textContent = String(state.tasks.filter((task) => task.status === 'Completed').length);
    $('stat-failed').textContent = String(state.tasks.filter((task) => task.status === 'Failed').length);
    const signature = JSON.stringify([state.selectedId, query, filter, filtered.map(({ id, paperName, status, createdAt, model }) => [id, paperName, status, createdAt, model])]);
    if (signature === state.listSignature) return;
    state.listSignature = signature;
    const list = $('task-list');
    const previousScroll = list.scrollTop;
    const focusedTask = list.contains(document.activeElement) ? document.activeElement.dataset.taskId : null;
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    if (!filtered.length) {
      const empty = node('div', 'history-empty');
      empty.append(node('span', 'history-empty-icon', '▤'), node('strong', '', state.tasks.length ? 'No matching tasks' : 'No tasks yet'));
      empty.append(node('p', '', state.tasks.length ? 'Try another search or status filter.' : 'Create a task to see your papers and run history here.'));
      list.append(empty);
      return;
    }
    for (const task of filtered) {
      const card = node('button', `task-card${task.id === state.selectedId ? ' selected' : ''}`);
      card.type = 'button';
      card.dataset.taskId = task.id;
      card.setAttribute('aria-pressed', task.id === state.selectedId ? 'true' : 'false');
      card.setAttribute('aria-label', `${task.paperName}, ${task.status}`);
      const title = node('span', 'task-card-name', task.paperName);
      title.title = task.paperName;
      const footer = node('span', 'task-card-footer');
      footer.append(statusBadge(task.status), node('span', 'task-card-date', date(task.createdAt, true)));
      card.append(title, footer, node('span', 'task-card-model', task.model));
      card.addEventListener('click', () => {
        setSelection(task.id);
        void refreshDetail();
      });
      list.append(card);
      if (focusedTask === task.id) card.focus({ preventScroll: true });
    }
    list.scrollTop = previousScroll;
  }

  const STEPS = [
    { status: 'Queued', label: 'Queued' },
    { status: 'Parsing', label: 'Parsing paper' },
    { status: 'Running Crafter', label: 'Generating code' },
    { status: 'Completed', label: 'Completed' },
  ];

  // Each step is done, current, failed or pending. A failed task marks the stage it stopped in;
  // tasks that failed before stages were recorded fall back to marking the last step.
  function stepStates(task) {
    if (task.status === 'Completed') return STEPS.map(() => 'done');
    if (task.status === 'Failed') {
      const stage = task.failedStage || (task.startedAt ? null : 'Queued');
      const index = STEPS.findIndex((step) => step.status === stage);
      if (index === -1) return STEPS.map((_, i) => (i === STEPS.length - 1 ? 'failed' : 'pending'));
      return STEPS.map((_, i) => (i < index ? 'done' : i === index ? 'failed' : 'pending'));
    }
    const index = STEPS.findIndex((step) => step.status === task.status);
    return STEPS.map((_, i) => (i < index ? 'done' : i === index ? 'current' : 'pending'));
  }

  function renderSteps(task) {
    const states = stepStates(task);
    const unknownStage = task.status === 'Failed' && states[STEPS.length - 1] === 'failed';
    const notes = { current: 'In progress', failed: unknownStage ? 'Stage not recorded' : 'Stopped here', done: '', pending: '' };
    const spoken = { done: 'done', current: 'in progress', failed: 'failed', pending: 'not started' };
    $('task-steps').replaceChildren(...STEPS.map((step, i) => {
      const state = states[i];
      const item = node('li', `task-step ${state}`);
      if (state === 'current') item.setAttribute('aria-current', 'step');
      const marker = node('span', 'step-marker', state === 'done' ? '✓' : state === 'failed' ? '✕' : String(i + 1));
      marker.setAttribute('aria-hidden', 'true');
      const label = i === STEPS.length - 1 && unknownStage ? 'Failed' : step.label;
      item.append(marker, node('span', 'step-label', label));
      const note = state === 'current' && step.status === 'Queued' ? 'Waiting' : notes[state];
      if (note) item.append(node('span', 'step-note', note));
      item.append(node('span', 'sr-only', `: ${spoken[state]}`));
      return item;
    }));
  }

  function showTask(task) {
    $('detail-empty').hidden = Boolean(task);
    $('task-detail').hidden = !task;
    if (!task) return;
    $('task-title').textContent = task.paperName;
    $('task-status').replaceChildren(statusBadge(task.status));
    renderSteps(task);
    $('task-id').textContent = `#${task.id.slice(0, 8)}`;
    $('task-id').title = task.id;
    $('task-model').textContent = task.model;
    $('task-model').title = task.model;
    $('task-mode').textContent = task.mode === 'local' ? 'Local vLLM' : 'Remote API';
    $('task-created').textContent = date(task.createdAt);
    $('task-duration').textContent = elapsed(task);
    $('paper-name').textContent = task.paperName;
    $('paper-name').title = task.paperName;
    $('paper-size').textContent = `${formatBytes(task.pdfBytes)} · Original paper`;
    $('view-pdf').href = taskUrl(task.id, '/pdf');
    $('download-pdf').href = taskUrl(task.id, '/pdf?download=1');
    $('download-zip').href = taskUrl(task.id, '/archive.zip');
    const active = activeStatuses.has(task.status);
    const terminal = finalStatuses.has(task.status);
    $('delete-button').disabled = active;
    $('delete-button').title = active ? 'Tasks cannot be deleted during parsing or generation' : task.status === 'Queued' ? 'Withdraw and delete queued task' : 'Delete task';
    $('delete-button').textContent = task.status === 'Queued' ? 'Withdraw' : 'Delete';
    $('live-tag').hidden = !active;
    $('log-status').textContent = active ? 'Receiving execution output' : task.status === 'Queued' ? 'Waiting for the task to start' : 'Retained execution logs';
    const message = task.error || task.waitReason || (task.status === 'Queued' ? 'This task is queued. It will start when earlier tasks finish and resources are available.' : '');
    notice('task-notice', message, `notice task-notice${task.status === 'Failed' ? ' failed' : ''}`);
    if (!terminal) {
      $('output-count').textContent = '0';
      $('download-zip').hidden = true;
      $('outputs-description').textContent = 'Output files are available after execution ends.';
      const message = node('p', 'outputs-empty', 'This task is still pending or running. Output files will be available after execution ends.');
      $('output-files').replaceChildren(message);
    }
  }

  async function refreshDetail() {
    const id = state.selectedId;
    if (!id) return;
    const version = state.selectionVersion;
    const isCurrent = () => state.selectedId === id && state.selectionVersion === version;
    try {
      const { task } = await api(taskUrl(id));
      if (!isCurrent()) return;
      const existing = state.tasks.findIndex((item) => item.id === id);
      if (existing !== -1) state.tasks[existing] = task;
      showTask(task);
      const requests = [api(taskUrl(id, '/logs'))];
      if (finalStatuses.has(task.status)) requests.push(api(taskUrl(id, '/outputs')));
      const [logResult, outputResult] = await Promise.allSettled(requests);
      if (!isCurrent()) return;
      if (logResult.status === 'fulfilled') {
        const { text = '', truncated = false } = logResult.value || {};
        if (text !== state.lastLog || !$('logs').textContent || $('logs').textContent === 'Loading logs…') {
          state.lastLog = text;
          $('logs').textContent = text || 'No logs yet. Execution output will appear here when the task starts.';
          if ($('follow-logs').checked) $('logs').scrollTop = $('logs').scrollHeight;
        }
        $('log-truncated').hidden = !truncated;
      } else {
        $('log-status').textContent = `Logs are temporarily unavailable: ${logResult.reason.message}`;
      }
      if (outputResult?.status === 'fulfilled') renderOutputs(task, outputResult.value);
      else if (outputResult?.status === 'rejected') {
        $('outputs-description').textContent = `Files are temporarily unavailable: ${outputResult.reason.message}`;
        $('download-zip').hidden = true;
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status === 404) {
        setSelection(null);
        toast('This task has been deleted.');
      } else notice('page-error', error.message);
    }
  }

  function renderOutputs(task, result) {
    const files = result?.files || [];
    $('output-count').textContent = String(files.length);
    $('download-zip').hidden = files.length === 0;
    $('outputs-description').textContent = result?.unavailableReason || (result?.partial
      ? 'Partial results from a failed task. These files may be incomplete.'
      : `${files.length} published file${files.length === 1 ? '' : 's'} · Preview text or download`);
    const container = $('output-files');
    const signature = JSON.stringify([task.id, result]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.replaceChildren();
    if (!files.length) {
      container.append(node('p', 'outputs-empty', result?.unavailableReason || (task.status === 'Failed' ? 'This task has no published results. Check the logs for details.' : 'There are no output files to download.')));
      return;
    }
    for (const file of files) {
      const row = node('div', 'output-file');
      const info = node('div', 'output-file-info');
      info.append(node('div', 'output-file-name mono', file.path), node('div', 'output-file-size', formatBytes(file.size)));
      const actions = node('div', 'output-file-actions');
      if (file.previewable) {
        const preview = node('button', 'text-button', 'Preview');
        preview.type = 'button';
        preview.setAttribute('aria-label', `Preview ${file.path}`);
        preview.addEventListener('click', () => { void showPreview(task.id, file.path); });
        actions.append(preview);
      }
      const download = node('a', '', 'Download ↓');
      download.href = taskUrl(task.id, `/file?path=${encodeURIComponent(file.path)}`);
      download.setAttribute('aria-label', `Download ${file.path}`);
      actions.append(download);
      row.append(node('span', 'output-file-icon', file.previewable ? '</>' : '↓'), info, actions);
      container.append(row);
    }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    $('refresh-button').disabled = true;
    try {
      const result = await api('/api/tasks');
      state.tasks = result?.tasks || [];
      notice('page-error', '');
      if (state.selectedId && !state.tasks.some((task) => task.id === state.selectedId)) setSelection(null);
      if (!state.selectedId && state.tasks.length) setSelection(state.tasks[0].id);
      renderList();
      await refreshDetail();
    } catch (error) {
      notice('page-error', error.message);
      $('task-list').setAttribute('aria-busy', 'false');
    } finally {
      state.refreshing = false;
      $('refresh-button').disabled = false;
    }
  }

  function selectTab(name) {
    for (const tabName of ['logs', 'outputs']) {
      const selected = tabName === name;
      $(`tab-${tabName}`).classList.toggle('selected', selected);
      $(`tab-${tabName}`).setAttribute('aria-selected', String(selected));
      $(`tab-${tabName}`).tabIndex = selected ? 0 : -1;
      $(`${tabName}-panel`).hidden = !selected;
    }
  }

  function mode() {
    return $('task-form').elements.mode.value;
  }

  function updateMode() {
    const remote = mode() === 'remote';
    $('remote-fields').hidden = !remote;
    $('local-fields').hidden = remote;
    for (const id of ['base-url', 'model', 'api-key']) {
      $(id).disabled = !remote;
      $(id).required = remote;
    }
    if (!remote) $('api-key').value = '';
    $('local-model').disabled = remote || !(state.config?.localModels?.length);
    $('local-model').required = !remote;
    $('submit-task').disabled = state.submitting || (!remote && !state.config?.localModels?.length);
  }

  function closeTaskDialog() {
    $('api-key').value = '';
    $('task-dialog').close();
  }

  function openTaskForm(task = null) {
    if (state.submitting) { toast('Your task is being submitted. Please wait.'); return; }
    $('task-form').reset();
    $('task-form').querySelectorAll('input, select').forEach((field) => field.setCustomValidity(''));
    state.rerunId = task?.id || null;
    $('form-title').textContent = task ? 'Rerun task' : 'New task';
    $('form-eyebrow').textContent = task ? 'RERUN EXPERIMENT' : 'NEW EXPERIMENT';
    $('form-description').textContent = task ? 'Review the model settings. The new task will copy the original PDF and keep independent records and results.' : 'Submit a paper to start an independent code generation task.';
    $('upload-field').hidden = Boolean(task);
    $('paper').required = !task;
    $('paper').disabled = Boolean(task);
    $('rerun-paper').hidden = !task;
    $('rerun-paper').textContent = task ? `Reuse paper · ${task.paperName}` : '';
    $('upload-label').textContent = 'Choose a PDF';
    $('upload-description').textContent = 'Click to browse, or drop a file here';
    $('submit-task').textContent = task ? 'Create new task ↗' : 'Submit task ↗';
    notice('form-error', '');
    if (task) {
      $('task-form').elements.mode.value = task.mode;
      $('base-url').value = task.baseUrl || '';
      $('model').value = task.model || '';
      $('local-model').value = task.localModelId || '';
    } else if (state.config?.integration?.demo && state.config.localModels?.length) {
      $('task-form').elements.mode.value = 'local';
    }
    updateMode();
    $('task-dialog').showModal();
    if (task && task.mode === 'remote') $('api-key').focus();
  }

  function updateFileLabel() {
    const file = $('paper').files[0];
    $('upload-label').textContent = file ? file.name : 'Choose a PDF';
    $('upload-description').textContent = file ? `${formatBytes(file.size)} · Click to choose another file` : 'Click to browse, or drop a file here';
    notice('form-error', '');
  }

  async function submitTask(event) {
    event.preventDefault();
    if (state.submitting) return;
    const form = $('task-form');
    if (!form.reportValidity()) { $('api-key').value = ''; return; }
    const selectedMode = mode();
    const fields = { mode: selectedMode };
    let body;
    const path = state.rerunId ? taskUrl(state.rerunId, '/rerun') : '/api/tasks';
    try {
      if (selectedMode === 'remote') {
        fields.baseUrl = $('base-url').value.trim();
        fields.model = $('model').value.trim();
        fields.apiKey = $('api-key').value;
      } else fields.localModelId = $('local-model').value;
      if (!state.rerunId) {
        const file = $('paper').files[0];
        if (!file || file.size === 0) throw new Error('Choose a non-empty PDF file.');
        if (!/\.pdf$/i.test(file.name)) throw new Error('Upload a .pdf file.');
        if (file.size > (state.config?.limits?.maxUploadBytes || 75e6)) throw new Error(`The PDF exceeds the upload limit of ${formatBytes(state.config?.limits?.maxUploadBytes || 75e6)}.`);
        body = new FormData();
        body.append('paper', file);
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
      } else body = JSON.stringify(fields);
      // Immediately clear the visible field; the request alone retains the value until it settles.
      $('api-key').value = '';
      delete fields.apiKey;
      state.submitting = true;
      updateMode();
      $('submit-task').textContent = 'Submitting…';
      notice('form-error', '');
      const result = await api(path, {
        method: 'POST', body, timeout: 120000,
        ...(state.rerunId ? { headers: { 'Content-Type': 'application/json' } } : {}),
      });
      closeTaskDialog();
      if (result?.task) {
        state.tasks.unshift(result.task);
        setSelection(result.task.id);
        selectTab('logs');
      }
      toast('Task submitted and added to the queue.');
      await refresh();
    } catch (error) {
      notice('form-error', error.message);
      if (!$('task-dialog').open) toast(error.message, true);
      // A failed request still clears the key so retries require explicit re-entry.
      $('api-key').value = '';
    } finally {
      body = null;
      delete fields.apiKey;
      state.submitting = false;
      $('submit-task').textContent = state.rerunId ? 'Create new task ↗' : 'Submit task ↗';
      updateMode();
    }
  }

  function openDelete() {
    const task = state.tasks.find((item) => item.id === state.selectedId);
    if (!task || activeStatuses.has(task.status)) return;
    state.deleteId = task.id;
    $('delete-title').textContent = task.status === 'Queued' ? 'Withdraw and delete task?' : 'Delete task?';
    $('delete-description').textContent = task.status === 'Queued'
      ? 'This task will be withdrawn from the queue. Its PDF, logs, and record will be permanently deleted.'
      : 'The original PDF, logs, output files, and task record will be permanently deleted. Other tasks will be unaffected.';
    $('delete-paper').textContent = task.paperName;
    notice('delete-error', '');
    $('confirm-delete').disabled = false;
    $('delete-dialog').showModal();
    $('delete-dialog').querySelector('[data-close-delete]').focus();
  }

  async function deleteTask(event) {
    event.preventDefault();
    const id = state.deleteId;
    if (!id) return;
    $('confirm-delete').disabled = true;
    try {
      await api(taskUrl(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }), timeout: 30000 });
      $('delete-dialog').close();
      state.deleteId = null;
      state.tasks = state.tasks.filter((task) => task.id !== id);
      if (state.selectedId === id) setSelection(null);
      toast('The task and its files have been deleted.');
      await refresh();
    } catch (error) {
      notice('delete-error', error.message);
    } finally {
      $('confirm-delete').disabled = false;
    }
  }

  async function showPreview(id, path) {
    const version = ++state.previewVersion;
    $('preview-title').textContent = path;
    $('preview-content').textContent = 'Loading file…';
    $('preview-notice').hidden = true;
    $('preview-dialog').showModal();
    try {
      const result = await api(taskUrl(id, `/preview?path=${encodeURIComponent(path)}`));
      if (state.previewVersion !== version || !$('preview-dialog').open) return;
      $('preview-content').textContent = result.text || '(Empty file)';
      $('preview-notice').textContent = 'This file exceeds the preview limit. Only the beginning is shown; download it to view the full content.';
      $('preview-notice').hidden = !result.truncated;
    } catch (error) {
      if (state.previewVersion === version) $('preview-content').textContent = error.message;
    }
  }

  function downloadLogs() {
    if (!state.selectedId) return;
    const blob = new Blob([state.lastLog], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = node('a');
    anchor.href = url;
    anchor.download = `${state.selectedId}.log`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function initialize() {
    document.querySelectorAll('[data-new-task]').forEach((el) => el.addEventListener('click', () => openTaskForm()));
    document.querySelectorAll('[data-close-task]').forEach((el) => el.addEventListener('click', closeTaskDialog));
    document.querySelectorAll('[data-close-delete]').forEach((el) => el.addEventListener('click', () => $('delete-dialog').close()));
    $('task-dialog').addEventListener('close', () => { $('api-key').value = ''; });
    $('task-dialog').addEventListener('cancel', () => { $('api-key').value = ''; });
    const requiredMessages = {
      paper: 'Choose one PDF file.',
      'base-url': 'Enter the API base URL.',
      model: 'Enter a model name.',
      'api-key': 'Enter your API key.',
      'local-model': 'Choose an available lab model.',
    };
    // Explicit messages keep validation in English regardless of browser locale.
    $('task-form').addEventListener('invalid', (event) => {
      const field = event.target;
      if (!field.validity) return;
      const message = field.validity.valueMissing ? requiredMessages[field.id] || 'Complete this field.'
        : field.validity.typeMismatch ? 'Enter a valid URL, such as https://api.example.com/v1.'
        : field.validity.tooLong ? `Use no more than ${field.maxLength} characters.`
        : 'Check this field and try again.';
      field.setCustomValidity(message);
      $('api-key').value = '';
    }, true);
    $('task-form').querySelectorAll('input, select').forEach((field) => {
      const clearValidation = () => field.setCustomValidity('');
      field.addEventListener('input', clearValidation);
      field.addEventListener('change', clearValidation);
    });
    $('task-form').addEventListener('submit', submitTask);
    $('delete-form').addEventListener('submit', deleteTask);
    $('task-form').querySelectorAll('[name="mode"]').forEach((el) => el.addEventListener('change', updateMode));
    $('paper').addEventListener('change', updateFileLabel);
    $('search').addEventListener('input', renderList);
    $('status-filter').addEventListener('change', renderList);
    $('refresh-button').addEventListener('click', () => { void refresh(); });
    $('delete-button').addEventListener('click', openDelete);
    $('rerun-button').addEventListener('click', () => {
      const task = state.tasks.find((item) => item.id === state.selectedId);
      if (task) openTaskForm(task);
    });
    $('download-logs').addEventListener('click', downloadLogs);
    $('close-preview').addEventListener('click', () => $('preview-dialog').close());
    $('preview-dialog').addEventListener('close', () => { state.previewVersion += 1; $('preview-content').textContent = ''; });
    for (const tab of ['logs', 'outputs']) {
      $(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
      $(`tab-${tab}`).addEventListener('keydown', (event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const target = event.key === 'Home' ? 'logs' : event.key === 'End' ? 'outputs' : tab === 'logs' ? 'outputs' : 'logs';
          selectTab(target);
          $(`tab-${target}`).focus();
        }
      });
    }
    const zone = $('upload-zone');
    for (const eventName of ['dragover', 'dragenter']) zone.addEventListener(eventName, (event) => {
      event.preventDefault(); zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      if (event.dataTransfer.files.length !== 1) { notice('form-error', 'Each task accepts exactly one PDF.'); return; }
      $('paper').files = event.dataTransfer.files;
      updateFileLabel();
    });
    addEventListener('hashchange', () => {
      const id = readHash();
      if (id) { setSelection(id, false); void refreshDetail(); }
    });
    addEventListener('pageshow', () => { $('api-key').value = ''; });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refresh();
    });
    addEventListener('pagehide', () => { $('api-key').value = ''; });
    try {
      state.config = await api('/api/config');
      const { integration = {}, limits = {}, localModels = [] } = state.config;
      const integrationMessage = integration.demo
        ? integration.message || 'Demo mode: test scripts run the workflow without calling a model or the real Crafter engine, so no paper is implemented.'
        : integration.adapter === 'ptc' ? integration.message
        : !integration.ready ? integration.message || 'Crafter is not configured. Ask your administrator to connect the real preprocessing and Crafter scripts.' : '';
      notice('integration-banner', integrationMessage, `notice integration-notice${integration.demo ? ' demo' : ''}`);
      $('upload-limit').textContent = formatBytes(limits.maxUploadBytes || 75e6);
      $('local-model').replaceChildren();
      if (!localModels.length) {
        const option = node('option', '', 'No local models configured');
        option.value = '';
        $('local-model').append(option);
        $('local-help').textContent = 'No vLLM models are available. Ask your administrator to configure one.';
      } else for (const model of localModels) {
        const option = node('option', '', `${model.label || model.model}${model.label && model.label !== model.model ? ` · ${model.model}` : ''}`);
        option.value = model.id;
        $('local-model').append(option);
      }
      const interval = Math.min(5000, Math.max(1000, Number(limits.pollIntervalMs) || 2000));
      $('poll-seconds').textContent = String(interval / 1000);
      const hashId = readHash();
      if (hashId) state.selectedId = hashId;
      await refresh();
      state.polling = setInterval(() => { if (!document.hidden) void refresh(); }, interval);
    } catch (error) {
      notice('page-error', error.message);
      $('task-list').setAttribute('aria-busy', 'false');
      // Retry both configuration and task reads after a server start or restart.
      setTimeout(() => { location.reload(); }, 15000);
    }
  }

  void initialize();
})();
