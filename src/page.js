/**
 * The page: controls, the figures, two charts and the grid, all over one
 * Parquet file read by DuckDB-Wasm.
 *
 *   the grid         `duckdbAdapter` + `createPushdownSource`: filter, sort,
 *                    quick search and paging are SQL in DuckDB.
 *   the trend chart  `createChart` bound to the grid, `aggregate: 'engine'`:
 *                    one `GROUP BY hour` over everything the grid's filter keeps.
 *   the figures      `source.aggregate()` over the same filter.
 *   top pages        one ranking query over the scope the controls describe.
 *   the histograms   the grid's own header strips, fed by `source.aggregate()`.
 *
 * Nothing is reduced from the rows on screen: the grid holds one window of a
 * file of tens of millions of rows, and a figure computed from it would be a
 * figure about the window.
 */

import { dataUrl } from './config.js';
import {
  ACCESS, WINDOWS, DEFAULT_WINDOW, MODES, WEEK_START_MS, WEEK_END_MS, SPIKE_DEFAULT_PROJECT, SPIKE_MIN_VIEWS, TOP_PAGES,
  BASE_FIELDS, SPIKE_FIELDS, fromFile, spikeFrom, columns, fmt, num,
} from './data.js';

const HOUR = 3600 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A group of single-choice buttons. `onPick(id)` fires on a real click. */
function chips(label, options, onPick) {
  const wrap = el('div', 'field');
  wrap.append(el('span', 'field-label', label));
  const row = el('div', 'chips');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  const buttons = new Map();
  for (const option of options) {
    const button = el('button', 'chip', option.label);
    button.type = 'button';
    button.dataset.id = option.id;
    button.addEventListener('click', () => onPick(option.id));
    buttons.set(option.id, button);
    row.append(button);
  }
  wrap.append(row);
  const select = (id) => {
    for (const [key, button] of buttons) {
      button.classList.toggle('on', key === id);
      button.setAttribute('aria-pressed', String(key === id));
    }
  };
  return { wrap, select };
}

const isoHour = (ms) => new Date(ms).toISOString().slice(0, 16);

