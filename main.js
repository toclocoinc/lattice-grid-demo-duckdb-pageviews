/**
 * The entry point.
 *
 * Starts DuckDB, hands the connection to the page, and gets out of the way.
 * Nothing is awaited at the top level: a module with a pending top-level await
 * leaves the document in its loading state, which blocks a headless browser's
 * evaluations. `start()` is called and the module finishes.
 */

import * as LG from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection } from './src/duckdb.js';
import { buildPage } from './src/page.js';

/* Applied before anything is drawn: a grid keeps whatever licence was in force
   when it was built. */
LG.setLicence(DEMO_LICENCE);

const loading = document.querySelector('#loading');
const message = loading.querySelector('.loading-message');

/** The statements DuckDB ran, newest last. The timings and the SQL panel read this. */
const sqlLog = [];
const record = (connection) => recordingConnection(connection, (entry) => {
  sqlLog.push(entry);
  if (sqlLog.length > 300) sqlLog.splice(0, sqlLog.length - 300);
});

function showError(error) {
  loading.hidden = false;
  loading.classList.add('failed');
  message.textContent = `The data could not be loaded: ${String(error?.message ?? error)}. `
    + 'This page runs DuckDB compiled to WebAssembly and reads a Parquet file with HTTP range requests. '
    + 'It needs a browser with WebAssembly and a host that answers 206 Partial Content.';
  console.error('[pageviews demo]', error);
}

async function start() {
  const started = performance.now();
  try {
    message.textContent = 'Starting DuckDB in your browser...';
    const { connection, version, close } = await startDuckDB((text) => { message.textContent = text; });
    message.textContent = 'Opening the Parquet file...';

    const page = buildPage({
      host: document.querySelector('#dashboard'),
      LG,
      createChart,
      connection: record(connection),
      sqlLog,
      duckdbVersion: version,
    });
    page.sqlLog = sqlLog;
    window.__pageviews = page;
    window.addEventListener('pagehide', () => { page.destroy(); close(); }, { once: true });

    await page.ready;
    loading.hidden = true;
    document.querySelector('#dashboard').classList.remove('pending');
    page.bootMs = Math.round(performance.now() - started);
    console.log('[pageviews demo] ready', { ms: page.bootMs, rows: page.matchCount, duckdb: version });
  } catch (error) {
    window.__pageviews = { ready: false, error: String(error?.message ?? error) };
    showError(error);
  }
}

start();
