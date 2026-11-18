// Janela principal: lista "Meus itens". Depende de common.js.
const { listen } = TAURI.event;

// localStorage só para preferências e cache da lista (o token NÃO fica aqui)
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento */ }
  },
};

const BOARDS_PER_REQUEST = 4;

let settings = { interval: 5, showDone: false, showUnassigned: false, onTop: false, ...store.get('settings', {}) };
let cache = store.get('cache', null); // { me, items, labels, at }
let timer = null;
let loading = false;
let lastError = null;

// ---------------------------------------------------------------- monday API

/** Filtro de quadros conforme a área de trabalho/quadros escolhidos nas configurações. */
function boardScope() {
  const ws = settings.workspaceId;
  if (!ws || !isId(ws)) return 'limit: 100, state: active, order_by: used_at'; // tudo (lento)
  const ids = (settings.boardIds || []).filter(isId);
  if (ids.length) return `ids: [${ids.join(', ')}], limit: 100`;
  return `workspace_ids: [${ws}], limit: 100, state: active`;
}

async function fetchMyItems(onPartial) {
  const base = await withSettings((f) => `query {
    me { id name }
    boards(${boardScope()}) {
      id name type
      columns(types: [people, status, date]) { id title type ${f} }
    }
  }`);

  const meId = base.me.id;
  const labels = {};
  const boards = (base.boards || []).filter(
    (b) => b.type !== 'document' && b.columns.some((c) => c.type === 'people'),
  );

  for (const b of boards) prepareBoard(b, labels);

  // 1ª etapa: atribuídos a mim (rápido; já mostra na tela)
  const mine = await queryItems(boards, meId, 'mine', labels);
  const result = { me: base.me.name, meId: String(meId), items: mine, labels, at: Date.now() };

  // 2ª etapa: sem responsável, nos mesmos quadros
  if (settings.showUnassigned) {
    onPartial?.(result);
    const free = await queryItems(boards, meId, 'unassigned', labels);
    const seen = new Set(mine.map((i) => i.id));
    result.items = mine.concat(free.filter((i) => !seen.has(i.id)));
    result.at = Date.now();
  }
  return result;
}

function prepareBoard(b, labels) {
  const statusCols = b.columns.filter((c) => c.type === 'status').sort(byHint(STATUS_HINT_RE));
  const dateCols = b.columns.filter((c) => c.type === 'date').sort(byHint(DATE_HINT_RE));
  const people = b.columns.filter((c) => c.type === 'people').sort(byHint(PEOPLE_HINT_RE));
  b._statusCols = statusCols.map((c) => c.id);
  b._statusHinted = statusCols.length > 0 && STATUS_HINT_RE.test(statusCols[0].title);
  b._dateCols = dateCols.map((c) => c.id);
  b._peopleCols = people.map((c) => c.id);
  for (const c of statusCols) labels[`${b.id}:${c.id}`] = parseLabels(c.settings_str ?? c.settings);
}

