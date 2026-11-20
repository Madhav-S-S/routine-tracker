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
  selectedIconName: 'sparkles',
  selectedIconColor: '#a895f0',
  selectedIconBackground: null,
  iconManuallySelected: false,
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calendarEvents: [],
  calendarWarning: null,
  selectedCalendarDate: null,
  selectedCalendarEvent: null
};

// Coalesce redundant refreshes so a page switch, a save and a visibility event
// cannot launch overlapping copies of the same GET requests.
let bootstrapLoadPromise = null;
let historyLoadPromise = null;
const calendarLoadPromises = new Map();
let calendarManualTaskRefreshTimer = null;
let foregroundRefreshRunning = false;
let lastForegroundRefreshAt = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const COLOR_HEX = { lavender: '#a895f0', mint: '#72c6a0', peach: '#e9a77f', blue: '#84a8df', rose: '#d98eaa', gold: '#d8b85d' };
const COLOR_STORAGE_KEY = 'routine-tracker.saved-colors.v1';
const ICON_BACKGROUND_STORAGE_KEY = 'routine-tracker.icon-backgrounds.v1';
const ICON_LIBRARY = [
  ['sparkles','Sparkles','default shine star motivation',`<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z"/>`],
  ['leaf','Leaf','aloe vera rosemary plant herb skin hair nature',`<path d="M20.5 3.5C12 3.5 5 6.2 5 13a7 7 0 0 0 7 7c6.8 0 8.5-8 8.5-16.5Z"/><path d="M3.5 21c3-5 7-8 13-12"/>`],
  ['sprout','Sprout','plant grow seed gardening',`<path d="M12 21v-9"/><path d="M12 12C5 12 4 7 4 4c5 0 8 2 8 8Z"/><path d="M12 15c0-6 4-9 8-9 0 5-2 9-8 9Z"/>`],
  ['droplet','Droplet','water hydration drink skincare',`<path d="M12 22a7 7 0 0 0 7-7c0-4-7-13-7-13S5 11 5 15a7 7 0 0 0 7 7Z"/><path d="M9 16a3 3 0 0 0 3 3"/>`],
  ['flower','Flower','flower garden blossom',`<circle cx="12" cy="12" r="2.5"/><path d="M12 3c3 0 3 4 0 6-3-2-3-6 0-6ZM21 12c0 3-4 3-6 0 2-3 6-3 6 0ZM12 21c-3 0-3-4 0-6 3 2 3 6 0 6ZM3 12c0-3 4-3 6 0-2 3-6 3-6 0Z"/>`],
  ['sun','Sun','sunshine outdoor morning',`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>`],
  ['moon','Moon','sleep night rest',`<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>`],
  ['bed','Bed','bedsheet sleep bedroom',`<path d="M3 18v-6h18v6M3 12V7h6v5M9 10h7a5 5 0 0 1 5 5"/><path d="M5 18v2m14-2v2"/>`],
  ['bath','Bath','bath bathing shower clean',`<path d="M3 12h18v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-4Z"/><path d="M7 12V7a3 3 0 0 1 6 0v1M5 20v1m14-1v1"/>`],
  ['book','Book','read reading study learning',`<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5v-12Z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8m-8 3h6"/>`],
  ['heart','Heart','health love care wellness',`<path d="M20.8 8.8c0 5-8.8 11-8.8 11s-8.8-6-8.8-11A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.8 2.8Z"/>`],
  ['dumbbell','Dumbbell','gym exercise workout fitness',`<path d="M6 7v10M3.5 9v6M18 7v10m2.5-8v6M6 12h12"/>`],
  ['pill','Pill','medicine medication supplement',`<path d="M4.9 19.1a6 6 0 0 1 0-8.5l5.7-5.7a6 6 0 0 1 8.5 8.5l-5.7 5.7a6 6 0 0 1-8.5 0Z"/><path d="m8 8 8 8"/>`],
  ['glass-water','Glass of water','water glass drink',`<path d="M5 3h14l-1.5 18h-11L5 3Z"/><path d="M6 13h12"/>`],
  ['apple','Apple','fruit food nutrition',`<path d="M12 8c-2-4-8-2-8 4 0 5 3 9 6 9 1 0 1.5-.7 2-.7s1 .7 2 .7c3 0 6-4 6-9 0-6-6-8-8-4Z"/><path d="M12 8c0-3 2-5 5-5"/>`],
  ['footprints','Footprints','walk walking steps',`<path d="M8 4c1.5 0 2 2 1.8 4S8.5 11 7 11 5 9 5 7s1.5-3 3-3ZM16 13c1.5 0 2 2 1.8 4s-1.3 3-2.8 3-2-2-2-4 1.5-3 3-3Z"/><path d="M5 14c-1 1-1 3 0 4m12-9c1 1 1 2 1 3"/>`],
  ['house','Home','home house chores',`<path d="m3 10 9-7 9 7v10H3V10Z"/><path d="M9 20v-7h6v7"/>`],
  ['shirt','Shirt','laundry clothes dress',`<path d="m8 4 4 2 4-2 5 3-3 5-3-2v10H9V10l-3 2-3-5 5-3Z"/>`],
  ['spray-can','Spray bottle','spray cleaning skincare',`<path d="M8 8h8l1 13H7L8 8Z"/><path d="M9 8V5h6v3m-6-3h7l2-2m-1 0h3"/><path d="M18 5h3"/>`],
  ['clock','Clock','time routine punctual',`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`],
  ['hand','Hand','hands care apply skincare',`<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7l1-2a1.7 1.7 0 0 1 3 1l-2 7a5 5 0 0 1-5 4h-2a5 5 0 0 1-4-2l-4-5a1.8 1.8 0 0 1 3-2l2 2"/>`],
  ['smile','Smile','mood happiness mental health',`<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>`],
  ['wind','Wind','breathing fresh air',`<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h7a2 2 0 1 1-2 2"/>`],
  ['cloud','Cloud','weather calm',`<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9Z"/>`],
  ['flame','Flame','energy fire',`<path d="M12 22c4 0 7-3 7-7 0-3-2-6-5-9 0 3-1 4-2 5-1-3-3-5-3-5 0 4-4 6-4 10a7 7 0 0 0 7 6Z"/><path d="M10 18c0-2 2-4 3-5 2 3 2 5 0 7-2 0-3-1-3-2Z"/>`],
  ['star','Star','favorite priority',`<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>`],
  ['music','Music','music practice instrument',`<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`],
  ['laptop','Laptop','work computer screen',`<rect x="4" y="4" width="16" height="12" rx="1.5"/><path d="M2 20h20l-2-4H4l-2 4Z"/>`],
  ['wallet','Wallet','money budget finance',`<path d="M4 6h15a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h13"/><path d="M16 12h5m-4 0h.01"/>`],
  ['shopping-bag','Shopping bag','shopping errands',`<path d="M4 8h16l-1 13H5L4 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>`],
  ['broom','Broom','cleaning sweep',`<path d="m14 3 7 7M13 4l7 7M4 20l10-10M3 21l6-1 3-3-5-5-3 3-1 6Z"/>`],
  ['recycle','Recycle','recycle environment sustainability',`<path d="m7 7 3-4 3 4M10 3l-3 8h7M17 17l4-1-2 5M21 16l-8 2 4-7M5 15l-3 3 4 3M2 18l7 3 3-6"/>`],
  ['camera','Camera','photo photography',`<path d="M4 7h4l2-3h4l2 3h4v13H4V7Z"/><circle cx="12" cy="13" r="4"/>`],
  ['scissors','Scissors','cut hair grooming',`<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.2 8.2 12 12m-12-4.4 12-12"/>`],
  ['notebook','Notebook','journal notes diary',`<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M2 7h3m-3 5h3m-3 5h3m4-10h7m-7 4h7"/>`],
  ['pen','Pen','write writing notes',`<path d="m4 20 4-.8L20 7a2.8 2.8 0 0 0-4-4L4 15l-.8 4Z"/><path d="m14 5 5 5"/>`],
  ['bike','Bicycle','cycling cycling fitness',`<circle cx="6" cy="17" r="4"/><circle cx="18" cy="17" r="4"/><path d="m6 17 4-8h4l4 8m-8-8 4 8H6m5-11h3"/>`],
  ['paw','Paw','pet dog cat animal',`<ellipse cx="12" cy="16" rx="5" ry="4"/><circle cx="5" cy="9" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="20" cy="9" r="2"/>`],
  ['cooking-pot','Cooking pot','cook cooking meal food',`<path d="M4 10h16v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8ZM2 10h20M9 6h6M12 3v3"/>`],
  ['utensils','Utensils','food eating kitchen',`<path d="M7 3v7m-3-7v4a3 3 0 0 0 6 0V3m-3 8v10M17 3v18m0-18c3 2 3 7 0 9"/>`],
  ['sunrise','Sunrise','morning wake up',`<path d="M3 18h18M5 21h14M12 3v5m-7-1 3 3m11-3-3 3M4 14a8 8 0 0 1 16 0"/>`],
  ['waves','Waves','swim sea ocean',`<path d="M2 8c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 16c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>`],
  ['mountain','Mountain','hiking outdoors nature',`<path d="m2 20 7-12 4 6 3-4 6 10H2Z"/><path d="m7 12 2 2 2-1"/>`],
  ['tree','Tree','nature outdoors garden',`<path d="M12 22v-7m0-12 7 8h-4l5 5H4l5-5H5l7-8Z"/>`],
  ['soap','Soap','wash hygiene skincare',`<path d="M5 9h14l-1 12H6L5 9Z"/><path d="M8 6c0-2 2-2 2-4m4 4c0-2 2-2 2-4M9 13h6"/>`],
  ['bottle','Bottle','bottle oil serum lotion',`<path d="M9 3h6v4l2 2v12H7V9l2-2V3Z"/><path d="M9 7h6M7 12h10"/>`],
  ['meditation','Meditation','meditate yoga mindfulness',`<circle cx="12" cy="5" r="2"/><path d="M12 8v5m-6 7a6 6 0 0 1 12 0M6 13l-3 4m15-4 3 4M8 16h8"/>`],
  ['gift','Gift','reward treat',`<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M2 9h20v4H2zM12 9v12m0-12H8a2.5 2.5 0 1 1 2.5-2.5L12 9Zm0 0h4a2.5 2.5 0 1 0-2.5-2.5L12 9Z"/>`],
  ['clipboard','Clipboard','task checklist plan',`<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M8 10h8m-8 4h8m-8 4h5"/>`],
  ['shield','Shield','protection safety',`<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>`],
  ['target','Target','goal focus objective',`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`],
  ['running','Running','run jog steps',`<circle cx="15" cy="5" r="2"/><path d="m12 9-3 4 4 2 2 5m-6-7-4 1m7-5 4 2 3 1m-9 3-3 6"/>`],
  ['stethoscope','Stethoscope','doctor health medical',`<path d="M6 3v6a4 4 0 0 0 8 0V3M4 3h4m4 0h4m-2 6v4a5 5 0 0 0 10 0v-1"/><circle cx="20" cy="10" r="2"/>`],
  ['tooth','Tooth','dental dentist teeth',`<path d="M7 3C4 3 3 6 4 10l2 9c.5 2 2 2 3 0l2-5c.5-1 1.5-1 2 0l2 5c1 2 2.5 2 3 0l2-9c1-4 0-7-3-7-2 0-3 1-5 1S9 3 7 3Z"/>`],
  ['coffee','Coffee','tea coffee drink',`<path d="M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8ZM17 10h2a2 2 0 0 1 0 5h-2M7 3v2m4-2v2m4-2v2"/>`],
  ['calendar','Calendar','schedule date plan',`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M7 14h3m3 0h4m-10 4h3"/>`],
  ['check-circle','Check circle','done complete success',`<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>`],
  ['alarm-clock','Alarm clock','wake alarm time',`<circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M5 3 2 6m17-3 3 3M7 20l-2 2m12-2 2 2"/>`],
  ['washing-machine','Washing machine','laundry wash clean',`<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M7 7h.01m3 0h.01"/>`],
  ['comb','Comb','hair grooming brush',`<path d="M4 8h16M6 8v8m3-8v8m3-8v8m3-8v8m3-8v8m3-8v8"/>`],
  ['mirror','Mirror','face skincare beauty',`<rect x="5" y="2" width="14" height="16" rx="7"/><path d="M12 18v4m-4 0h8"/>`],
  ['syringe','Syringe','injection medical',`<path d="m4 20 10-10m-7 7-3-3m8-8 6 6m-3-9 6 6M12 4l8 8M3 21l3-1"/>`]
].map(([name,label,keywords,svg]) => ({ name,label,keywords,svg }));
const ICON_BY_NAME = Object.fromEntries(ICON_LIBRARY.map((item) => [item.name, item]));
const ICON_SUGGESTIONS = [
  [/aloe|rosemary|plant|herb|leaf|skin|hair|oil|serum/i, 'leaf'],
  [/bath|shower|bathe/i, 'bath'], [/bed|bedsheet|sheet|linen|sleep/i, 'bed'],
  [/water|drink|hydrate/i, 'droplet'], [/read|book|study|learn/i, 'book'],
  [/gym|workout|exercise|fitness|lift/i, 'dumbbell'], [/walk|steps/i, 'footprints'],
  [/run|jog/i, 'running'], [/medicine|tablet|pill|medication/i, 'pill'],
  [/tooth|teeth|dental|brush teeth/i, 'tooth'], [/clean|sweep|dust|tidy/i, 'broom'],
  [/wash|laundry|clothes/i, 'washing-machine'], [/cook|meal|food/i, 'cooking-pot'],
  [/meditat|yoga|mindful|breath/i, 'meditation'], [/journal|diary|write|notes/i, 'notebook'],
  [/coffee|tea/i, 'coffee'], [/pet|dog|cat/i, 'paw'], [/cycle|bike/i, 'bike'],
  [/calendar|plan|schedule/i, 'calendar'], [/photo|camera/i, 'camera']
];


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function resolveColor(value) {
  const text = String(value || 'lavender').toLowerCase();
  if (COLOR_HEX[text]) return COLOR_HEX[text];
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return COLOR_HEX.lavender;
}
function hexRgb(hex) {
  const value = resolveColor(hex).slice(1);
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
}
function rgbHex(rgb) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}
function mixHex(first, second, amount) {
  const a = hexRgb(first), b = hexRgb(second);
  return rgbHex(a.map((value, index) => value * amount + b[index] * (1 - amount)));
}
function relativeLuminance(hex) {
  const channels = hexRgb(hex).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function automaticIconBackground(iconColor) {
  const accent = resolveColor(iconColor);
  const darkSurface = '#17231b';
  const lightSurface = '#f5f7ed';
  const useDark = contrastRatio(accent, darkSurface) >= contrastRatio(accent, lightSurface);
  const surface = useDark ? darkSurface : lightSurface;
  // Tint the surface with the icon hue, but retain at least 3:1 contrast for the line icon.
  for (const amount of [0.24, 0.18, 0.12, 0.08, 0.04, 0.02, 0]) {
    const candidate = mixHex(accent, surface, amount);
    if (contrastRatio(accent, candidate) >= 3) return candidate;
  }
  return surface;
}
function readRoutineIconBackgrounds() {
  try {
    const value = JSON.parse(localStorage.getItem(ICON_BACKGROUND_STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, color]) => typeof id === 'string' && /^#[0-9a-f]{6}$/i.test(String(color))));
  } catch { return {}; }
}
function routineIconBackgroundOverride(routineId) {
  if (!routineId) return null;
  return readRoutineIconBackgrounds()[routineId] || null;
}
function persistRoutineIconBackground(routineId, color) {
  if (!routineId) return;
  const backgrounds = readRoutineIconBackgrounds();
  if (color && /^#[0-9a-f]{6}$/i.test(color)) backgrounds[routineId] = color.toLowerCase();
  else delete backgrounds[routineId];
  try { localStorage.setItem(ICON_BACKGROUND_STORAGE_KEY, JSON.stringify(backgrounds)); }
  catch { toast('Could not save the icon background in this browser.', 'error'); }
}
function selectedIconBackground() {
  return state.selectedIconBackground || automaticIconBackground(state.selectedIconColor || state.selectedColor);
}
function routineIconBackground(routine) {
  return routineIconBackgroundOverride(routine.id) || automaticIconBackground(routine.color);
}
function setSelectedIconBackground(color) {
  state.selectedIconBackground = color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
  const picker = $('#customRoutineBackground');
  if (picker) picker.value = selectedIconBackground();
  const swatch = $('#routineBackgroundSwatch');
  if (swatch) swatch.style.backgroundColor = selectedIconBackground();
  $('#resetRoutineBackground')?.classList.toggle('active', !state.selectedIconBackground);
  renderIconSelection();
}
function suggestIconName(title) {
  const text = String(title || '');
  for (const [pattern, name] of ICON_SUGGESTIONS) if (pattern.test(text)) return name;
  return 'sparkles';
}
function renderRoutineIcon(name, color, size = 20) {
  const item = ICON_BY_NAME[name] || ICON_BY_NAME.sparkles;
  const safeColor = resolveColor(color);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${safeColor}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.svg}</svg>`;
}
function readSavedColors() {
  try {
    const rows = JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY) || '[]');
    return Array.isArray(rows) ? rows.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 24) : [];
  } catch { return []; }
}
function saveColorToBrowser(color) {
  const hex = resolveColor(color).toLowerCase();
  const colors = readSavedColors().filter((item) => item !== hex);
  colors.unshift(hex);
  try { localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(colors.slice(0, 24))); }
  catch { toast('This browser does not allow local color storage.', 'error'); return; }
  renderSavedColorOptions();
  toast('Color saved in this browser.');
}
function renderSavedColorOptions() {
  const holder = $('#savedColorOptions');
  if (!holder) return;
  const colors = readSavedColors();
  holder.innerHTML = colors.length ? colors.map((color) => `<button type="button" class="saved-color-choice ${resolveColor(state.selectedColor) === color ? 'selected' : ''}" data-saved-color="${color}" style="--swatch:${color}" title="Use ${color}" aria-label="Use color ${color}"></button>`).join('') : '<small class="saved-colors-empty">Saved colors stay in this browser.</small>';
}
function renderIconGrid() {
  const holder = $('#iconGrid');
  if (!holder) return;
  const query = ($('#iconSearch')?.value || '').trim().toLowerCase();
  const rows = ICON_LIBRARY.filter((item) => !query || `${item.name} ${item.label} ${item.keywords}`.toLowerCase().includes(query));
  const iconBg = selectedIconBackground();
  holder.innerHTML = rows.map((item) => `<button type="button" class="icon-choice ${item.name === state.selectedIconName ? 'selected' : ''}" data-icon-name="${item.name}" style="--picker-icon-background:${iconBg};--picker-icon-color:${resolveColor(state.selectedIconColor)}" title="${item.label}" aria-label="${item.label}">${renderRoutineIcon(item.name, state.selectedIconColor, 20)}<small>${item.label}</small></button>`).join('') || '<div class="icon-empty">No icons match that search.</div>';
}
function renderIconSelection() {
  const suggestion = suggestIconName($('#routineTitle')?.value || '');
  const suggested = ICON_BY_NAME[suggestion] || ICON_BY_NAME.sparkles;
  $('#iconSuggestionLabel').textContent = `Suggested: ${suggested.label}`;
  $('#useSuggestedIcon').hidden = state.selectedIconName === suggestion;
  const preview = $('#selectedIconPreview');
  preview.innerHTML = renderRoutineIcon(state.selectedIconName, state.selectedIconColor, 27);
  preview.style.backgroundColor = selectedIconBackground();
  preview.style.borderColor = `color-mix(in srgb, ${resolveColor(state.selectedIconColor)} 50%, transparent)`;
  const bgPicker = $('#customRoutineBackground');
  if (bgPicker) bgPicker.value = selectedIconBackground();
  const bgSwatch = $('#routineBackgroundSwatch');
  if (bgSwatch) bgSwatch.style.backgroundColor = selectedIconBackground();
  $('#resetRoutineBackground')?.classList.toggle('active', !state.selectedIconBackground);
  renderIconGrid();
}
function selectRoutineIcon(name, manual = true) {
  state.selectedIconName = ICON_BY_NAME[name] ? name : 'sparkles';
  state.iconManuallySelected = manual;
  renderIconSelection();
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

function loadBootstrap(showError = true) {
  if (bootstrapLoadPromise) return bootstrapLoadPromise;
  const request = (async () => {
    try {
      const data = await api('/api/bootstrap');
      state.csrfToken = data.csrfToken;
      state.user = data.user;
      state.routines = data.routines || [];
      state.stats = data.stats || {};
      state.google = data.google || { connected: false };
      renderAll();
      setSyncState('saved', state.google.connected ? 'Saved · Google connected' : 'Saved on this server');
      return data;
    } catch (error) {
      if (showError) toast(error.message, 'error');
      setSyncState('error', 'Could not load data');
      return null;
    }
  })();
  bootstrapLoadPromise = request;
  return request.finally(() => {
    if (bootstrapLoadPromise === request) bootstrapLoadPromise = null;
  });
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
    if (!routine.checkinAvailable) return `Next task appears ${formatDate(routine.nextUnlockAt || routine.nextOpportunityAt || routine.periodStart, { day: 'numeric', month: 'short' })}`;
    if (routine.minimumReached) return 'Minimum reached';
    return `${routine.remainingMinimum} more to reach minimum`;
  }
  return dueDescription(routine);
}
function routineCard(routine) {
  const accent = resolveColor(routine.color);
  const iconTint = accent;
  const iconBackground = routineIconBackground(routine);
  const isFrequency = routine.type === 'frequency';
  const progress = isFrequency ? (routine.progress || 0) : 0;
  const completed = isFrequency && routine.maximumReached;
  // Progressive controls checklist visibility, not manual logging permission.
  const canComplete = isFrequency ? !routine.maximumReached : Boolean(routine.isDue);
  const statusGood = isFrequency ? routine.minimumReached : !routine.isDue;
  const status = routineStatusText(routine);
  const actionTitle = completed ? 'Target complete' : !canComplete ? 'Not due yet' : isFrequency && !routine.checkinAvailable ? 'Log an early completion' : 'Mark complete';
  return `
    <article class="routine-card custom-routine-color" style="--routine-accent:${accent};--routine-icon-color:${iconTint};--routine-icon-background:${iconBackground}" data-routine-card="${escapeHtml(routine.id)}">
      <div class="routine-top">
        <div class="routine-symbol">${renderRoutineIcon(routine.icon_name || suggestIconName(routine.title), iconTint, 19)}</div>
        <div class="routine-title-wrap"><h3 title="${escapeHtml(routine.title)}">${escapeHtml(routine.title)}</h3><p>${escapeHtml(isFrequency ? (routine.linked_to_routine_id ? 'Linked frequency target' : 'Frequency target') : routine.linked_to_routine_id ? 'Linked routine' : 'Repeat after completion')}</p></div>
        <button class="routine-menu" type="button" data-action="edit" data-id="${escapeHtml(routine.id)}" aria-label="Edit ${escapeHtml(routine.title)}" title="Edit">✎</button>
        <button class="routine-menu" type="button" data-action="archive" data-id="${escapeHtml(routine.id)}" aria-label="Archive ${escapeHtml(routine.title)}" title="Archive">×</button>
      </div>
      <div class="routine-meta"><span>${escapeHtml(isFrequency ? periodLabel(routine) : routine.cadenceLabel)}</span><strong>${escapeHtml(isFrequency ? `${routine.completedCount}/${routine.max_count}` : routine.daysUntilDue < 0 ? `${Math.abs(routine.daysUntilDue)}d late` : routine.daysUntilDue === 0 ? 'Today' : routine.daysUntilDue > 0 ? `${routine.daysUntilDue}d` : '—')}</strong></div>
      <div class="progress-track"><div class="progress-fill" style="width:${isFrequency ? progress : (routine.isDue ? 100 : Math.max(8, Math.min(100, 100 - routine.daysUntilDue * 5)))}%"></div></div>
      <div class="routine-card-footer"><span class="routine-status"><i class="status-dot ${statusGood ? 'good' : ''}"></i>${escapeHtml(status)}</span><button class="routine-action routine-tick-button" type="button" data-action="complete" data-id="${escapeHtml(routine.id)}" aria-label="${escapeHtml(actionTitle)}: ${escapeHtml(routine.title)}" title="${escapeHtml(actionTitle)}" ${!canComplete || completed ? 'disabled' : ''}><span aria-hidden="true">✓</span></button></div>
    </article>`;
}
function renderChecklist() {
  const items = state.routines.filter((r) => !r.taskSuppressed && (r.type === 'frequency' ? r.checkinAvailable : r.isDue))
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
    const accent = resolveColor(r.color);
    const iconTint = accent;
    const iconBackground = routineIconBackground(r);
    return `<article class="checklist-card" style="--routine-accent:${accent};--routine-icon-color:${iconTint};--routine-icon-background:${iconBackground}"><div class="check-spot">${renderRoutineIcon(r.icon_name || suggestIconName(r.title), iconTint, 18)}</div><div class="check-info"><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(info)}</small></div><button class="check-action" data-action="complete" data-id="${escapeHtml(r.id)}" aria-label="Mark ${escapeHtml(r.title)} complete" title="Mark complete"><span aria-hidden="true">✓</span></button></article>`;
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
  const label = ({ dashboard: 'Dashboard', calendar: 'Calendar', routines: 'All routines', history: 'Activity', settings: 'Settings & sync' })[page];
  $('#breadcrumbCurrent').textContent = label;
  $('#sidebar').classList.remove('open');
  $('#mobileMenuButton')?.setAttribute('aria-expanded', 'false');
  if (page === 'calendar') loadCalendar();
  if (page === 'history') loadHistory();
  if (page === 'settings') renderGoogleSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadCalendar(options = {}) {
  const month = `${state.calendarMonth.getFullYear()}-${String(state.calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const forceTaskRefresh = options.forceTaskRefresh === true;
  const requestKey = `${month}${forceTaskRefresh ? ':force-tasks' : ''}`;
  if (calendarLoadPromises.has(requestKey)) return calendarLoadPromises.get(requestKey);
  $('#calendarMonthTitle').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(state.calendarMonth);
  if (!state.calendarEvents.length) $('#calendarGrid').innerHTML = '<div class="calendar-empty">Loading your month…</div>';
  const request = (async () => {
    try {
      const data = await api(`/api/calendar?month=${encodeURIComponent(month)}${forceTaskRefresh ? '&refreshTasks=1' : ''}`);
      // Ignore a late response if the user has already navigated to another month.
      const currentMonth = `${state.calendarMonth.getFullYear()}-${String(state.calendarMonth.getMonth() + 1).padStart(2, '0')}`;
      if (currentMonth !== month) return data;
      state.calendarEvents = data.events || [];
      state.calendarWarning = data.syncWarning;
      const externalTaskSyncAge = Date.now() - (Date.parse(data.googleTasksLastSync || '') || 0);
      if (state.google.connected && externalTaskSyncAge > 30000 && !calendarManualTaskRefreshTimer) {
        calendarManualTaskRefreshTimer = window.setTimeout(() => {
          calendarManualTaskRefreshTimer = null;
          const visibleMonth = `${state.calendarMonth.getFullYear()}-${String(state.calendarMonth.getMonth() + 1).padStart(2, '0')}`;
          if (state.activePage === 'calendar' && visibleMonth === month) loadCalendar();
        }, 5000);
      }
      if (state.selectedCalendarDate && !state.selectedCalendarDate.startsWith(month)) state.selectedCalendarDate = null;
      renderCalendarGrid();
      $('#calendarFootnote').textContent = data.syncWarning
        ? `Calendar sync needs attention: ${data.syncWarning}`
        : state.google.connected
          ? `Google Calendar refreshed ${timeAgo(data.googleLastSync)}. Your routine dates are shown here, too.`
          : 'Connect Google in Settings to display your Google Calendar events and dated Google Tasks here.';
      return data;
    } catch (error) {
      const currentMonth = `${state.calendarMonth.getFullYear()}-${String(state.calendarMonth.getMonth() + 1).padStart(2, '0')}`;
      if (currentMonth === month) $('#calendarGrid').innerHTML = `<div class="calendar-empty">${escapeHtml(error.message)}</div>`;
      return null;
    }
  })();
  calendarLoadPromises.set(requestKey, request);
  return request.finally(() => {
    if (calendarLoadPromises.get(requestKey) === request) calendarLoadPromises.delete(requestKey);
  });
}
function calendarEventsForDate(key) {
  return state.calendarEvents
    .filter((event) => dateKey(event.start) === key)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}
function calendarKindLabel(event) {
  return ({ google: 'Google event', 'google-task': event.status === 'completed' ? 'Google Task · Completed' : 'Google Task', completion: 'Completed', due: 'Routine due', frequency: 'Frequency task' })[event.kind] || 'Calendar item';
}
function calendarTimeLabel(event) {
  if (event.allDay) return 'All day';
  const start = formatDate(event.start, { hour: 'numeric', minute: '2-digit' });
  const end = event.end ? formatDate(event.end, { hour: 'numeric', minute: '2-digit' }) : '';
  return end && end !== 'Not set' ? `${start} – ${end}` : start;
}
function calendarEventDetailText(event) {
  if (event.kind === 'google') {
    return [event.description, event.location ? `Location: ${event.location}` : ''].filter(Boolean).join(' · ') || 'Google Calendar event';
  }
  if (event.kind === 'google-task') {
    return [event.taskListTitle ? `List: ${event.taskListTitle}` : '', event.description || '', event.status === 'completed' ? 'Completed in Google Tasks' : 'Added in Google Tasks']
      .filter(Boolean).join(' · ');
  }
  if (event.kind === 'completion') return event.note || 'Routine marked complete';
  const routine = state.routines.find((item) => item.id === event.routineId);
  const details = [];
  if (routine?.notes) details.push(routine.notes);
  if (routine?.cadenceLabel) details.push(routine.cadenceLabel);
  if (event.linked || routine?.linked_to_routine_id) details.push('Linked task · date follows its parent routine');
  if (event.kind === 'frequency' && routine) details.push(`${routine.completedCount || 0} of ${routine.max_count} completed this period`);
  return details.join(' · ') || (event.kind === 'frequency' ? 'Frequency routine task' : routine?.title ? 'Repeat-after routine task' : 'Routine task');
}
function renderCalendarDayDetails() {
  const panel = $('#calendarDayPanel');
  const key = state.selectedCalendarDate;
  if (!panel || !key) {
    if (panel) panel.hidden = true;
    if ($('#calendarEventModal')?.hidden && $('#routineModal')?.hidden) document.body.style.overflow = '';
    return;
  }
  const date = new Date(`${key}T12:00:00`);
  const events = calendarEventsForDate(key);
  $('#calendarSelectedDateTitle').textContent = formatLongDate(date);
  $('#calendarSelectedDateSubtitle').textContent = `${events.length} ${events.length === 1 ? 'task or event' : 'tasks and events'} on this date`;
  if (!events.length) {
    $('#calendarDayItems').innerHTML = '<div class="calendar-day-empty"><span>✧</span><strong>No tasks or events</strong><small>Nothing is scheduled for this date.</small></div>';
  } else {
    $('#calendarDayItems').innerHTML = events.map((event) => {
      const routine = state.routines.find((item) => item.id === event.routineId);
      const accent = event.color || routine?.color || '#9a88db';
      const detail = calendarEventDetailText(event);
      const eventId = escapeHtml(event.id);
      const eventDate = dateKey(event.start);
      const isCompletion = event.kind === 'completion' && event.completionId;
      const isRoutineTask = ['due', 'frequency'].includes(event.kind) && event.routineId;
      const canEditDate = Boolean(isCompletion || (event.kind === 'due' && !event.linked));
      const canDelete = Boolean(isCompletion || isRoutineTask);
      const canComplete = Boolean(isRoutineTask && event.available !== false);
      const googleLink = ['google', 'google-task'].includes(event.kind) && event.url
        ? `<a class="calendar-day-open-link" href="${escapeHtml(event.url)}" target="_blank" rel="noopener">Open in Google ↗</a>` : '';
      const dateControl = canEditDate
        ? `<label class="calendar-day-date-control"><span>${isCompletion ? 'Completed' : 'Due date'}</span><input type="date" value="${escapeHtml(eventDate)}" data-calendar-day-date="${eventId}" aria-label="Edit ${isCompletion ? 'completion' : 'due'} date for ${escapeHtml(event.title)}"></label>`
        : `<span class="calendar-day-date-label">${escapeHtml(calendarTimeLabel(event))}</span>`;
      const tickControl = canComplete
        ? `<button type="button" class="calendar-row-action calendar-row-tick" data-calendar-day-complete="${eventId}" aria-label="Complete ${escapeHtml(event.title)}" title="Complete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"></path></svg></button>`
        : isCompletion
          ? `<span class="calendar-row-completed" aria-label="Completed" title="Completed"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"></path></svg></span>` : '';
      const deleteControl = canDelete
        ? `<button type="button" class="calendar-row-action calendar-row-delete" data-calendar-day-delete="${eventId}" aria-label="Delete ${isCompletion ? 'activity' : 'task'} ${escapeHtml(event.title)}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"></path></svg></button>` : '';
      return `<article class="calendar-day-item" style="--day-item-accent:${escapeHtml(accent)}"><button type="button" class="calendar-day-item-main" data-calendar-event="${eventId}" aria-label="View details for ${escapeHtml(event.title)}"><span class="calendar-day-item-marker" aria-hidden="true"></span><span class="calendar-day-item-copy"><span class="calendar-day-item-heading"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(calendarKindLabel(event))} · ${escapeHtml(calendarTimeLabel(event))}</small></span><span class="calendar-day-item-detail">${escapeHtml(detail)}</span></span></button><div class="calendar-day-item-actions">${dateControl}${deleteControl}${tickControl}${googleLink}</div></article>`;
    }).join('');
  }
  panel.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeCalendarDayPanel() {
  state.selectedCalendarDate = null;
  const panel = $('#calendarDayPanel');
  if (panel) panel.hidden = true;
  renderCalendarGrid();
  if ($('#calendarEventModal')?.hidden && $('#routineModal')?.hidden) document.body.style.overflow = '';
}
function selectCalendarDate(key) {
  const [year, month] = key.split('-').map(Number);
  if (year !== state.calendarMonth.getFullYear() || month !== state.calendarMonth.getMonth() + 1) {
    state.calendarMonth = new Date(year, month - 1, 1);
    state.selectedCalendarDate = key;
    loadCalendar();
    return;
  }
  if (state.selectedCalendarDate === key) {
    closeCalendarDayPanel();
    return;
  }
  state.selectedCalendarDate = key;
  renderCalendarGrid();
}
async function saveCalendarDayItemDate(eventId, rawDate) {
  const item = state.calendarEvents.find((row) => row.id === eventId);
  const dateIso = dateInputToIso(rawDate);
  if (!item || !dateIso) return toast('Choose a valid date.', 'error');
  try {
    if (item.kind === 'completion' && item.completionId) {
      await api(`/api/completions/${encodeURIComponent(item.completionId)}`, { method: 'PATCH', body: JSON.stringify({ completedAt: dateIso }) });
    } else if (item.kind === 'due' && !item.linked) {
      await api(`/api/routines/${encodeURIComponent(item.routineId)}/reschedule`, { method: 'PATCH', body: JSON.stringify({ nextDueAt: dateIso }) });
    } else {
      return toast('This date is controlled by its linked or frequency schedule.', 'error');
    }
    await loadBootstrap();
    await loadCalendar();
    await loadHistory();
    toast(item.kind === 'completion' ? 'Completion date updated.' : 'Task date updated.');
  } catch (error) { toast(error.message, 'error'); }
}
async function completeCalendarDayItem(eventId) {
  const item = state.calendarEvents.find((row) => row.id === eventId);
  if (!item || !item.routineId || !['due', 'frequency'].includes(item.kind)) return;
  if (item.available === false) return toast('This task is not available yet.', 'error');
  await completeRoutine(item.routineId);
}
async function deleteCalendarDayItem(eventId) {
  const item = state.calendarEvents.find((row) => row.id === eventId);
  if (!item) return;
  const isCompletion = item.kind === 'completion' && item.completionId;
  const isRoutineTask = ['due', 'frequency'].includes(item.kind) && item.routineId;
  if (!isCompletion && !isRoutineTask) return;
  if (!confirm(isCompletion ? 'Delete this activity and its matching Google Task?' : 'Delete this scheduled task and its matching Google Task? The routine itself will remain.')) return;
  try {
    if (isCompletion) {
      await api(`/api/history/${encodeURIComponent(item.completionId)}`, { method: 'DELETE' });
    } else {
      await api(`/api/routines/${encodeURIComponent(item.routineId)}/task`, { method: 'DELETE' });
    }
    await loadBootstrap();
    await loadCalendar();
    await loadHistory();
    toast(isCompletion ? 'Activity deleted.' : 'Scheduled task deleted.');
  } catch (error) { toast(error.message, 'error'); }
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
    const events = (grouped.get(key) || []).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    const visibleLimit = 4;
    const visible = events.slice(0, visibleLimit);
    const more = events.length - visible.length;
    const eventMarkup = visible.map((event) => `<button type="button" class="calendar-event ${escapeHtml(event.kind)} ${event.kind === 'google-task' ? 'google' : ''}" data-calendar-event="${escapeHtml(event.id)}" title="Open ${escapeHtml(event.title)}">${escapeHtml(event.title)}</button>`).join('');
    const overflowBadge = more > 0
      ? `<span class="calendar-overflow-count" aria-label="${more} additional tasks or events">+${more}</span>`
      : '';
    cells.push(`<div data-calendar-date="${key}" class="calendar-day ${day.getMonth() !== state.calendarMonth.getMonth() ? 'outside' : ''} ${key === todayKey ? 'today' : ''} ${state.selectedCalendarDate === key ? 'selected' : ''}"><button type="button" class="day-number day-select" data-calendar-date="${key}" aria-label="Show ${events.length} tasks and events for ${escapeHtml(formatLongDate(day))}" aria-pressed="${state.selectedCalendarDate === key}">${day.getDate()}</button>${overflowBadge}${eventMarkup}</div>`);
  }
  $('#calendarGrid').innerHTML = cells.join('');
  renderCalendarDayDetails();
}

function loadHistory() {
  if (historyLoadPromise) return historyLoadPromise;
  if (!$('#historyList').children.length) $('#historyList').innerHTML = '<div class="history-empty">Loading activity…</div>';
  const request = (async () => {
    try {
      const data = await api('/api/history?limit=100');
      const rows = data.history || [];
      if (!rows.length) {
        $('#historyList').innerHTML = '<div class="history-empty">Your completed routines will appear here. Complete a routine to get started.</div>';
        return data;
      }
      $('#historyList').innerHTML = rows.map((row) => `<div class="history-entry"><div class="history-mark">✓</div><div class="history-entry-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.note || 'Routine completed')}</small></div><div class="history-date">${formatDate(row.completed_at, { day: 'numeric', month: 'short' })} · ${formatDate(row.completed_at, { hour: 'numeric', minute: '2-digit' })}</div><button class="history-delete" type="button" data-action="delete-activity" data-id="${escapeHtml(row.id)}" aria-label="Delete activity" title="Delete activity">×</button></div>`).join('');
      return data;
    } catch (error) {
      $('#historyList').innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
      return null;
    }
  })();
  historyLoadPromise = request;
  return request.finally(() => {
    if (historyLoadPromise === request) historyLoadPromise = null;
  });
}
async function deleteActivity(id) {
  if (!confirm('Delete this activity? This will remove it from your history, update routine progress, and delete its matching Google Task if one was synced.')) return;
  try { await api(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadBootstrap(); await loadHistory(); if (state.activePage === 'calendar') await loadCalendar(); toast('Activity deleted.'); }
  catch (error) { toast(error.message, 'error'); }
}

function setSelectedType(type) {
  state.selectedType = type;
  $$('.type-option').forEach((button) => button.classList.toggle('active', button.dataset.type === type));
  $('#frequencyFields').hidden = type !== 'frequency';
  $('#intervalFields').hidden = type !== 'interval';
  if ($('#linkedEnabled')) toggleLinkedFields();
}
function setSelectedColor(color) {
  const value = COLOR_HEX[color] ? color : resolveColor(color);
  state.selectedColor = value;
  $$('.color-choice').forEach((button) => button.classList.toggle('selected', button.dataset.color === value));
  const picker = $('#customRoutineColor');
  if (picker) picker.value = resolveColor(value);
  state.selectedIconColor = resolveColor(value);
  renderIconSelection();
  renderSavedColorOptions();
}
function toggleLastDoneFields() {
  const hasLast = $('#hasLastDone').checked;
  $('#lastDoneWrap').hidden = !hasLast;
  $('#firstDueWrap').hidden = hasLast;
}
function fillLinkedRoutineOptions(routine = null) {
  const select = $('#linkedRoutine');
  const choices = state.routines.filter((r) => !r.linked_to_routine_id && !r.archived && r.id !== routine?.id);
  select.innerHTML = '<option value="">Choose a routine to follow</option>' + choices.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.title)} · ${escapeHtml(r.cadenceLabel)}</option>`).join('');
  if (routine?.linked_to_routine_id) select.value = routine.linked_to_routine_id;
}
function toggleLinkedFields() {
  const linked = $('#linkedEnabled').checked;
  $('#linkedFields').hidden = !linked;
  $('#intervalRegularFields').hidden = state.selectedType === 'interval' && linked;
}
function openRoutineModal(routine = null) {
  $('#routineForm').reset();
  $('#routineId').value = routine?.id || '';
  $('#modalTitle').textContent = routine ? 'Edit routine' : 'Create a routine';
  $('#routineTitle').value = routine?.title || '';
  $('#routineNotes').value = routine?.notes || '';
  const type = routine?.type || 'frequency';
  state.selectedIconBackground = routineIconBackgroundOverride(routine?.id);
  setSelectedType(type);
  setSelectedColor(routine?.color || 'lavender');
  state.selectedIconName = routine?.icon_name && routine.icon_name !== 'sparkles' ? routine.icon_name : suggestIconName(routine?.title || '');
  state.iconManuallySelected = Boolean(routine?.icon_name && routine.icon_name !== 'sparkles');
  state.selectedIconColor = resolveColor(state.selectedColor);
  $('#customRoutineColor').value = resolveColor(state.selectedColor);
  $('#minCount').value = routine?.min_count ?? 2;
  $('#maxCount').value = routine?.max_count ?? 3;
  $('#periodValue').value = routine?.period_value ?? 1;
  $('#periodUnit').value = routine?.period_unit || 'weeks';
  const progressiveValue = routine?.progressive;
  $('#progressive').checked = routine ? (progressiveValue === true || progressiveValue === 1 || progressiveValue === '1') : true;
  const today = formatDateText(localDateInput());
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
  $('#iconSearch').value = '';
  renderSavedColorOptions();
  renderIconSelection();
  $$('.type-option').forEach((button) => { button.disabled = Boolean(routine); button.style.opacity = routine ? '.65' : '1'; });
  $('#routineModal').hidden = false;
  document.body.style.overflow = 'hidden';
  const routineDialog = $('#routineModal .routine-modal');
  if (routineDialog) routineDialog.scrollTop = 0;
  // Do not auto-open the phone keyboard when the modal appears. It changes
  // the visual viewport and can jump the dialog under the browser address bar.
  if (window.matchMedia('(min-width: 681px)').matches) {
    setTimeout(() => $('#routineTitle').focus({ preventScroll: true }), 40);
  }
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
  const linked = $('#linkedEnabled').checked;
  const linkedToRoutineId = linked ? $('#linkedRoutine').value : null;
  const linkedOffsetDays = ($('#linkedDirection').value === 'before' ? -1 : 1) * Number($('#linkedDays').value || 0);
  if (linked && !linkedToRoutineId) return toast('Choose the routine this task should follow.', 'error');
  let body = { title, notes: $('#routineNotes').value, color: state.selectedColor, iconName: state.selectedIconName, iconColor: resolveColor(state.selectedColor), type: state.selectedType, linkedToRoutineId, linkedOffsetDays };
  if (state.selectedType === 'frequency') {
    const startAt = dateInputToIso($('#startAt').value);
    if (!startAt) return toast('Enter the start date as DD-MM-YYYY or choose it from the calendar.', 'error');
    body = { ...body, minCount: Number($('#minCount').value), maxCount: Number($('#maxCount').value), progressive: $('#progressive').checked,
      periodValue: Number($('#periodValue').value), periodUnit: $('#periodUnit').value, startAt };
  } else {
    body = { ...body, intervalValue: Number($('#intervalValue').value), intervalUnit: $('#intervalUnit').value };
    if (!linked && $('#hasLastDone').checked) {
      const lastCompletedAt = dateInputToIso($('#lastCompletedAt').value);
      if (!lastCompletedAt) return toast('Enter the last-completed date as DD-MM-YYYY.', 'error');
      body.lastCompletedAt = lastCompletedAt;
    } else if (!linked) {
      const nextDueAt = dateInputToIso($('#firstDueAt').value);
      if (!nextDueAt) return toast('Enter the first due date as DD-MM-YYYY.', 'error');
      body.lastCompletedAt = null;
      body.nextDueAt = nextDueAt;
    }
  }
  const button = $('#saveRoutineButton');
  button.disabled = true;
  button.textContent = 'Saving…';
  setSyncState('syncing', 'Saving your routine');
  try {
    const result = await api(id ? `/api/routines/${encodeURIComponent(id)}` : '/api/routines', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    const savedRoutineId = id || result.routine?.id;
    if (savedRoutineId) persistRoutineIconBackground(savedRoutineId, state.selectedIconBackground);
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
  setSyncState('syncing', 'Saving completion');
  try {
    await api(`/api/routines/${encodeURIComponent(id)}/complete`, { method: 'POST', body: JSON.stringify({}) });
    await loadBootstrap();
    if (state.activePage === 'calendar') await loadCalendar();
    toast(`${routine.title} completed. Nice work.`);
  } catch (error) { toast(error.message, 'error'); setSyncState('error', 'Save failed'); }
}
async function archiveRoutine(id) {
  const routine = state.routines.find((r) => r.id === id);
  if (!routine || !confirm(`Archive “${routine.title}”? Its history will be kept.`)) return;
  try {
    await api(`/api/routines/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadBootstrap();
    toast('Routine archived. Its completion history is preserved.');
  } catch (error) { toast(error.message, 'error'); }
}

