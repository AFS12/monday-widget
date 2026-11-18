// Código compartilhado entre a janela principal (lista) e a janela de detalhes.
const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const appWindow = TAURI.window.getCurrentWindow();

const $ = (sel) => document.querySelector(sel);

const DONE_RE = /^(done|feito|conclu[ií]do|finalizado|entregue|completo|completed|ok|lan[cç]ado)\b/i;
const STATUS_HINT_RE = /^(status|situa|etapa|andamento|estado|fase)/i;
const DATE_HINT_RE = /prazo|entrega|vencimento|due|deadline|data|date/i;
const PEOPLE_HINT_RE = /respons|owner|dono|pessoa|assignee|atribu|encarregad/i;

// ordena colunas: as que batem com a regex (pelo título) vêm primeiro
const byHint = (re) => (a, b) => (re.test(b.title || '') ? 1 : 0) - (re.test(a.title || '') ? 1 : 0);

// ---------------------------------------------------------------- API

const gql = (query) => invoke('monday_query', { query });
const gstr = (s) => JSON.stringify(String(s)); // string GraphQL segura
const isId = (v) => /^\d+$/.test(String(v));

// A API do monday trocou "settings_str" por "settings" em versões novas.
// Tenta um, cai para o outro e lembra qual funcionou.
let SETTINGS_FIELD = null;
async function withSettings(build) {
  const order = SETTINGS_FIELD ? [SETTINGS_FIELD] : ['settings_str', 'settings'];
  let lastErr;
  for (const field of order) {
    try {
      const data = await gql(build(field));
      SETTINGS_FIELD = field;
      return data;
    } catch (e) {
      lastErr = e;
      if (!/settings/i.test(String(e))) throw e;
    }
  }
  throw lastErr;
}

// Extrai as opções de uma coluna de status (aceita o formato antigo e o novo)
function parseLabels(raw) {
  let s = raw;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return []; }
  }
  if (!s || !s.labels) return [];
  const hex = (c) => {
    if (typeof c === 'string' && c.startsWith('#')) return c;
    if (c && typeof c.color === 'string' && c.color.startsWith('#')) return c.color;
    return null;
  };

  // "done": a opção marcada como concluída na configuração da coluna
  if (Array.isArray(s.labels)) {
    return s.labels
      .filter((l) => l && !l.is_deactivated && (l.label ?? l.name))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((l) => ({ label: String(l.label ?? l.name), color: hex(l.color) || hex(l.hex), done: !!l.is_done }));
  }

  const deactivated = new Set((s.deactivated_labels || []).map(String));
  const doneKeys = new Set((s.done_colors || []).map(String));
  const pos = s.labels_positions_v2 || {};
  const colors = s.labels_colors || {};
  return Object.entries(s.labels)
    .filter(([k, v]) => v && !deactivated.has(String(k)))
    .sort(([a], [b]) => (pos[a] ?? Number(a)) - (pos[b] ?? Number(b)))
    .map(([k, v]) => ({ label: String(v), color: hex(colors[k]), done: doneKeys.has(String(k)) }));
}

/** O status conta como concluído? Usa a marcação do monday e, na falta dela, o nome. */
function isDoneStatus(labels, text) {
  const t = (text || '').trim();
  if (!t) return false;
  return !!(labels || []).find((l) => l.label === t)?.done || DONE_RE.test(t);
}

async function changeStatus(boardId, itemId, columnId, label) {
  if (!isId(boardId) || !isId(itemId)) throw new Error('ID inválido');
  const col = gstr(columnId);
  const data = await gql(`mutation {
    change_simple_column_value(board_id: ${boardId}, item_id: ${itemId}, column_id: ${col}, value: ${gstr(label)}) {
      id
      column_values(ids: [${col}]) { text ... on StatusValue { label_style { color } } }
    }
  }`);
  const cv = data.change_simple_column_value?.column_values?.[0];
  return { status: cv?.text ?? label, color: cv?.label_style?.color ?? null };
}

// ---------------------------------------------------------------- responsáveis (coluna "people")

const normPersons = (list) => (list || []).map((p) => ({ id: String(p.id), kind: p.kind || 'person' }));
const isMe = (meId) => (p) => p.kind !== 'team' && String(p.id) === String(meId);

/** people = { colId: [{id, kind}] } → é meu? está sem ninguém? */
function classifyPeople(people, meId) {
  const lists = Object.values(people || {});
  return {
    mine: lists.some((l) => l.some(isMe(meId))),
    unassigned: lists.every((l) => l.length === 0),
  };
}