/** mode "mine" = atribuídos a mim; "unassigned" = todas as colunas de pessoas vazias */
async function queryItems(boards, meId, mode, labels) {
  const items = [];
  for (let i = 0; i < boards.length; i += BOARDS_PER_REQUEST) {
    const chunk = boards.slice(i, i + BOARDS_PER_REQUEST);

    const parts = chunk.map((b, idx) => {
      const rules = b._peopleCols
        .map((pid) => (mode === 'mine'
          ? `{column_id: ${gstr(pid)}, compare_value: [${gstr('person-' + meId)}], operator: any_of}`
          : `{column_id: ${gstr(pid)}, compare_value: [], operator: is_empty}`))
        .join(', ');
      // "mine": basta uma coluna me conter (or); "unassigned": todas vazias (and)
      const op = mode === 'mine' ? 'or' : 'and';
      const ids = [...b._statusCols, ...b._dateCols, ...b._peopleCols];
      const cols = `column_values(ids: [${ids.map(gstr).join(', ')}]) {
             id text
             ... on StatusValue { label_style { color } }
             ... on DateValue { date }
             ... on PeopleValue { persons_and_teams { id kind } }
           }`;

      return `b${idx}: boards(ids: [${b.id}]) {
        items_page(limit: 100, query_params: { operator: ${op}, rules: [${rules}] }) {
          items { id name url ${cols} }
        }
      }`;
    });

    const data = await gql(`query { ${parts.join('\n')} }`);

    chunk.forEach((b, idx) => {
      const page = data[`b${idx}`]?.[0]?.items_page;
      for (const it of page?.items || []) {
        const byId = Object.fromEntries((it.column_values || []).map((c) => [c.id, c]));
        // coluna "Status" (pelo nome) tem prioridade; senão, a primeira que tiver valor
        const stId = b._statusHinted
          ? b._statusCols[0]
          : b._statusCols.find((id) => byId[id]?.text) || b._statusCols[0] || null;
        const dtId = b._dateCols.find((id) => byId[id]?.date);
        const st = stId ? byId[stId] : null;
        const status = st?.text || '';

        const peopleMap = {};
        for (const pid of b._peopleCols) peopleMap[pid] = normPersons(byId[pid]?.persons_and_teams);
        const cls = classifyPeople(peopleMap, meId);
        if (mode === 'mine' ? !cls.mine : !cls.unassigned) continue;

        items.push({
          id: it.id,
          name: it.name,
          url: it.url,
          boardId: b.id,
          board: b.name.replace(/^Subitems of /i, '↳ '),
          statusCol: stId,
          status,
          color: st?.label_style?.color || null,
          date: dtId ? byId[dtId].date : null,
          done: isDoneStatus(labels[`${b.id}:${stId}`], status),
          people: peopleMap,
          peopleCol: b._peopleCols[0],
          mine: cls.mine,
          unassigned: cls.unassigned,
        });
      }
    });
  }
  return items;
}

const isVisible = (i) =>
  (settings.showDone || !i.done) && (i.mine !== false || (settings.showUnassigned && i.unassigned));

// ---------------------------------------------------------------- render

function sortItems(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (!a.date && !b.date) return a.name.localeCompare(b.name, 'pt-BR');
  if (!a.date) return 1;
  if (!b.date) return -1;
  return a.date.localeCompare(b.date);
}

function render() {
  const list = $('#items');
  const empty = $('#empty');
  const banner = $('#banner');
  closePicker();
  list.replaceChildren();

  banner.hidden = !lastError;
  banner.textContent = lastError ? `⚠ ${lastError}` : '';

  if (!cache) {
    empty.hidden = false;
    empty.textContent = loading ? 'Carregando seus itens…' : 'Nenhum dado ainda.';
    $('#count').textContent = '';
    return;
  }

  const visible = cache.items.filter(isVisible).sort(sortItems);
  $('#count').textContent = String(visible.length);

  empty.hidden = visible.length > 0;
  empty.textContent = settings.showUnassigned
    ? 'Nada atribuído a você nem sem responsável. 🎉'
    : 'Nada atribuído a você por aqui. 🎉';

  const mine = visible.filter((i) => i.mine !== false);
  const free = visible.filter((i) => i.mine === false);
  const withHeaders = settings.showUnassigned && free.length > 0;

  if (withHeaders && mine.length) list.append(sectionHeader('Atribuídos a mim', mine.length));
  for (const item of mine) list.append(renderItem(item));
  if (withHeaders) list.append(sectionHeader('Sem responsável', free.length));
  for (const item of free) list.append(renderItem(item));
}

function sectionHeader(text, n) {
  const li = el('li', 'section-title', text);
  li.append(el('span', 'count', String(n)));
  return li;
}

