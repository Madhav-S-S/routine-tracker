'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const morgan = require('morgan');
const { google } = require('googleapis');

const PORT = Number(process.env.PORT || 4317);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/auth/google/callback`;
const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/routine-tracker.sqlite');
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const DRIVE_AUTO_SYNC = String(process.env.DRIVE_AUTO_SYNC || 'true').toLowerCase() !== 'false';
// Set false temporarily on the known-good source server when rebuilding a lost Drive mapping backup.
const DRIVE_RESTORE_ON_STARTUP = String(process.env.DRIVE_RESTORE_ON_STARTUP || 'true').toLowerCase() !== 'false';
const DRIVE_AUTO_SYNC_DELAY_MS = Math.max(15000, Number(process.env.DRIVE_AUTO_SYNC_DELAY_MS || 30000));
const CALENDAR_SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS || 300000);
const TASK_SYNC_INTERVAL_MS = Number(process.env.TASK_SYNC_INTERVAL_MS || 180000);
const TASK_SYNC_BOOTSTRAP_COOLDOWN_MS = Math.max(30000, Number(process.env.TASK_SYNC_BOOTSTRAP_COOLDOWN_MS || 60000));
const TASK_MONTH_CACHE_MS = Math.max(5000, Number(process.env.TASK_MONTH_CACHE_MS || 15000));
const DATABASE_BACKUP_INTERVAL_MS = Math.max(60000, Number(process.env.DATABASE_BACKUP_INTERVAL_MS || 300000));
// Routine dates are date-based, while Google reports task completion timestamps
// as UTC instants. Use the user's local calendar date when computing the next
// occurrence; configure APP_TIME_ZONE if the server owner uses another zone.
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365;
const APP_VERSION = '1.8.0';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('replace-with')) {
  throw new Error('Set SESSION_SECRET in your .env file before starting the app.');
}
if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY || '')) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Schema is intentionally simple and portable so the SQLite file can live on
// a local disk now and a persistent Oracle Cloud block volume later.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_account_key TEXT UNIQUE,
    email TEXT,
    display_name TEXT,
    picture TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_accounts (
    account_key TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT,
    display_name TEXT,
    picture TEXT,
    tokens_enc TEXT NOT NULL,
    calendar_sync_token TEXT,
    drive_file_id TEXT,
    last_calendar_sync TEXT,
    last_drive_sync TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'lavender',
    icon_name TEXT NOT NULL DEFAULT '',
    icon_color TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK(type IN ('frequency', 'interval')),
    min_count INTEGER,
    max_count INTEGER,
    period_value INTEGER,
    period_unit TEXT,
    interval_value INTEGER,
    interval_unit TEXT,
    start_at TEXT,
    last_completed_at TEXT,
    next_due_at TEXT,
    progressive INTEGER NOT NULL DEFAULT 1,
    linked_to_routine_id TEXT,
    linked_offset_days INTEGER NOT NULL DEFAULT -1,
    linked_completed_anchor TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS completions (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    completed_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS google_tasks (
    account_key TEXT NOT NULL REFERENCES google_accounts(account_key) ON DELETE CASCADE,
    routine_id TEXT NOT NULL, slot_key TEXT NOT NULL, task_id TEXT NOT NULL, due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'needsAction', updated_at TEXT NOT NULL, completion_id TEXT,
    PRIMARY KEY(account_key, routine_id, slot_key)
  );
  CREATE TABLE IF NOT EXISTS routine_task_suppressions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    slot_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, routine_id, slot_key)
  );
  CREATE TABLE IF NOT EXISTS google_events (
    account_key TEXT NOT NULL REFERENCES google_accounts(account_key) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '(No title)',
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'confirmed',
    location TEXT,
    html_link TEXT,
    updated_at TEXT,
    PRIMARY KEY(account_key, event_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_routines_user_archived ON routines(user_id, archived);
  CREATE INDEX IF NOT EXISTS idx_completions_user_date ON completions(user_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_completions_routine_date ON completions(routine_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_google_events_account_start ON google_events(account_key, start_at);
  CREATE INDEX IF NOT EXISTS idx_google_tasks_account_id ON google_tasks(account_key, task_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

// In-place schema upgrades preserve existing routines and completion history.
function ensureColumn(tableName, columnName, definition) {
  const columns = db.pragma(`table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
ensureColumn('routines', 'progressive', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('routines', 'linked_to_routine_id', 'TEXT');
ensureColumn('routines', 'linked_offset_days', 'INTEGER NOT NULL DEFAULT -1');
ensureColumn('routines', 'linked_completed_anchor', 'TEXT');
ensureColumn('google_events', 'description', 'TEXT');
ensureColumn('google_tasks', 'completion_id', 'TEXT');
ensureColumn('google_tasks', 'remote_updated_at', 'TEXT');
ensureColumn('google_tasks', 'legacy_probe_done', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('google_accounts', 'last_task_sync', 'TEXT');
ensureColumn('google_accounts', 'last_external_task_sync', 'TEXT');
ensureColumn('google_accounts', 'database_backup_file_id', 'TEXT');
ensureColumn('google_accounts', 'last_database_backup', 'TEXT');
ensureColumn('google_tasks', 'identity_marker_added', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS google_external_tasks (
    account_key TEXT NOT NULL REFERENCES google_accounts(account_key) ON DELETE CASCADE,
    tasklist_id TEXT NOT NULL,
    tasklist_title TEXT NOT NULL DEFAULT 'Google Tasks',
    task_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '(No title)',
    notes TEXT,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'needsAction',
    completed_at TEXT,
    updated_at TEXT,
    PRIMARY KEY(account_key, tasklist_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_google_external_tasks_due
    ON google_external_tasks(account_key, due_at);
  CREATE TABLE IF NOT EXISTS google_external_task_month_sync (
    account_key TEXT NOT NULL REFERENCES google_accounts(account_key) ON DELETE CASCADE,
    month TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY(account_key, month)
  );
`);
ensureColumn('routines', 'icon_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('routines', 'icon_color', "TEXT NOT NULL DEFAULT ''");

function nowIso() { return new Date().toISOString(); }
function makeId(prefix = 'r') { return `${prefix}_${crypto.randomUUID()}`; }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function dateFromInput(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date;
}
function toIso(value, fallback = null) {
  const date = value instanceof Date ? value : dateFromInput(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback;
}
function addInterval(dateLike, amount, unit) {
  const date = new Date(dateLike);
  const n = Number(amount);

  // Zero is valid as an internal date offset. getCurrentPeriod() uses it
  // for the first period boundary. Actual routine intervals are validated
  // separately and must still be at least one unit.
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Date offset cannot be negative.');
  }
  if (!Number.isInteger(n)) {
    throw new Error('Date offset must be a whole number.');
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error('A valid date is required.');
  }
  if (n === 0) return date;

  if (unit === 'days') date.setUTCDate(date.getUTCDate() + n);
  else if (unit === 'weeks') date.setUTCDate(date.getUTCDate() + (7 * n));
  else if (unit === 'months') {
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + n);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(originalDay, lastDay));
  } else if (unit === 'years') {
    const originalMonth = date.getUTCMonth();
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + n);
    date.setUTCMonth(originalMonth);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), originalMonth + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(originalDay, lastDay));
  } else {
    throw new Error('Unsupported time unit.');
  }
  return date;
}
function addOffsetDays(dateLike, offsetDays) {
  const date = new Date(dateLike);
  const offset = Number(offsetDays);
  if (Number.isNaN(date.getTime()) || !Number.isInteger(offset) || Math.abs(offset) > 3650) {
    throw new Error('A valid linked date offset is required.');
  }
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}
function updateLinkedRoutineSchedules(userId, sourceRoutineId) {
  const source = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(sourceRoutineId, userId);
  const children = db.prepare('SELECT * FROM routines WHERE user_id=? AND linked_to_routine_id=? AND archived=0').all(userId, sourceRoutineId);
  const anchor = source && !source.archived ? getRoutineAnchorDate(source) : null;
  let anyChanged = false;
  for (const child of children) {
    const nextDue = anchor ? addOffsetDays(anchor, child.linked_offset_days || 0).toISOString() : null;
    const changed = (child.next_due_at || null) !== nextDue;
    if (!changed) continue;
    anyChanged = true;
    db.prepare('UPDATE routines SET next_due_at=?,linked_completed_anchor=NULL,updated_at=? WHERE id=? AND user_id=?')
      .run(nextDue, nowIso(), child.id, userId);
  }
  if (anyChanged) queueDriveSync(userId);
}

function getCurrentPeriod(routine, now = new Date()) {
  const anchor = new Date(routine.start_at || routine.created_at);
  const amount = Number(routine.period_value || 1);
  const unit = routine.period_unit || 'weeks';
  if (now <= anchor) return { start: anchor, end: addInterval(anchor, amount, unit) };
  let index = 0;
  if (unit === 'days' || unit === 'weeks') {
    const stepMs = amount * (unit === 'weeks' ? 7 : 1) * 86400000;
    index = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / stepMs));
  } else if (unit === 'months') {
    const monthDifference = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
    index = Math.max(0, Math.floor(monthDifference / amount));
  } else {
    const yearDifference = now.getUTCFullYear() - anchor.getUTCFullYear();
    index = Math.max(0, Math.floor(yearDifference / amount));
  }
  // Always derive each boundary from the original anchor. This avoids date drift
  // for month-end starts (for example Jan 31 -> Feb 28 -> Mar 31).
  let start = addInterval(anchor, index * amount, unit);
  while (start > now && index > 0) {
    index--;
    start = addInterval(anchor, index * amount, unit);
  }
  let end = addInterval(anchor, (index + 1) * amount, unit);
  while (end <= now) {
    index++;
    start = end;
    end = addInterval(anchor, (index + 1) * amount, unit);
  }
  return { start, end };
}

function getRoutineAnchorDate(routine, now = new Date()) {
  if (!routine || routine.archived) return null;
  if (routine.type === 'interval') return routine.next_due_at ? new Date(routine.next_due_at) : null;
  if (routine.type !== 'frequency') return null;
  const window = getCurrentPeriod(routine, now);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM completions WHERE routine_id=? AND completed_at>=? AND completed_at<?`)
    .get(routine.id, window.start.toISOString(), window.end.toISOString()).n;
  const maxCount = Math.max(1, Number(routine.max_count || 1));
  if (Number(count || 0) >= maxCount) return window.end;
  if (!parseBooleanFlag(routine.progressive, true)) return window.start;
  const duration = Math.max(1, window.end.getTime() - window.start.getTime());
  return new Date(window.start.getTime() + duration * (Number(count || 0) / maxCount));
}

function unitLabel(unit, plural = true) {
  const labels = { days: plural ? 'days' : 'day', weeks: plural ? 'weeks' : 'week', months: plural ? 'months' : 'month', years: plural ? 'years' : 'year' };
  return labels[unit] || unit;
}

const encryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
function decryptTokens(payload) {
  const packed = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(packed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, safeJsonParse(row.data));
    } catch (error) { return callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_MAX_AGE;
      db.prepare(`INSERT INTO sessions(sid, data, expires_at) VALUES(?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at`)
        .run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_MAX_AGE;
      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (error) { callback(error); }
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(session({
  name: 'routine.sid',
  secret: process.env.SESSION_SECRET,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/'
  }
}));

function createAnonymousUser() {
  const id = makeId('u');
  db.prepare('INSERT INTO users(id, created_at) VALUES(?, ?)').run(id, nowIso());
  return id;
}
app.use((req, res, next) => {
  try {
    if (!req.session.userId || !db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId)) {
      req.session.userId = createAnonymousUser();
    }
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    req.userId = req.session.userId;
    next();
  } catch (error) { next(error); }
});
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session.csrfToken || req.get('X-CSRF-Token') !== req.session.csrfToken) {
    return res.status(403).json({ error: 'This page session expired. Refresh the page and try again.' });
  }
  next();
});

function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.');
  }
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/tasks'
];

function persistAccountTokens(accountKey, tokens) {
  const row = db.prepare('SELECT tokens_enc FROM google_accounts WHERE account_key = ?').get(accountKey);
  if (!row) return;
  let oldTokens = {};
  try { oldTokens = decryptTokens(row.tokens_enc); } catch { /* replace unusable stored token */ }
  const merged = { ...oldTokens, ...tokens };
  if (!tokens.refresh_token && oldTokens.refresh_token) merged.refresh_token = oldTokens.refresh_token;
  db.prepare('UPDATE google_accounts SET tokens_enc = ?, updated_at = ? WHERE account_key = ?')
    .run(encryptTokens(merged), nowIso(), accountKey);
}
function getGoogleClient(accountKey) {
  const row = db.prepare('SELECT * FROM google_accounts WHERE account_key = ?').get(accountKey);
  if (!row) throw new Error('Google account is not connected.');
  const tokens = decryptTokens(row.tokens_enc);
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    try { persistAccountTokens(accountKey, newTokens); }
    catch (error) { console.error('Could not persist refreshed Google credentials:', error.message); }
  });
  return { client, row, tokens };
}
function getCurrentGoogleAccount(userId) {
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) return null;
  return db.prepare('SELECT * FROM google_accounts WHERE account_key = ?').get(user.google_account_key) || null;
}
function driveApi(accountKey) {
  const { client } = getGoogleClient(accountKey);
  return google.drive({ version: 'v3', auth: client });
}
function calendarApi(accountKey) {
  const { client } = getGoogleClient(accountKey);
  return google.calendar({ version: 'v3', auth: client });
}

