// Janela de detalhes: briefing + atualizações de um item. Depende de common.js.
const { listen, emitTo } = TAURI.event;

const BRIEF_RE = /brief/i;

let itemId = new URLSearchParams(location.search).get('id');
let item = null; // dados carregados do monday
let loadSeq = 0;

// ---------------------------------------------------------------- dados

// Campo da foto do usuário varia entre versões da API; cai para "sem foto" se não existir
let PHOTO_FIELD = 'photo_thumb';

async function fetchItem(id) {
  if (!isId(id)) throw new Error('ID inválido');
  try {
    return await queryItem(id);
  } catch (e) {
    if (PHOTO_FIELD && /photo/i.test(String(e))) {
      PHOTO_FIELD = '';
      return queryItem(id);
    }
    throw e;
  }
}

async function queryItem(id) {
  const creator = `creator { name ${PHOTO_FIELD} }`;
  const data = await withSettings((f) => `query {
    me { id }
    items(ids: [${id}]) {
      id name url
      board { id name columns(types: [status, people]) { id title type ${f} } }
      group { title color }
      column_values {
        id type text
        column { title }
        ... on StatusValue { label_style { color } }
        ... on DateValue { date }
        ... on PeopleValue { persons_and_teams { id kind } }
      }
      updates(limit: 50) {
        id body created_at
        ${creator}
        assets { name public_url file_extension }
        replies { id body created_at ${creator} }
      }
    }
  }`);
  const it = data.items?.[0];
  if (!it) throw new Error('Item não encontrado (pode ter sido excluído ou você não tem acesso)');
  it.meId = String(data.me.id);
  return it;
}

// ---------------------------------------------------------------- HTML seguro das atualizações

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'A', 'SPAN', 'DIV',
  'BLOCKQUOTE', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR',
]);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT']);

/** Recria o HTML do monday só com tags/atributos seguros (sem scripts, estilos ou eventos). */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const frag = document.createDocumentFragment();
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { dst.append(document.createTextNode(n.textContent)); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE || DROP_TAGS.has(n.tagName)) continue;
      if (!ALLOWED_TAGS.has(n.tagName)) { walk(n, dst); continue; } // desembrulha tags desconhecidas
      const e = document.createElement(n.tagName);
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) { e.dataset.href = href; e.href = '#'; e.title = href; }
      }
      if (n.tagName === 'IMG') {
        const src2 = n.getAttribute('src') || '';
        if (!/^https:\/\//i.test(src2)) continue;
        e.src = src2;
        e.loading = 'lazy';
        e.addEventListener('error', () => e.remove());
      }
      walk(n, e);
      dst.append(e);
    }
  };
  walk(doc.body, frag);
  return frag;
}

// ---------------------------------------------------------------- render

function timeAgo(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (s < 60) return 'agora';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function avatar(creator) {
  const photo = creator?.[PHOTO_FIELD];
  if (photo && /^https:\/\//.test(photo)) {
    const img = el('img', 'avatar');
    img.src = photo;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(initials(creator)));
    return img;
  }
  return initials(creator);
}

function initials(creator) {
  const name = creator?.name || '?';
  const parts = name.trim().split(/\s+/);
  return el('span', 'avatar', ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase());
}

function section(title, count) {
  const s = el('section');
  const h = el('h2', null, title);
  if (count != null) h.append(el('span', 'count', String(count)));
  s.append(h);
  return s;
}