function renderItem(item) {
  const li = el('li', item.done ? 'done' : '');
  li.title = `${item.name}\n${item.board}\n\nClique para ver briefing e atualizações`;

  const bar = el('span', 'bar');
  if (item.color) { bar.style.background = item.color; bar.style.opacity = 1; }

  const name = el('span', 'name', item.name);

  const date = el('span', 'date');
  if (item.date) {
    const f = formatDate(item.date);
    date.textContent = f.text;
    if (f.cls && !item.done) date.classList.add(f.cls);
  }

  const meta = el('span', 'meta');
  const labels = cache.labels?.[`${item.boardId}:${item.statusCol}`] || [];
  if (item.statusCol) {
    const pill = el('button', 'pill', item.status || 'Definir status');
    pill.style.background = item.color || 'var(--muted)';
    if (!item.status) pill.classList.add('empty-pill');
    pill.title = labels.length ? 'Alterar status' : 'Status';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!labels.length) { toast('Não encontrei as opções de status deste quadro', true); return; }
      showStatusPicker(pill, labels, item.status, (opt) => updateStatus(item, opt));
    });
    meta.append(pill);
  }
  meta.append(el('span', 'board', item.board));

  const actions = el('span', 'row-actions');

  if (item.peopleCol && cache.meId) {
    const mineNow = item.mine !== false;
    const assign = el('button', 'icon-btn');
    assign.title = mineNow ? 'Remover de mim' : 'Atribuir a mim';
    assign.append(icon(mineNow ? 'userMinus' : 'userPlus'));
    assign.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAssign(item, assign);
    });
    actions.append(assign);
  }

  const copy = el('button', 'icon-btn copy');
  copy.title = 'Copiar link da tarefa';
  copy.append(icon('copy'));
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    await copyText(item.url);
    copy.replaceChildren(icon('check'));
    copy.classList.add('ok');
    toast('Link copiado');
    setTimeout(() => { copy.replaceChildren(icon('copy')); copy.classList.remove('ok'); }, 1500);
  });

  actions.append(copy);
  li.append(bar, name, date, meta, actions);
  li.addEventListener('click', () => {
    invoke('open_detail', { itemId: item.id }).catch((err) => toast(String(err), true));
  });
  return li;
}

async function updateStatus(item, opt) {
  const prev = { status: item.status, color: item.color, done: item.done };
  const labels = cache.labels?.[`${item.boardId}:${item.statusCol}`];
  // atualização otimista: muda na hora e desfaz se der erro
  Object.assign(item, { status: opt.label, color: opt.color || item.color, done: isDoneStatus(labels, opt.label) });
  render();
  try {
    const res = await changeStatus(item.boardId, item.id, item.statusCol, opt.label);
    Object.assign(item, { status: res.status, color: res.color || item.color, done: isDoneStatus(labels, res.status) });
    store.set('cache', cache);
    render();
    toast(`Status: ${res.status}`);
  } catch (err) {
    Object.assign(item, prev);
    render();
    toast(`Não foi possível alterar: ${err}`, true);
  }
}

function applyPeople(item, people) {
  item.people = people;
  const c = classifyPeople(people, cache.meId);
  item.mine = c.mine;
  item.unassigned = c.unassigned;
}

async function toggleAssign(item, btn) {
  const wasMine = item.mine !== false;
  btn.disabled = true;
  try {
    // itens de um cache antigo podem não ter o mapa de pessoas
    if (!item.people) throw new Error('Atualize a lista e tente de novo');
    const res = wasMine
      ? await unassignMe(item.boardId, item.id, item.people, cache.meId)
      : await assignMe(item.boardId, item.id, item.people, item.peopleCol, cache.meId);
    applyPeople(item, res.people);
    store.set('cache', cache);
    render();
    if (wasMine) {
      toast(item.unassigned ? 'Removido de você — agora sem responsável' : 'Removido de você');
    } else {
      toast('Atribuído a você');
    }
  } catch (err) {
    btn.disabled = false;
    toast(`Não foi possível alterar: ${err}`, true);
  }
}

function setFooter() {
  const s = $('#status');
  if (loading) { s.textContent = 'Atualizando…'; return; }
  if (!cache) { s.textContent = ''; return; }
  const t = new Date(cache.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  s.textContent = `Atualizado às ${t}`;
}

// ---------------------------------------------------------------- ações

let refreshQueued = false;

async function refresh() {
  if (loading) { refreshQueued = true; return; } // roda de novo assim que a atual terminar
  loading = true;
  $('#btn-refresh').classList.add('spin');
  setFooter();
  if (!cache) render();
  try {
    cache = await fetchMyItems((partial) => {
      // 1ª etapa pronta: mostra as minhas já, mantendo as "sem responsável" anteriores até chegar a 2ª
      const prevFree = (cache?.items || []).filter((i) => i.mine === false);
      const seen = new Set(partial.items.map((i) => i.id));
      cache = { ...partial, items: partial.items.concat(prevFree.filter((i) => !seen.has(i.id))) };
      render();
    });
    store.set('cache', cache);
    lastError = null;
  } catch (err) {
    lastError = String(err);
  } finally {
    loading = false;
    $('#btn-refresh').classList.remove('spin');
    render();
    setFooter();
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refresh(); // oculto = não gasta rede nem CPU
  }, settings.interval * 60 * 1000);
}