function tasksApi(accountKey) {
  const { client } = getGoogleClient(accountKey);
  return google.tasks({ version: 'v1', auth: client });
}
function isoDateOnly(value) {
  const d = new Date(value);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function routineDateOnly(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('A valid completion date is required.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function routineDateAnchor(value) {
  return new Date(`${routineDateOnly(value)}T00:00:00.000Z`);
}
function addRoutineIntervalFromCompletion(value, amount, unit) {
  return addInterval(routineDateAnchor(value), amount, unit);
}
function routineTaskSlotKey(routine, item = null) {
  if (routine.type === 'interval' && routine.next_due_at) {
    return `${routine.linked_to_routine_id ? 'linked' : 'interval'}:${routine.next_due_at}`;
  }
  if (routine.type === 'frequency') {
    const publicItem = item || publicRoutine(routine);
    if (!publicItem.periodStart) return null;
    return `frequency:${publicItem.periodStart}:${publicItem.completedCount}`;
  }
  return null;
}

// A stable marker travels with each task in Google Tasks. Separate SQLite
// installations can therefore rediscover the same remote task instead of
// creating another copy when their local mapping table is empty.
function routineTaskMarker(routineId, slotKey) {
  return `[[Routine Tracker task:${sha256(`${routineId}${String.fromCharCode(0)}${slotKey}`).slice(0, 32)}]]`;
}
function routineTaskNotes(routine, slotKey) {
  const baseNotes = String(routine.notes || 'Routine Tracker checklist item');
  const marker = routineTaskMarker(routine.id, slotKey);
  return baseNotes.includes(marker) ? baseNotes : `${baseNotes}\n\n${marker}`;
}
async function listAllDefaultGoogleTasks(tasks) {
  const results = [];
  let pageToken = null;
  do {
    const response = await tasks.tasks.list({
      tasklist: '@default', maxResults: 100,
      showCompleted: true, showDeleted: true, showHidden: true,
      fields: 'items(id,title,notes,due,status,completed,updated,deleted,hidden),nextPageToken',
      ...(pageToken ? { pageToken } : {})
    });
    results.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || null;
  } while (pageToken);
  return results;
}
function isRoutineTaskSuppressed(userId, routineId, slotKey) {
  return Boolean(slotKey && db.prepare('SELECT 1 FROM routine_task_suppressions WHERE user_id=? AND routine_id=? AND slot_key=?').get(userId, routineId, slotKey));
}
async function deleteGoogleTask(accountKey, taskId) {
  if (!accountKey || !taskId) return;
  try {
    await tasksApi(accountKey).tasks.delete({ tasklist: '@default', task: taskId });
  } catch (error) {
    if (Number(error.code || error.response?.status) !== 404) throw error;
  }
}
const taskSyncLocks = new Set();
// A connected account must restore its shared Drive state before any task
// publisher or backup writer is allowed to run in this process.
const driveRestoreReadyUsers = new Set();

// Pull changes made in Google Tasks/Calendar back into Routine Tracker.
// The Tasks API requires both showCompleted and showHidden to return tasks
// completed in Google's first-party Calendar/Tasks interfaces.
function recalculateRoutineAfterGoogleTaskChange(userId, routineId) {
  const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(routineId, userId);
  if (!routine) return;
  const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routineId);
  const lastCompletedAt = latest?.completed_at || null;

  if (routine.type === 'interval' && !routine.linked_to_routine_id) {
    const nextDueAt = lastCompletedAt
      ? addRoutineIntervalFromCompletion(lastCompletedAt, routine.interval_value, routine.interval_unit).toISOString()
      : nowIso();
    db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=? AND user_id=?')
      .run(lastCompletedAt, nextDueAt, nowIso(), routineId, userId);
  } else {
    db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=? AND user_id=?')
      .run(lastCompletedAt, nowIso(), routineId, userId);
  }

  const refreshed = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(routineId, userId);
  if (refreshed?.type === 'frequency' && refreshed.linked_to_routine_id) {
    const period = getCurrentPeriod(refreshed);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM completions
      WHERE routine_id=? AND completed_at>=? AND completed_at<?`)
      .get(routineId, period.start.toISOString(), period.end.toISOString()).n;
    if (Number(count) < Number(refreshed.max_count || 1) && refreshed.linked_completed_anchor) {
      db.prepare('UPDATE routines SET linked_completed_anchor=NULL,updated_at=? WHERE id=? AND user_id=?')
        .run(nowIso(), routineId, userId);
    } else if (Number(count) >= Number(refreshed.max_count || 1) && refreshed.next_due_at &&
               refreshed.linked_completed_anchor !== refreshed.next_due_at) {
      db.prepare('UPDATE routines SET linked_completed_anchor=next_due_at,updated_at=? WHERE id=? AND user_id=?')
        .run(nowIso(), routineId, userId);
    }
  }

  updateLinkedRoutineSchedules(userId, routineId);
  queueDriveSync(userId);
}

function applyRemoteGoogleTaskUpdate(userId, account, localTask, remote, changedRoutines) {
  if (!localTask || !remote) return;
  const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(localTask.routine_id, userId);
  if (!routine) return;

  const remoteUpdatedAt = toIso(remote.updated, null);
  const remoteDueDate = remote.due ? isoDateOnly(remote.due) : localTask.due_date;
  const remoteState = (remote.deleted || remote.status === 'deleted')
    ? 'deleted'
    : (remote.status === 'completed' || Boolean(remote.completed) || remote.hidden === true)
      ? 'completed'
      : remote.status === 'needsAction' ? 'needsAction' : null;
  if (!remoteState) return;

  const incomingTime = Date.parse(remoteUpdatedAt || '') || 0;
  const knownTime = Date.parse(localTask.remote_updated_at || '') || 0;
  const sameDate = remoteDueDate === localTask.due_date;
  if (remoteState === localTask.status && sameDate && incomingTime <= knownTime) return;

  if (remoteState === 'deleted') {
    if (localTask.completion_id) {
      db.prepare('DELETE FROM completions WHERE id=? AND user_id=?').run(localTask.completion_id, userId);
      changedRoutines.add(routine.id);
    }
    db.prepare("UPDATE google_tasks SET status='deleted',completion_id=NULL,remote_updated_at=COALESCE(?,remote_updated_at),updated_at=? WHERE account_key=? AND task_id=?")
      .run(remoteUpdatedAt, nowIso(), account.account_key, localTask.task_id);
    db.prepare('INSERT OR IGNORE INTO routine_task_suppressions(user_id,routine_id,slot_key,created_at) VALUES(?,?,?,?)')
      .run(userId, routine.id, localTask.slot_key, nowIso());
    return;
  }

  if (remoteState === 'completed') {
    // A completed task with this exact Google ID is authoritative, even when
    // an older version of Routine Tracker had incorrectly tombstoned its map.
    if (localTask.status === 'deleted') {
      db.prepare('DELETE FROM routine_task_suppressions WHERE user_id=? AND routine_id=? AND slot_key=?')
        .run(userId, routine.id, localTask.slot_key);
    }
    const completedAt = toIso(remote.completed, toIso(remote.updated, nowIso()));
    let completionId = localTask.completion_id;
    let existingCompletion = completionId
      ? db.prepare('SELECT id,completed_at FROM completions WHERE id=? AND user_id=?').get(completionId, userId)
      : null;

    if (!existingCompletion) {
      const possibleMatch = db.prepare(`SELECT id,completed_at FROM completions
        WHERE routine_id=? ORDER BY ABS(strftime('%s',completed_at)-strftime('%s',?)) LIMIT 1`)
        .get(routine.id, completedAt);
      if (possibleMatch && Math.abs(new Date(possibleMatch.completed_at).getTime() - new Date(completedAt).getTime()) <= 5 * 60 * 1000) {
        completionId = possibleMatch.id;
        existingCompletion = possibleMatch;
      }
    }

    if (!existingCompletion && !routine.archived) {
      completionId = makeId('done');
      db.prepare('INSERT INTO completions(id,routine_id,user_id,completed_at,note) VALUES(?,?,?,?,?)')
        .run(completionId, routine.id, userId, completedAt, 'Completed in Google Tasks');
      changedRoutines.add(routine.id);
    } else if (existingCompletion) {
      completionId = existingCompletion.id;
      if (existingCompletion.completed_at !== completedAt) {
        db.prepare('UPDATE completions SET completed_at=? WHERE id=? AND user_id=?')
          .run(completedAt, completionId, userId);
        changedRoutines.add(routine.id);
      }
      if (localTask.status !== 'completed') changedRoutines.add(routine.id);
    } else {
      completionId = null;
    }

    db.prepare("UPDATE google_tasks SET status='completed',completion_id=?,due_date=?,remote_updated_at=COALESCE(?,remote_updated_at),updated_at=? WHERE account_key=? AND task_id=?")
      .run(completionId, remoteDueDate, remoteUpdatedAt, nowIso(), account.account_key, localTask.task_id);
    return;
  }

  if (remoteState === 'needsAction') {
    // Intentional local deletions remain suppressed. A task is only restored
    // from completion when Google's version is newer than our stored version.
    if (localTask.status === 'deleted') return;
    const baseline = localTask.remote_updated_at || (localTask.status === 'completed' ? localTask.updated_at : null);
    const remoteIsNewer = remoteUpdatedAt && (!baseline || Date.parse(remoteUpdatedAt) > Date.parse(baseline));

    if (localTask.status === 'completed' && remoteIsNewer) {
      if (localTask.completion_id) {
        db.prepare('DELETE FROM completions WHERE id=? AND user_id=?').run(localTask.completion_id, userId);
        changedRoutines.add(routine.id);
      }
      db.prepare("UPDATE google_tasks SET status='needsAction',completion_id=NULL,due_date=?,remote_updated_at=?,updated_at=? WHERE account_key=? AND task_id=?")
        .run(remoteDueDate, remoteUpdatedAt, nowIso(), account.account_key, localTask.task_id);
    } else if (localTask.status !== 'completed' && (remoteDueDate !== localTask.due_date || incomingTime > knownTime)) {
      db.prepare("UPDATE google_tasks SET status='needsAction',due_date=?,remote_updated_at=COALESCE(?,remote_updated_at),updated_at=? WHERE account_key=? AND task_id=?")
        .run(remoteDueDate, remoteUpdatedAt, nowIso(), account.account_key, localTask.task_id);
    }
  }
}

async function syncGoogleManualTasks(userId, account) {
  // Keep manually-created Google Tasks separate from Routine Tracker's mapped
  // tasks. Only dated tasks belong on the calendar grid.
  const tasks = tasksApi(account.account_key);
  const state = db.prepare('SELECT last_external_task_sync FROM google_accounts WHERE account_key=?')
    .get(account.account_key);
  const lastSyncMs = Date.parse(state?.last_external_task_sync || '') || 0;
  const updatedMin = lastSyncMs
    ? new Date(Math.max(0, lastSyncMs - 2 * 60 * 1000)).toISOString()
    : null;
  const mappedIds = new Set(db.prepare('SELECT task_id FROM google_tasks WHERE account_key=?')
    .all(account.account_key).map((row) => row.task_id));

  // Discover every task list so tasks manually created in non-default lists
  // are included too. The list endpoint is paginated and relatively small.
  const taskLists = [];
  let listPageToken = null;
  do {
    const response = await tasks.tasklists.list({
      maxResults: 1000,
      ...(listPageToken ? { pageToken: listPageToken } : {}),
      fields: 'items(id,title),nextPageToken'
    });
    taskLists.push(...(response.data.items || []));
    listPageToken = response.data.nextPageToken || null;
  } while (listPageToken);

  const upsert = db.prepare(`INSERT INTO google_external_tasks(
    account_key,tasklist_id,tasklist_title,task_id,title,notes,due_at,status,completed_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(account_key,tasklist_id,task_id) DO UPDATE SET
    tasklist_title=excluded.tasklist_title,title=excluded.title,notes=excluded.notes,
    due_at=excluded.due_at,status=excluded.status,completed_at=excluded.completed_at,
    updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM google_external_tasks WHERE account_key=? AND tasklist_id=? AND task_id=?');

  for (const taskList of taskLists) {
    if (!taskList.id) continue;
    let pageToken = null;
    do {
      const params = {
        tasklist: taskList.id,
        maxResults: 100,
        showCompleted: true,
        showDeleted: true,
        showHidden: true,
        showAssigned: true,
        fields: 'items(id,title,notes,due,status,completed,updated,deleted,hidden),nextPageToken',
        ...(updatedMin ? { updatedMin } : {}),
        ...(pageToken ? { pageToken } : {})
      };
      const response = await tasks.tasks.list(params);
      for (const remote of (response.data.items || [])) {
        if (!remote.id) continue;
        // Mapped routine tasks are already represented by their routine due
        // item or completion record. Do not display a duplicate calendar item.
        if (mappedIds.has(remote.id)) {
          remove.run(account.account_key, taskList.id, remote.id);
          continue;
        }
        if (remote.deleted || remote.status === 'deleted' || !remote.due) {
          remove.run(account.account_key, taskList.id, remote.id);
          continue;
        }
        upsert.run(
          account.account_key, taskList.id, taskList.title || 'Google Tasks', remote.id,
          remote.title || '(No title)', remote.notes || null, remote.due,
          remote.status || 'needsAction', remote.completed || null, remote.updated || null
        );
      }
      pageToken = response.data.nextPageToken || null;
    } while (pageToken);
  }

  const syncedAt = nowIso();
  db.prepare('UPDATE google_accounts SET last_external_task_sync=?,updated_at=? WHERE account_key=?')
    .run(syncedAt, syncedAt, account.account_key);
  return { taskLists: taskLists.length };
}

const manualTaskMonthLocks = new Set();

// Fetch a complete, date-bounded snapshot for the month being viewed.
// This deliberately does not use updatedMin: a task that predates the last
// incremental cursor (or is an assigned task) must still be discoverable.
// The month cache prevents repeated Google calls while navigating the UI.
async function syncGoogleManualTasksForMonth(userId, account, month, force = false) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return { skipped: true, reason: 'invalid month' };
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) return { skipped: true, reason: 'invalid month' };

  const cached = db.prepare('SELECT synced_at FROM google_external_task_month_sync WHERE account_key=? AND month=?')
    .get(account.account_key, month);
  const cachedAt = Date.parse(cached?.synced_at || '') || 0;
  if (!force && cachedAt && Date.now() - cachedAt < TASK_MONTH_CACHE_MS) {
    return { cached: true, syncedAt: cached.synced_at };
  }

  const lockKey = `${account.account_key}:${month}`;
  if (manualTaskMonthLocks.has(lockKey)) return { skipped: true, reason: 'month sync already running' };
  manualTaskMonthLocks.add(lockKey);
  try {
    const tasks = tasksApi(account.account_key);
    const start = new Date(Date.UTC(year, monthNumber - 1, 1));
    const end = new Date(Date.UTC(year, monthNumber, 1));
    const dueMin = start.toISOString();
    const dueMax = end.toISOString();
    const mappedIds = new Set(db.prepare('SELECT task_id FROM google_tasks WHERE account_key=?')
      .all(account.account_key).map((row) => row.task_id));

    const taskLists = [];
    let listPageToken = null;
    do {
      const response = await tasks.tasklists.list({
        maxResults: 1000,
        ...(listPageToken ? { pageToken: listPageToken } : {}),
        fields: 'items(id,title),nextPageToken'
      });
      taskLists.push(...(response.data.items || []));
      listPageToken = response.data.nextPageToken || null;
    } while (listPageToken);

    const records = [];
    const seen = new Set();
    for (const taskList of taskLists) {
      if (!taskList.id) continue;
      let pageToken = null;
      do {
        const response = await tasks.tasks.list({
          tasklist: taskList.id,
          maxResults: 100,
          dueMin,
          dueMax,
          showCompleted: true,
          showDeleted: true,
          showHidden: true,
          showAssigned: true,
          fields: 'items(id,title,notes,due,status,completed,updated,deleted,hidden),nextPageToken',
          ...(pageToken ? { pageToken } : {})
        });
        for (const remote of (response.data.items || [])) {
          if (!remote.id) continue;
          const key = `${taskList.id}\u0000${remote.id}`;
          if (mappedIds.has(remote.id) || remote.deleted || remote.status === 'deleted' || !remote.due) continue;
          const dueTime = Date.parse(remote.due);
          if (!Number.isFinite(dueTime) || dueTime < start.getTime() || dueTime >= end.getTime()) continue;
          records.push({
            tasklist_id: taskList.id,
            tasklist_title: taskList.title || 'Google Tasks',
            task_id: remote.id,
            title: remote.title || '(No title)',
            notes: remote.notes || null,
            due_at: remote.due,
            status: remote.status || 'needsAction',
            completed_at: remote.completed || null,
            updated_at: remote.updated || null
          });
          seen.add(key);
        }
        pageToken = response.data.nextPageToken || null;
      } while (pageToken);
    }

    const syncedAt = nowIso();
    // Commit the snapshot only after every task-list page succeeded. If a
    // request fails, the old cache remains intact and the next view retries.
    const commit = db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO google_external_tasks(
        account_key,tasklist_id,tasklist_title,task_id,title,notes,due_at,status,completed_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_key,tasklist_id,task_id) DO UPDATE SET
        tasklist_title=excluded.tasklist_title,title=excluded.title,notes=excluded.notes,
        due_at=excluded.due_at,status=excluded.status,completed_at=excluded.completed_at,
        updated_at=excluded.updated_at`);
      for (const row of records) {
        upsert.run(account.account_key, row.tasklist_id, row.tasklist_title, row.task_id,
          row.title, row.notes, row.due_at, row.status, row.completed_at, row.updated_at);
      }

      // Remove stale cached entries whose due date was moved out of this month,
      // or whose task was deleted. The complete month snapshot makes this safe.
      const oldRows = db.prepare(`SELECT tasklist_id,task_id FROM google_external_tasks
        WHERE account_key=? AND due_at>=? AND due_at<?`).all(account.account_key, dueMin, dueMax);
      const remove = db.prepare('DELETE FROM google_external_tasks WHERE account_key=? AND tasklist_id=? AND task_id=?');
      for (const row of oldRows) {
        if (!seen.has(`${row.tasklist_id}\u0000${row.task_id}`)) {
          remove.run(account.account_key, row.tasklist_id, row.task_id);
        }
      }
      db.prepare(`INSERT INTO google_external_task_month_sync(account_key,month,synced_at)
        VALUES(?,?,?) ON CONFLICT(account_key,month) DO UPDATE SET synced_at=excluded.synced_at`)
        .run(account.account_key, month, syncedAt);
      db.prepare('UPDATE google_accounts SET last_external_task_sync=?,updated_at=? WHERE account_key=?')
        .run(syncedAt, syncedAt, account.account_key);
    });
    commit();
    return { synced: true, taskLists: taskLists.length, tasks: records.length, syncedAt };
  } finally {
    manualTaskMonthLocks.delete(lockKey);
  }
}

async function syncGoogleTaskChanges(userId, account) {
  if (!account) return { skipped: true };
  const tasks = tasksApi(account.account_key);
  const localRows = db.prepare(`SELECT gt.* FROM google_tasks gt
    JOIN routines r ON r.id=gt.routine_id
    WHERE gt.account_key=? AND r.user_id=? AND r.archived=0`)
    .all(account.account_key, userId);
  const localByTaskId = new Map(localRows.map((row) => [row.task_id, row]));
  const changedRoutines = new Set();
  const lastSyncMs = Date.parse(account.last_task_sync || '') || 0;
  // Google Tasks supports updatedMin. A small overlap protects against API
  // indexing delay while avoiding a full list + one GET per local task every run.
  const updatedMin = lastSyncMs
    ? new Date(Math.max(0, lastSyncMs - 2 * 60 * 1000)).toISOString()
    : null;
  const params = {
    tasklist: '@default', showCompleted: true, showDeleted: true, showHidden: true,
    maxResults: 100,
    fields: 'items(id,status,completed,updated,due,deleted,hidden),nextPageToken'
  };
  if (updatedMin) params.updatedMin = updatedMin;

  let pageToken = null;
  let remoteCount = 0;
  do {
    const page = await tasks.tasks.list({ ...params, ...(pageToken ? { pageToken } : {}) });
    for (const remote of (page.data.items || [])) {
      if (!remote.id) continue;
      remoteCount += 1;
      const localTask = localByTaskId.get(remote.id);
      if (localTask) applyRemoteGoogleTaskUpdate(userId, account, localTask, remote, changedRoutines);
    }
    pageToken = page.data.nextPageToken || null;
  } while (pageToken);

  // One-time recovery for mappings tombstoned by older releases. This is
  // intentionally capped and never probes every mapped task on each sync.
  const legacyTombstones = db.prepare(`SELECT gt.* FROM google_tasks gt
    JOIN routines r ON r.id=gt.routine_id
    WHERE gt.account_key=? AND r.user_id=? AND r.archived=0
      AND gt.status='deleted' AND gt.legacy_probe_done=0
    ORDER BY gt.updated_at ASC LIMIT 8`).all(account.account_key, userId);
  for (const localTask of legacyTombstones) {
    try {
      const response = await tasks.tasks.get({ tasklist: '@default', task: localTask.task_id });
      applyRemoteGoogleTaskUpdate(userId, account, localTask, response.data, changedRoutines);
      db.prepare('UPDATE google_tasks SET legacy_probe_done=1 WHERE account_key=? AND task_id=?')
        .run(account.account_key, localTask.task_id);
    } catch (error) {
      const status = Number(error.code || error.response?.status);
      if (status === 404) {
        db.prepare('UPDATE google_tasks SET legacy_probe_done=1,remote_updated_at=COALESCE(remote_updated_at,?) WHERE account_key=? AND task_id=?')
          .run(nowIso(), account.account_key, localTask.task_id);
      } else {
        throw error;
      }
    }
  }

  for (const routineId of changedRoutines) recalculateRoutineAfterGoogleTaskChange(userId, routineId);
  try {
    await syncGoogleManualTasks(userId, account);
  } catch (error) {
    // A task-list failure should not block synchronization of Routine Tracker's
    // own mapped tasks. Keep the external-task cursor unchanged so it retries.
    console.warn(`Manual Google Tasks calendar sync failed for ${account.account_key}:`, error.message);
  }
  const syncedAt = nowIso();
  db.prepare('UPDATE google_accounts SET last_task_sync=?,updated_at=? WHERE account_key=?')
    .run(syncedAt, syncedAt, account.account_key);
  return { synced: true, checked: localRows.length, received: remoteCount, changedRoutines: changedRoutines.size };
}
async function syncRoutineTasks(userId, routineIds = null, options = {}) {
  if (!driveRestoreReadyUsers.has(userId)) return { skipped: true, reason: 'Drive restore is not complete' };
  if (taskSyncLocks.has(userId)) return { skipped: true, reason: 'sync already running' };
  taskSyncLocks.add(userId);
  let mappingsChanged = false;
  try {
    const account = getCurrentGoogleAccount(userId);
    if (!account) return { skipped: true };
    if (options.pullChanges !== false) await syncGoogleTaskChanges(userId, account);
    const allRoutines = listRoutines(userId);
    const selectedIds = Array.isArray(routineIds)
      ? new Set(routineIds.map((value) => typeof value === 'string' ? value : value?.id).filter(Boolean))
      : null;
    const routines = selectedIds ? allRoutines.filter((routine) => selectedIds.has(routine.id)) : allRoutines;
    const tasks = tasksApi(account.account_key);
    let remoteTaskSnapshot = null;
    const getRemoteTaskSnapshot = async () => {
      if (!remoteTaskSnapshot) remoteTaskSnapshot = await listAllDefaultGoogleTasks(tasks);
      return remoteTaskSnapshot;
    };

    // Full archived-task cleanup is only needed during a full/background sync.
    const archivedTasks = selectedIds ? [] : db.prepare(`SELECT gt.* FROM google_tasks gt
      JOIN routines r ON r.id=gt.routine_id
      WHERE gt.account_key=? AND r.user_id=? AND r.archived=1 AND gt.status<>'deleted'`)
      .all(account.account_key, userId);
    for (const oldTask of archivedTasks) {
      try {
        await deleteGoogleTask(account.account_key, oldTask.task_id);
        db.prepare("UPDATE google_tasks SET status='deleted',updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?")
          .run(nowIso(), account.account_key, oldTask.routine_id, oldTask.slot_key);
        mappingsChanged = true;
      } catch (error) {
        console.warn('Could not clean up a task belonging to an archived routine:', error.message);
      }
    }

    for (const routine of routines) {
      let dueDate = null;
      let slotKey = '';
      if (routine.type === 'interval' && routine.next_due_at) {
        if (routine.linked_to_routine_id && routine.last_completed_at &&
            new Date(routine.last_completed_at).getTime() >= new Date(routine.next_due_at).getTime()) continue;
        dueDate = isoDateOnly(routine.next_due_at);
        slotKey = routineTaskSlotKey(routine);
      } else if (routine.type === 'frequency' && routine.checkinAvailable) {
        dueDate = isoDateOnly(nowIso());
        slotKey = routineTaskSlotKey(routine);
      }
      if (!dueDate || !slotKey) continue;
      if (isRoutineTaskSuppressed(userId, routine.id, slotKey)) continue;

      let existing = db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND slot_key=?')
        .get(account.account_key, routine.id, slotKey);
      if (!existing) {
        existing = db.prepare("SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status='needsAction' ORDER BY updated_at DESC LIMIT 1")
          .get(account.account_key, routine.id);
      }

      const marker = routineTaskMarker(routine.id, slotKey);
      const requestBody = {
        title: routine.title,
        notes: routineTaskNotes(routine, slotKey),
        due: `${dueDate}T00:00:00.000Z`
      };

      // Recover a missing SQLite mapping before creating anything remotely.
      // Prefer the exact stable marker. For tasks created by older versions,
      // adopt a single exact title + due-date + notes match; never delete
      // ambiguous matches because one could be a manually-created task.
      if (!existing) {
        const remoteTasks = await getRemoteTaskSnapshot();
        let candidate = remoteTasks.find((remote) => remote.id && String(remote.notes || '').includes(marker));
        if (!candidate) {
          const legacyNotes = String(routine.notes || 'Routine Tracker checklist item');
          const legacyMatches = remoteTasks.filter((remote) =>
            remote.id &&
            !remote.deleted &&
            remote.status === 'needsAction' &&
            remote.title === routine.title &&
            remote.due &&
            isoDateOnly(remote.due) === dueDate &&
            String(remote.notes || '') === legacyNotes
          );
          if (legacyMatches.length) {
            candidate = legacyMatches[0];
            if (legacyMatches.length > 1) {
              console.warn(`Found ${legacyMatches.length} legacy Google Tasks matching routine "${routine.title}" on ${dueDate}; adopted one and left the others untouched.`);
            }
          }
        }
        if (candidate) {
          let adopted = candidate;
          const remoteStatus = candidate.deleted || candidate.status === 'deleted'
            ? 'deleted'
            : (candidate.status === 'completed' || candidate.completed || candidate.hidden)
              ? 'completed' : 'needsAction';
          if (remoteStatus !== 'deleted' && !String(candidate.notes || '').includes(marker)) {
            const patched = await tasks.tasks.patch({
              tasklist: '@default', task: candidate.id, requestBody
            });
            adopted = patched.data || candidate;
            if (remoteTaskSnapshot) {
              const ix = remoteTaskSnapshot.findIndex((row) => row.id === candidate.id);
              if (ix >= 0) remoteTaskSnapshot[ix] = adopted;
            }
          }
          db.prepare(`INSERT INTO google_tasks(
            account_key,routine_id,slot_key,task_id,due_date,status,updated_at,remote_updated_at,identity_marker_added
          ) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_key,routine_id,slot_key) DO UPDATE SET
            task_id=excluded.task_id,due_date=excluded.due_date,status=excluded.status,
            updated_at=excluded.updated_at,remote_updated_at=excluded.remote_updated_at,
            identity_marker_added=excluded.identity_marker_added`)
            .run(account.account_key, routine.id, slotKey, candidate.id, dueDate, remoteStatus,
              nowIso(), toIso(adopted.updated, null), remoteStatus === 'deleted' ? 0 : 1);
          existing = db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND slot_key=?')
            .get(account.account_key, routine.id, slotKey);
          mappingsChanged = true;
        }
      }

      if (existing && (existing.status === 'deleted' || existing.status === 'completed')) {
        continue;
      }
      if (existing) {
        if (existing.slot_key !== slotKey || existing.due_date !== dueDate || !existing.identity_marker_added) {
          const patched = await tasks.tasks.patch({
            tasklist: '@default', task: existing.task_id, requestBody
          });
          db.prepare(`UPDATE google_tasks SET slot_key=?,due_date=?,remote_updated_at=?,updated_at=?,
            identity_marker_added=1 WHERE account_key=? AND routine_id=? AND slot_key=?`)
            .run(slotKey, dueDate, toIso(patched.data?.updated, null), nowIso(),
              account.account_key, routine.id, existing.slot_key);
          mappingsChanged = true;
        }
        continue;
      }

      const created = await tasks.tasks.insert({ tasklist: '@default', requestBody });
      db.prepare(`INSERT INTO google_tasks(
        account_key,routine_id,slot_key,task_id,due_date,status,updated_at,remote_updated_at,identity_marker_added
      ) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(account.account_key, routine.id, slotKey, created.data.id, dueDate,
          'needsAction', nowIso(), toIso(created.data?.updated, null));
      if (remoteTaskSnapshot) remoteTaskSnapshot.push(created.data);
      mappingsChanged = true;
    }
    if (mappingsChanged) queueDriveSync(userId);
    return { synced: true, mappingsUpdated: mappingsChanged };
  } finally {
    taskSyncLocks.delete(userId);
  }
}
const routineTaskPublishQueues = new Map();
const taskPullQueues = new Map();
const taskPullLastQueuedAt = new Map();

