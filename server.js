'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
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
const DRIVE_AUTO_SYNC_DELAY_MS = Number(process.env.DRIVE_AUTO_SYNC_DELAY_MS || 6000);
const CALENDAR_SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS || 300000);
const TASK_SYNC_INTERVAL_MS = Number(process.env.TASK_SYNC_INTERVAL_MS || 60000);
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365;
const APP_VERSION = '1.4.0';

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
    status TEXT NOT NULL DEFAULT 'needsAction', updated_at TEXT NOT NULL,
    PRIMARY KEY(account_key, routine_id, slot_key)
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
  for (const child of children) {
    const nextDue = source && !source.archived && source.next_due_at
      ? addOffsetDays(source.next_due_at, child.linked_offset_days || 0).toISOString()
      : null;
    db.prepare('UPDATE routines SET next_due_at=?,updated_at=? WHERE id=? AND user_id=?')
      .run(nextDue, nowIso(), child.id, userId);
  }
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
const taskSyncLocks = new Set();
async function syncRoutineTasks(userId, routines = listRoutines(userId)) {
  if (taskSyncLocks.has(userId)) return { skipped: true, reason: 'sync already running' };
  taskSyncLocks.add(userId);
  try {
  const account = getCurrentGoogleAccount(userId);
  if (!account) return { skipped: true };
  const tasks = tasksApi(account.account_key);
  for (const routine of routines) {
    let dueDate = null;
    let slotKey = '';
    if (routine.type === 'interval' && routine.next_due_at) {
      // A linked task is only eligible again after its parent moves to a new due date.
      if (routine.linked_to_routine_id && routine.last_completed_at &&
          new Date(routine.last_completed_at).getTime() >= new Date(routine.next_due_at).getTime()) continue;
      dueDate = isoDateOnly(routine.next_due_at);
      slotKey = `${routine.linked_to_routine_id ? 'linked' : 'interval'}:${routine.next_due_at}`;
    } else if (routine.type === 'frequency' && routine.checkinAvailable) {
      // Create frequency tasks only when the next progressive check-in is actually unlocked.
      dueDate = isoDateOnly(nowIso());
      slotKey = `frequency:${routine.periodStart}:${routine.completedCount}`;
    }
    if (!dueDate) continue;

    let existing = db.prepare('SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND slot_key=?')
      .get(account.account_key, routine.id, slotKey);
    if (!existing) {
      existing = db.prepare("SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status='needsAction' ORDER BY updated_at DESC LIMIT 1")
        .get(account.account_key, routine.id);
    }
    const requestBody = { title: routine.title, notes: routine.notes || 'Routine Tracker checklist item', due: `${dueDate}T00:00:00.000Z` };
    if (existing) {
      if (existing.status === 'completed') {
        await tasks.tasks.patch({ tasklist: '@default', task: existing.task_id, requestBody: { ...requestBody, status: 'needsAction' } });
        db.prepare("UPDATE google_tasks SET slot_key=?,due_date=?,status='needsAction',updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?")
          .run(slotKey, dueDate, nowIso(), account.account_key, routine.id, existing.slot_key);
      } else if (existing.slot_key !== slotKey || existing.due_date !== dueDate) {
        await tasks.tasks.patch({ tasklist: '@default', task: existing.task_id, requestBody });
        db.prepare('UPDATE google_tasks SET slot_key=?,due_date=?,updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?')
          .run(slotKey, dueDate, nowIso(), account.account_key, routine.id, existing.slot_key);
      }
      continue;
    }
    const created = await tasks.tasks.insert({ tasklist: '@default', requestBody });
    db.prepare('INSERT INTO google_tasks(account_key,routine_id,slot_key,task_id,due_date,status,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(account.account_key, routine.id, slotKey, created.data.id, dueDate, 'needsAction', nowIso());
  }
  return { synced: true };
  } finally {
    taskSyncLocks.delete(userId);
  }
}
async function completeCurrentGoogleTask(userId, routine) {
  const account = getCurrentGoogleAccount(userId);
  if (!account) return;
  const row = db.prepare("SELECT * FROM google_tasks WHERE account_key=? AND routine_id=? AND status='needsAction' ORDER BY updated_at DESC LIMIT 1").get(account.account_key, routine.id);
  if (!row) return;
  await tasksApi(account.account_key).tasks.patch({ tasklist: '@default', task: row.task_id, requestBody: { status: 'completed', completed: nowIso() } });
  db.prepare('UPDATE google_tasks SET status=?,updated_at=? WHERE account_key=? AND routine_id=? AND slot_key=?').run('completed', nowIso(), account.account_key, routine.id, row.slot_key);
}

function publicRoutine(routine, now = new Date()) {
  const item = { ...routine, archived: Boolean(routine.archived), progressive: routine.progressive !== 0 };
  if (routine.type === 'frequency') {
    const window = getCurrentPeriod(routine, now);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM completions
      WHERE routine_id = ? AND completed_at >= ? AND completed_at < ?`)
      .get(routine.id, window.start.toISOString(), window.end.toISOString()).n;
    const duration = Math.max(1, window.end.getTime() - window.start.getTime());
    const hasStarted = now.getTime() >= window.start.getTime();
    const elapsedFraction = Math.max(0, Math.min(1, (now.getTime() - window.start.getTime()) / duration));
    const unlockedCount = !hasStarted ? 0 : routine.progressive === 0
      ? routine.max_count
      : Math.min(routine.max_count, Math.max(1, Math.floor(elapsedFraction * routine.max_count + 1e-9) + 1));
    const nextUnlock = !hasStarted
      ? window.start
      : routine.progressive === 0
        ? window.start
        : new Date(window.start.getTime() + duration * Math.min(routine.max_count - 1, count) / routine.max_count);
    const checkinAvailable = hasStarted && count < unlockedCount && count < routine.max_count;
    const nextOpportunityAt = checkinAvailable ? now.toISOString() : nextUnlock.toISOString();
    item.periodStart = window.start.toISOString();
    item.periodEnd = window.end.toISOString();
    item.completedCount = count;
    item.minimumReached = count >= routine.min_count;
    item.maximumReached = count >= routine.max_count;
    item.remainingMinimum = Math.max(0, routine.min_count - count);
    item.progress = Math.min(100, Math.round((count / Math.max(1, routine.max_count)) * 100));
    item.unlockedCount = unlockedCount;
    item.checkinAvailable = checkinAvailable;
    item.nextOpportunityAt = nextOpportunityAt;
    item.cadenceLabel = `${routine.min_count}${routine.max_count > routine.min_count ? `–${routine.max_count}` : ''} times every ${routine.period_value} ${unitLabel(routine.period_unit)}`;
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
  return item;
}
function listRoutines(userId, includeArchived = false) {
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
  const dueCount = routines.filter((r) => r.type === 'interval' ? r.isDue : r.checkinAvailable).length;
  const targetsMet = routines.filter((r) => r.type === 'frequency' && r.minimumReached).length;
  return { routineCount: routines.length, completedThisMonth, dueCount, targetsMet };
}
function queueDriveSync(userId) {
  if (!DRIVE_AUTO_SYNC) return;
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

async function syncDriveBackup(userId) {
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) throw new Error('Connect Google before syncing to Drive.');
  const accountKey = user.google_account_key;
  const drive = driveApi(accountKey);
  const routines = db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY created_at').all(userId);
  const completions = db.prepare(`SELECT c.* FROM completions c WHERE c.user_id = ? ORDER BY c.completed_at`).all(userId);
  const backup = {
    product: 'Routine Tracker',
    formatVersion: 1,
    exportedAt: nowIso(),
    routines,
    completions
  };
  let account = db.prepare('SELECT drive_file_id FROM google_accounts WHERE account_key = ?').get(accountKey);
  let fileId = account && account.drive_file_id;
  if (!fileId) {
    const found = await drive.files.list({
      q: "name = 'Routine Tracker Backup.json' and trashed = false",
      spaces: 'drive',
      pageSize: 10,
      fields: 'files(id,name,modifiedTime)'
    });
    fileId = (found.data.files || [])[0]?.id || null;
  }
  const body = Readable.from([Buffer.from(JSON.stringify(backup, null, 2), 'utf8')]);
  if (fileId) {
    await drive.files.update({
      fileId,
      media: { mimeType: 'application/json', body },
      fields: 'id,name,modifiedTime'
    });
  } else {
    const created = await drive.files.create({
      requestBody: { name: 'Routine Tracker Backup.json', mimeType: 'application/json' },
      media: { mimeType: 'application/json', body },
      fields: 'id,name,modifiedTime'
    });
    fileId = created.data.id;
  }
  db.prepare(`UPDATE google_accounts SET drive_file_id = ?, last_drive_sync = ?, last_error = NULL, updated_at = ? WHERE account_key = ?`)
    .run(fileId, nowIso(), nowIso(), accountKey);
  return { fileId, exportedAt: backup.exportedAt, routineCount: routines.length, completionCount: completions.length };
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
async function restoreDriveBackup(userId) {
  const user = db.prepare('SELECT google_account_key FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_account_key) throw new Error('Connect Google before restoring from Drive.');
  const accountKey = user.google_account_key;
  const drive = driveApi(accountKey);
  const account = db.prepare('SELECT drive_file_id FROM google_accounts WHERE account_key = ?').get(accountKey);
  let fileId = account && account.drive_file_id;
  if (!fileId) {
    const found = await drive.files.list({
      q: "name = 'Routine Tracker Backup.json' and trashed = false",
      spaces: 'drive', pageSize: 10, fields: 'files(id,name,modifiedTime)'
    });
    fileId = (found.data.files || [])[0]?.id || null;
  }
  if (!fileId) throw new Error('No Routine Tracker Backup.json file was found in this Google Drive.');
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  const backup = safeJsonParse(await readStream(response.data));
  if (!backup || backup.product !== 'Routine Tracker' || backup.formatVersion !== 1 || !Array.isArray(backup.routines) || !Array.isArray(backup.completions)) {
    throw new Error('The Drive file is not a supported Routine Tracker backup.');
  }
  let routineCount = 0;
  let completionCount = 0;
  const importTransaction = db.transaction(() => {
    const routineIdMap = new Map();
    for (const r of backup.routines) {
      if (!r || !r.id || !r.title || !['frequency', 'interval'].includes(r.type)) continue;
      const sourceId = String(r.id);
      const existing = db.prepare('SELECT user_id FROM routines WHERE id = ?').get(sourceId);
      // Routine IDs are global in this SQLite schema. When restoring the same
      // backup into a different Google profile, clone conflicting IDs instead
      // of moving the original profile's routine into the new profile.
      const targetId = existing && existing.user_id !== userId ? makeId('routine') : sourceId;
      routineIdMap.set(sourceId, targetId);
      const values = {
        id: targetId, user_id: userId, title: String(r.title).slice(0, 120), notes: String(r.notes || ''),
        color: r.color || 'lavender', type: r.type, min_count: r.min_count ?? null, max_count: r.max_count ?? null,
        period_value: r.period_value ?? null, period_unit: r.period_unit ?? null,
        interval_value: r.interval_value ?? null, interval_unit: r.interval_unit ?? null,
        start_at: r.start_at ?? null, last_completed_at: r.last_completed_at ?? null,
        next_due_at: r.next_due_at ?? null, progressive: r.progressive ?? 1, linked_to_routine_id: r.linked_to_routine_id ?? null, linked_offset_days: r.linked_offset_days ?? -1, archived: r.archived ? 1 : 0,
        created_at: r.created_at || nowIso(), updated_at: r.updated_at || nowIso()
      };
      if (existing && targetId === sourceId) {
        db.prepare(`UPDATE routines SET title=@title,notes=@notes,color=@color,type=@type,min_count=@min_count,
          max_count=@max_count,period_value=@period_value,period_unit=@period_unit,interval_value=@interval_value,
          interval_unit=@interval_unit,start_at=@start_at,last_completed_at=@last_completed_at,next_due_at=@next_due_at,progressive=@progressive,linked_to_routine_id=@linked_to_routine_id,linked_offset_days=@linked_offset_days,
          archived=@archived,updated_at=@updated_at WHERE id=@id AND user_id=@user_id AND updated_at < @updated_at`)
          .run(values);
      } else {
        db.prepare(`INSERT OR IGNORE INTO routines(
          id,user_id,title,notes,color,type,min_count,max_count,period_value,period_unit,
          interval_value,interval_unit,start_at,last_completed_at,next_due_at,progressive,linked_to_routine_id,linked_offset_days,archived,created_at,updated_at
        ) VALUES(
          @id,@user_id,@title,@notes,@color,@type,@min_count,@max_count,@period_value,@period_unit,
          @interval_value,@interval_unit,@start_at,@last_completed_at,@next_due_at,@progressive,@linked_to_routine_id,@linked_offset_days,@archived,@created_at,@updated_at
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
  });
  importTransaction();
  db.prepare('UPDATE google_accounts SET drive_file_id = ?, last_drive_sync = ?, last_error = NULL, updated_at = ? WHERE account_key = ?')
    .run(fileId, nowIso(), nowIso(), accountKey);
  queueDriveSync(userId);
  return { routineCount, completionCount, backupExportedAt: backup.exportedAt || null };
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
        db.prepare(`INSERT INTO google_events(account_key,event_id,summary,start_at,end_at,all_day,status,location,html_link,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_key,event_id) DO UPDATE SET
            summary=excluded.summary,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,
            status=excluded.status,location=excluded.location,html_link=excluded.html_link,updated_at=excluded.updated_at`)
          .run(accountKey, event.id, event.summary || '(No title)', start, end || null,
            event.start.date ? 1 : 0, event.status || 'confirmed', event.location || null,
            event.htmlLink || null, event.updated || null);
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

function parseRoutineBody(body, existing = null) {
  const type = body.type || (existing && existing.type);
  if (!['frequency', 'interval'].includes(type)) throw new Error('Choose a valid routine type.');
  const title = String(body.title ?? existing?.title ?? '').trim().slice(0, 120);
  if (!title) throw new Error('Give your routine a name.');
  const colorOptions = ['lavender', 'mint', 'peach', 'blue', 'rose', 'gold'];
  const color = colorOptions.includes(body.color || existing?.color) ? (body.color || existing.color) : 'lavender';
  const common = { title, notes: String(body.notes ?? existing?.notes ?? '').trim().slice(0, 1200), color, type };
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
    const progressive = body.progressive !== undefined ? (body.progressive ? 1 : 0) : (existing?.progressive ?? 1);
    return { ...common, min_count: minCount, max_count: maxCount, period_value: periodValue, period_unit: periodUnit,
      interval_value: null, interval_unit: null, start_at: startAt, progressive,
      linked_to_routine_id: null, linked_offset_days: -1,
      last_completed_at: null, next_due_at: null };
  }
  const intervalValue = Number(body.intervalValue ?? existing?.interval_value ?? 2);
  const intervalUnit = body.intervalUnit || existing?.interval_unit || 'weeks';
  if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 3650) throw new Error('Repeat interval must be from 1 to 3650.');
  if (!['days', 'weeks', 'months', 'years'].includes(intervalUnit)) throw new Error('Choose a valid repeat interval.');
  const suppliedLast = Object.prototype.hasOwnProperty.call(body, 'lastCompletedAt');
  const lastRaw = suppliedLast ? body.lastCompletedAt : existing?.last_completed_at;
  const lastCompletedAt = lastRaw ? toIso(lastRaw, null) : null;
  const linkedId = Object.prototype.hasOwnProperty.call(body, 'linkedToRoutineId')
    ? (body.linkedToRoutineId ? String(body.linkedToRoutineId) : null)
    : (existing?.linked_to_routine_id || null);
  const linkedOffsetDays = Number(body.linkedOffsetDays ?? existing?.linked_offset_days ?? -1);
  if (!Number.isInteger(linkedOffsetDays) || Math.abs(linkedOffsetDays) > 3650) throw new Error('Linked offset must be a whole number between -3650 and 3650 days.');
  let nextDueAt;
  if (linkedId) {
    if (linkedId === existing?.id) throw new Error('A routine cannot be linked to itself.');
    if (existing && db.prepare('SELECT 1 FROM routines WHERE user_id=? AND linked_to_routine_id=? AND archived=0 LIMIT 1').get(body.userId, existing.id)) {
      throw new Error('This routine already has linked routines and cannot itself be linked.');
    }
    const parent = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=? AND archived=0').get(linkedId, body.userId || existing?.user_id);
    if (!parent || parent.type !== 'interval' || parent.linked_to_routine_id) throw new Error('Choose an active, unlinked repeat-after routine to link to.');
    nextDueAt = parent.next_due_at ? addOffsetDays(parent.next_due_at, linkedOffsetDays).toISOString() : null;
  } else if (lastCompletedAt) {
    nextDueAt = addInterval(lastCompletedAt, intervalValue, intervalUnit).toISOString();
  } else {
    nextDueAt = toIso(body.nextDueAt ?? existing?.next_due_at, nowIso());
  }
  return { ...common, min_count: null, max_count: null, period_value: null, period_unit: null,
    interval_value: intervalValue, interval_unit: intervalUnit, start_at: null, progressive: 1,
    linked_to_routine_id: linkedId, linked_offset_days: linkedOffsetDays,
    last_completed_at: linkedId ? (existing?.last_completed_at || null) : lastCompletedAt, next_due_at: nextDueAt };
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
    else if (req.query.reauthorize === '1') options.prompt = 'consent';
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
    req.session.save(async (saveError) => {
      if (saveError) return next(saveError);
      syncCalendarForAccount(accountKey).catch((error) => console.warn('Initial Calendar sync failed:', error.message));
      queueDriveSync(canonicalUserId);
      res.redirect('/?connected=1');
    });
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message);
    res.redirect(`/?google_error=${encodeURIComponent(error.message.slice(0, 180))}`);
  }
});