// Modo "fixo na área de trabalho": fica na frente enquanto em foco e
// volta para o fundo quando o usuário clica em outra janela.
async function applyPin() {
  $('#btn-pin').classList.toggle('on', settings.onTop);
  try {
    if (settings.onTop) {
      await appWindow.setAlwaysOnBottom(false);
      await appWindow.setAlwaysOnTop(true);
    } else {
      await appWindow.setAlwaysOnTop(false); // vai para o fundo no próximo "blur"
    }
  } catch (e) { console.error(e); }
}

appWindow.onFocusChanged(({ payload: focused }) => {
  if (!focused) closePicker();
  if (settings.onTop) return;
  appWindow.setAlwaysOnBottom(!focused).catch(console.error);
});

// ---------------------------------------------------------------- configurações

async function showSettings(message) {
  $('#view-list').hidden = true;
  $('#view-settings').hidden = false;
  $('#title').textContent = 'Configurações';
  $('#count').textContent = '';
  $('#token').value = '';
  const hasToken = await invoke('has_token');
  $('#token').placeholder = hasToken ? '•••••••• (salvo; cole outro para trocar)' : 'Cole aqui o token pessoal';
  $('#btn-cancel').hidden = !hasToken;
  $('#btn-clear').hidden = !hasToken;
  $('#interval').value = String(settings.interval);
  $('#show-done').checked = settings.showDone;
  $('#show-unassigned').checked = settings.showUnassigned;
  loadWorkspaces();
  try { $('#autostart').checked = await invoke('plugin:autostart|is_enabled'); } catch { /* ignora */ }
  setMsg(message || '');
}

function showList() {
  $('#view-settings').hidden = true;
  $('#view-list').hidden = false;
  $('#title').textContent = 'Meus itens';
  render();
}

// ---- área de trabalho + quadros
let workspacesLoaded = false;
let boardLoadSeq = 0;

async function loadWorkspaces() {
  const sel = $('#workspace');
  if (!workspacesLoaded) {
    try {
      const d = await gql('query { workspaces(limit: 200) { id name } }');
      const list = (d.workspaces || []).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      sel.replaceChildren(new Option('Todas as áreas (mais lento)', ''), ...list.map((w) => new Option(w.name, w.id)));
      workspacesLoaded = true;
    } catch (e) {
      setMsg(`Não foi possível carregar as áreas de trabalho: ${e}`, true);
    }
  }
  sel.value = settings.workspaceId || '';
  if (sel.value !== (settings.workspaceId || '')) sel.value = ''; // área não existe mais
  await loadBoards(sel.value, settings.boardIds || []);
}

async function loadBoards(wsId, selectedIds) {
  const picker = $('#board-picker');
  const list = $('#board-list');
  $('#board-filter').value = '';
  picker.hidden = !wsId;
  if (!wsId || !isId(wsId)) return;

  const seq = ++boardLoadSeq;
  list.replaceChildren(el('p', 'muted', 'Carregando quadros…'));
  try {
    const d = await gql(`query { boards(workspace_ids: [${wsId}], state: active, limit: 200) { id name type } }`);
    if (seq !== boardLoadSeq) return; // trocou de área enquanto carregava
    const selected = new Set(selectedIds.map(String));
    // só quadros de verdade (sem documentos, dashboards e subelementos)
    const boards = (d.boards || [])
      .filter((b) => b.type === 'board')
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    list.replaceChildren();
    if (!boards.length) list.append(el('p', 'muted', 'Nenhum quadro nesta área.'));
    for (const b of boards) {
      const row = el('label', 'check bp-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = b.id;
      cb.checked = selected.has(String(b.id));
      row.append(cb, el('span', 'bp-name', b.name));
      row.dataset.name = b.name.toLowerCase();
      list.append(row);
    }
  } catch (e) {
    if (seq === boardLoadSeq) list.replaceChildren(el('p', 'muted', `Erro ao carregar quadros: ${e}`));
  }
}

$('#workspace').addEventListener('change', (e) => loadBoards(e.target.value, []));
$('#board-filter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const row of $('#board-list').querySelectorAll('.bp-row')) row.hidden = q && !row.dataset.name.includes(q);
});
$('#bp-all').addEventListener('click', () => {
  for (const cb of $('#board-list').querySelectorAll('.bp-row:not([hidden]) input')) cb.checked = true;
});
$('#bp-none').addEventListener('click', () => {
  for (const cb of $('#board-list').querySelectorAll('input')) cb.checked = false;
});