/** Grava a lista de pessoas de uma coluna. Lista vazia = sem responsável. */
async function setPeople(boardId, itemId, columnId, persons) {
  if (!isId(boardId) || !isId(itemId)) throw new Error('ID inválido');
  const col = gstr(columnId);
  const ret = `id column_values(ids: [${col}]) { text ... on PeopleValue { persons_and_teams { id kind } } }`;
  const value = JSON.stringify({
    personsAndTeams: persons.map((p) => ({ id: Number(p.id), kind: p.kind || 'person' })),
  });

  let res;
  try {
    const d = await gql(`mutation {
      change_column_value(board_id: ${boardId}, item_id: ${itemId}, column_id: ${col}, value: ${gstr(value)}) { ${ret} }
    }`);
    res = d.change_column_value;
  } catch (e) {
    if (persons.length) throw e;
    // alternativa documentada para limpar a coluna
    const d = await gql(`mutation {
      change_simple_column_value(board_id: ${boardId}, item_id: ${itemId}, column_id: ${col}, value: "") { ${ret} }
    }`);
    res = d.change_simple_column_value;
  }
  const cv = res?.column_values?.[0];
  return { persons: normPersons(cv?.persons_and_teams), text: cv?.text || '' };
}

/** Adiciona "eu" na coluna principal, mantendo quem já estava. */
async function assignMe(boardId, itemId, people, mainCol, meId) {
  const list = people[mainCol] || [];
  if (list.some(isMe(meId))) return { people, texts: {} };
  const r = await setPeople(boardId, itemId, mainCol, [...list, { id: String(meId), kind: 'person' }]);
  return { people: { ...people, [mainCol]: r.persons }, texts: { [mainCol]: r.text } };
}

/** Remove "eu" de todas as colunas de pessoas (os outros responsáveis continuam). */
async function unassignMe(boardId, itemId, people, meId) {
  const out = { ...people };
  const texts = {};
  for (const [col, list] of Object.entries(people)) {
    if (!list.some(isMe(meId))) continue;
    const r = await setPeople(boardId, itemId, col, list.filter((p) => !isMe(meId)(p)));
    out[col] = r.persons;
    texts[col] = r.text;
  }
  return { people: out, texts };
}

// ---------------------------------------------------------------- UI helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // textContent: sem injeção de HTML
  return e;
}

function icon(name) {
  const paths = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
    userMinus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 11h6"/>',
  };
  const span = document.createElement('span');
  span.className = 'ico';
  span.innerHTML = `<svg viewBox="0 0 24 24">${paths[name] || ''}</svg>`; // conteúdo fixo, não vem da API
  return span;
}

function openUrl(url) {
  if (url) invoke('plugin:opener|open_url', { url }).catch((e) => toast(String(e), true));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = msg;
  t.className = isErr ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 4000 : 1800);
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  const dm = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (diff < 0) return { text: `Atrasado · ${dm}`, cls: 'late' };
  if (diff === 0) return { text: 'Hoje', cls: 'today' };
  if (diff === 1) return { text: 'Amanhã', cls: '' };
  if (diff < 7) return { text: date.toLocaleDateString('pt-BR', { weekday: 'short' }) + ` · ${dm}`, cls: '' };
  return { text: dm, cls: '' };
}

// ---------------------------------------------------------------- seletor de status

let pickerCleanup = null;

function closePicker() {
  if (pickerCleanup) { pickerCleanup(); pickerCleanup = null; }
}

/** Mostra um menu com as opções de status ancorado em `anchor`. */
function showStatusPicker(anchor, labels, current, onPick) {
  closePicker();
  const menu = el('div', 'picker');
  for (const opt of labels) {
    const b = el('button', opt.label === current ? 'opt current' : 'opt');
    const sw = el('span', 'swatch');
    sw.style.background = opt.color || 'var(--muted)';
    b.append(sw, el('span', 'lbl', opt.label));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closePicker();
      if (opt.label !== current) onPick(opt);
    });
    menu.append(b);
  }
  document.body.append(menu);

  // posiciona abaixo do botão; se não couber, acima
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  menu.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6))}px`;
  menu.style.top = mh <= below || below > r.top ? `${r.bottom + 4}px` : `${Math.max(6, r.top - mh - 4)}px`;

  const onDoc = (e) => { if (!menu.contains(e.target)) closePicker(); };
  const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  document.addEventListener('keydown', onKey);
  pickerCleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onKey);
  };
}

// sem menu de contexto do navegador, exceto em campos de texto
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, select, textarea, .selectable')) e.preventDefault();
});
