# A week of Wikipedia traffic, sliced in seconds

One week of Wikimedia pageviews (35.9 million hourly rows, one 205 MB Parquet file) queried live in the browser:
[Lattice Grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) over DuckDB-Wasm, reading the file by HTTP
byte range. Filter, sort, quick search and paging run as SQL in DuckDB.

On the page: a time-window filter, a project and access-method filter, quick search over page titles, header
histograms, an hourly trend chart bound to the grid, the top pages for the selection, live query timings, and a
spike-detection view whose `vs trailing 24h` column is a SQL window function with conditional formatting.

Plain JavaScript, no framework and no build step.

```
npm ci
npm run build-data      # downloads ~5 GB from Wikimedia, writes data/pageviews-2026-09-21.parquet
npm start               # http://localhost:<port>/?data=local
npm run verify          # headless Chrome, checks every figure against a second DuckDB in Node
```

Data: [Wikimedia pageview_complete](https://dumps.wikimedia.org/other/pageview_complete/readme.html), CC0, credit the
Wikimedia Foundation. Details, row counts and sizes: [data/README.md](data/README.md).

## How it stays fast

The week is stored as one Parquet file per day (`pageviews-2026-09-DD.parquet`, same sort and row groups as before), and the
page opens only the days inside the selected window. Two small tables answer what needs no page rows: `hourly-by-project`
(the project list and the file's row count) and `top-pages` (the whole-week ranking, exact for any project and access
choice; a search or a partial window ranks from the day files). Measured against `tools/serve.mjs` on a laptop, before
(one 205 MB file) and after, in a fresh browser: first rows of the default day 13 s to 4.5–6 s (about 9.4 s to 3.7–5.5 s
after DuckDB-Wasm loads); whole-week ranking 22.9 s to about 1 s; whole-week rows about 1 s in both; whole-week figures
(views sum, trend) about 40 s to 3–13 s depending on what else is queued.

## Loading

The first visit has three slow steps: the query engine (about 34 MB of WebAssembly, a fifth of that on the wire), starting it, and reading the opening window from the Parquet files. The page says what it is doing from first paint (pattern shared with the SaaS demo, `src/loading.js`, `src/duckdb.js`):

1. A status line in the static HTML: spinner, one plain-English sentence, and a progress bar wherever the size is known. "Downloading the query engine (about 34 MB, first visit only): n of m MB", "Starting the engine", "Reading the day files and the hourly and top-pages tables (n of m MB)", then "Building the grid, charts and figures".
2. Real byte counts. The engine download is DuckDB-Wasm's own progress callback. The Parquet reads are counted by a small wrapper around the worker that reports each response size over a `BroadcastChannel`; the total is the compressed size of the opening window's day files and the two small tables, from `parquet_metadata()`.
3. Every panel (figures, both charts, the grid) is covered by a loading state until its first answer, so there is no blank space.

## Grid notes (1.111.7)

- Grouping by project, then access method, works: expanded groups load their children and `lastPlan()` carries typed
  `groupValues`.
- Header histograms come from the DuckDB adapter's built-in facets (no host provider). Project draws as its ten commonest
  values plus Other. **The Hour histogram is not drawn** (`suppressed: no-provider` on a timestamp column over a pushdown
  source) and the Views histogram is switched off: its quantiles sort the whole column (about 5 s a day, tens of seconds a week).
