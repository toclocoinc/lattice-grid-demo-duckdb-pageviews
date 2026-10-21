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

## Known grid issue: grouping is left out

Grouping by project and by access method is requested and the grid pushes the group query (`GROUP BY "project"`),
but once a group is expanded its child rows never load ("Loading rows 1 to 27" stays), and the grid's plan reports
`groupReason: the request carries no typed groupValues for its group path, and the string groupPath cannot be compared
against a typed column`. Repro: `duckdbAdapter` + `createPushdownSource` over `read_parquet(...)`, columns
`project` and `access` with `group: { enabled: true, index: 0 | 1 }`, `rowKey` an array of the four key columns,
open the page. Reported rather than worked around, so the demo has no grouped view.