function queueRoutineTaskPublish(userId, routineIds = null) {
  let queue = routineTaskPublishQueues.get(userId);
  if (!queue) {
    queue = { ids: new Set(), all: false, timer: null };
    routineTaskPublishQueues.set(userId, queue);
  }
  if (Array.isArray(routineIds)) {
    for (const id of routineIds) if (typeof id === 'string') queue.ids.add(id);
  } else {
    queue.all = true;
  }
  if (queue.timer) clearTimeout(queue.timer);
  const run = async () => {
    if (taskSyncLocks.has(userId)) {
      queue.timer = setTimeout(run, 1500);
      if (queue.timer.unref) queue.timer.unref();
      return;
    }
    routineTaskPublishQueues.delete(userId);
    try {
      await syncRoutineTasks(userId, queue.all ? null : [...queue.ids], { pullChanges: false });
    } catch (error) {
      console.warn(`Google Task publish failed for ${userId}:`, error.message);
    }
  };
  queue.timer = setTimeout(run, 900);
  if (queue.timer.unref) queue.timer.unref();
}

function queueTaskPullSync(userId) {
  if (taskPullQueues.has(userId) || taskSyncLocks.has(userId)) return;
  const account = getCurrentGoogleAccount(userId);
  if (!account) return;
  const now = Date.now();
  const lastQueued = taskPullLastQueuedAt.get(userId) || 0;
  if (now - lastQueued < 15000) return;
  const lastRoutineSync = Date.parse(account.last_task_sync || '') || 0;
  const lastExternalSync = Date.parse(account.last_external_task_sync || '') || 0;
  const routineFresh = lastRoutineSync && now - lastRoutineSync < TASK_SYNC_BOOTSTRAP_COOLDOWN_MS;
  const externalFresh = lastExternalSync && now - lastExternalSync < TASK_SYNC_BOOTSTRAP_COOLDOWN_MS;
  if (routineFresh && externalFresh) return;
  taskPullLastQueuedAt.set(userId, now);
  const timer = setTimeout(async () => {
    taskPullQueues.delete(userId);
    if (taskSyncLocks.has(userId)) return;
    try { await syncRoutineTasks(userId, null, { pullChanges: true }); }
    catch (error) { console.warn(`Google Task refresh failed for ${userId}:`, error.message); }
  }, 250);
  if (timer.unref) timer.unref();
  taskPullQueues.set(userId, timer);
}