function setMsg(text, isErr = false) {
  const m = $('#settings-msg');
  m.textContent = text;
  m.classList.toggle('err', isErr);
}

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const token = $('#token').value.trim();
  const tokenChanged = token.length > 0;

  try {
    if (tokenChanged) {
      await invoke('save_token', { token });
      setMsg('Testando token…');
      const me = await gql('query { me { name } }');
      setMsg(`Conectado como ${me.me.name}`);
    } else if (!(await invoke('has_token'))) {
      setMsg('Cole o token para continuar.', true);
      return;
    }

    settings.interval = Number($('#interval').value);
    settings.showDone = $('#show-done').checked;
    const unassignedChanged = settings.showUnassigned !== $('#show-unassigned').checked;
    settings.showUnassigned = $('#show-unassigned').checked;
    const scopeBefore = boardScope();
    const ws = $('#workspace').value;
    settings.workspaceId = ws || null;
    settings.boardIds = ws ? [...$('#board-list').querySelectorAll('input:checked')].map((cb) => cb.value) : [];
    const scopeChanged = boardScope() !== scopeBefore;
    store.set('settings', settings);

    const wantAuto = $('#autostart').checked;
    try {
      const isAuto = await invoke('plugin:autostart|is_enabled');
      if (wantAuto !== isAuto) await invoke(wantAuto ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
    } catch (e) { console.error(e); }

    schedule();
    showList();
    // ligar "sem responsável" exige buscar itens que não vieram antes
    if (scopeChanged) {
      // escopo novo: descarta a lista antiga em vez de mostrar itens de quadros fora da seleção
      cache = null;
      store.set('cache', null);
      render();
    }
    if (tokenChanged || !cache || scopeChanged || (unassignedChanged && settings.showUnassigned)) refresh();
  } catch (err) {
    setMsg(String(err), true);
    if (tokenChanged) await invoke('clear_token').catch(() => {});
  }
});

$('#btn-cancel').addEventListener('click', showList);

$('#btn-clear').addEventListener('click', async () => {
  await invoke('clear_token');
  cache = null;
  store.set('cache', null);
  showSettings('Token removido.');
});

// ---------------------------------------------------------------- janela

$('#btn-refresh').addEventListener('click', refresh);
$('#btn-settings').addEventListener('click', () => {
  if ($('#view-settings').hidden) showSettings(); else showList();
});
$('#btn-hide').addEventListener('click', () => appWindow.hide());
$('#btn-pin').addEventListener('click', () => {
  settings.onTop = !settings.onTop;
  store.set('settings', settings);
  applyPin();
});
$('#grip').addEventListener('mousedown', (e) => {
  e.preventDefault();
  appWindow.startResizeDragging('SouthEast');
});
$('#items').addEventListener('scroll', closePicker, true);
$('#view-list').addEventListener('scroll', closePicker);

document.addEventListener('visibilitychange', () => {
  // voltou a aparecer depois de muito tempo oculto → atualiza
  if (!document.hidden && cache && Date.now() - cache.at > settings.interval * 60 * 1000) refresh();
});

listen('refresh', refresh);

// status alterado na janela de detalhes → reflete na lista
listen('item-changed', ({ payload }) => {
  const item = cache?.items.find((i) => i.id === payload.id);
  if (!item) return;
  if (payload.status != null) {
    const labels = cache.labels?.[`${item.boardId}:${item.statusCol}`];
    Object.assign(item, { status: payload.status, color: payload.color || item.color, done: isDoneStatus(labels, payload.status) });
  }
  if (payload.people) applyPeople(item, payload.people);
  store.set('cache', cache);
  render();
});

// ---------------------------------------------------------------- início

(async function init() {
  applyPin();
  render();
  setFooter();
  if (!(await invoke('has_token'))) {
    showSettings('Configure o token para começar.');
    return;
  }
  schedule();
  refresh();
})();