function openCalendarEvent(event) {
  state.selectedCalendarEvent = event;
  $('#calendarEventTitle').textContent = event.title;
  const isCompletion = event.kind === 'completion';
  const isGoogle = event.kind === 'google' || event.kind === 'google-task';
  const isDue = event.kind === 'due' || event.kind === 'frequency';
  $('#calendarEventDescription').textContent = event.kind === 'google-task'
    ? ([event.taskListTitle ? `Task list: ${event.taskListTitle}` : '', event.description || '', event.status === 'completed' ? 'Completed in Google Tasks' : 'Added in Google Tasks'].filter(Boolean).join(' · '))
    : isGoogle ? ([event.description, event.location ? `Location: ${event.location}` : ''].filter(Boolean).join(' · ') || 'Google Calendar event')
      : isCompletion ? 'Edit the date of this completed activity or remove it from your history.'
        : event.kind === 'frequency' ? (event.available ? 'This task is available. Complete it when ready.' : 'This task appears when its scheduled point in the period is reached.')
          : event.linked ? 'This task follows another routine. Its date moves automatically when the linked routine is rescheduled.'
            : 'Complete this task when it is due, or change its scheduled date.';
  const canEditDate = isCompletion || (event.kind === 'due' && !event.linked);
  $('#calendarActionDateLabel').textContent = isCompletion ? 'Completion date' : 'Scheduled date';
  $('#calendarActionDateLabel').hidden = !canEditDate;
  $('#calendarActionDate').value = formatDateText(dateKey(event.start));
  const dateWrap = $('#calendarActionDate').closest('.date-entry-wrap') || $('#calendarActionDate');
  dateWrap.hidden = !canEditDate;
  $('#calendarEventComplete').hidden = !isDue;
  $('#calendarEventComplete').disabled = (isDue && event.available === false) || isGoogle;
  $('#calendarEventComplete').innerHTML = '<span aria-hidden="true">✓</span>';
  $('#calendarEventComplete').setAttribute('aria-label', 'Mark routine complete');
  $('#calendarEventComplete').title = 'Mark complete';
  $('#calendarEventSaveDate').hidden = !canEditDate;
  $('#calendarEventDelete').hidden = !(isCompletion || isDue);
  $('#calendarEventDelete').textContent = isCompletion ? 'Delete activity' : 'Delete task';
  $('#calendarEventOpen').hidden = !isGoogle || !event.url;
  if (event.url) $('#calendarEventOpen').href = event.url;
  $('#calendarEventModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeCalendarEvent() {
  $('#calendarEventModal').hidden = true;
  state.selectedCalendarEvent = null;
  if ($('#routineModal').hidden && $('#calendarDayPanel').hidden) document.body.style.overflow = '';
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
  if (!event) return;
  const isCompletion = event.kind === 'completion' && event.completionId;
  const isRoutineTask = ['due', 'frequency'].includes(event.kind) && event.routineId;
  if (!isCompletion && !isRoutineTask) return;
  const message = isCompletion
    ? 'Delete this activity and its matching Google Task? This also updates routine progress.'
    : 'Delete this scheduled task from the website and its matching Google Task? The routine itself will remain.';
  if (!confirm(message)) return;
  try {
    if (isCompletion) {
      await api(`/api/history/${encodeURIComponent(event.completionId)}`, { method: 'DELETE' });
    } else {
      await api(`/api/routines/${encodeURIComponent(event.routineId)}/task`, { method: 'DELETE' });
    }
    closeCalendarEvent();
    await loadBootstrap();
    await loadCalendar();
    await loadHistory();
    toast(isCompletion ? 'Activity and its Google Task deleted.' : 'Task and its Google Task deleted.');
  } catch (error) { toast(error.message, 'error'); }
}

function renderDatePopover(input, popover) {
  const key = parseDateText(input.value) || localDateInput();
  const [y, m] = (popover.dataset.month || key.slice(0, 7)).split('-').map(Number);
  const safeYear = Math.min(2100, Math.max(1900, Number.isFinite(y) ? y : new Date().getFullYear()));
  const safeMonth = Math.min(12, Math.max(1, Number.isFinite(m) ? m : 1));
  const first = new Date(safeYear, safeMonth - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(safeYear, safeMonth - 1, 1 - offset);
  const monthNames = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2020, index, 1)));
  const monthOptions = monthNames.map((name, index) => `<option value="${index + 1}" ${index + 1 === safeMonth ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
  const yearOptions = Array.from({ length: 201 }, (_, index) => 1900 + index)
    .map((year) => `<option value="${year}" ${year === safeYear ? 'selected' : ''}>${year}</option>`).join('');
  const days = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dayKey = localDateInput(day);
    days.push(`<button type="button" class="date-picker-day ${day.getMonth() !== first.getMonth() ? 'outside' : ''} ${dayKey === key ? 'selected' : ''} ${dayKey === localDateInput() ? 'today' : ''}" data-date-choice="${dayKey}">${day.getDate()}</button>`);
  }
  popover.dataset.month = `${safeYear}-${String(safeMonth).padStart(2, '0')}`;
  popover.innerHTML = `<div class="date-picker-head"><button type="button" class="date-picker-nav" data-date-nav="-1" aria-label="Previous month" title="Previous month">‹</button><div class="date-picker-head-selects"><select class="date-picker-month-select" data-date-month-select aria-label="Choose month">${monthOptions}</select><select class="date-picker-year-select" data-date-year-select aria-label="Choose year">${yearOptions}</select></div><button type="button" class="date-picker-nav" data-date-nav="1" aria-label="Next month" title="Next month">›</button></div><div class="date-picker-weekdays"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div><div class="date-picker-days">${days.join('')}</div>`;

  // Bind controls directly after each render. This avoids stale/delegated handlers
  // when the popup is rebuilt and keeps month navigation reliable on touch devices.
  const changeMonth = (delta) => {
    const next = new Date(safeYear, safeMonth - 1 + delta, 1);
    popover.dataset.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    renderDatePopover(input, popover);
  };
  popover.querySelectorAll('[data-date-nav]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      changeMonth(Number(button.dataset.dateNav));
    });
  });
  const monthSelect = popover.querySelector('[data-date-month-select]');
  const yearSelect = popover.querySelector('[data-date-year-select]');
  const applySelectedMonthYear = () => {
    const nextYear = Number(yearSelect.value);
    const nextMonth = Number(monthSelect.value);
    if (!Number.isInteger(nextYear) || !Number.isInteger(nextMonth)) return;
    popover.dataset.month = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    renderDatePopover(input, popover);
  };
  monthSelect.addEventListener('change', applySelectedMonthYear);
  yearSelect.addEventListener('change', applySelectedMonthYear);
  popover.querySelectorAll('[data-date-choice]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.value = formatDateText(button.dataset.dateChoice);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      popover.hidden = true;
    });
  });
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
      // Keep the year dropdown and its arrow inside the visible area. Pickers
      // near the right edge of a modal/page are shifted left instead of clipped.
      requestAnimationFrame(() => {
        const wrapRect = wrap.getBoundingClientRect();
        const modal = wrap.closest('.routine-modal');
        const modalRect = modal ? modal.getBoundingClientRect() : null;
        const popupWidth = popover.getBoundingClientRect().width || Math.min(320, window.innerWidth - 24);
        const viewportRight = window.innerWidth - 12;
        const allowedRight = modalRect ? Math.min(viewportRight, modalRect.right - 12) : viewportRight;
        const allowedLeft = modalRect ? Math.max(12, modalRect.left + 12) : 12;
        let left = 0;
        const rightIfDefault = wrapRect.left + popupWidth;
        if (rightIfDefault > allowedRight) left = allowedRight - rightIfDefault;
        if (wrapRect.left + left < allowedLeft) left = allowedLeft - wrapRect.left;
        popover.style.left = `${Math.round(left)}px`;
      });
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
    if (state.activePage === 'calendar') await loadCalendar({ forceTaskRefresh: true });
    toast('Google Calendar and Google Tasks are up to date.');
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
  $('#customRoutineColor').addEventListener('input', (event) => setSelectedColor(event.target.value));
  $('#customRoutineBackground').addEventListener('input', (event) => setSelectedIconBackground(event.target.value));
  $('#resetRoutineBackground').addEventListener('click', () => setSelectedIconBackground(null));
  $('#saveRoutineColor').addEventListener('click', () => saveColorToBrowser(state.selectedColor));
  $('#savedColorOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-saved-color]');
    if (button) setSelectedColor(button.dataset.savedColor);
  });
  $('#iconSearch').addEventListener('input', renderIconGrid);
  $('#iconGrid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-icon-name]');
    if (button) selectRoutineIcon(button.dataset.iconName, true);
  });
  $('#useSuggestedIcon').addEventListener('click', () => selectRoutineIcon(suggestIconName($('#routineTitle').value), false));
  $('#routineTitle').addEventListener('input', () => {
    if (!state.iconManuallySelected) {
      state.selectedIconName = suggestIconName($('#routineTitle').value);
      renderIconSelection();
    } else {
      const suggestion = ICON_BY_NAME[suggestIconName($('#routineTitle').value)] || ICON_BY_NAME.sparkles;
      $('#iconSuggestionLabel').textContent = `Suggested: ${suggestion.label}`;
      $('#useSuggestedIcon').hidden = state.selectedIconName === suggestion.name;
    }
  });
  $('#hasLastDone').addEventListener('change', toggleLastDoneFields);
  $('#linkedEnabled').addEventListener('change', toggleLinkedFields);
  $('#calendarPrev').addEventListener('click', () => { state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1); state.selectedCalendarDate = null; loadCalendar(); });
  $('#calendarNext').addEventListener('click', () => { state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1); state.selectedCalendarDate = null; loadCalendar(); });
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
  const handleCalendarSelection = (event) => {
    const completeButton = event.target.closest('[data-calendar-day-complete]');
    if (completeButton) {
      event.preventDefault(); event.stopPropagation();
      completeCalendarDayItem(completeButton.dataset.calendarDayComplete);
      return;
    }
    const deleteButton = event.target.closest('[data-calendar-day-delete]');
    if (deleteButton) {
      event.preventDefault(); event.stopPropagation();
      deleteCalendarDayItem(deleteButton.dataset.calendarDayDelete);
      return;
    }
    const eventButton = event.target.closest('[data-calendar-event]');
    if (eventButton) {
      event.stopPropagation();
      const item = state.calendarEvents.find((row) => row.id === eventButton.dataset.calendarEvent);
      if (item) openCalendarEvent(item);
      return;
    }
    const day = event.target.closest('[data-calendar-date]');
    if (day) selectCalendarDate(day.dataset.calendarDate);
  };
  $('#calendarGrid').addEventListener('click', handleCalendarSelection);
  $('#calendarDayItems').addEventListener('click', handleCalendarSelection);
  $('#calendarDayItems').addEventListener('change', (event) => { const input = event.target.closest('[data-calendar-day-date]'); if (input) saveCalendarDayItemDate(input.dataset.calendarDayDate, input.value); });
  $('#closeCalendarDayPanel').addEventListener('click', closeCalendarDayPanel);
  $('#calendarDayPanel').addEventListener('click', (event) => { if (event.target === $('#calendarDayPanel')) closeCalendarDayPanel(); });
  $('#closeCalendarEventModal').addEventListener('click', closeCalendarEvent);
  $('#calendarEventModal').addEventListener('click', (event) => { if (event.target === $('#calendarEventModal')) closeCalendarEvent(); });
  $('#calendarEventComplete').addEventListener('click', completeCalendarEvent);
  $('#calendarEventSaveDate').addEventListener('click', saveCalendarEventDate);
  $('#calendarEventDelete').addEventListener('click', deleteCalendarActivity);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (!$('#calendarEventModal').hidden) closeCalendarEvent(); else if (!$('#routineModal').hidden) closeRoutineModal(); else if (!$('#calendarDayPanel').hidden) closeCalendarDayPanel(); } });
}

async function init() {
  installHandlers();
  setupDateInputs();
  const todayText = formatDateText(localDateInput());
  $('#startAt').value = todayText;
  $('#lastCompletedAt').value = todayText;
  $('#firstDueAt').value = todayText;
  await loadBootstrap();
  lastForegroundRefreshAt = Date.now();
  const refreshForegroundData = async () => {
    if (document.hidden || foregroundRefreshRunning || Date.now() - lastForegroundRefreshAt < 15000) return;
    foregroundRefreshRunning = true;
    lastForegroundRefreshAt = Date.now();
    try {
      await loadBootstrap(false);
      if (state.activePage === 'calendar') await loadCalendar();
      else if (state.activePage === 'history') await loadHistory();
    } finally {
      foregroundRefreshRunning = false;
    }
  };
  window.setInterval(refreshForegroundData, 60000);
  document.addEventListener('visibilitychange', refreshForegroundData);
  const params = new URLSearchParams(window.location.search);
  if (params.has('connected')) toast('Google account connected. Calendar sync has started.');
  if (params.has('google_error')) toast(`Google connection: ${params.get('google_error')}`, 'error');
  if (params.has('connected') || params.has('google_error')) history.replaceState({}, '', '/');
}

document.addEventListener('DOMContentLoaded', init);