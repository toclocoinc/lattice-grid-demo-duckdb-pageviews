/**
 * Load the page in a real browser against the local data and check that what
 * it says is true.
 *
 * Every figure the page shows is recomputed here by a second DuckDB, in Node,
 * over the same Parquet file, with SQL written out separately from the grid's
 * so an error in the adapter cannot hide by being made twice. Every
 * interaction is a real pointer or keyboard event (`Input.dispatch*`).
 *
 *   npm run build-data     # once: writes data/pageviews-<week>.parquet
 *   npm run verify
 *
 * `--shots <dir>` also saves screenshots at 1440px and 390px, light and dark.
 */

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './serve.mjs';
import { launchBrowser } from './browser.mjs';
import { LOCAL_DATA_URL } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const shotDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;

const failures = [];
const notes = [];
function check(ok, description, detail) {
  const line = `${description}${detail ? ` (${detail})` : ''}`;
  if (ok) notes.push(`  ok   ${line}`);
  else { failures.push(line); notes.push(`  FAIL ${line}`); }
  console.log(notes.at(-1));
}

const int = (n) => Number(n).toLocaleString('en-US');
const DAY = 24 * 3600 * 1000;
const WEEK_START = Date.UTC(2026, 8, 21);
const ts = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/* ------------------------------------------------------------------ */
/* The independent answer                                              */
/* ------------------------------------------------------------------ */

const { DuckDBInstance } = await import('@duckdb/node-api');
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
const FILE = join(root, LOCAL_DATA_URL).replaceAll("'", "''");
const P = `read_parquet('${FILE}')`;
const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const one = async (sql) => (await rows(sql))[0];
const n = (v) => (typeof v === 'bigint' ? Number(v) : Number(v));

/** WHERE for a scope, written again here in the same terms the controls use. */
const where = ({ from = WEEK_START, to = WEEK_START + 7 * DAY, project, access, search } = {}) => [
  `hour >= TIMESTAMP '${ts(from)}' AND hour < TIMESTAMP '${ts(to)}'`,
  project && `project = '${project}'`,
  access && `access = '${access}'`,
  search && `page_title ILIKE '%${search}%'`,
].filter(Boolean).join(' AND ');

async function truth(scope) {
  const w = where(scope);
  const a = await one(`SELECT count(*) AS rows, sum(views)::HUGEINT AS views FROM ${P} WHERE ${w}`);
  return { rows: n(a.rows), views: n(a.views), where: w };
}

/* ------------------------------------------------------------------ */
/* The browser                                                         */
/* ------------------------------------------------------------------ */

