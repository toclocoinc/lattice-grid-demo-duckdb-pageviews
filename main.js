/**
 * The entry point.
 *
 * Starts DuckDB, hands the connection to the page, and gets out of the way.
 * Nothing is awaited at the top level: a module with a pending top-level await
 * leaves the document in its loading state, which blocks a headless browser's
 * evaluations. `start()` is called and the module finishes.
 */

import * as LG from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/lattice-grid.esm.min.js?v=20261022';
import { createChart } from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/charts.esm.min.js?v=20261022';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection } from './src/duckdb.js';
import { buildPage } from './src/page.js';
import { createStatus, megabytes } from './src/loading.js';

/* Applied before anything is drawn: a grid keeps whatever licence was in force
   when it was built. */
LG.setLicence(DEMO_LICENCE);

const loading = document.querySelector('#loading');
const message = loading.querySelector('.loading-message');
/* The status line is in index.html, so it is on screen from first paint. */
const status = createStatus(loading.querySelector('.load-status'));

/** The statements DuckDB ran, newest last. The timings and the SQL panel read this. */
const sqlLog = [];
const record = (connection) => recordingConnection(connection, (entry) => {
  sqlLog.push(entry);
  if (sqlLog.length > 300) sqlLog.splice(0, sqlLog.length - 300);
});

function showError(error) {
  loading.hidden = false;
  loading.classList.add('failed');
  status.hide();
  message.hidden = false;
  message.textContent = `The data could not be loaded: ${String(error?.message ?? error)}. `
    + 'This page runs DuckDB compiled to WebAssembly and reads a Parquet file with HTTP range requests. '
    + 'It needs a browser with WebAssembly and a host that answers 206 Partial Content.';
  console.error('[pageviews demo]', error);
}

async function start() {
  const started = performance.now();
  try {
    const { connection, version, close, reads } = await startDuckDB(
      (text) => status.set(text),
      ({ loaded, total }) => status.set(
        `Downloading the query engine (about ${megabytes(total)}, first visit only): ${megabytes(loaded)} of ${megabytes(total)}`,
        loaded / total,
      ),
    );

    const page = buildPage({
      host: document.querySelector('#dashboard'),
      LG,
      createChart,
      connection: record(connection),
      sqlLog,
      duckdbVersion: version,
      reads,
      status,
    });
    page.sqlLog = sqlLog;
    window.__pageviews = page;
    window.addEventListener('pagehide', () => { page.destroy(); close(); }, { once: true });

    await page.ready;
    await page.settled;
    status.hide();
    loading.hidden = true;
    page.bootMs = Math.round(performance.now() - started);
    console.log('[pageviews demo] ready', { ms: page.bootMs, rows: page.matchCount, duckdb: version });
  } catch (error) {
    window.__pageviews = { ready: false, error: String(error?.message ?? error) };
    showError(error);
  }
}

start();