export function buildPage({ host, LG, createChart, connection, sqlLog, duckdbVersion }) {
  const FILE = dataUrl();

  const built = {
    isReady: false,
    isSettled: false,
    error: null,
    grid: null,
    source: null,
    adapter: null,
    chart: null,
    topChart: null,
    topGrid: null,
    state: { window: DEFAULT_WINDOW.id, from: DEFAULT_WINDOW.from, to: DEFAULT_WINDOW.to, project: '', access: '', quick: '', mode: 'rows' },
    mode: 'rows',
    matchCount: null,
    totalRows: null,
    plan: null,
    pagePlan: null,
    scope: { rows: null, views: null },
    topRows: [],
    timings: { page: null, scope: null, top: null },
    projects: [],
    duckdbVersion,
    file: FILE,
  };
  const state = built.state;

  /* ---------------------------------------------------------------- theme */

  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  if (!root.dataset.theme) root.dataset.theme = dark.matches ? 'dark' : 'light';
  const themeButton = el('button', 'theme-toggle');
  themeButton.type = 'button';
  const paintTheme = () => {
    const now = root.dataset.theme;
    themeButton.textContent = now === 'dark' ? 'Light theme' : 'Dark theme';
    themeButton.setAttribute('aria-pressed', String(now === 'dark'));
  };
  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    paintTheme();
  });
  paintTheme();
  document.querySelector('.masthead')?.append(themeButton);

  /* ---------------------------------------------------------------- frame */

  host.textContent = '';
  const controls = el('section', 'controls');
  controls.setAttribute('aria-label', 'Choose what to look at');
  const tiles = el('section', 'tiles');
  tiles.setAttribute('aria-label', 'Figures for the current selection');
  const chartRow = el('section', 'charts');
  chartRow.setAttribute('aria-label', 'Charts for the current selection');
  const gridSection = el('section', 'grid-section');
  const gridHost = el('div', 'grid-host');
  gridHost.setAttribute('aria-label', 'Hourly pageviews');
  const planSection = el('details', 'plan');
  host.append(controls, tiles, chartRow, gridSection, planSection);

  /* ------------------------------------------------------------- controls */

  const windowChips = chips('Time window (UTC)', WINDOWS, (id) => pickWindow(id));
  const customWindow = el('div', 'field');
  customWindow.append(el('span', 'field-label', 'Custom range'));
  const range = el('div', 'range');
  const fromInput = el('input'); fromInput.type = 'datetime-local';
  const toInput = el('input'); toInput.type = 'datetime-local';
  for (const [input, name] of [[fromInput, 'From'], [toInput, 'To']]) {
    input.setAttribute('aria-label', `${name}, UTC`);
    input.min = isoHour(WEEK_START_MS);
    input.max = isoHour(WEEK_END_MS);
    input.step = 3600;
    input.addEventListener('change', () => pickCustom());
  }
  range.append(fromInput, el('span', 'range-to', 'to'), toInput);
  customWindow.append(range);

  const projectField = el('label', 'field');
  projectField.append(el('span', 'field-label', 'Project'));
  const projectSelect = el('select');
  projectSelect.append(new Option('All projects', ''));
  projectSelect.addEventListener('change', () => { state.project = projectSelect.value; applyScope(); });
  projectField.append(projectSelect);

  const accessChips = chips('Access method', [{ id: '', label: 'All' }, ...ACCESS], (id) => { state.access = id; applyScope(); });

  const searchField = el('label', 'field');
  searchField.append(el('span', 'field-label', 'Search page titles'));
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'e.g. Taylor_Swift';
  search.autocomplete = 'off';
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.quick = search.value.trim(); applyScope(); }, 350);
  });
  searchField.append(search);

  const modeChips = chips('Grid view', MODES, (id) => setMode(id));
  const modeNote = el('p', 'mode-note');
  modeNote.dataset.modeNote = '';

  const rowA = el('div', 'controls-row');
  rowA.append(windowChips.wrap, customWindow);
  const rowB = el('div', 'controls-row');
  rowB.append(projectField, accessChips.wrap, searchField);
  const rowC = el('div', 'controls-row');
  rowC.append(modeChips.wrap, modeNote);
  controls.append(rowA, rowB, rowC);

  /* ---------------------------------------------------------------- tiles */

  const tileValues = {};
  const makeTile = (id, label, hint) => {
    const tile = el('div', 'tile');
    tile.dataset.tile = id;
    const value = el('div', 'tile-value', '—');
    tile.append(el('div', 'tile-label', label), value, el('div', 'tile-hint', hint));
    tileValues[id] = value;
    tiles.append(tile);
  };
  makeTile('rows', 'Hourly rows matching', 'counted by DuckDB');
  makeTile('views', 'Views in the selection', 'summed over every matching row');
  makeTile('page', 'Last page of rows', 'one window of the grid');
  makeTile('scope', 'Figures and charts', 'whole-selection queries');

  const paintTiles = () => {
    tileValues.rows.textContent = fmt.int(built.matchCount);
    tileValues.views.textContent = fmt.int(built.scope.views);
    tileValues.page.textContent = fmt.ms(built.timings.page);
    tileValues.scope.textContent = fmt.ms(built.timings.scope);
  };

  /* --------------------------------------------------------------- charts */

  const trendBox = el('div', 'chart-box trend');
  trendBox.dataset.chart = 'trend';
  const topBox = el('div', 'chart-box top');
  topBox.dataset.chart = 'top';
  chartRow.append(trendBox, topBox);

  /* ------------------------------------------------------------ the filter */

  /** The grid's filter, from the controls. Header filters the visitor adds replace it, and vice versa. */
  function scopeTree() {
    const conditions = [];
    const full = state.from <= WEEK_START_MS && state.to >= WEEK_END_MS;
    if (!full) {
      conditions.push({ col: 'hour', op: 'gte', value: new Date(state.from).toISOString() });
      conditions.push({ col: 'hour', op: 'lt', value: new Date(state.to).toISOString() });
    }
    if (state.project) conditions.push({ col: 'project', op: 'eq', value: state.project });
    if (state.access) conditions.push({ col: 'access', op: 'eq', value: state.access });
    if (state.mode === 'spikes') conditions.push({ col: 'views', op: 'gte', value: SPIKE_MIN_VIEWS });
    if (conditions.length === 0) return null;
    return conditions.length === 1 ? conditions[0] : { op: 'and', conditions };
  }

  function paintControls() {
    windowChips.select(state.window);
    accessChips.select(state.access);
    modeChips.select(state.mode);
    fromInput.value = isoHour(state.from);
    toInput.value = isoHour(state.to - HOUR);
    projectSelect.value = state.project;
    modeNote.textContent = {
      rows: 'Every hourly row in the selection: sort any column, filter from its header, or click a bar in a histogram.',
      spikes: `One project at a time. A window function compares each hour with the 24 before it; hours under ${SPIKE_MIN_VIEWS} views are left out.`,
    }[state.mode];
  }

  function pickWindow(id) {
    const preset = WINDOWS.find((w) => w.id === id);
    if (!preset) return;
    state.window = id;
    state.from = preset.from;
    state.to = preset.to;
    applyScope();
  }

  function pickCustom() {
    const from = Date.parse(`${fromInput.value}:00Z`);
    const to = Date.parse(`${toInput.value}:00Z`) + HOUR;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { paintControls(); return; }
    state.window = 'custom';
    state.from = Math.max(from, WEEK_START_MS);
    state.to = Math.min(to, WEEK_END_MS);
    applyScope();
  }

  function applyScope() {
    paintControls();
    if (state.mode === 'spikes') {
      /* The window function reads the selected hours and the 24 before them, so a new window is a new source. */
      mountGrid();
    } else {
      built.grid?.filters.set(scopeTree());
      built.grid?.filters.quick(state.quick);
    }
    void refreshTop();
  }

  /* ---------------------------------------------------------- the grid */

  /** Resolves once the first figures and charts are in, so the histograms queue behind them. */
  let openFacets;
  const facetGate = new Promise((ok) => { openFacets = ok; });

  const request = (filters, groupBy) => ({ filters, sort: [], range: null, groupBy, quick: '' });
  const realGroups = (groups) => (groups ?? []).filter((g) => !g.grouping?.[0]);

  /**
   * The header histograms. The grid asks for one answer per column per
   * filter change; each is one `GROUP BY` through the same source, with the
   * column's own filter already removed by the grid. Bar edges are fixed from
   * the first answer so the bars do not move under the pointer.
   */
  function facetProvider(getSource) {
    const first = new Map();
    return async (req) => {
      await facetGate;
      const source = getSource();
      const agg = await source.aggregate(request(req.filters, [req.colId]), [{ id: 'n', col: 'views', fn: 'count' }]);
      const groups = realGroups(agg.groups).map((g) => ({ key: g.keys[0], n: num(g.values.n) }));
      let out;
      if (req.colId === 'project' || req.colId === 'access') {
        const edges = first.get(req.colId) ?? groups.slice().sort((a, b) => b.n - a.n).slice(0, req.colId === 'project' ? 10 : 3).map((g) => g.key);
        first.set(req.colId, edges);
        const counts = edges.map((key) => groups.find((g) => g.key === key)?.n ?? 0);
        out = { bounds: { kind: 'category', buckets: edges.map((value) => ({ value })) }, counts, kind: 'category' };
      } else if (req.colId === 'hour') {
        const buckets = Array.from({ length: 7 }, (_, i) => ({ from: WEEK_START_MS + i * 24 * HOUR, to: WEEK_START_MS + (i + 1) * 24 * HOUR }));
        const counts = buckets.map(() => 0);
        for (const g of groups) {
          const i = Math.floor((num(g.key) - WEEK_START_MS) / (24 * HOUR));
          if (i >= 0 && i < 7) counts[i] += g.n;
        }
        out = { bounds: { kind: 'date', granularity: 'day', min: WEEK_START_MS, max: WEEK_END_MS, buckets }, counts, kind: 'date' };
      } else {
        /* views: powers of two, because the distribution spans six orders of magnitude. */
        const buckets = Array.from({ length: 23 }, (_, i) => ({ from: 2 ** i, to: 2 ** (i + 1) }));
        const counts = buckets.map(() => 0);
        for (const g of groups) {
          const v = num(g.key);
          if (v >= 1) counts[Math.min(22, Math.floor(Math.log2(v)))] += g.n;
        }
        out = { bounds: { kind: 'numeric', strategy: 'log', min: 1, max: 2 ** 23, buckets }, counts, kind: 'numeric' };
      }
      if (!first.has(`${req.colId}:all`)) { first.set(`${req.colId}:all`, true); out.unfiltered = out.counts; }
      return out;
    };
  }

  function makeSource(mode, project) {
    const spikes = mode === 'spikes';
    const adapter = LG.duckdbAdapter({
      connection,
      from: spikes ? spikeFrom(FILE, project, state.from, state.to) : fromFile(FILE),
      fields: spikes ? SPIKE_FIELDS : BASE_FIELDS,
      quickColumns: ['page_title'],
    });
    const source = LG.createPushdownSource({
      adapter,
      compute: LG,
      pageSize: 200,
      aggregates: { default: 'engine-if-identical' },
    });
    return { adapter, source };
  }

  let mountSequence = 0;

  function mountGrid() {
    const sequence = ++mountSequence;
    built.chart?.destroy?.();
    built.chart = null;
    built.grid?.destroy?.();
    gridHost.textContent = '';
    trendBox.textContent = '';
    built.matchCount = null;
    built.mode = state.mode;

    const { adapter, source } = makeSource(state.mode, state.project);
    built.adapter = adapter;
    built.source = source;

    const grid = LG.createGrid(gridHost, {
      rowKey: ['project', 'page_title', 'access', 'hour'],
      columns: columns({ mode: state.mode }),
      source,
      timeZone: 'UTC',
      toolPanel: { side: 'right', panels: ['filters', 'columns'] },
      showTotalInHeader: true,
      /* Each histogram is a query; over the window-function source that is the window again, so that view goes without. */
      facets: state.mode === 'spikes' ? false : { enabled: true, collapsed: false, height: 40, provider: facetProvider(() => built.source) },
          });
    built.grid = grid;

    const tree = scopeTree();
    if (tree) grid.filters.set(tree);
    if (state.quick) grid.filters.quick(state.quick);
    if (state.mode === 'spikes') grid.sort.set([{ col: 'spike', dir: 'desc' }]);

    /*
     * The rows query is where the match count comes from: the adapter asks for
     * it in the same dispatch as the page. Wrapping the adapter's own execute
     * is how the page learns the filter changed, whoever changed it.
     */
    const inner = adapter.execute.bind(adapter);
    let lastSignature = null;
    adapter.execute = async (query, req) => {
      const started = performance.now();
      const result = await inner(query, req);
      if (sequence !== mountSequence) return result;
      if (!query.groupBy?.length || !query.groupPath?.length) built.timings.page = Math.round(performance.now() - started);
      if (typeof result.total === 'number' && !query.groupBy?.length) built.matchCount = result.total;
      built.plan = source.lastPlan?.() ?? null;
      if (!query.groupBy?.length) built.pagePlan = built.plan;
      const signature = JSON.stringify([query.filters ?? null, query.quick ?? '']);
      if (signature !== lastSignature) {
        lastSignature = signature;
        void refreshScope(query.filters ?? null, sequence);
      }
      paintTiles();
      renderPlan();
      return result;
    };

    /* The trend chart is a viewer of this grid: its filter, its source. */
    try {
      built.chart = createChart({
        grid,
        container: trendBox,
        type: 'line',
        x: 'hour',
        y: { col: 'views', fn: 'sum' },
        aggregate: 'engine',
        legend: false,
        title: 'Views per hour',
        subtitle: 'Summed by DuckDB over every row the grid is showing a window of',
        axis: { y: 'Views' },
      });
    } catch (error) {
      trendBox.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[pageviews demo] chart', error);
    }
    return grid;
  }

  async function setMode(id) {
    if (id === state.mode && built.grid) return;
    state.mode = id;
    if (id === 'spikes' && !state.project) state.project = SPIKE_DEFAULT_PROJECT;
    if (id === 'spikes' && ![...projectSelect.options].some((o) => o.value === state.project)) {
      projectSelect.append(new Option(state.project, state.project));
    }
    paintControls();
    mountGrid();
    void refreshTop();
  }

  /* -------------------------------------------------- whole-selection queries */

  let scopeSequence = 0;
  async function refreshScope(filters, sequence) {
    const turn = ++scopeSequence;
    const started = performance.now();
    try {
      const result = await built.source.aggregate(request(filters, []), [{ id: 'views', col: 'views', fn: 'sum' }]);
      if (turn !== scopeSequence || sequence !== mountSequence) return;
      built.scope.views = num(result.values?.views);
      built.timings.scope = Math.round(performance.now() - started);
      paintTiles();
      renderPlan();
      openFacets();
    } catch (error) {
      console.error('[pageviews demo] aggregate', error);
      built.error = String(error?.message ?? error);
      openFacets();
    }
  }

  /**
   * The ranking. One `GROUP BY` with an `ORDER BY ... LIMIT`, over the scope
   * the controls describe. With no project chosen the key is the project and
   * the page together, since "Main_Page" is a page on every project.
   */
  let topSequence = 0;
  async function refreshTop() {
    const turn = ++topSequence;
    const started = performance.now();
    const where = [];
    const params = [];
    const full = state.from <= WEEK_START_MS && state.to >= WEEK_END_MS;
    if (!full) {
      where.push('hour >= CAST(? AS TIMESTAMP) AND hour < CAST(? AS TIMESTAMP)');
      params.push(new Date(state.from).toISOString().slice(0, 19).replace('T', ' '), new Date(state.to).toISOString().slice(0, 19).replace('T', ' '));
    }
    if (state.project) { where.push('project = ?'); params.push(state.project); }
    if (state.access) { where.push('access = ?'); params.push(state.access); }
    if (state.quick) { where.push('page_title ILIKE ?'); params.push(`%${state.quick}%`); }
    const keys = state.project ? 'page_title' : 'project, page_title';
    const sql = `SELECT ${keys}, sum(views)::BIGINT AS views FROM ${fromFile(FILE)}`
      + `${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY ${keys} ORDER BY views DESC, ${keys} LIMIT ${TOP_PAGES}`;
    try {
      const statement = await connection.prepare(sql);
      const result = await statement.query(...params);
      statement.close?.();
      if (turn !== topSequence) return;
      built.topRows = result.toArray().map((r, i) => {
        const row = r.toJSON();
        const title = String(row.page_title).replaceAll('_', ' ');
        return { id: i, label: state.project ? title : `${title} · ${row.project}`, views: num(row.views) };
      });
      built.timings.top = Math.round(performance.now() - started);
      feedTop();
      renderPlan();
    } catch (error) {
      console.error('[pageviews demo] top pages', error);
      built.error = String(error?.message ?? error);
    }
  }

  function feedTop() {
    const columnDefs = [{ field: 'id', type: 'number' }, { field: 'label' }, { field: 'views', type: 'number' }];
    if (built.topGrid) {
      built.topGrid.rows.load(built.topRows);
      built.topChart?.refresh?.();
      return;
    }
    topBox.textContent = '';
    built.topGrid = LG.createHeadlessGrid({ rowKey: 'id', columns: columnDefs, rows: built.topRows });
    try {
      built.topChart = createChart({
        grid: built.topGrid,
        container: topBox,
        type: 'horizontalBar',
        x: 'label',
        y: 'views',
        legend: false,
        title: `Top ${TOP_PAGES} pages`,
        subtitle: 'For the time window, project, access method and search chosen above',
        margin: { left: window.innerWidth < 600 ? 150 : 270 },
      });
    } catch (error) {
      topBox.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[pageviews demo] chart', error);
    }
  }

  /* ----------------------------------------------------------- the plan */

  function latestStatements() {
    const kinds = new Map();
    for (const entry of sqlLog) {
      const kind = entry.sql.startsWith('DESCRIBE') ? 'describe'
        : entry.sql.includes('__lattice_total') || entry.sql.includes('__lattice_match') ? 'count'
          : entry.sql.includes('GROUP BY ROLLUP') ? (entry.sql.includes('sum("views") AS "views"') ? 'figure' : 'histogram')
            : entry.sql.includes('ORDER BY views DESC') ? 'top'
              : /\bLIMIT\b/.test(entry.sql) ? 'rows' : 'other';
      kinds.set(kind, entry);
    }
    return kinds;
  }

  const planSummary = el('summary', 'plan-summary', 'What went to DuckDB');
  const planNote = el('p', 'plan-note');
  planNote.dataset.planNote = '';
  const planPre = el('pre', 'plan-sql');
  planSection.append(planSummary, planNote, planPre);

  function renderPlan() {
    const plan = built.plan;
    const statements = latestStatements();
    const block = (title, entry) => {
      if (!entry) return '';
      const sql = entry.sql.replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT|OFFSET|WINDOW) /g, '\n$1 ');
      const bound = entry.params?.length ? `\n-- bound: ${JSON.stringify(entry.params)}` : '';
      return `-- ${title} · ${fmt.ms(entry.ms)} · ${fmt.int(entry.rows)} rows back\n${sql}${bound}\n\n`;
    };
    planPre.textContent =
      block('the page of rows on screen', statements.get('rows'))
      + block('the match count, sent with it', statements.get('count'))
      + block('the views figure', statements.get('figure'))
      + block('the trend chart or a histogram: one GROUP BY over the whole selection', statements.get('histogram'))
      + block('the top pages', statements.get('top'));
    if (plan) {
      const unpushed = plan.unpushed ?? [];
      planNote.textContent = unpushed.length === 0
        ? 'Filter, sort, quick search and paging all ran in DuckDB; nothing was left for the browser to do.'
        : `Left for the browser: ${unpushed.join(', ')}.`;
    }
  }

  /* -------------------------------------------------------------- start */

  async function loadProjects() {
    const result = await connection.query(
      `SELECT project FROM ${fromFile(FILE)} GROUP BY project ORDER BY sum(views) DESC LIMIT 15`,
    );
    built.projects = result.toArray().map((r) => String(r.toJSON().project));
    const current = projectSelect.value;
    for (const name of built.projects) {
      if (![...projectSelect.options].some((o) => o.value === name)) projectSelect.append(new Option(name, name));
    }
    projectSelect.value = current;
  }

  gridSection.append(gridHost);
  paintControls();
  mountGrid();
  topBox.append(el('p', 'chart-wait', 'Ranking pages...'));
  built.ready = (async () => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(built.grid.rows.count() > 0 && built.matchCount != null && built.scope.views != null)) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (built.matchCount == null) throw new Error('the first window of rows never arrived');
    const total = document.querySelector('#row-total');
    built.totalRows = num((await connection.query(`SELECT count(*) AS n FROM ${fromFile(FILE)}`)).toArray()[0].toJSON().n);
    if (total) total.textContent = `${fmt.compact(built.totalRows)} `;
    built.isReady = true;
    built.settled = Promise.all([refreshTop(), loadProjects()]).then(() => { built.isSettled = true; });
  })();

  built.destroy = () => { built.chart?.destroy?.(); built.grid?.destroy?.(); };
  return built;
}