async function run() {
  const served = await startServer(0);
  const origin = `http://127.0.0.1:${served.port}`;
  const browser = await launchBrowser({ width: 1440, height: 900 });
  console.log(`Browser: ${browser.chromePath}\nServing: ${origin}`);
  try {
    const { evaluate, waitFor, click, type } = browser;
    const page = (expr) => evaluate(`(() => { const p = window.__pageviews; return ${expr}; })()`);

    await browser.navigate(`${origin}/?data=local`);
    await waitFor('window.__pageviews && (window.__pageviews.isReady || window.__pageviews.error)', 180000, 'the page to be ready');
    check(await page('!p.error'), 'the page started', await page('p.error || ""'));

    /* The settled state: ranking and project list in. */
    await waitFor('window.__pageviews.isSettled', 180000, 'the ranking and project list');

    /* ---------------------------- the file itself ---------------------------- */
    const file = await one(`SELECT count(*) AS rows, min(hour) AS first, max(hour) AS last, sum(views)::HUGEINT AS views FROM ${P}`);
    check(await page('p.totalRows') === n(file.rows), 'the page counted the whole file', `${int(n(file.rows))} rows`);
    const lede = await evaluate("document.querySelector('.lede').textContent");
    check(/million\s+hourly rows/.test(lede), 'the intro states the size', lede.replace(/\s+/g, ' ').slice(60, 130));
    check(n(file.rows) >= 20e6 && n(file.rows) <= 60e6, 'the file is within 20–60 million rows', int(n(file.rows)));

    /* -------------------- default window: Wednesday 23 ----------------------- */
    const WED = { from: WEEK_START + 2 * DAY, to: WEEK_START + 3 * DAY };
    let t = await truth(WED);
    check(await page('p.matchCount') === t.rows, 'Wed 23 row count matches DuckDB in Node', int(t.rows));
    check(await page('p.scope.views') === t.views, 'Wed 23 views match', int(t.views));
    const first = await one(`SELECT project, page_title, access, hour, views FROM ${P} WHERE ${t.where} LIMIT 1`);
    const firstRow = await evaluate(`(() => { const r = document.querySelector('.grid-host [role="row"][aria-rowindex="2"], .grid-host [role="row"]:nth-of-type(2)'); return document.querySelector('.grid-host').innerText.slice(0, 600); })()`);
    check(firstRow.includes(first.project) && firstRow.includes(first.page_title), 'the first grid row is the file\'s first row for that window', `${first.project} / ${first.page_title}`);
    await waitFor(`['project','access','hour','views'].every((c) => document.querySelectorAll('.lat-facet[data-col="' + c + '"] .lat-facet__bar').length > 0)`, 120000, 'the header histograms');
    const planDefault = await page('p.pagePlan');
    check(planDefault && planDefault.unpushed.length === 0 && planDefault.pushed.filters != null,
      'the time window went to DuckDB as a bound WHERE, nothing left for the browser', JSON.stringify(planDefault?.unpushed));
    const histograms = await evaluate(`['project','access','hour','views'].map((c) => document.querySelectorAll('.lat-facet[data-col="' + c + '"] .lat-facet__bar').length)`);
    check(histograms.every((c) => c > 0), 'header histograms are drawn for project, access, hour and views', histograms.join(', '));

    /* trend chart: engine-computed, one point per hour */
    const trend = await page('p.chart && p.chart.provenance && p.chart.provenance()');
    check(trend?.source === 'engine' && trend?.refused === false, 'the trend chart is computed in DuckDB', JSON.stringify({ source: trend?.source, refused: trend?.refused }));
    const trendSql = await page(`p.sqlLog.some((l) => /GROUP BY ROLLUP\\("hour"\\)/.test(l.sql) && /sum\\("views"\\)/.test(l.sql))`);
    check(trendSql, 'the trend chart ran GROUP BY hour with sum(views)');
    check(await evaluate("document.querySelectorAll('[data-chart=\"trend\"] svg path').length > 0"), 'the trend chart drew a line');

    /* top pages */
    const top = await rows(`SELECT project, page_title, sum(views)::BIGINT AS views FROM ${P} WHERE ${t.where} GROUP BY project, page_title ORDER BY views DESC, project, page_title LIMIT 12`);
    const topPage = await page('p.topRows');
    check(topPage.length === 12 && topPage.every((r, i) => r.views === n(top[i].views)), 'top 12 pages and their views match DuckDB in Node', `${top[0].project} ${top[0].page_title} ${int(n(top[0].views))}`);

    /* ------------------------ time-window filter ------------------------------ */
    await click('.chip[data-id="d5"]');
    const SAT = { from: WEEK_START + 5 * DAY, to: WEEK_START + 6 * DAY };
    t = await truth(SAT);
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 60000, 'Saturday to count');
    check(true, 'clicking Sat 26 filters to that day', `${int(t.rows)} rows`);
    await waitFor(`window.__pageviews.scope.views === ${t.views}`, 60000, 'Saturday views');
    check(true, 'the views figure follows', int(t.views));

    await click('.chip[data-id="week"]');
    t = await truth({});
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'whole week');
    check(true, 'Whole week returns every row', int(t.rows));

    await click('.chip[data-id="weekend"]');
    t = await truth({ from: WEEK_START + 5 * DAY });
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'weekend');
    check(true, 'Weekend filters to Saturday and Sunday', int(t.rows));

    /* ----------------------- project, access, search ------------------------- */
    await evaluate(`(() => { const s = document.querySelector('.controls select'); s.value = 'ja.wikipedia'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const WE = { from: WEEK_START + 5 * DAY };
    t = await truth({ ...WE, project: 'ja.wikipedia' });
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'ja.wikipedia');
    check(true, 'choosing a project filters in DuckDB', `ja.wikipedia, ${int(t.rows)} rows`);

    await click('.chip[data-id="mobile-app"]');
    t = await truth({ ...WE, project: 'ja.wikipedia', access: 'mobile-app' });
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'mobile app');
    check(true, 'access method filters', `${int(t.rows)} rows`);
    await click('.chip[data-id=""]');

    await type('input.search', 'Main_Page');
    t = await truth({ ...WE, project: 'ja.wikipedia', search: 'Main_Page' });
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'quick search');
    check(true, 'quick search (typed) runs as ILIKE in DuckDB', `${int(t.rows)} rows`);
    check(await page(`p.sqlLog.some((l) => /ILIKE/.test(l.sql) && (l.params || []).some((v) => String(v).includes('Main_Page')))`), 'the search term was bound into the ILIKE, not interpolated');
    await type('input.search', '');
    t = await truth({ ...WE, project: 'ja.wikipedia' });
    await waitFor(`window.__pageviews.matchCount === ${t.rows}`, 120000, 'search cleared');

    /* --------------------- spike detection (window function) ------------------- */
    await evaluate(`(() => { const s = document.querySelector('.controls select'); s.value = 'es.wikipedia'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await click('.chip[data-id="d2"]');
    await click('.chip[data-id="spikes"]');
    await waitFor(`window.__pageviews.mode === 'spikes' && window.__pageviews.matchCount > 0 && window.__pageviews.grid.rows.count() > 0`, 180000, 'the spike view');
    await sleep(1500);
    const SP = await one(`
      SELECT page_title, access, hour, views, avg24, spike FROM (
        SELECT page_title, access, hour, views,
               sum(views) OVER w / 24.0 AS avg24,
               views / nullif(sum(views) OVER w / 24.0, 0) AS spike
        FROM ${P} WHERE project = 'es.wikipedia'
        WINDOW w AS (PARTITION BY page_title, access ORDER BY hour RANGE BETWEEN INTERVAL 24 HOURS PRECEDING AND INTERVAL 1 HOUR PRECEDING))
      WHERE hour >= TIMESTAMP '${ts(WEEK_START + 2 * DAY)}' AND hour < TIMESTAMP '${ts(WEEK_START + 3 * DAY)}' AND views >= 50 AND spike IS NOT NULL
      ORDER BY spike DESC, page_title, hour LIMIT 1`);
    const spikeCount = (await one(`
      SELECT count(*) AS c FROM (
        SELECT views, hour, sum(views) OVER w / 24.0 AS avg24
        FROM ${P} WHERE project = 'es.wikipedia'
        WINDOW w AS (PARTITION BY page_title, access ORDER BY hour RANGE BETWEEN INTERVAL 24 HOURS PRECEDING AND INTERVAL 1 HOUR PRECEDING))
      WHERE hour >= TIMESTAMP '${ts(WEEK_START + 2 * DAY)}' AND hour < TIMESTAMP '${ts(WEEK_START + 3 * DAY)}' AND views >= 50`)).c;
    check(await page('p.matchCount') === n(spikeCount), 'the spike view row count matches the window query in Node', `${int(n(spikeCount))} rows, page says ${await page('p.matchCount')}`);
    const spikeText = await evaluate("document.querySelector('.grid-host').innerText.slice(0, 700)");
    check(spikeText.includes(SP.page_title), 'the top spike in the grid is the top spike DuckDB in Node finds', `${SP.page_title}, ${Number(SP.spike).toFixed(1)}×`);
    check(spikeText.includes(`${Number(SP.spike).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`), 'the spike ratio is shown to one decimal', Number(SP.spike).toFixed(1));
    const pills = await evaluate("document.querySelectorAll('.grid-host [class*=\"pill\"], .grid-host [class*=\"lat-pill\"]').length");
    check(pills > 0, 'the spike column carries conditional formatting (pills)', `${pills} pills`);

    /* -------------------------------- hygiene --------------------------------- */
    const body = await evaluate('document.body.innerText');
    check(!/\bNaN\b|undefined|\[object Object\]/.test(body), 'no NaN, undefined or [object Object] in the page text');
    check(await page('p.grid.licence.watermark() === false'), 'no watermark');
    check(browser.consoleErrors.length === 0 && browser.pageErrors.length === 0, '0 console errors', JSON.stringify([...browser.consoleErrors, ...browser.pageErrors]).slice(0, 400));

    if (shotDir) {
      await browser.screenshot(join(shotDir, 'desktop-light-spikes.png'));
    }
  } finally {
    await browser.close();
    served.server.close();
  }
}

try {
  await run();
} catch (error) {
  failures.push(`the run itself failed: ${error.message}`);
  console.error(error);
}
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${notes.length - failures.length} ok, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