function render() {
  const main = $('#content');
  main.replaceChildren();
  closePicker();
  const it = item;

  $('#crumb').textContent = it.board.name;
  document.title = it.name;

  // --- cabeçalho do item
  const head = el('div', 'item-head');
  head.append(el('h1', 'selectable', it.name));
  if (it.group?.title) {
    const g = el('div', 'group', it.group.title);
    if (it.group.color) g.style.setProperty('--gc', it.group.color);
    head.append(g);
  }

  const cvs = it.column_values || [];
  const boardCols = it.board.columns || [];
  const statusCols = boardCols.filter((c) => c.type === 'status').sort(byHint(STATUS_HINT_RE));
  const peopleCols = boardCols.filter((c) => c.type === 'people').sort(byHint(PEOPLE_HINT_RE));
  const primary = STATUS_HINT_RE.test(statusCols[0]?.title || '')
    ? statusCols[0]
    : statusCols.find((c) => cvs.find((v) => v.id === c.id)?.text) || statusCols[0];

  const chips = el('div', 'chips');
  if (primary) {
    const cv = cvs.find((v) => v.id === primary.id);
    const labels = parseLabels(primary.settings_str ?? primary.settings);
    const pill = el('button', 'pill big', cv?.text || 'Definir status');
    pill.style.background = cv?.label_style?.color || 'var(--muted)';
    pill.title = `${primary.title} — clique para alterar`;
    pill.append(icon('chevron'));
    pill.addEventListener('click', () => {
      if (!labels.length) { toast('Não encontrei as opções de status deste quadro', true); return; }
      showStatusPicker(pill, labels, cv?.text, (opt) => updateStatus(primary.id, opt));
    });
    chips.append(pill);
  }
  const dateCv = cvs.filter((v) => v.type === 'date' && v.date)
    .sort((a, b) => (DATE_HINT_RE.test(b.column?.title) ? 1 : 0) - (DATE_HINT_RE.test(a.column?.title) ? 1 : 0))[0];
  if (dateCv) {
    const f = formatDate(dateCv.date);
    const d = el('span', `chip ${f.cls}`, `${dateCv.column?.title || 'Prazo'}: ${f.text}`);
    chips.append(d);
  }
  head.append(chips);

  // --- responsáveis + atribuir/remover
  if (peopleCols.length) {
    const people = peopleMap();
    const { mine } = classifyPeople(people, it.meId);
    const names = peopleCols
      .map((c) => cvs.find((v) => v.id === c.id)?.text)
      .filter((t) => t && t.trim())
      .join(', ');

    const row = el('div', 'people-row');
    const who = el('span', names ? 'people-names' : 'people-names none', names || 'Sem responsável');
    who.prepend(icon('user'));
    who.firstChild.className = 'ico small';
    const btn = el('button', 'btn-small');
    btn.append(icon(mine ? 'userMinus' : 'userPlus'), el('span', null, mine ? 'Remover de mim' : 'Atribuir a mim'));
    btn.addEventListener('click', () => toggleAssign(btn, mine));
    row.append(who, btn);
    head.append(row);
  }

  main.append(head);

  // --- briefing
  const withText = cvs.filter((v) => v.text && v.text.trim());
  let brief = withText.filter((v) => BRIEF_RE.test(v.column?.title || ''));
  if (!brief.length) brief = withText.filter((v) => v.type === 'long_text');

  const sBrief = section('Briefing');
  if (brief.length) {
    for (const b of brief) {
      if (brief.length > 1 || !BRIEF_RE.test(b.column?.title || '')) sBrief.append(el('h3', null, b.column?.title || ''));
      sBrief.append(el('div', 'brief selectable', b.text));
    }
  } else {
    sBrief.append(el('p', 'muted', 'Nenhuma coluna de briefing ou texto longo preenchida neste item.'));
  }
  main.append(sBrief);

  // --- demais colunas (recolhido)
  const shown = new Set([primary?.id, dateCv?.id, ...brief.map((b) => b.id), ...peopleCols.map((c) => c.id)]);
  const others = withText.filter((v) => !shown.has(v.id) && v.type !== 'name');
  if (others.length) {
    const det = el('details', 'cols');
    det.append(el('summary', null, `Outras colunas (${others.length})`));
    const dl = el('dl');
    for (const v of others) {
      dl.append(el('dt', null, v.column?.title || v.id), el('dd', 'selectable', v.text));
    }
    det.append(dl);
    main.append(det);
  }

  // --- atualizações
  const updates = it.updates || [];
  const sUpd = section('Atualizações', updates.length);
  if (!updates.length) sUpd.append(el('p', 'muted', 'Nenhuma atualização ainda.'));
  for (const u of updates) sUpd.append(renderUpdate(u));
  main.append(sUpd);

  const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#footer').textContent = `Carregado às ${now}`;
}

