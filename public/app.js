'use strict';

const state = {
  csrfToken: '',
  user: null,
  routines: [],
  stats: {},
  google: { connected: false },
  activePage: 'dashboard',
  routineFilter: 'all',
  selectedType: 'frequency',
  selectedColor: 'lavender',
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calendarEvents: [],
  calendarWarning: null,
  selectedCalendarEvent: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const colorSymbols = { lavender: '✧', mint: '✿', peach: '☼', blue: '◈', rose: '♡', gold: '✦' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function localDateInput(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseDateText(value) {
  const text = String(value || '').trim();
  let year, month, day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (!match) return null;
    [, day, month, year] = match;
  }
  const y = Number(year), m = Number(month), d = Number(day);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function formatDateText(value) {
  const key = parseDateText(value) || dateKey(value);
  if (!key) return String(value || '');
  const [year, month, day] = key.split('-');
  return `${day}-${month}-${year}`;
}
function dateInputToIso(value) {
  const key = parseDateText(value);
  return key ? `${key}T00:00:00.000Z` : null;
}
function formatDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return new Intl.DateTimeFormat(undefined, options).format(date);
}
function formatLongDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
function dateKey(value) {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = parseDateText(s);
  if (parsed) return parsed;
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return '';
  return localDateInput(date);
}
function timeAgo(value) {
  if (!value) return 'Not synced yet';
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return 'Not synced yet';
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
function unitText(unit) {
  return ({ days: 'day', weeks: 'week', months: 'month', years: 'year' })[unit] || unit || 'period';
}
function dueDescription(routine) {
  if (!routine.next_due_at) return 'Due now';
  if (routine.daysUntilDue < 0) {
    const days = Math.abs(routine.daysUntilDue);
    return `Overdue by ${days} day${days === 1 ? '' : 's'}`;
  }
  if (routine.daysUntilDue === 0) return 'Due today';
  if (routine.daysUntilDue === 1) return 'Due tomorrow';
  return `Due in ${routine.daysUntilDue} days`;
}
function periodLabel(routine) {
  return `${routine.min_count}${routine.max_count > routine.min_count ? `–${routine.max_count}` : ''} times / ${routine.period_value} ${unitText(routine.period_unit)}`;
}
function toast(message, type = 'success') {
  const region = $('#toastRegion');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  region.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}
function setSyncState(status, label) {
  const el = $('#syncIndicator');
  el.classList.toggle('syncing', status === 'syncing');
  el.classList.toggle('error', status === 'error');
  $('#syncText').textContent = label;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase()) && state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

async function loadBootstrap(showError = true) {
  try {
    const data = await api('/api/bootstrap');
    state.csrfToken = data.csrfToken;
    state.user = data.user;
    state.routines = data.routines || [];
    state.stats = data.stats || {};
    state.google = data.google || { connected: false };
    renderAll();
    if (state.activePage === 'calendar') loadCalendar();
    setSyncState('saved', state.google.connected ? 'Saved · Google connected' : 'Saved on this server');
  } catch (error) {
    if (showError) toast(error.message, 'error');
    setSyncState('error', 'Could not load data');
  }
}

function renderProfile() {
  const user = state.user || {};
  const name = user.display_name || 'Your space';
  const email = user.email || (user.googleConnected ? 'Google account' : 'Local workspace');
  const initial = (name.trim()[0] || 'Y').toUpperCase();
  const sidebarName = $('#sidebarName');
  const sidebarEmail = $('#sidebarEmail');
  const sidebarAvatar = $('#sidebarAvatar');
  const mobileAvatar = $('#mobileHeaderAvatar');
  if (sidebarName) sidebarName.textContent = name;
  if (sidebarEmail) sidebarEmail.textContent = email;
  [sidebarAvatar, mobileAvatar].filter(Boolean).forEach((avatar) => {
    avatar.textContent = initial;
    if (user.picture) avatar.innerHTML = `<img src="${escapeHtml(user.picture)}" alt="">`;
  });
  const badge = $('#navRoutineCount');
  const count = Number(state.stats?.routineCount ?? state.routines.length);
  if (badge) badge.textContent = String(Number.isFinite(count) ? count : state.routines.length);
}

function renderStats() {
  $('#statDue').textContent = String(state.stats.dueCount || 0);
  $('#statDone').textContent = String(state.stats.completedThisMonth || 0);
  $('#statTargets').textContent = String(state.stats.targetsMet || 0);
  $('#statRoutines').textContent = String(state.stats.routineCount ?? state.routines.length ?? 0);
}

function routineStatusText(routine) {
  if (routine.type === 'frequency') {
    if (routine.maximumReached) return 'Target complete';
    if (!routine.checkinAvailable) return `Next check-in unlocks ${formatDate(routine.nextOpportunityAt, { day: 'numeric', month: 'short' })}`;
    if (routine.minimumReached) return 'Minimum reached';
    return `${routine.remainingMinimum} more to reach minimum`;
  }
  return dueDescription(routine);
}
function routineCard(routine) {
  const color = escapeHtml(routine.color || 'lavender');
  const symbol = colorSymbols[routine.color] || '✧';
  const isFrequency = routine.type === 'frequency';
  const progress = isFrequency ? (routine.progress || 0) : 0;
  const completed = isFrequency && routine.maximumReached;
  const canComplete = isFrequency ? Boolean(routine.checkinAvailable) : Boolean(routine.isDue);
  const statusGood = isFrequency ? routine.minimumReached : !routine.isDue;
  const status = routineStatusText(routine);
  const actionLabel = completed ? 'All done' : isFrequency ? (canComplete ? 'Log a check-in' : 'Not unlocked') : (routine.isDue ? 'Mark complete' : 'Not due yet');
  return `
    <article class="routine-card ${color}" data-routine-card="${escapeHtml(routine.id)}">
      <div class="routine-top">
        <div class="routine-symbol ${color}">${symbol}</div>
        <div class="routine-title-wrap"><h3 title="${escapeHtml(routine.title)}">${escapeHtml(routine.title)}</h3><p>${escapeHtml(isFrequency ? 'Frequency target' : routine.linked_to_routine_id ? 'Linked routine' : 'Repeat after completion')}</p></div>
        <button class="routine-menu" type="button" data-action="edit" data-id="${escapeHtml(routine.id)}" aria-label="Edit ${escapeHtml(routine.title)}" title="Edit">✎</button>
        <button class="routine-menu" type="button" data-action="archive" data-id="${escapeHtml(routine.id)}" aria-label="Archive ${escapeHtml(routine.title)}" title="Archive">×</button>
      </div>
      <div class="routine-meta"><span>${escapeHtml(isFrequency ? periodLabel(routine) : routine.cadenceLabel)}</span><strong>${escapeHtml(isFrequency ? `${routine.completedCount}/${routine.max_count}` : routine.daysUntilDue < 0 ? `${Math.abs(routine.daysUntilDue)}d late` : routine.daysUntilDue === 0 ? 'Today' : routine.daysUntilDue > 0 ? `${routine.daysUntilDue}d` : '—')}</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${isFrequency ? progress : (routine.isDue ? 100 : Math.max(8, Math.min(100, 100 - routine.daysUntilDue * 5)))}%"></div></div>
      <div class="routine-card-footer"><span class="routine-status"><i class="status-dot ${statusGood ? 'good' : ''}"></i>${escapeHtml(status)}</span><button class="routine-action" type="button" data-action="complete" data-id="${escapeHtml(routine.id)}" ${!canComplete || completed ? 'disabled' : ''}>${actionLabel} ${completed ? '✓' : '→'}</button></div>
    </article>`;
}

function renderChecklist() {
  const items = state.routines.filter((r) => r.type === 'frequency' ? r.checkinAvailable : r.isDue)
    .sort((a, b) => (a.type === 'interval' ? 0 : 1) - (b.type === 'interval' ? 0 : 1) || (a.title || '').localeCompare(b.title || ''));
  $('#checklistCount').textContent = String(items.length);
  if (!items.length) {
    $('#checklistList').innerHTML = `<div class="checklist-empty"><div class="empty-check-icon">✓</div><div><strong>You're all caught up.</strong><small>No routines need your attention right now.</small></div></div>`;
    return;
  }
  $('#checklistList').innerHTML = items.map((r) => {
    const isFrequency = r.type === 'frequency';
    const info = isFrequency
      ? `${r.completedCount}/${r.max_count} completed this period${r.minimumReached ? ' · minimum reached' : ` · ${r.remainingMinimum} more for minimum`}`
      : `${dueDescription(r)} · ${r.cadenceLabel}`;
    const label = isFrequency ? 'Check in' : 'Mark done';
    return `<article class="checklist-card"><div class="check-spot ${escapeHtml(r.color)}">${colorSymbols[r.color] || '✧'}</div><div class="check-info"><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(info)}</small></div><button class="check-action" data-action="complete" data-id="${escapeHtml(r.id)}">${label} <span>→</span></button></article>`;
  }).join('');
}

function renderRoutineGrids() {
  const cards = state.routines.map(routineCard).join('');
  $('#dashboardRoutineGrid').innerHTML = cards || `<div class="routine-grid-empty"><div>✧</div><strong>Your routine space is ready.</strong><span>Start with one small thing you'd like to make room for.</span><br><button class="primary-button" data-action="new-routine">Create your first routine <span>＋</span></button></div>`;
  const filtered = state.routines.filter((r) => state.routineFilter === 'all' || r.type === state.routineFilter);
  $('#allRoutineGrid').innerHTML = filtered.map(routineCard).join('') || `<div class="routine-grid-empty"><div>✧</div><strong>${state.routines.length ? 'No routines in this view.' : 'Nothing here just yet.'}</strong><span>${state.routines.length ? 'Try a different filter.' : 'Create a routine to begin your own rhythm.'}</span><br>${state.routines.length ? '' : '<button class="primary-button" data-action="new-routine">Create a routine <span>＋</span></button>'}</div>`;
  $('#routineResultCount').textContent = `${filtered.length} routine${filtered.length === 1 ? '' : 's'}`;
}

function renderGoogleSettings() {
  const google = state.google || {};
  const connected = Boolean(google.connected);
  $('#googleStatusPill').textContent = connected ? 'Connected' : 'Not connected';
  $('#googleStatusPill').classList.toggle('connected', connected);
  $('#googleConnectButton').hidden = connected;
  $('#googleConnectButton').textContent = 'Connect Google ↗';
  $('#googleConnectButton').href = '/auth/google';
  $('#googleSwitchButton').hidden = !connected;
  $('#googleSwitchButton').textContent = 'Switch account';
  $('#googleUnlinkButton').hidden = !connected;
  $('#connectedAccount').hidden = !connected;
  if (connected) {
    const picture = google.picture ? `<img src="${escapeHtml(google.picture)}" alt="">` : `<div class="avatar">G</div>`;
    $('#connectedAccount').innerHTML = `${picture}<div><strong>${escapeHtml(google.displayName || 'Google account')}</strong><small>${escapeHtml(google.email || '')}</small></div>`;
  }
  $('#driveSyncButton').disabled = !connected;
  $('#driveRestoreButton').disabled = !connected;
  $('#calendarSyncButton').disabled = !connected;
  $('#driveStatus').textContent = connected ? (google.lastDriveSync ? `Last sync ${timeAgo(google.lastDriveSync)}` : 'Ready to sync') : 'Waiting for Google';
  $('#driveStatus').classList.toggle('ready', connected);
  $('#calendarStatus').textContent = connected ? (google.lastCalendarSync ? 'Syncing automatically' : 'Connected · first sync') : 'Not connected';
  $('#calendarStatus').classList.toggle('ready', connected);
  $('#calendarSyncText').textContent = connected
    ? `Primary calendar refreshed ${timeAgo(google.lastCalendarSync)}. Automatic refresh runs every few minutes.`
    : 'Connect Google to start syncing your primary calendar.';
}

function renderAll() {
  renderProfile();
  renderStats();
  renderChecklist();
  renderRoutineGrids();
  renderGoogleSettings();
}

function setPage(page) {
  if (!['dashboard', 'calendar', 'routines', 'history', 'settings'].includes(page)) page = 'dashboard';
  state.activePage = page;
  $$('.page-view').forEach((view) => view.classList.toggle('active', view.id === `page-${page}`));
  $$('.nav-item[data-page], .mobile-nav-item[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const label = ({ dashboard: 'Overview', calendar: 'Calendar', routines: 'All routines', history: 'Activity', settings: 'Settings & sync' })[page];
  $('#breadcrumbCurrent').textContent = label;
  $('#sidebar').classList.remove('open');
  $('#mobileMenuButton')?.setAttribute('aria-expanded', 'false');
  if (page === 'calendar') loadCalendar();
  if (page === 'history') loadHistory();
  if (page === 'settings') renderGoogleSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadCalendar() {
  const month = `${state.calendarMonth.getFullYear()}-${String(state.calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  $('#calendarMonthTitle').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(state.calendarMonth);
  $('#calendarGrid').innerHTML = '<div class="calendar-empty">Loading your month…</div>';
  try {
    const data = await api(`/api/calendar?month=${encodeURIComponent(month)}`);
    state.calendarEvents = data.events || [];
    state.calendarWarning = data.syncWarning;
    renderCalendarGrid();
    $('#calendarFootnote').textContent = data.syncWarning
      ? `Calendar sync needs attention: ${data.syncWarning}`
      : state.google.connected
        ? `Google Calendar refreshed ${timeAgo(data.googleLastSync)}. Your routine dates are shown here, too.`
        : 'Connect Google in Settings to display your primary Google Calendar events here.';
  } catch (error) {
    $('#calendarGrid').innerHTML = `<div class="calendar-empty">${escapeHtml(error.message)}</div>`;
  }
}
function renderCalendarGrid() {
  const first = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  const grouped = new Map();
  for (const event of state.calendarEvents) {
    const key = dateKey(event.start);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const todayKey = localDateInput();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = localDateInput(day);
    const events = grouped.get(key) || [];
    const visible = events.slice(0, 3);
    const more = events.length - visible.length;
    const eventMarkup = visible.map((event) => `<button type="button" class="calendar-event ${escapeHtml(event.kind)}" data-calendar-event="${escapeHtml(event.id)}" title="Open ${escapeHtml(event.title)}">${escapeHtml(event.title)}</button>`).join('');
    cells.push(`<div class="calendar-day ${day.getMonth() !== state.calendarMonth.getMonth() ? 'outside' : ''} ${key === todayKey ? 'today' : ''}"><span class="day-number">${day.getDate()}</span>${eventMarkup}${more > 0 ? `<div class="calendar-more">+${more} more</div>` : ''}</div>`);
  }
  $('#calendarGrid').innerHTML = cells.join('');
}

async function loadHistory() {
  $('#historyList').innerHTML = '<div class="history-empty">Loading activity…</div>';
  try {
    const data = await api('/api/history?limit=100');
    const rows = data.history || [];
    if (!rows.length) {
      $('#historyList').innerHTML = '<div class="history-empty">Your completed routines will appear here. Your first check-in is a good place to start.</div>';
      return;
    }
    $('#historyList').innerHTML = rows.map((row) => `<div class="history-entry"><div class="history-mark">✓</div><div class="history-entry-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.note || 'Routine completed')}</small></div><div class="history-date">${formatDate(row.completed_at, { day: 'numeric', month: 'short' })} · ${formatDate(row.completed_at, { hour: 'numeric', minute: '2-digit' })}</div><button class="history-delete" type="button" data-action="delete-activity" data-id="${escapeHtml(row.id)}" aria-label="Delete activity" title="Delete activity">×</button></div>`).join('');
  } catch (error) {
    $('#historyList').innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function deleteActivity(id) {
  if (!confirm('Delete this activity? This will remove it from your history and update routine progress.')) return;
  try { await api(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadBootstrap(); await loadHistory(); if (state.activePage === 'calendar') await loadCalendar(); toast('Activity deleted.'); }
  catch (error) { toast(error.message, 'error'); }
}

function setSelectedType(type) {
  state.selectedType = type;
  $$('.type-option').forEach((button) => button.classList.toggle('active', button.dataset.type === type));
  $('#frequencyFields').hidden = type !== 'frequency';
  $('#intervalFields').hidden = type !== 'interval';
}
function setSelectedColor(color) {
  state.selectedColor = color;
  $$('.color-choice').forEach((button) => button.classList.toggle('selected', button.dataset.color === color));
}
function toggleLastDoneFields() {
  const hasLast = $('#hasLastDone').checked;
  $('#lastDoneWrap').hidden = !hasLast;
  $('#firstDueWrap').hidden = hasLast;
}
function fillLinkedRoutineOptions(routine = null) {
  const select = $('#linkedRoutine');
  const choices = state.routines.filter((r) => r.type === 'interval' && !r.linked_to_routine_id && !r.archived && r.id !== routine?.id);
  select.innerHTML = '<option value="">Choose a repeat-after routine</option>' + choices.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.title)} · ${escapeHtml(r.cadenceLabel)}</option>`).join('');
  if (routine?.linked_to_routine_id) select.value = routine.linked_to_routine_id;
}
function toggleLinkedFields() {
  const linked = $('#linkedEnabled').checked;
  $('#linkedFields').hidden = !linked;
  $('#intervalRegularFields').hidden = linked;
}
function openRoutineModal(routine = null) {
  $('#routineForm').reset();
  $('#routineId').value = routine?.id || '';
  $('#modalTitle').textContent = routine ? 'Edit routine' : 'Create a routine';
  $('#routineTitle').value = routine?.title || '';
  $('#routineNotes').value = routine?.notes || '';
  const type = routine?.type || 'frequency';
  setSelectedType(type);
  setSelectedColor(routine?.color || 'lavender');
  const today = formatDateText(localDateInput());
  $('#minCount').value = routine?.min_count ?? 2;
  $('#maxCount').value = routine?.max_count ?? 3;
  $('#periodValue').value = routine?.period_value ?? 1;
  $('#periodUnit').value = routine?.period_unit || 'weeks';
  $('#progressive').checked = routine?.progressive !== false && routine?.progressive !== 0;
  $('#startAt').value = routine?.start_at ? formatDateText(dateKey(routine.start_at)) : today;
  $('#intervalValue').value = routine?.interval_value ?? 2;
  $('#intervalUnit').value = routine?.interval_unit || 'weeks';
  const hasLast = routine ? Boolean(routine.last_completed_at) : true;
  $('#hasLastDone').checked = hasLast;
  $('#lastCompletedAt').value = routine?.last_completed_at ? formatDateText(dateKey(routine.last_completed_at)) : today;
  $('#firstDueAt').value = routine?.next_due_at ? formatDateText(dateKey(routine.next_due_at)) : today;
  $('#linkedEnabled').checked = Boolean(routine?.linked_to_routine_id);
  fillLinkedRoutineOptions(routine);
  const offset = Number(routine?.linked_offset_days ?? -1);
  $('#linkedDirection').value = offset < 0 ? 'before' : 'after';
  $('#linkedDays').value = Math.abs(offset);
  toggleLinkedFields();
  toggleLastDoneFields();
  $$('.type-option').forEach((button) => { button.disabled = Boolean(routine); button.style.opacity = routine ? '.65' : '1'; });
  $('#routineModal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#routineTitle').focus(), 40);
}

function closeRoutineModal() {
  $('#routineModal').hidden = true;
  document.body.style.overflow = '';
  $$('.type-option').forEach((button) => { button.disabled = false; button.style.opacity = '1'; });
}

async function saveRoutine(event) {
  event.preventDefault();
  const id = $('#routineId').value;
  const title = $('#routineTitle').value.trim();
  if (!title) return toast('Give your routine a name first.', 'error');
  let body = { title, notes: $('#routineNotes').value, color: state.selectedColor, type: state.selectedType };
  if (state.selectedType === 'frequency') {
    const startAt = dateInputToIso($('#startAt').value);
    if (!startAt) return toast('Enter the start date as DD-MM-YYYY or choose it from the calendar.', 'error');
    body = { ...body, minCount: Number($('#minCount').value), maxCount: Number($('#maxCount').value), progressive: $('#progressive').checked,
      periodValue: Number($('#periodValue').value), periodUnit: $('#periodUnit').value, startAt };
  } else {
    const linked = $('#linkedEnabled').checked;
    body = { ...body, intervalValue: Number($('#intervalValue').value), intervalUnit: $('#intervalUnit').value,
      linkedToRoutineId: linked ? $('#linkedRoutine').value : null,
      linkedOffsetDays: ( $('#linkedDirection').value === 'before' ? -1 : 1) * Number($('#linkedDays').value || 0) };
    if (linked && !body.linkedToRoutineId) return toast('Choose the routine this task should follow.', 'error');
    if (!linked && $('#hasLastDone').checked) {
      const lastCompletedAt = dateInputToIso($('#lastCompletedAt').value);
      if (!lastCompletedAt) return toast('Enter the last-completed date as DD-MM-YYYY.', 'error');
      body.lastCompletedAt = lastCompletedAt;
    } else if (!linked) {
      const nextDueAt = dateInputToIso($('#firstDueAt').value);
      if (!nextDueAt) return toast('Enter the first due date as DD-MM-YYYY.', 'error');
      body.nextDueAt = nextDueAt;
    }
  }
  const button = $('#saveRoutineButton');
  button.disabled = true;
  button.textContent = 'Saving…';
  setSyncState('syncing', 'Saving your routine');
  try {
    await api(id ? `/api/routines/${encodeURIComponent(id)}` : '/api/routines', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    closeRoutineModal();
    await loadBootstrap();
    if (state.activePage === 'calendar') await loadCalendar();
    toast(id ? 'Routine updated.' : 'A new routine is in your space.');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = 'Save routine <span>→</span>'; }
}

async function completeRoutine(id) {
  const routine = state.routines.find((r) => r.id === id);
  if (!routine) return;
  setSyncState('syncing', 'Saving your check-in');
  try {
    await api(`/api/routines/${encodeURIComponent(id)}/complete`, { method: 'POST', body: JSON.stringify({}) });
    await loadBootstrap();
    if (state.activePage === 'calendar') await loadCalendar();
    toast(`${routine.title} checked off. Nice work.`);
  } catch (error) { toast(error.message, 'error'); setSyncState('error', 'Save failed'); }
}
async function archiveRoutine(id) {
  const routine = state.routines.find((r) => r.id === id);
  if (!routine || !confirm(`Archive “${routine.title}”? Its history will be kept.`)) return;
  try {
    await api(`/api/routines/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadBootstrap();
    toast('Routine archived. Its check-in history is preserved.');
  } catch (error) { toast(error.message, 'error'); }
}

function openCalendarEvent(event) {
  state.selectedCalendarEvent = event;
  $('#calendarEventTitle').textContent = event.title;
  const isCompletion = event.kind === 'completion';
  const isGoogle = event.kind === 'google';
  const isDue = event.kind === 'due' || event.kind === 'frequency';
  $('#calendarEventDescription').textContent = isGoogle ? (event.location || 'Google Calendar event') : isCompletion ? 'Edit the date of this completed activity or remove it from your history.' : event.kind === 'frequency' ? (event.available ? 'Your Progressive check-in is unlocked. Complete it when you are ready.' : 'This Progressive check-in appears here in advance and unlocks at its scheduled point in the period.') : event.linked ? 'This task follows another routine. Its date moves automatically when the linked routine is rescheduled.' : 'Complete this task when it is due, or change its scheduled date.';
  const canEditDate = isCompletion || (event.kind === 'due' && !event.linked);
  $('#calendarActionDateLabel').textContent = isCompletion ? 'Completion date' : 'Scheduled date';
  $('#calendarActionDateLabel').hidden = !canEditDate;
  $('#calendarActionDate').value = formatDateText(dateKey(event.start));
  const dateWrap = $('#calendarActionDate').closest('.date-entry-wrap') || $('#calendarActionDate');
  dateWrap.hidden = !canEditDate;
  $('#calendarEventComplete').hidden = !isDue;
  $('#calendarEventComplete').disabled = (isDue && event.available === false) || isGoogle;
  $('#calendarEventComplete').textContent = event.kind === 'frequency' ? 'Check in now' : 'Mark complete';
  $('#calendarEventSaveDate').hidden = !canEditDate;
  $('#calendarEventDelete').hidden = !isCompletion;
  $('#calendarEventOpen').hidden = !isGoogle || !event.url;
  if (event.url) $('#calendarEventOpen').href = event.url;
  $('#calendarEventModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeCalendarEvent() {
  $('#calendarEventModal').hidden = true;
  state.selectedCalendarEvent = null;
  if ($('#routineModal').hidden) document.body.style.overflow = '';
}
async function saveCalendarEventDate() {
  const event = state.selectedCalendarEvent;
  const completedAt = dateInputToIso($('#calendarActionDate').value);
  if (!event || !completedAt) return toast('Enter a valid date as DD-MM-YYYY.', 'error');
  try {
    if (event.kind === 'completion') {
      await api(`/api/completions/${encodeURIComponent(event.completionId)}`, { method: 'PATCH', body: JSON.stringify({ completedAt }) });
    } else if (event.kind === 'due') {
      await api(`/api/routines/${encodeURIComponent(event.routineId)}/reschedule`, { method: 'PATCH', body: JSON.stringify({ nextDueAt: completedAt }) });
    }
    closeCalendarEvent();
    await loadBootstrap();
    await loadCalendar();
    if (state.activePage === 'history') await loadHistory();
    toast(event.kind === 'completion' ? 'Completion date updated.' : 'Task date updated.');
  } catch (error) { toast(error.message, 'error'); }
}
async function completeCalendarEvent() {
  const event = state.selectedCalendarEvent;
  if (!event?.routineId) return;
  const id = event.routineId;
  closeCalendarEvent();
  await completeRoutine(id);
}
async function deleteCalendarActivity() {
  const event = state.selectedCalendarEvent;
  if (!event?.completionId) return;
  if (!confirm('Delete this completion from your activity and update routine progress?')) return;
  try {
    await api(`/api/history/${encodeURIComponent(event.completionId)}`, { method: 'DELETE' });
    closeCalendarEvent();
    await loadBootstrap();
    await loadCalendar();
    await loadHistory();
    toast('Activity deleted.');
  } catch (error) { toast(error.message, 'error'); }
}

function renderDatePopover(input, popover) {
  const key = parseDateText(input.value) || localDateInput();
  const [y, m] = (popover.dataset.month || key).split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(y, m - 1, 1 - offset);
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(first);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dayKey = localDateInput(day);
    days.push(`<button type="button" class="date-picker-day ${day.getMonth() !== first.getMonth() ? 'outside' : ''} ${dayKey === key ? 'selected' : ''} ${dayKey === localDateInput() ? 'today' : ''}" data-date-choice="${dayKey}">${day.getDate()}</button>`);
  }
  popover.dataset.month = `${y}-${String(m).padStart(2, '0')}`;
  popover.innerHTML = `<div class="date-picker-head"><button type="button" data-date-month="-1" aria-label="Previous month">‹</button><strong>${escapeHtml(monthName)}</strong><button type="button" data-date-month="1" aria-label="Next month">›</button></div><div class="date-picker-weekdays"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div><div class="date-picker-days">${days.join('')}</div>`;
}
function setupDateInputs() {
  $$('input[data-date-field]').forEach((input) => {
    if (input.dataset.dateReady) return;
    input.dataset.dateReady = '1';
    const wrap = document.createElement('div');
    wrap.className = 'date-entry-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const popover = document.createElement('div');
    popover.className = 'date-picker-popover';
    popover.hidden = true;
    wrap.appendChild(popover);
    const open = () => {
      $$('.date-picker-popover').forEach((item) => { if (item !== popover) item.hidden = true; });
      const key = parseDateText(input.value) || localDateInput();
      popover.dataset.month = key.slice(0, 7);
      renderDatePopover(input, popover);
      popover.hidden = false;
    };
    input.addEventListener('click', open);
    input.addEventListener('focus', open);
    input.addEventListener('input', () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return;
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = digits.length > 4 ? `${digits.slice(0,2)}-${digits.slice(2,4)}-${digits.slice(4)}`
        : digits.length > 2 ? `${digits.slice(0,2)}-${digits.slice(2)}` : digits;
    });
    input.addEventListener('blur', () => {
      const parsed = parseDateText(input.value);
      if (parsed) input.value = formatDateText(parsed);
    });
    popover.addEventListener('mousedown', (event) => event.preventDefault());
    popover.addEventListener('click', (event) => {
      const monthButton = event.target.closest('[data-date-month]');
      if (monthButton) {
        const [year, month] = popover.dataset.month.split('-').map(Number);
        const next = new Date(year, month - 1 + Number(monthButton.dataset.dateMonth), 1);
        popover.dataset.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
        renderDatePopover(input, popover);
        return;
      }
      const dayButton = event.target.closest('[data-date-choice]');
      if (dayButton) {
        input.value = formatDateText(dayButton.dataset.dateChoice);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        popover.hidden = true;
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('.date-entry-wrap')) return;
    $$('.date-picker-popover').forEach((popover) => { popover.hidden = true; });
  });
}

async function driveSync() {
  const button = $('#driveSyncButton');
  button.disabled = true;
  button.textContent = 'Syncing…';
  setSyncState('syncing', 'Backing up to Drive');
  try {
    const data = await api('/api/drive/sync', { method: 'POST', body: JSON.stringify({}) });
    toast(`Drive backup updated · ${data.result.routineCount} routines saved.`);
    await loadBootstrap();
  } catch (error) { toast(error.message, 'error'); setSyncState('error', 'Drive sync failed'); }
  finally { button.disabled = !state.google.connected; button.innerHTML = 'Sync to Drive <span>↥</span>'; }
}
async function driveRestore() {
  if (!confirm('Restore and merge the backup from Google Drive? Existing routines will not be deleted.')) return;
  const button = $('#driveRestoreButton');
  button.disabled = true;
  button.textContent = 'Restoring…';
  try {
    const data = await api('/api/drive/restore', { method: 'POST', body: JSON.stringify({}) });
    await loadBootstrap();
    toast(`Restore complete · ${data.result.routineCount} routines and ${data.result.completionCount} history items imported.`);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = !state.google.connected; button.textContent = 'Restore from Drive'; }
}
async function calendarSync() {
  const button = $('#calendarSyncButton');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try {
    await api('/api/google/sync-calendar', { method: 'POST', body: JSON.stringify({}) });
    await loadBootstrap();
    if (state.activePage === 'calendar') await loadCalendar();
    toast('Google Calendar is up to date.');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = !state.google.connected; button.innerHTML = 'Refresh calendar <span>↻</span>'; }
}
async function unlinkGoogle() {
  if (!confirm('Sign out of Google on this browser? Your server-side Google connection and data will remain available to other browsers already linked to that account.')) return;
  try {
    await api('/api/google/unlink', { method: 'POST', body: JSON.stringify({}) });
    await loadBootstrap();
    toast('This browser is now using a separate local workspace.');
  } catch (error) { toast(error.message, 'error'); }
}

function installHandlers() {
  $$('[data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
  $$('[data-go-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.goPage)));
  $('#newRoutineButton').addEventListener('click', () => openRoutineModal());
  $('#calendarNewButton').addEventListener('click', () => openRoutineModal());
  $('#routinesNewButton').addEventListener('click', () => openRoutineModal());
  $('#closeRoutineModal').addEventListener('click', closeRoutineModal);
  $('#cancelRoutineButton').addEventListener('click', closeRoutineModal);
  $('#routineModal').addEventListener('click', (event) => { if (event.target === $('#routineModal')) closeRoutineModal(); });
  $('#routineForm').addEventListener('submit', saveRoutine);
  $$('.type-option').forEach((button) => button.addEventListener('click', () => setSelectedType(button.dataset.type)));
  $$('.color-choice').forEach((button) => button.addEventListener('click', () => setSelectedColor(button.dataset.color)));
  $('#hasLastDone').addEventListener('change', toggleLastDoneFields);
  $('#linkedEnabled').addEventListener('change', toggleLinkedFields);
  $('#calendarPrev').addEventListener('click', () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1); loadCalendar(); });
  $('#calendarNext').addEventListener('click', () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1); loadCalendar(); });
  $('#routineFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.routineFilter = button.dataset.filter;
    $$('.filter-pill').forEach((pill) => pill.classList.toggle('active', pill === button));
    renderRoutineGrids();
  });
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === 'complete') completeRoutine(id);
    if (action === 'edit') {
      const routine = state.routines.find((r) => r.id === id);
      if (routine) openRoutineModal(routine);
    }
    if (action === 'archive') archiveRoutine(id);
    if (action === 'delete-activity') deleteActivity(id);
    if (action === 'new-routine') openRoutineModal();
  });
  $('#driveSyncButton').addEventListener('click', driveSync);
  $('#driveRestoreButton').addEventListener('click', driveRestore);
  $('#calendarSyncButton').addEventListener('click', calendarSync);
  $('#googleUnlinkButton').addEventListener('click', unlinkGoogle);
  $('#googleSwitchButton').addEventListener('click', () => { window.location.href = '/auth/google?switch=1'; });
  $('#mobileMenuButton')?.addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#mobileMenuButton').setAttribute('aria-expanded', String(open)); });
  $('#mobileProfileButton')?.addEventListener('click', () => setPage('settings'));
  $('#sidebarProfile')?.addEventListener('click', () => setPage('settings'));
  $('#calendarGrid').addEventListener('click', (event) => { const target = event.target.closest('[data-calendar-event]'); if (!target) return; const item = state.calendarEvents.find((row) => row.id === target.dataset.calendarEvent); if (item) openCalendarEvent(item); });
  $('#closeCalendarEventModal').addEventListener('click', closeCalendarEvent);
  $('#calendarEventModal').addEventListener('click', (event) => { if (event.target === $('#calendarEventModal')) closeCalendarEvent(); });
  $('#calendarEventComplete').addEventListener('click', completeCalendarEvent);
  $('#calendarEventSaveDate').addEventListener('click', saveCalendarEventDate);
  $('#calendarEventDelete').addEventListener('click', deleteCalendarActivity);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (!$('#calendarEventModal').hidden) closeCalendarEvent(); else if (!$('#routineModal').hidden) closeRoutineModal(); } });
}

async function init() {
  installHandlers();
  setupDateInputs();
  const todayText = formatDateText(localDateInput());
  $('#startAt').value = todayText;
  $('#lastCompletedAt').value = todayText;
  $('#firstDueAt').value = todayText;
  await loadBootstrap();
  window.setInterval(() => { if (!document.hidden) loadBootstrap(false); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadBootstrap(false); });
  const params = new URLSearchParams(window.location.search);
  if (params.has('connected')) toast('Google account connected. Calendar sync has started.');
  if (params.has('google_error')) toast(`Google connection: ${params.get('google_error')}`, 'error');
  if (params.has('connected') || params.has('google_error')) history.replaceState({}, '', '/');
}

document.addEventListener('DOMContentLoaded', init);