async function completeCurrentGoogleTask(userId, routine) {
  const account = getCurrentGoogleAccount(userId);
  if (!account) return;
  const row = db.prepare("SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status='needsAction' ORDER BY updated_at DESC LIMIT 1").get(account.account_key, routine.id);
  if (!row) return;
  const patched = await tasksApi(account.account_key).tasks.patch({ tasklist: '@default', task: row.task_id, requestBody: { status: 'completed', completed: nowIso() } });
  db.prepare('UPDATE google_tasks SET status=?,remote_updated_at=?,updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?')
    .run('completed', toIso(patched.data?.updated, null), nowIso(), account.account_key, routine.id, row.slot_key);
  return { ...row, account_key: account.account_key };
}

function publicRoutine(routine, now = new Date()) {
  const progressive = parseBooleanFlag(routine.progressive, true);
  const item = { ...routine, archived: Boolean(routine.archived), progressive };
  if (routine.type === 'frequency') {
    const window = getCurrentPeriod(routine, now);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM completions
      WHERE routine_id = ? AND completed_at >= ? AND completed_at < ?`)
      .get(routine.id, window.start.toISOString(), window.end.toISOString()).n;
    const duration = Math.max(1, window.end.getTime() - window.start.getTime());
    const hasStarted = now.getTime() >= window.start.getTime();
    const elapsedFraction = Math.max(0, Math.min(1, (now.getTime() - window.start.getTime()) / duration));
    const maxCount = Math.max(1, Number(routine.max_count || 1));
    const completedCount = Math.min(maxCount, Number(count || 0));

    // Progressive is a visibility schedule only. It determines when the next
    // checklist/Calendar/Google Task item appears; it does not prohibit a user
    // from manually logging an early completion from the routine card.
    const frequencyUnlock = completedCount >= maxCount
      ? null
      : progressive
        ? new Date(window.start.getTime() + duration * (completedCount / maxCount))
        : window.start;
    const linkedDue = routine.linked_to_routine_id && routine.next_due_at ? new Date(routine.next_due_at) : null;
    const linkedDoneForThisAnchor = Boolean(routine.linked_to_routine_id && routine.linked_completed_anchor && routine.next_due_at && routine.linked_completed_anchor === routine.next_due_at);
    const nextUnlock = completedCount >= maxCount || linkedDoneForThisAnchor
      ? null
      : linkedDue && frequencyUnlock
        ? new Date(Math.max(frequencyUnlock.getTime(), linkedDue.getTime()))
        : frequencyUnlock;
    const linkedReady = !routine.linked_to_routine_id || (linkedDue && now.getTime() >= linkedDue.getTime() && !linkedDoneForThisAnchor);
    const checkinAvailable = completedCount < maxCount && hasStarted && linkedReady && (!progressive || now.getTime() >= frequencyUnlock.getTime());
    const nextOpportunityAt = completedCount >= maxCount || linkedDoneForThisAnchor
      ? null
      : (checkinAvailable ? now.toISOString() : (nextUnlock ? nextUnlock.toISOString() : null));

    item.periodStart = window.start.toISOString();
    item.periodEnd = window.end.toISOString();
    item.completedCount = completedCount;
    item.minimumReached = completedCount >= Number(routine.min_count || 1);
    item.maximumReached = completedCount >= maxCount;
    item.remainingMinimum = Math.max(0, Number(routine.min_count || 1) - completedCount);
    item.progress = Math.min(100, Math.round((completedCount / maxCount) * 100));
    item.unlockedCount = progressive
      ? Math.min(maxCount, Math.max(completedCount, hasStarted ? Math.floor(elapsedFraction * maxCount + 1e-9) + 1 : 0))
      : maxCount;
    item.checkinAvailable = checkinAvailable;
    item.nextUnlockAt = nextUnlock ? nextUnlock.toISOString() : null;
    item.nextOpportunityAt = nextOpportunityAt;
    item.cadenceLabel = `${routine.min_count}${routine.max_count > routine.min_count ? `–${routine.max_count}` : ''} times every ${routine.period_value} ${unitLabel(routine.period_unit)}`;
    if (routine.linked_to_routine_id) {
      const parent = db.prepare('SELECT title FROM routines WHERE id=? AND user_id=?').get(routine.linked_to_routine_id, routine.user_id);
      item.linkedRoutineTitle = parent?.title || 'Linked routine';
      item.cadenceLabel += ` · Linked ${routine.linked_offset_days < 0 ? 'before' : 'after'} ${item.linkedRoutineTitle}`;
    }
  } else {
    const due = routine.next_due_at ? new Date(routine.next_due_at) : null;
    const alreadyDoneForLinkedOccurrence = Boolean(routine.linked_to_routine_id && routine.last_completed_at && due && new Date(routine.last_completed_at) >= due);
    item.isDue = due ? (due.getTime() <= now.getTime() && !alreadyDoneForLinkedOccurrence) : !routine.linked_to_routine_id;
    item.daysUntilDue = due ? Math.ceil((due.getTime() - now.getTime()) / 86400000) : 0;
    if (routine.linked_to_routine_id) {
      const parent = db.prepare('SELECT title FROM routines WHERE id=? AND user_id=?').get(routine.linked_to_routine_id, routine.user_id);
      item.linkedRoutineTitle = parent?.title || 'Linked routine';
      item.cadenceLabel = `Linked · ${Math.abs(routine.linked_offset_days || 0)} day${Math.abs(routine.linked_offset_days || 0) === 1 ? '' : 's'} ${routine.linked_offset_days < 0 ? 'before' : 'after'} ${item.linkedRoutineTitle}`;
    } else {
      item.cadenceLabel = `Every ${routine.interval_value} ${unitLabel(routine.interval_unit)}`;
    }
  }
  item.taskSlotKey = routineTaskSlotKey(routine, item);
  item.taskSuppressed = isRoutineTaskSuppressed(routine.user_id, routine.id, item.taskSlotKey);
  return item;
}
function listRoutines(userId, includeArchived = false) {
  // Keep linked child dates aligned with their parent's next occurrence even
  // when a frequency period rolls over while the user is away from the app.
  const parentRows = db.prepare(`SELECT DISTINCT p.id FROM routines p JOIN routines c
    ON c.linked_to_routine_id=p.id AND c.user_id=p.user_id AND c.archived=0
    WHERE p.user_id=? AND p.archived=0`).all(userId);
  for (const parent of parentRows) updateLinkedRoutineSchedules(userId, parent.id);
  const rows = db.prepare(`SELECT * FROM routines WHERE user_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY created_at DESC`).all(userId);
  return rows.map((row) => publicRoutine(row));
}
function getUserPublic(userId) {
  const user = db.prepare('SELECT id, email, display_name, picture, google_account_key FROM users WHERE id = ?').get(userId);
  if (!user) return { id: userId, display_name: 'Your space', email: null, picture: null, googleConnected: false };
  return {
    id: user.id,
    email: user.email || null,
    display_name: user.display_name || 'Your space',
    picture: user.picture || null,
    googleConnected: Boolean(user.google_account_key)
  };
}
function googleStatus(userId) {
  const account = getCurrentGoogleAccount(userId);
  if (!account) return { connected: false, email: null, displayName: null, lastCalendarSync: null, lastDriveSync: null, error: null };
  return {
    connected: true,
    email: account.email,
    displayName: account.display_name,
    picture: account.picture,
    lastCalendarSync: account.last_calendar_sync,
    lastDriveSync: account.last_drive_sync,
    error: account.last_error || null
  };
}
function statsFor(userId, routines) {
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const completedThisMonth = db.prepare('SELECT COUNT(*) AS n FROM completions WHERE user_id = ? AND completed_at >= ?')
    .get(userId, monthStart.toISOString()).n;
  const dueCount = routines.filter((r) => !r.taskSuppressed && (r.type === 'interval' ? r.isDue : r.checkinAvailable)).length;
  const targetsMet = routines.filter((r) => r.type === 'frequency' && r.minimumReached).length;
  return { routineCount: routines.length, completedThisMonth, dueCount, targetsMet };
}
function queueDriveSync(userId) {
  if (!DRIVE_AUTO_SYNC || !driveRestoreReadyUsers.has(userId)) return;
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) return;
  const oldTimer = driveTimers.get(userId);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    driveTimers.delete(userId);
    syncDriveBackup(userId).catch((error) => {
      console.warn(`Automatic Drive backup failed for ${userId}:`, error.message);
      const account = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
      if (account) db.prepare('UPDATE google_accounts SET last_error = ?, updated_at = ? WHERE account_key = ?')
        .run(`Drive backup: ${error.message}`, nowIso(), account.google_account_key);
    });
  }, DRIVE_AUTO_SYNC_DELAY_MS);
  if (timer.unref) timer.unref();
  driveTimers.set(userId, timer);
}
const driveTimers = new Map();

async function findDriveFileByName(drive, name) {
  const escapedName = String(name).replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `name = '${escapedName}' and trashed = false`,
    spaces: 'drive',
    pageSize: 10,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,modifiedTime)'
  });
  return (found.data.files || [])[0]?.id || null;
}

async function syncDriveBackup(userId, options = {}) {
  if (!driveRestoreReadyUsers.has(userId)) throw new Error('Drive restore must complete before a backup can be uploaded.');
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) throw new Error('Connect Google before syncing to Drive.');
  const accountKey = user.google_account_key;
  const drive = driveApi(accountKey);
  const routines = db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY created_at').all(userId);
  const completions = db.prepare('SELECT * FROM completions WHERE user_id = ? ORDER BY completed_at').all(userId);
  const googleTasks = db.prepare(`SELECT gt.* FROM google_tasks gt
    JOIN routines r ON r.id=gt.routine_id
    WHERE gt.account_key=? AND r.user_id=? ORDER BY gt.routine_id,gt.slot_key`)
    .all(accountKey, userId);
  const taskSuppressions = db.prepare('SELECT * FROM routine_task_suppressions WHERE user_id=? ORDER BY routine_id,slot_key')
    .all(userId);
  const backup = {
    product: 'Routine Tracker',
    formatVersion: 2,
    exportedAt: nowIso(),
    routines,
    completions,
    googleTasks,
    taskSuppressions
  };

  let account = db.prepare(`SELECT drive_file_id,database_backup_file_id,last_database_backup
    FROM google_accounts WHERE account_key=?`).get(accountKey);
  let fileId = account?.drive_file_id || await findDriveFileByName(drive, 'Routine Tracker Backup.json');
  const jsonBody = Readable.from([Buffer.from(JSON.stringify(backup, null, 2), 'utf8')]);
  if (fileId) {
    await drive.files.update({
      fileId,
      media: { mimeType: 'application/json', body: jsonBody },
      fields: 'id,name,modifiedTime'
    });
  } else {
    const created = await drive.files.create({
      requestBody: { name: 'Routine Tracker Backup.json', mimeType: 'application/json' },
      media: { mimeType: 'application/json', body: jsonBody },
      fields: 'id,name,modifiedTime'
    });
    fileId = created.data.id;
  }

  // Keep a real, transactionally-consistent SQLite snapshot in the same user's
  // Drive as well as the portable JSON export. The binary snapshot preserves
  // internal mappings and sync state that a routines-only export cannot.
  const lastDatabaseBackupMs = Date.parse(account?.last_database_backup || '') || 0;
  const shouldWriteDatabaseBackup = options.forceDatabaseBackup ||
    !lastDatabaseBackupMs || Date.now() - lastDatabaseBackupMs >= DATABASE_BACKUP_INTERVAL_MS;
  let databaseBackupFileId = account?.database_backup_file_id || null;
  let databaseBackupUpdated = false;
  if (shouldWriteDatabaseBackup) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'routine-tracker-db-backup-'));
    const tempPath = path.join(tempDir, 'routine-tracker.sqlite');
    try {
      await db.backup(tempPath);
      if (!databaseBackupFileId) {
        databaseBackupFileId = await findDriveFileByName(drive, 'Routine Tracker Database.sqlite');
      }
      const databaseBody = fs.createReadStream(tempPath);
      if (databaseBackupFileId) {
        await drive.files.update({
          fileId: databaseBackupFileId,
          media: { mimeType: 'application/vnd.sqlite3', body: databaseBody },
          fields: 'id,name,modifiedTime'
        });
      } else {
        const created = await drive.files.create({
          requestBody: { name: 'Routine Tracker Database.sqlite', mimeType: 'application/vnd.sqlite3' },
          media: { mimeType: 'application/vnd.sqlite3', body: databaseBody },
          fields: 'id,name,modifiedTime'
        });
        databaseBackupFileId = created.data.id;
      }
      const backupAt = nowIso();
      db.prepare(`UPDATE google_accounts SET database_backup_file_id=?,last_database_backup=?,
        updated_at=? WHERE account_key=?`)
        .run(databaseBackupFileId, backupAt, backupAt, accountKey);
      databaseBackupUpdated = true;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  const syncedAt = nowIso();
  db.prepare(`UPDATE google_accounts SET drive_file_id=?,last_drive_sync=?,last_error=NULL,updated_at=?
    WHERE account_key=?`)
    .run(fileId, syncedAt, syncedAt, accountKey);
  return {
    fileId,
    databaseBackupFileId,
    databaseBackupUpdated,
    exportedAt: backup.exportedAt,
    routineCount: routines.length,
    completionCount: completions.length,
    googleTaskMappingCount: googleTasks.length
  };
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readSqliteBackupFromDrive(drive, fileId, accountKey) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'routine-tracker-db-restore-'));
  const tempPath = path.join(tempDir, 'routine-tracker.sqlite');
  let sourceDb = null;
  try {
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    await pipeline(response.data, fs.createWriteStream(tempPath));
    sourceDb = new Database(tempPath, { readonly: true, fileMustExist: true });
    const sourceAccount = sourceDb.prepare('SELECT account_key,last_database_backup FROM google_accounts WHERE account_key=?')
      .get(accountKey);
    if (!sourceAccount) throw new Error('The SQLite backup belongs to a different Google account or is incomplete.');
    const sourceUser = sourceDb.prepare('SELECT id FROM users WHERE google_account_key=?').get(accountKey);
    if (!sourceUser) throw new Error('The SQLite backup does not contain this Google account\'s user data.');
    const hasTable = (name) => Boolean(sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    return {
      product: 'Routine Tracker',
      formatVersion: 2,
      exportedAt: sourceAccount.last_database_backup || nowIso(),
      routines: sourceDb.prepare('SELECT * FROM routines WHERE user_id=? ORDER BY created_at').all(sourceUser.id),
      completions: sourceDb.prepare('SELECT * FROM completions WHERE user_id=? ORDER BY completed_at').all(sourceUser.id),
      googleTasks: hasTable('google_tasks')
        ? sourceDb.prepare('SELECT * FROM google_tasks WHERE account_key=? ORDER BY routine_id,slot_key').all(accountKey) : [],
      taskSuppressions: hasTable('routine_task_suppressions')
        ? sourceDb.prepare('SELECT * FROM routine_task_suppressions WHERE user_id=? ORDER BY routine_id,slot_key').all(sourceUser.id) : []
    };
  } finally {
    if (sourceDb) sourceDb.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function restoreDriveBackup(userId, options = {}) {
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) throw new Error('Connect Google before restoring from Drive.');
  const accountKey = user.google_account_key;
  const drive = driveApi(accountKey);
  const account = db.prepare(`SELECT drive_file_id,database_backup_file_id FROM google_accounts
    WHERE account_key=?`).get(accountKey);
  const databaseBackupFileId = account?.database_backup_file_id ||
    await findDriveFileByName(drive, 'Routine Tracker Database.sqlite');
  const fileId = account?.drive_file_id ||
    await findDriveFileByName(drive, 'Routine Tracker Backup.json');
  const candidates = [];

  // Compare Drive's modification timestamps. The JSON export can be newer
  // than the periodic SQLite snapshot, so never blindly prefer SQLite.
  if (databaseBackupFileId) {
    const meta = await drive.files.get({ fileId: databaseBackupFileId, fields: 'id,modifiedTime' });
    candidates.push({
      kind: 'sqlite',
      modifiedAt: Date.parse(meta.data.modifiedTime || '') || 0,
      backup: await readSqliteBackupFromDrive(drive, databaseBackupFileId, accountKey)
    });
  }
  if (fileId) {
    const meta = await drive.files.get({ fileId, fields: 'id,modifiedTime' });
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    const jsonBackup = safeJsonParse(await readStream(response.data));
    if (jsonBackup) candidates.push({
      kind: 'json',
      modifiedAt: Date.parse(meta.data.modifiedTime || '') || 0,
      backup: jsonBackup
    });
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const selected = candidates[0] || null;
  const backup = selected?.backup || null;

  if (!backup) {
    if (options.allowMissing) {
      driveRestoreReadyUsers.add(userId);
      return { restored: false, routineCount: 0, completionCount: 0, googleTaskMappingCount: 0 };
    }
    throw new Error('No Routine Tracker SQLite or JSON backup was found in this Google Drive.');
  }
  if (backup.product !== 'Routine Tracker' ||
      ![1, 2].includes(Number(backup.formatVersion)) ||
      !Array.isArray(backup.routines) ||
      !Array.isArray(backup.completions)) {
    throw new Error('The Drive file is not a supported Routine Tracker backup.');
  }

  let routineCount = 0;
  let completionCount = 0;
  let googleTaskMappingCount = 0;
  let duplicateRemoteTasksRemoved = 0;
  const duplicateRemoteTaskIds = [];
  const importTransaction = db.transaction(() => {
    const routineIdMap = new Map();
    for (const r of backup.routines) {
      if (!r || !r.id || !r.title || !['frequency', 'interval'].includes(r.type)) continue;
      const sourceId = String(r.id);
      const existing = db.prepare('SELECT user_id FROM routines WHERE id = ?').get(sourceId);
      const targetId = existing && existing.user_id !== userId ? makeId('routine') : sourceId;
      routineIdMap.set(sourceId, targetId);
      const values = {
        id: targetId, user_id: userId, title: String(r.title).slice(0, 120), notes: String(r.notes || ''),
        color: r.color || 'lavender', icon_name: r.icon_name || '', icon_color: r.icon_color || '', type: r.type, min_count: r.min_count ?? null, max_count: r.max_count ?? null,
        period_value: r.period_value ?? null, period_unit: r.period_unit ?? null,
        interval_value: r.interval_value ?? null, interval_unit: r.interval_unit ?? null,
        start_at: r.start_at ?? null, last_completed_at: r.last_completed_at ?? null,
        next_due_at: r.next_due_at ?? null, progressive: r.progressive ?? 1,
        linked_to_routine_id: r.linked_to_routine_id ?? null, linked_offset_days: r.linked_offset_days ?? -1,
        linked_completed_anchor: r.linked_completed_anchor ?? null, archived: r.archived ? 1 : 0,
        created_at: r.created_at || nowIso(), updated_at: r.updated_at || nowIso()
      };
      if (existing && targetId === sourceId) {
        db.prepare(`UPDATE routines SET title=@title,notes=@notes,color=@color,icon_name=@icon_name,icon_color=@icon_color,type=@type,min_count=@min_count,
          max_count=@max_count,period_value=@period_value,period_unit=@period_unit,interval_value=@interval_value,
          interval_unit=@interval_unit,start_at=@start_at,last_completed_at=@last_completed_at,next_due_at=@next_due_at,progressive=@progressive,
          linked_to_routine_id=@linked_to_routine_id,linked_offset_days=@linked_offset_days,linked_completed_anchor=@linked_completed_anchor,
          archived=@archived,updated_at=@updated_at WHERE id=@id AND user_id=@user_id AND updated_at < @updated_at`)
          .run(values);
      } else {
        db.prepare(`INSERT OR IGNORE INTO routines(
          id,user_id,title,notes,color,icon_name,icon_color,type,min_count,max_count,period_value,period_unit,
          interval_value,interval_unit,start_at,last_completed_at,next_due_at,progressive,linked_to_routine_id,
          linked_offset_days,linked_completed_anchor,archived,created_at,updated_at
        ) VALUES(
          @id,@user_id,@title,@notes,@color,@icon_name,@icon_color,@type,@min_count,@max_count,@period_value,@period_unit,
          @interval_value,@interval_unit,@start_at,@last_completed_at,@next_due_at,@progressive,@linked_to_routine_id,
          @linked_offset_days,@linked_completed_anchor,@archived,@created_at,@updated_at
        )`).run(values);
      }
      routineCount++;
    }

    for (const c of backup.completions) {
      if (!c || !c.id || !c.routine_id || !c.completed_at) continue;
      const targetRoutineId = routineIdMap.get(String(c.routine_id));
      if (!targetRoutineId) continue;
      const existingCompletion = db.prepare('SELECT user_id FROM completions WHERE id = ?').get(String(c.id));
      const targetCompletionId = existingCompletion && existingCompletion.user_id !== userId ? makeId('done') : String(c.id);
      db.prepare('INSERT OR IGNORE INTO completions(id,routine_id,user_id,completed_at,note) VALUES(?,?,?,?,?)')
        .run(targetCompletionId, targetRoutineId, userId, String(c.completed_at), String(c.note || ''));
      completionCount++;
    }

    for (const mapping of (Array.isArray(backup.googleTasks) ? backup.googleTasks : [])) {
      if (!mapping || !mapping.routine_id || !mapping.slot_key || !mapping.task_id) continue;
      const targetRoutineId = routineIdMap.get(String(mapping.routine_id));
      if (!targetRoutineId) continue;
      const otherOwner = db.prepare('SELECT routine_id FROM google_tasks WHERE account_key=? AND task_id=?')
        .get(accountKey, String(mapping.task_id));
      if (otherOwner && otherOwner.routine_id !== targetRoutineId) continue;
      const current = db.prepare('SELECT task_id,status FROM google_tasks WHERE account_key=? AND routine_id=? AND slot_key=?')
        .get(accountKey, targetRoutineId, String(mapping.slot_key));
      // The Drive backup is the shared source of truth for cross-server task IDs.
      // If this installation independently created a pending task for the same
      // routine occurrence, remove that mapped duplicate and restore the backup
      // ID. Never touch arbitrary Google Tasks or completed local tasks.
      if (current && current.task_id !== String(mapping.task_id) && current.status === 'needsAction') {
        duplicateRemoteTaskIds.push(current.task_id);
      }
      db.prepare(`INSERT INTO google_tasks(
        account_key,routine_id,slot_key,task_id,due_date,status,updated_at,completion_id,
        remote_updated_at,legacy_probe_done,identity_marker_added
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_key,routine_id,slot_key) DO UPDATE SET
        task_id=excluded.task_id,due_date=excluded.due_date,status=excluded.status,
        updated_at=excluded.updated_at,completion_id=excluded.completion_id,
        remote_updated_at=excluded.remote_updated_at,legacy_probe_done=excluded.legacy_probe_done,
        identity_marker_added=excluded.identity_marker_added
      `)
        .run(accountKey, targetRoutineId, String(mapping.slot_key), String(mapping.task_id),
          String(mapping.due_date || ''), ['needsAction', 'completed', 'deleted'].includes(mapping.status) ? mapping.status : 'needsAction',
          mapping.updated_at || nowIso(), mapping.completion_id || null, mapping.remote_updated_at || null,
          mapping.legacy_probe_done ? 1 : 0, mapping.identity_marker_added ? 1 : 0);
      googleTaskMappingCount++;
    }

    for (const suppression of (Array.isArray(backup.taskSuppressions) ? backup.taskSuppressions : [])) {
      if (!suppression || !suppression.routine_id || !suppression.slot_key) continue;
      const targetRoutineId = routineIdMap.get(String(suppression.routine_id));
      if (!targetRoutineId) continue;
      db.prepare('INSERT OR IGNORE INTO routine_task_suppressions(user_id,routine_id,slot_key,created_at) VALUES(?,?,?,?)')
        .run(userId, targetRoutineId, String(suppression.slot_key), suppression.created_at || nowIso());
    }
  });
  importTransaction();

  for (const duplicateTaskId of new Set(duplicateRemoteTaskIds)) {
    try {
      await deleteGoogleTask(accountKey, duplicateTaskId);
      duplicateRemoteTasksRemoved++;
    } catch (error) {
      console.warn('Could not remove a duplicate Google Task during Drive restore:', error.message);
    }
  }

  driveRestoreReadyUsers.add(userId);
  const syncedAt = nowIso();
  db.prepare(`UPDATE google_accounts SET
    drive_file_id=COALESCE(?,drive_file_id),
    database_backup_file_id=COALESCE(?,database_backup_file_id),
    last_drive_sync=?,last_error=NULL,updated_at=?
    WHERE account_key=?`)
    .run(fileId, databaseBackupFileId || null, syncedAt, syncedAt, accountKey);
  queueDriveSync(userId);
  return {
    restored: true,
    routineCount,
    completionCount,
    googleTaskMappingCount,
    duplicateRemoteTasksRemoved,
    backupExportedAt: backup.exportedAt || null,
    source: selected.kind
  };
}
const calendarSyncLocks = new Set();
async function syncCalendarForAccount(accountKey, attempt = 0) {
  if (calendarSyncLocks.has(accountKey)) return { skipped: true };
  calendarSyncLocks.add(accountKey);
  try {
    const accountRow = db.prepare('SELECT calendar_sync_token FROM google_accounts WHERE account_key = ?').get(accountKey);
    if (!accountRow) return { skipped: true };
    const calendar = calendarApi(accountKey);
    const syncToken = accountRow.calendar_sync_token;
    let pageToken;
    let nextSyncToken = null;
    do {
      const params = {
        calendarId: 'primary', maxResults: 2500, singleEvents: true, showDeleted: true,
        ...(syncToken ? { syncToken } : {}), ...(pageToken ? { pageToken } : {})
      };
      let response;
      try {
        response = await calendar.events.list(params);
      } catch (error) {
        if (error.code === 410 && attempt === 0) {
          db.prepare('DELETE FROM google_events WHERE account_key = ?').run(accountKey);
          db.prepare('UPDATE google_accounts SET calendar_sync_token = NULL WHERE account_key = ?').run(accountKey);
          calendarSyncLocks.delete(accountKey);
          return syncCalendarForAccount(accountKey, 1);
        }
        throw error;
      }
      for (const event of (response.data.items || [])) {
        if (!event.id) continue;
        if (event.status === 'cancelled') {
          db.prepare('DELETE FROM google_events WHERE account_key = ? AND event_id = ?').run(accountKey, event.id);
          continue;
        }
        const start = event.start && (event.start.dateTime || event.start.date);
        if (!start) continue;
        const end = event.end && (event.end.dateTime || event.end.date);
        db.prepare(`INSERT INTO google_events(account_key,event_id,summary,start_at,end_at,all_day,status,location,html_link,description,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_key,event_id) DO UPDATE SET
            summary=excluded.summary,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,
            status=excluded.status,location=excluded.location,html_link=excluded.html_link,description=excluded.description,updated_at=excluded.updated_at`)
          .run(accountKey, event.id, event.summary || '(No title)', start, end || null,
            event.start.date ? 1 : 0, event.status || 'confirmed', event.location || null,
            event.htmlLink || null, event.description || null, event.updated || null);
      }
      pageToken = response.data.nextPageToken || null;
      nextSyncToken = response.data.nextSyncToken || nextSyncToken;
    } while (pageToken);
    db.prepare('UPDATE google_accounts SET calendar_sync_token = ?, last_calendar_sync = ?, last_error = NULL, updated_at = ? WHERE account_key = ?')
      .run(nextSyncToken || syncToken || null, nowIso(), nowIso(), accountKey);
    return { syncedAt: nowIso() };
  } catch (error) {
    db.prepare('UPDATE google_accounts SET last_error = ?, updated_at = ? WHERE account_key = ?')
      .run(`Calendar sync: ${error.message}`, nowIso(), accountKey);
    throw error;
  } finally {
    calendarSyncLocks.delete(accountKey);
  }
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'off', 'no', 'unchecked', ''].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes', 'checked'].includes(normalized)) return true;
  return Boolean(fallback);
}
function normalizeHexColor(value, fallback = '#c4b5fd') {
  const text = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return fallback;
}
const ROUTINE_COLOR_PRESETS = new Set(['lavender', 'mint', 'peach', 'blue', 'rose', 'gold']);
const ROUTINE_COLOR_HEX = { lavender: '#a895f0', mint: '#72c6a0', peach: '#e9a77f', blue: '#84a8df', rose: '#d98eaa', gold: '#d8b85d' };
const ROUTINE_ICON_NAMES = new Set([
  'sparkles','leaf','sprout','droplet','flower','sun','moon','bed','bath','book','heart','dumbbell',
  'pill','glass-water','apple','footprints','house','shirt','spray-can','clock','hand','smile','wind',
  'cloud','flame','star','music','laptop','wallet','shopping-bag','broom','recycle','camera','scissors',
  'notebook','pen','bike','paw','cooking-pot','utensils','sunrise','waves','mountain','tree','soap',
  'bottle','meditation','gift','clipboard','shield','target','running','stethoscope','tooth','coffee',
  'calendar','check-circle','alarm-clock','washing-machine','plant','water','comb','mirror','syringe'
]);

function parseRoutineBody(body, existing = null) {
  const type = body.type || existing?.type;
  if (!['frequency', 'interval'].includes(type)) throw new Error('Choose a valid routine type.');
  const title = String(body.title ?? existing?.title ?? '').trim().slice(0, 120);
  if (!title) throw new Error('Give your routine a name.');
  const rawColor = body.color ?? existing?.color ?? 'lavender';
  const color = ROUTINE_COLOR_PRESETS.has(String(rawColor)) ? String(rawColor) : normalizeHexColor(rawColor, 'lavender');
  const rawIcon = String(body.iconName ?? existing?.icon_name ?? 'sparkles').trim().toLowerCase();
  const iconName = ROUTINE_ICON_NAMES.has(rawIcon) ? rawIcon : 'sparkles';
  const iconColor = /^#[0-9a-f]{3,6}$/i.test(color) ? normalizeHexColor(color) : (ROUTINE_COLOR_HEX[color] || '#a895f0');
  const common = { title, notes: String(body.notes ?? existing?.notes ?? '').trim().slice(0, 1200), color, icon_name: iconName, icon_color: iconColor, type };

  const hasLinkedValue = Object.prototype.hasOwnProperty.call(body, 'linkedToRoutineId');
  const linkedId = hasLinkedValue ? (body.linkedToRoutineId ? String(body.linkedToRoutineId) : null) : (existing?.linked_to_routine_id || null);
  const linkedOffsetDays = Number(body.linkedOffsetDays ?? existing?.linked_offset_days ?? -1);
  if (!Number.isInteger(linkedOffsetDays) || Math.abs(linkedOffsetDays) > 3650) throw new Error('Linked offset must be a whole number between -3650 and 3650 days.');
  let linkedParent = null;
  let linkedNextDueAt = null;
  if (linkedId) {
    if (linkedId === existing?.id) throw new Error('A routine cannot be linked to itself.');
    if (existing && db.prepare('SELECT 1 FROM routines WHERE user_id=? AND linked_to_routine_id=? AND archived=0 LIMIT 1').get(existing.user_id, existing.id)) {
      throw new Error('A routine that already has linked routines cannot itself be linked.');
    }
    linkedParent = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=? AND archived=0').get(linkedId, body.userId || existing?.user_id);
    if (!linkedParent || linkedParent.linked_to_routine_id) throw new Error('Choose an active routine that is not itself linked.');
    const anchor = getRoutineAnchorDate(linkedParent);
    linkedNextDueAt = anchor ? addOffsetDays(anchor, linkedOffsetDays).toISOString() : null;
  }

  if (type === 'frequency') {
    const minCount = Number(body.minCount ?? existing?.min_count ?? 2);
    const maxCount = Number(body.maxCount ?? existing?.max_count ?? minCount);
    const periodValue = Number(body.periodValue ?? existing?.period_value ?? 1);
    const periodUnit = body.periodUnit || existing?.period_unit || 'weeks';
    if (!Number.isInteger(minCount) || minCount < 1 || minCount > 100) throw new Error('Minimum count must be from 1 to 100.');
    if (!Number.isInteger(maxCount) || maxCount < minCount || maxCount > 100) throw new Error('Maximum count must be at least the minimum and no more than 100.');
    if (!Number.isInteger(periodValue) || periodValue < 1 || periodValue > 365) throw new Error('Frequency period must be from 1 to 365.');
    if (!['days', 'weeks', 'months'].includes(periodUnit)) throw new Error('Choose a valid frequency period.');
    const startAt = toIso(body.startAt ?? existing?.start_at, nowIso());
    const progressive = Object.prototype.hasOwnProperty.call(body, 'progressive')
      ? (parseBooleanFlag(body.progressive, true) ? 1 : 0)
      : (parseBooleanFlag(existing?.progressive, true) ? 1 : 0);
    return { ...common, min_count: minCount, max_count: maxCount, period_value: periodValue, period_unit: periodUnit,
      interval_value: null, interval_unit: null, start_at: startAt, progressive,
      linked_to_routine_id: linkedId, linked_offset_days: linkedOffsetDays,
      linked_completed_anchor: linkedId ? (linkedId === existing?.linked_to_routine_id ? (existing?.linked_completed_anchor || null) : null) : null,
      last_completed_at: existing?.last_completed_at || null, next_due_at: linkedId ? linkedNextDueAt : null };
  }

  const intervalValue = Number(body.intervalValue ?? existing?.interval_value ?? 2);
  const intervalUnit = body.intervalUnit || existing?.interval_unit || 'weeks';
  if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 3650) throw new Error('Repeat interval must be from 1 to 3650.');
  if (!['days', 'weeks', 'months', 'years'].includes(intervalUnit)) throw new Error('Choose a valid repeat interval.');
  const suppliedLast = Object.prototype.hasOwnProperty.call(body, 'lastCompletedAt');
  const lastRaw = suppliedLast ? body.lastCompletedAt : existing?.last_completed_at;
  const lastCompletedAt = lastRaw ? toIso(lastRaw, null) : null;
  const nextDueAt = linkedId ? linkedNextDueAt : lastCompletedAt
    ? addRoutineIntervalFromCompletion(lastCompletedAt, intervalValue, intervalUnit).toISOString()
    : toIso(body.nextDueAt ?? existing?.next_due_at, nowIso());
  return { ...common, min_count: null, max_count: null, period_value: null, period_unit: null,
    interval_value: intervalValue, interval_unit: intervalUnit, start_at: null, progressive: 1,
    linked_to_routine_id: linkedId, linked_offset_days: linkedOffsetDays,
    linked_completed_anchor: linkedId ? (linkedId === existing?.linked_to_routine_id ? (existing?.linked_completed_anchor || null) : null) : null,
    last_completed_at: lastCompletedAt, next_due_at: nextDueAt };
}

app.get('/auth/google', (req, res, next) => {
  try {
    const client = oauthClient();
    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;
    req.session.oauthSwitch = req.query.switch === '1';
    const options = {
      access_type: 'offline',
      include_granted_scopes: true,
      state,
      scope: GOOGLE_SCOPES
    };
    if (req.session.oauthSwitch) options.prompt = 'select_account consent';
    else if (req.query.reauthorize === '1' || !getCurrentGoogleAccount(req.userId)) options.prompt = 'consent';
    const authUrl = client.generateAuthUrl(options);
    req.session.save((error) => error ? next(error) : res.redirect(authUrl));
  } catch (error) { next(error); }
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (req.query.error) return res.redirect('/?google_error=access_denied');
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send('Google sign-in could not be verified. Return to the app and try again.');
    }
    delete req.session.oauthState;
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ''));
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const profileResponse = await oauth2.userinfo.get();
    const profile = profileResponse.data;
    if (!profile.id) throw new Error('Google did not provide an account identifier.');

    const accountKey = `g_${sha256(profile.id).slice(0, 32)}`;
    const currentUserId = req.session.userId;
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUserId);
    const canonicalUserId = accountKey;
    const oldAccount = db.prepare('SELECT * FROM google_accounts WHERE account_key = ?').get(accountKey);
    let mergedTokens = { ...(oldAccount ? decryptTokens(oldAccount.tokens_enc) : {}), ...tokens };
    if (!tokens.refresh_token && oldAccount) mergedTokens.refresh_token = decryptTokens(oldAccount.tokens_enc).refresh_token;
    if (!mergedTokens.refresh_token) {
      throw new Error('Google did not return a long-lived refresh token. Open Google account permissions, remove this app, then connect again.');
    }

    const stamp = nowIso();
    db.prepare(`INSERT INTO users(id,google_account_key,email,display_name,picture,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      google_account_key=excluded.google_account_key,email=excluded.email,display_name=excluded.display_name,picture=excluded.picture`)
      .run(canonicalUserId, accountKey, profile.email || null, profile.name || 'Google user', profile.picture || null, stamp);
    db.prepare(`INSERT INTO google_accounts(account_key,google_sub,email,display_name,picture,tokens_enc,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET
      google_sub=excluded.google_sub,email=excluded.email,display_name=excluded.display_name,picture=excluded.picture,
      tokens_enc=excluded.tokens_enc,updated_at=excluded.updated_at`)
      .run(accountKey, profile.id, profile.email || null, profile.name || 'Google user', profile.picture || null, encryptTokens(mergedTokens), stamp, stamp);

    // First-time linking moves the temporary local browser profile into the Google
    // profile. Switching an already-linked browser never merges one person's data
    // into another person's account.
    if (currentUser && !currentUser.google_account_key && currentUserId !== canonicalUserId) {
      const move = db.transaction(() => {
        db.prepare('UPDATE routines SET user_id = ? WHERE user_id = ?').run(canonicalUserId, currentUserId);
        db.prepare('UPDATE completions SET user_id = ? WHERE user_id = ?').run(canonicalUserId, currentUserId);
        db.prepare('DELETE FROM users WHERE id = ?').run(currentUserId);
      });
      move();
    }
    req.session.userId = canonicalUserId;
    req.session.googleAccountKey = accountKey;
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      (async () => {
        // Merge the connected account's Drive backup before any local task
        // publisher or Drive uploader runs. This is safe for a non-empty local
        // workspace too: imports preserve local-only records and resolve routine
        // conflicts using updated_at, while restoring Google Task IDs prevents
        // a second server from creating duplicate tasks.
        await restoreDriveBackup(canonicalUserId, { allowMissing: true });
        syncCalendarForAccount(accountKey).catch((error) => console.warn('Initial Calendar sync failed:', error.message));
        queueDriveSync(canonicalUserId);
        res.redirect('/?connected=1');
      })().catch((error) => {
        console.error('Initial Drive restore failed; existing Drive backup was left untouched:', error.message);
        res.redirect('/?google_error=drive_restore_failed');
      });
    });
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message);
    res.redirect(`/?google_error=${encodeURIComponent(error.message.slice(0, 180))}`);
  }
});

app.get('/api/bootstrap', (req, res) => {
  // Never make the dashboard wait on Google. Pull changes in the background;
  // the next lightweight bootstrap poll paints the reconciled local state.
  queueTaskPullSync(req.userId);
  const routines = listRoutines(req.userId);
  res.json({
    appVersion: APP_VERSION,
    csrfToken: req.session.csrfToken,
    user: getUserPublic(req.userId),
    routines,
    stats: statsFor(req.userId, routines),
    google: googleStatus(req.userId)
  });
});

app.get('/api/routines', (req, res) => res.json({ routines: listRoutines(req.userId) }));
app.post('/api/routines', (req, res) => {
  try {
    const data = parseRoutineBody({ ...req.body, userId: req.userId });
    const id = makeId('routine');
    const stamp = nowIso();
    db.prepare(`INSERT INTO routines(
      id,user_id,title,notes,color,icon_name,icon_color,type,min_count,max_count,period_value,period_unit,
      interval_value,interval_unit,start_at,last_completed_at,next_due_at,progressive,linked_to_routine_id,linked_offset_days,linked_completed_anchor,created_at,updated_at
    ) VALUES(
      @id,@user_id,@title,@notes,@color,@icon_name,@icon_color,@type,@min_count,@max_count,@period_value,@period_unit,
      @interval_value,@interval_unit,@start_at,@last_completed_at,@next_due_at,@progressive,@linked_to_routine_id,@linked_offset_days,@linked_completed_anchor,@created_at,@updated_at
    )`).run({ id, user_id: req.userId, ...data, created_at: stamp, updated_at: stamp });
    if (!data.linked_to_routine_id) updateLinkedRoutineSchedules(req.userId, id);
    queueDriveSync(req.userId);
    queueRoutineTaskPublish(req.userId, [id]);
    res.status(201).json({ routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id = ?').get(id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/routines/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Routine not found.' });
    const data = parseRoutineBody({ ...req.body, type: existing.type, userId: req.userId }, existing);
    db.prepare(`UPDATE routines SET title=@title,notes=@notes,color=@color,icon_name=@icon_name,icon_color=@icon_color,min_count=@min_count,max_count=@max_count,
      period_value=@period_value,period_unit=@period_unit,interval_value=@interval_value,interval_unit=@interval_unit,
      start_at=@start_at,last_completed_at=@last_completed_at,next_due_at=@next_due_at,progressive=@progressive,linked_to_routine_id=@linked_to_routine_id,linked_offset_days=@linked_offset_days,linked_completed_anchor=@linked_completed_anchor,updated_at=@updated_at
      WHERE id=@id AND user_id=@user_id`).run({ ...data, updated_at: nowIso(), id: existing.id, user_id: req.userId });
    if (!data.linked_to_routine_id) updateLinkedRoutineSchedules(req.userId, existing.id);
    queueDriveSync(req.userId);
    queueRoutineTaskPublish(req.userId, [existing.id]);
    res.json({ routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id = ?').get(existing.id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/routines/:id/task', async (req, res) => {
  try {
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=? AND archived=0').get(req.params.id, req.userId);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const item = publicRoutine(routine);
    const slotKey = routineTaskSlotKey(routine, item);
    if (!slotKey) return res.status(409).json({ error: 'There is no current task occurrence to delete.' });
    const account = getCurrentGoogleAccount(req.userId);
    const linkedTask = account
      ? db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND slot_key=?').get(account.account_key, routine.id, slotKey)
      : null;
    // Delete remotely first. If Google rejects the operation, keep the local
    // checklist item visible so the two systems do not silently diverge.
    if (linkedTask && linkedTask.status !== 'deleted') {
      try { await deleteGoogleTask(account.account_key, linkedTask.task_id); }
      catch (error) {
        console.warn('Could not delete Google Task occurrence:', error.message);
        return res.status(502).json({ error: 'Google could not delete this task. Reconnect Google Tasks and try again.' });
      }
      db.prepare("UPDATE google_tasks SET status='deleted',updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?")
        .run(nowIso(), account.account_key, routine.id, slotKey);
    }
    db.prepare('INSERT OR IGNORE INTO routine_task_suppressions(user_id,routine_id,slot_key,created_at) VALUES(?,?,?,?)')
      .run(req.userId, routine.id, slotKey, nowIso());
    queueDriveSync(req.userId);
    res.json({ ok: true, googleDeleted: Boolean(linkedTask) });
  } catch (error) {
    console.error('Task deletion failed:', error.message);
    res.status(500).json({ error: 'Could not delete this task.' });
  }
});

app.delete('/api/routines/:id', async (req, res) => {
  try {
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=? AND archived=0').get(req.params.id, req.userId);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const account = getCurrentGoogleAccount(req.userId);
    const linkedTasks = account
      ? db.prepare("SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status<>'deleted'").all(account.account_key, routine.id)
      : [];
    // Archive only after every Google Task has been removed successfully.
    if (account) {
      for (const task of linkedTasks) {
        try { await deleteGoogleTask(account.account_key, task.task_id); }
        catch (error) {
          console.warn('Could not delete Google Task while archiving routine:', error.message);
          return res.status(502).json({ error: 'The routine was not archived because Google could not delete one of its tasks. Reconnect Google Tasks and try again.' });
        }
      }
      db.prepare("UPDATE google_tasks SET status='deleted',updated_at=? WHERE account_key=? AND routine_id=?")
        .run(nowIso(), account.account_key, routine.id);
    }
    db.prepare('UPDATE routines SET archived=1,updated_at=? WHERE id=? AND user_id=?').run(nowIso(), routine.id, req.userId);
    updateLinkedRoutineSchedules(req.userId, routine.id);
    queueDriveSync(req.userId);
    res.json({ ok: true, deletedGoogleTasks: linkedTasks.length });
  } catch (error) {
    console.error('Routine archive failed:', error.message);
    res.status(500).json({ error: 'Could not archive this routine.' });
  }
});
app.post('/api/routines/:id/complete', async (req, res) => {
  try {
    const routine = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ? AND archived = 0').get(req.params.id, req.userId);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const publicBefore = publicRoutine(routine);
    if (routine.type === 'frequency' && publicBefore.maximumReached) return res.status(409).json({ error: 'You have already reached the maximum for this period.' });
    if (routine.type === 'interval' && !publicBefore.isDue) return res.status(409).json({ error: 'This routine is not due yet.' });
    let completedGoogleTask = null;
    try { completedGoogleTask = await completeCurrentGoogleTask(req.userId, publicRoutine(routine)); } catch (error) { console.warn('Could not complete Google Task:', error.message); }
    const completedAt = toIso(req.body.completedAt, nowIso());
    const completionId = makeId('done');
    db.prepare('INSERT INTO completions(id,routine_id,user_id,completed_at,note) VALUES(?,?,?,?,?)')
      .run(completionId, routine.id, req.userId, completedAt, String(req.body.note || '').slice(0, 500));
    if (completedGoogleTask) db.prepare('UPDATE google_tasks SET completion_id=? WHERE account_key=? AND routine_id=? AND slot_key=?')
      .run(completionId, completedGoogleTask.account_key, routine.id, completedGoogleTask.slot_key);
    if (routine.type === 'interval' && !routine.linked_to_routine_id) {
      const nextDueAt = addRoutineIntervalFromCompletion(completedAt, routine.interval_value, routine.interval_unit).toISOString();
      db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?')
        .run(completedAt, nextDueAt, nowIso(), routine.id);
      updateLinkedRoutineSchedules(req.userId, routine.id);
    } else if (routine.type === 'interval' && routine.linked_to_routine_id) {
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(completedAt, nowIso(), routine.id);
    } else {
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(completedAt, nowIso(), routine.id);
    }
    updateLinkedRoutineSchedules(req.userId, routine.id);
    if (routine.type === 'frequency') {
      const afterLog = publicRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(routine.id));
      if (routine.linked_to_routine_id && afterLog.maximumReached) {
        db.prepare('UPDATE routines SET linked_completed_anchor=next_due_at,updated_at=? WHERE id=?').run(nowIso(), routine.id);
      }
    }
    queueDriveSync(req.userId);
    const updated = db.prepare('SELECT * FROM routines WHERE id = ?').get(routine.id);
    queueRoutineTaskPublish(req.userId, [routine.id]);
    res.json({ routine: publicRoutine(updated), completion: { id: completionId, completedAt } });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(250, Math.max(1, Number(req.query.limit || 100)));
  const rows = db.prepare(`SELECT c.id,c.completed_at,c.note,r.id AS routine_id,r.title,r.color,r.type
    FROM completions c JOIN routines r ON r.id=c.routine_id
    WHERE c.user_id=? ORDER BY c.completed_at DESC LIMIT ?`).all(req.userId, limit);
  res.json({ history: rows });
});

app.delete('/api/history/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM completions WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Activity not found.' });
  const account = getCurrentGoogleAccount(req.userId);
  let linkedTask = account ? db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND completion_id=?').get(account.account_key, row.id) : null;
  if (!linkedTask && account) {
    linkedTask = db.prepare(`SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status='completed' AND completion_id IS NULL
      ORDER BY ABS(strftime('%s', updated_at)-strftime('%s', ?)) LIMIT 1`).get(account.account_key, row.routine_id, row.completed_at);
    if (linkedTask) {
      const gap = Math.abs(new Date(linkedTask.updated_at).getTime() - new Date(row.completed_at).getTime());
      if (gap > 24 * 60 * 60 * 1000) linkedTask = null;
    }
  }
  if (linkedTask) {
    try {
      await deleteGoogleTask(account.account_key, linkedTask.task_id);
    } catch (error) {
      console.warn('Could not delete linked Google Task:', error.message);
      return res.status(502).json({ error: 'The activity was not deleted because its Google Task could not be deleted. Reconnect Google Tasks and try again.' });
    }
    db.prepare("UPDATE google_tasks SET status='deleted',completion_id=NULL,updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?")
      .run(nowIso(), account.account_key, row.routine_id, linkedTask.slot_key);
  }
  db.prepare('DELETE FROM completions WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(row.routine_id, req.userId);
  if (routine && routine.type === 'interval' && !routine.linked_to_routine_id) {
    const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
    const nextDue = latest ? addRoutineIntervalFromCompletion(latest.completed_at, routine.interval_value, routine.interval_unit).toISOString() : nowIso();
    db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nextDue, nowIso(), routine.id);
    updateLinkedRoutineSchedules(req.userId, routine.id);
  } else if (routine && routine.type === 'interval' && routine.linked_to_routine_id) {
    const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
    db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nowIso(), routine.id);
  }
  if (routine && routine.type === 'frequency') {
    const count = db.prepare('SELECT COUNT(*) AS n FROM completions WHERE routine_id=? AND completed_at>=? AND completed_at<?')
      .get(routine.id, getCurrentPeriod(routine).start.toISOString(), getCurrentPeriod(routine).end.toISOString()).n;
    if (routine.linked_to_routine_id && Number(count) < Number(routine.max_count || 1)) {
      db.prepare('UPDATE routines SET linked_completed_anchor=NULL,updated_at=? WHERE id=?').run(nowIso(), routine.id);
    }
  }
  updateLinkedRoutineSchedules(req.userId, row.routine_id);
  queueDriveSync(req.userId);
  queueRoutineTaskPublish(req.userId, [row.routine_id]);
  res.json({ ok: true });
});

app.patch('/api/routines/:id/reschedule', async (req, res) => {
  try {
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=? AND archived=0').get(req.params.id, req.userId);
    if (!routine || routine.type !== 'interval') return res.status(404).json({ error: 'Repeat-after routine not found.' });
    if (routine.linked_to_routine_id) return res.status(400).json({ error: 'This routine follows its linked routine. Change the linked routine date instead.' });
    const nextDueAt = toIso(req.body.nextDueAt, null);
    if (!nextDueAt) return res.status(400).json({ error: 'Choose a valid new due date.' });
    db.prepare('UPDATE routines SET next_due_at=?,updated_at=? WHERE id=? AND user_id=?').run(nextDueAt, nowIso(), routine.id, req.userId);
    updateLinkedRoutineSchedules(req.userId, routine.id);
    queueDriveSync(req.userId);
    queueRoutineTaskPublish(req.userId, [routine.id]);
    res.json({ ok: true, routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(routine.id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/completions/:id', async (req, res) => {
  try {
    const completion = db.prepare('SELECT * FROM completions WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (!completion) return res.status(404).json({ error: 'Completion not found.' });
    const completedAt = toIso(req.body.completedAt, null);
    if (!completedAt) return res.status(400).json({ error: 'Choose a valid completion date.' });

    // A completed Google Task is linked to this exact local completion by
    // completion_id. Update its due date as well as its completed timestamp so
    // the completed item moves to the same day in Google Tasks / Calendar.
    // The Google call is made before changing SQLite, so a real sync failure
    // does not leave the website and Google showing different dates.
    const account = getCurrentGoogleAccount(req.userId);
    let linkedTask = account
      ? db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND completion_id=?').get(account.account_key, completion.id)
      : null;
    let googleTaskUpdated = false;
    if (linkedTask) {
      const dateOnly = routineDateOnly(completedAt);
      try {
        const patched = await tasksApi(account.account_key).tasks.patch({
          tasklist: '@default',
          task: linkedTask.task_id,
          requestBody: {
            due: `${dateOnly}T00:00:00.000Z`,
            completed: completedAt
          }
        });
        db.prepare('UPDATE google_tasks SET due_date=?,remote_updated_at=?,updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?')
          .run(dateOnly, toIso(patched.data?.updated, null), nowIso(), account.account_key, linkedTask.routine_id, linkedTask.slot_key);
        googleTaskUpdated = true;
      } catch (error) {
        if (Number(error.code || error.response?.status) === 404) {
          // A task removed directly in Google is no longer syncable; retain
          // the local activity date without trying to recreate a completed task.
          db.prepare("UPDATE google_tasks SET status='deleted',updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?")
            .run(nowIso(), account.account_key, linkedTask.routine_id, linkedTask.slot_key);
        } else {
          console.warn('Could not update completed Google Task date:', error.message);
          return res.status(502).json({ error: 'Google could not update the completed task date. Your activity date was not changed. Reconnect Google Tasks and try again.' });
        }
      }
    }

    db.prepare('UPDATE completions SET completed_at=? WHERE id=? AND user_id=?').run(completedAt, completion.id, req.userId);
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(completion.routine_id, req.userId);
    if (routine && routine.type === 'interval' && !routine.linked_to_routine_id) {
      const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
      const nextDue = latest ? addRoutineIntervalFromCompletion(latest.completed_at, routine.interval_value, routine.interval_unit).toISOString() : nowIso();
      db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nextDue, nowIso(), routine.id);
      updateLinkedRoutineSchedules(req.userId, routine.id);
    } else if (routine && routine.type === 'interval' && routine.linked_to_routine_id) {
      const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nowIso(), routine.id);
    }
    if (routine && routine.type === 'frequency') {
      const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nowIso(), routine.id);
    }
    if (routine) updateLinkedRoutineSchedules(req.userId, routine.id);
    queueDriveSync(req.userId);
    queueRoutineTaskPublish(req.userId, [completion.routine_id]);
    res.json({ ok: true, googleTaskUpdated });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/calendar', async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const [year, monthNumber] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, monthNumber - 1, 1));
    const end = new Date(Date.UTC(year, monthNumber, 1));
    const account = getCurrentGoogleAccount(req.userId);
    let syncWarning = null;
    if (account) {
      queueTaskPullSync(req.userId);
      try {
        await syncGoogleManualTasksForMonth(req.userId, account, month, req.query.refreshTasks === '1');
      } catch (error) {
        syncWarning = `Google Tasks could not be refreshed: ${error.message}`;
        console.warn(`Google Tasks month sync failed for ${account.account_key} (${month}):`, error.message);
      }
      const last = account.last_calendar_sync ? new Date(account.last_calendar_sync).getTime() : 0;
      if (Date.now() - last > CALENDAR_SYNC_INTERVAL_MS && !calendarSyncLocks.has(account.account_key)) {
        setImmediate(() => syncCalendarForAccount(account.account_key).catch((error) => {
          console.warn(`Calendar refresh failed for ${account.account_key}:`, error.message);
        }));
      }
    }
    const events = [];
    if (account) {
      const googleRows = db.prepare(`SELECT event_id,summary,start_at,end_at,all_day,location,html_link,description
        FROM google_events WHERE account_key=? AND start_at < ? AND COALESCE(end_at,start_at) >= ?`)
        .all(account.account_key, end.toISOString().slice(0, 10) + 'T23:59:59.999Z', start.toISOString().slice(0, 10));
      for (const row of googleRows) events.push({ id: `g_${row.event_id}`, title: row.summary, start: row.start_at, end: row.end_at,
        allDay: Boolean(row.all_day), kind: 'google', location: row.location, description: row.description, url: row.html_link });
      const externalTasks = db.prepare(`SELECT tasklist_id,tasklist_title,task_id,title,notes,due_at,status,completed_at
        FROM google_external_tasks WHERE account_key=? AND due_at>=? AND due_at<?`)
        .all(account.account_key, start.toISOString(), end.toISOString());
      for (const task of externalTasks) events.push({
        id: `gt_${task.tasklist_id}_${task.task_id}`,
        title: task.title,
        start: task.due_at,
        allDay: true,
        kind: 'google-task',
        status: task.status,
        completedAt: task.completed_at,
        taskListTitle: task.tasklist_title,
        description: task.notes || '',
        url: 'https://calendar.google.com/calendar/u/0/r/tasks'
      });
    }
    const routines = listRoutines(req.userId);
    for (const r of routines) {
      if (r.type === 'interval' && r.next_due_at && !r.taskSuppressed && !(r.linked_to_routine_id && r.last_completed_at && new Date(r.last_completed_at) >= new Date(r.next_due_at))) {
        const due = new Date(r.next_due_at);
        if (due >= start && due < end) events.push({ id: `due_${r.id}`, title: `${r.title} · due`, start: r.next_due_at, allDay: true, kind: 'due', routineId: r.id, color: r.color, linked: Boolean(r.linked_to_routine_id), available: due.getTime() <= Date.now() });
      }
      if (r.type === 'frequency' && r.checkinAvailable && !r.maximumReached && !r.taskSuppressed) {
        const opportunity = new Date(r.nextOpportunityAt || r.periodStart);
        if (opportunity >= start && opportunity < end) events.push({ id: `freq_${r.id}`, title: `${r.title} · task`, start: opportunity.toISOString(), allDay: true, kind: 'frequency', routineId: r.id, color: r.color, available: r.checkinAvailable });
      }
    }
    const completionRows = db.prepare(`SELECT c.id,c.completed_at,c.note,r.title,r.color,r.id AS routine_id
      FROM completions c JOIN routines r ON r.id=c.routine_id
      WHERE c.user_id=? AND c.completed_at>=? AND c.completed_at<? ORDER BY c.completed_at`)
      .all(req.userId, start.toISOString(), end.toISOString());
    for (const row of completionRows) events.push({ id: `done_${row.id}`, title: `${row.title} · completed`, start: row.completed_at, allDay: false, kind: 'completion', routineId: row.routine_id, completionId: row.id, color: row.color, note: row.note });
    res.json({ month, events, googleLastSync: account?.last_calendar_sync || null, googleTasksLastSync: account?.last_external_task_sync || null, syncWarning });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/google/status', (req, res) => res.json({ google: googleStatus(req.userId) }));
app.post('/api/google/sync-calendar', async (req, res) => {
  try {
    const account = getCurrentGoogleAccount(req.userId);
    if (!account) return res.status(400).json({ error: 'Connect Google first.' });
    const result = await syncCalendarForAccount(account.account_key);
    res.json({ ok: true, result, google: googleStatus(req.userId) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/google/unlink', (req, res) => {
  const freshUserId = createAnonymousUser();
  req.session.userId = freshUserId;
  delete req.session.googleAccountKey;
  res.json({ ok: true, message: 'Google has been disconnected from this browser session.' });
});
app.post('/api/drive/sync', async (req, res) => {
  try {
    const result = await syncDriveBackup(req.userId, { forceDatabaseBackup: true });
    res.json({ ok: true, result, google: googleStatus(req.userId) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/drive/restore', async (req, res) => {
  try {
    const result = await restoreDriveBackup(req.userId);
    res.json({ ok: true, result });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: APP_VERSION, time: nowIso() }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, req, res, next) => {
  console.error('Request error:', error.stack || error.message || error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server console for details.' });
});

const server = app.listen(PORT, () => {
  console.log(`Routine Tracker ${APP_VERSION} listening at ${BASE_URL}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

// Unlock and publish Google Tasks from the server even when the dashboard is closed.
// This keeps progressive frequency tasks and repeat-after dates in sync automatically.
async function runBackgroundTaskSync() {
  const users = db.prepare('SELECT id FROM users WHERE google_account_key IS NOT NULL').all();
  for (const user of users) {
    if (!driveRestoreReadyUsers.has(user.id)) continue;
    try { await syncRoutineTasks(user.id); }
    catch (error) { console.warn(`Google Tasks background sync failed for ${user.id}:`, error.message); }
  }
}
async function restoreDriveStateBeforeInitialTaskSync() {
  const users = db.prepare('SELECT id FROM users WHERE google_account_key IS NOT NULL').all();
  for (const user of users) {
    try {
      if (DRIVE_RESTORE_ON_STARTUP) {
        const restored = await restoreDriveBackup(user.id, { allowMissing: true });
        console.log(`Initial Drive restore complete for ${user.id}: ${restored.routineCount || 0} routines, ${restored.googleTaskMappingCount || 0} Google Task mappings.`);
      } else {
        // Recovery mode: use this installation's existing mappings as the
        // source of truth for one controlled migration backup.
        driveRestoreReadyUsers.add(user.id);
        console.warn(`Startup Drive restore disabled for ${user.id}; using its local SQLite data as the recovery source.`);
      }
    } catch (error) {
      // Keep publishing and backup uploads paused for this account until a
      // manual Drive restore succeeds; never overwrite an unreadable backup.
      console.error(`Initial Drive restore failed for ${user.id}; Google Task publishing is paused:`, error.message);
    }
  }
  await runBackgroundTaskSync();
}
restoreDriveStateBeforeInitialTaskSync().catch((error) => console.warn('Initial Drive restore/task sync failed:', error.message));
const taskSyncTimer = setInterval(() => {
  runBackgroundTaskSync().catch((error) => console.warn('Google Tasks background sync failed:', error.message));
}, Math.max(30000, TASK_SYNC_INTERVAL_MS));
if (taskSyncTimer.unref) taskSyncTimer.unref();

// Keep Google Calendar copies fresh. Refresh tokens are loaded only on the server.
const calendarTimer = setInterval(() => {
  const accounts = db.prepare('SELECT account_key FROM google_accounts').all();
  for (const account of accounts) {
    syncCalendarForAccount(account.account_key).catch((error) => {
      console.warn(`Calendar background sync failed for ${account.account_key}:`, error.message);
    });
  }
}, Math.max(60000, CALENDAR_SYNC_INTERVAL_MS));
if (calendarTimer.unref) calendarTimer.unref();

// Remove expired browser sessions periodically. The browser cookie is long-lived,
// while server-side sessions are persistent and renewed on visits.
const cleanupTimer = setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); }
  catch (error) { console.warn('Session cleanup failed:', error.message); }
}, 60 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

function shutdown() {
  console.log('Shutting down Routine Tracker...');
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);