function renderUpdate(u, isReply = false) {
  const card = el('article', isReply ? 'update reply' : 'update');
  const top = el('div', 'u-head');
  top.append(avatar(u.creator), el('span', 'u-name', u.creator?.name || 'Alguém'));
  const when = el('span', 'u-time', timeAgo(u.created_at));
  when.title = new Date(u.created_at).toLocaleString('pt-BR');
  top.append(when);

  const body = el('div', 'u-body selectable');
  body.append(sanitize(u.body));

  card.append(top, body);

  if (u.assets?.length) {
    const files = el('div', 'assets');
    for (const a of u.assets) {
      const ext = (a.file_extension || '').replace('.', '').toLowerCase();
      if (/^(png|jpe?g|gif|webp)$/.test(ext) && a.public_url) {
        const img = el('img', 'thumb');
        img.src = a.public_url;
        img.alt = a.name;
        img.title = a.name;
        img.addEventListener('click', () => openUrl(a.public_url));
        img.addEventListener('error', () => img.remove());
        files.append(img);
      } else {
        const link = el('a', 'file', `📎 ${a.name}`);
        link.href = '#';
        link.dataset.href = a.public_url;
        files.append(link);
      }
    }
    card.append(files);
  }

  for (const r of u.replies || []) card.append(renderUpdate(r, true));
  return card;
}

function renderError(err) {
  const main = $('#content');
  main.replaceChildren(el('div', 'banner', `⚠ ${err}`));
  $('#footer').textContent = '';
}

// ---------------------------------------------------------------- ações

async function load(id) {
  if (id) itemId = String(id);
  const seq = ++loadSeq;
  $('#btn-reload').classList.add('spin');
  if (!item || item.id !== itemId) $('#content').replaceChildren(el('div', 'empty', 'Carregando…'));
  try {
    const it = await fetchItem(itemId);
    if (seq !== loadSeq) return; // outro item foi aberto enquanto carregava
    item = it;
    render();
    $('#content').scrollTop = 0;
  } catch (err) {
    if (seq === loadSeq) renderError(err);
  } finally {
    if (seq === loadSeq) $('#btn-reload').classList.remove('spin');
  }
}

async function updateStatus(columnId, opt) {
  try {
    const res = await changeStatus(item.board.id, item.id, columnId, opt.label);
    const cv = item.column_values.find((v) => v.id === columnId);
    if (cv) {
      cv.text = res.status;
      cv.label_style = { color: res.color || opt.color };
    }
    render();
    toast(`Status: ${res.status}`);
    emitTo('main', 'item-changed', { id: item.id, status: res.status, color: res.color || opt.color }).catch(() => {});
  } catch (err) {
    toast(`Não foi possível alterar: ${err}`, true);
  }
}

function peopleMap() {
  const map = {};
  for (const c of (item.board.columns || []).filter((col) => col.type === 'people')) {
    map[c.id] = normPersons(item.column_values.find((v) => v.id === c.id)?.persons_and_teams);
  }
  return map;
}

async function toggleAssign(btn, wasMine) {
  btn.disabled = true;
  try {
    const people = peopleMap();
    const mainCol = (item.board.columns || []).filter((c) => c.type === 'people').sort(byHint(PEOPLE_HINT_RE))[0].id;
    const res = wasMine
      ? await unassignMe(item.board.id, item.id, people, item.meId)
      : await assignMe(item.board.id, item.id, people, mainCol, item.meId);

    for (const [col, persons] of Object.entries(res.people)) {
      const cv = item.column_values.find((v) => v.id === col);
      if (!cv) continue;
      cv.persons_and_teams = persons;
      if (col in res.texts) cv.text = res.texts[col];
    }
    render();
    const { unassigned } = classifyPeople(res.people, item.meId);
    toast(wasMine ? (unassigned ? 'Removido de você — agora sem responsável' : 'Removido de você') : 'Atribuído a você');
    emitTo('main', 'item-changed', { id: item.id, people: res.people }).catch(() => {});
  } catch (err) {
    btn.disabled = false;
    toast(`Não foi possível alterar: ${err}`, true);
  }
}

// links dentro das atualizações abrem no navegador padrão
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (!a) return;
  e.preventDefault();
  openUrl(a.dataset.href);
});

$('#btn-close').addEventListener('click', () => appWindow.close());
$('#btn-reload').addEventListener('click', () => load());
$('#btn-open').addEventListener('click', () => item && openUrl(item.url));
$('#btn-copy').addEventListener('click', async () => {
  if (!item) return;
  await copyText(item.url);
  toast('Link copiado');
});
$('#grip').addEventListener('mousedown', (e) => {
  e.preventDefault();
  appWindow.startResizeDragging('SouthEast');
});
$('#content').addEventListener('scroll', closePicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('.picker')) appWindow.close();
});

listen('load-item', ({ payload }) => load(payload));

load();