app.get('/api/bootstrap', async (req, res) => {
  const routines = listRoutines(req.userId);
  try { await syncRoutineTasks(req.userId, routines); } catch (error) { console.warn('Google Tasks sync failed:', error.message); }
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
      id,user_id,title,notes,color,type,min_count,max_count,period_value,period_unit,
      interval_value,interval_unit,start_at,last_completed_at,next_due_at,progressive,linked_to_routine_id,linked_offset_days,created_at,updated_at
    ) VALUES(
      @id,@user_id,@title,@notes,@color,@type,@min_count,@max_count,@period_value,@period_unit,
      @interval_value,@interval_unit,@start_at,@last_completed_at,@next_due_at,@progressive,@linked_to_routine_id,@linked_offset_days,@created_at,@updated_at
    )`).run({ id, user_id: req.userId, ...data, created_at: stamp, updated_at: stamp });
    if (!data.linked_to_routine_id) updateLinkedRoutineSchedules(req.userId, id);
    queueDriveSync(req.userId);
    res.status(201).json({ routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id = ?').get(id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/routines/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Routine not found.' });
    const data = parseRoutineBody({ ...req.body, type: existing.type, userId: req.userId }, existing);
    db.prepare(`UPDATE routines SET title=@title,notes=@notes,color=@color,min_count=@min_count,max_count=@max_count,
      period_value=@period_value,period_unit=@period_unit,interval_value=@interval_value,interval_unit=@interval_unit,
      start_at=@start_at,last_completed_at=@last_completed_at,next_due_at=@next_due_at,progressive=@progressive,linked_to_routine_id=@linked_to_routine_id,linked_offset_days=@linked_offset_days,updated_at=@updated_at
      WHERE id=@id AND user_id=@user_id`).run({ ...data, updated_at: nowIso(), id: existing.id, user_id: req.userId });
    if (!data.linked_to_routine_id) updateLinkedRoutineSchedules(req.userId, existing.id);
    queueDriveSync(req.userId);
    res.json({ routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id = ?').get(existing.id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/routines/:id', (req, res) => {
  const result = db.prepare('UPDATE routines SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(nowIso(), req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Routine not found.' });
  updateLinkedRoutineSchedules(req.userId, req.params.id);
  queueDriveSync(req.userId);
  res.json({ ok: true });
});
app.post('/api/routines/:id/complete', async (req, res) => {
  try {
    const routine = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ? AND archived = 0').get(req.params.id, req.userId);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const publicBefore = publicRoutine(routine);
    if (routine.type === 'frequency' && !publicBefore.checkinAvailable) return res.status(409).json({ error: 'Your next Progressive check-in is not unlocked yet.' });
    if (routine.type === 'interval' && !publicBefore.isDue) return res.status(409).json({ error: 'This routine is not due yet.' });
    try { await completeCurrentGoogleTask(req.userId, publicRoutine(routine)); } catch (error) { console.warn('Could not complete Google Task:', error.message); }
    const completedAt = toIso(req.body.completedAt, nowIso());
    const completionId = makeId('done');
    db.prepare('INSERT INTO completions(id,routine_id,user_id,completed_at,note) VALUES(?,?,?,?,?)')
      .run(completionId, routine.id, req.userId, completedAt, String(req.body.note || '').slice(0, 500));
    if (routine.type === 'interval' && !routine.linked_to_routine_id) {
      const nextDueAt = addInterval(completedAt, routine.interval_value, routine.interval_unit).toISOString();
      db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?')
        .run(completedAt, nextDueAt, nowIso(), routine.id);
      updateLinkedRoutineSchedules(req.userId, routine.id);
    } else if (routine.type === 'interval' && routine.linked_to_routine_id) {
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(completedAt, nowIso(), routine.id);
    } else {
      db.prepare('UPDATE routines SET updated_at=? WHERE id=?').run(nowIso(), routine.id);
    }
    queueDriveSync(req.userId);
    const updated = db.prepare('SELECT * FROM routines WHERE id = ?').get(routine.id);
    try { await syncRoutineTasks(req.userId, [publicRoutine(updated)]); } catch (error) { console.warn('Could not create next Google Task:', error.message); }
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
  db.prepare('DELETE FROM completions WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(row.routine_id, req.userId);
  if (routine && routine.type === 'interval' && !routine.linked_to_routine_id) {
    const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
    const nextDue = latest ? addInterval(latest.completed_at, routine.interval_value, routine.interval_unit).toISOString() : nowIso();
    db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nextDue, nowIso(), routine.id);
    updateLinkedRoutineSchedules(req.userId, routine.id);
  } else if (routine && routine.type === 'interval' && routine.linked_to_routine_id) {
    const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
    db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nowIso(), routine.id);
  }
  queueDriveSync(req.userId);
  try { await syncRoutineTasks(req.userId); } catch (error) { console.warn('Google Task history-delete sync failed:', error.message); }
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
    try { await syncRoutineTasks(req.userId); } catch (error) { console.warn('Google Task reschedule sync failed:', error.message); }
    res.json({ ok: true, routine: publicRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(routine.id)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/completions/:id', async (req, res) => {
  try {
    const completion = db.prepare('SELECT * FROM completions WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (!completion) return res.status(404).json({ error: 'Completion not found.' });
    const completedAt = toIso(req.body.completedAt, null);
    if (!completedAt) return res.status(400).json({ error: 'Choose a valid completion date.' });
    db.prepare('UPDATE completions SET completed_at=? WHERE id=? AND user_id=?').run(completedAt, completion.id, req.userId);
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').get(completion.routine_id, req.userId);
    if (routine && routine.type === 'interval' && !routine.linked_to_routine_id) {
      const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
      const nextDue = latest ? addInterval(latest.completed_at, routine.interval_value, routine.interval_unit).toISOString() : nowIso();
      db.prepare('UPDATE routines SET last_completed_at=?,next_due_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nextDue, nowIso(), routine.id);
      updateLinkedRoutineSchedules(req.userId, routine.id);
    } else if (routine && routine.type === 'interval' && routine.linked_to_routine_id) {
      const latest = db.prepare('SELECT completed_at FROM completions WHERE routine_id=? ORDER BY completed_at DESC LIMIT 1').get(routine.id);
      db.prepare('UPDATE routines SET last_completed_at=?,updated_at=? WHERE id=?').run(latest?.completed_at || null, nowIso(), routine.id);
    }
    queueDriveSync(req.userId);
    try { await syncRoutineTasks(req.userId); } catch (error) { console.warn('Google Task completion-date sync failed:', error.message); }
    res.json({ ok: true });
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
      const last = account.last_calendar_sync ? new Date(account.last_calendar_sync).getTime() : 0;
      if (Date.now() - last > CALENDAR_SYNC_INTERVAL_MS) {
        try { await syncCalendarForAccount(account.account_key); }
        catch (error) { syncWarning = error.message; }
      }
    }
    const events = [];
    if (account) {
      const googleRows = db.prepare(`SELECT event_id,summary,start_at,end_at,all_day,location,html_link
        FROM google_events WHERE account_key=? AND start_at < ? AND COALESCE(end_at,start_at) >= ?`)
        .all(account.account_key, end.toISOString().slice(0, 10) + 'T23:59:59.999Z', start.toISOString().slice(0, 10));
      for (const row of googleRows) events.push({ id: `g_${row.event_id}`, title: row.summary, start: row.start_at, end: row.end_at,
        allDay: Boolean(row.all_day), kind: 'google', location: row.location, url: row.html_link });
    }
    const routines = listRoutines(req.userId);
    for (const r of routines) {
      if (r.type === 'interval' && r.next_due_at && !(r.linked_to_routine_id && r.last_completed_at && new Date(r.last_completed_at) >= new Date(r.next_due_at))) {
        const due = new Date(r.next_due_at);
        if (due >= start && due < end) events.push({ id: `due_${r.id}`, title: `${r.title} · due`, start: r.next_due_at, allDay: true, kind: 'due', routineId: r.id, color: r.color, linked: Boolean(r.linked_to_routine_id), available: due.getTime() <= Date.now() });
      }
      if (r.type === 'frequency' && !r.maximumReached) {
        const opportunity = new Date(r.nextOpportunityAt || r.periodStart);
        if (opportunity >= start && opportunity < end) events.push({ id: `freq_${r.id}`, title: `${r.title} · check-in`, start: opportunity.toISOString(), allDay: true, kind: 'frequency', routineId: r.id, color: r.color, available: r.checkinAvailable });
      }
    }
    const completionRows = db.prepare(`SELECT c.id,c.completed_at,r.title,r.color,r.id AS routine_id
      FROM completions c JOIN routines r ON r.id=c.routine_id
      WHERE c.user_id=? AND c.completed_at>=? AND c.completed_at<? ORDER BY c.completed_at`)
      .all(req.userId, start.toISOString(), end.toISOString());
    for (const row of completionRows) events.push({ id: `done_${row.id}`, title: `${row.title} · completed`, start: row.completed_at, allDay: false, kind: 'completion', routineId: row.routine_id, completionId: row.id, color: row.color });
    res.json({ month, events, googleLastSync: account?.last_calendar_sync || null, syncWarning });
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
    const result = await syncDriveBackup(req.userId);
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
// This keeps progressive frequency check-ins and repeat-after dates in sync automatically.
async function runBackgroundTaskSync() {
  const users = db.prepare('SELECT id FROM users WHERE google_account_key IS NOT NULL').all();
  for (const user of users) {
    try { await syncRoutineTasks(user.id); }
    catch (error) { console.warn(`Google Tasks background sync failed for ${user.id}:`, error.message); }
  }
}
runBackgroundTaskSync().catch((error) => console.warn('Initial Google Tasks sync failed:', error.message));
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
