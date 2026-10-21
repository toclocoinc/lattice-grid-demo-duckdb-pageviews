# Data

The page reads Parquet files that are **not in this repository**. `npm run build-data`
(`tools/build-parquet.mjs`, Node 22 and `@duckdb/node-api`, plus `bzip2` and `awk`) writes it
from public sources only; the release box uploads everything it writes under `data/` to
`https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-pageviews/`
(`DATA_BASE` in `src/config.js`): seven day files `pageviews-2026-09-21.parquet` … `-27.parquet`, `hourly-by-project-2026-09-21.parquet`
(views and page counts per project, access and hour) and `top-pages-2026-09-21.parquet` (the 50 leading pages of each project, per access
method and over all of them). `?data=local` reads `data/` through `tools/serve.mjs` instead.

## Source, licence, attribution

- **Wikimedia `pageview_complete`**, user-traffic daily files `pageviews-YYYYMMDD-user.bz2`,
  Monday 21 to Sunday 27 September 2026: <https://dumps.wikimedia.org/other/pageview_complete/readme.html>
  (about 730 MB each, 5.1 GB for the week).
- Licence: **CC0** (public-domain dedication of the Wikimedia Analytics datasets).
- Credit: the Wikimedia Foundation. The page footer says so.

## What the build does

1. Downloads the seven files into `.cache/` (gitignored).
2. Streams each through `bzip2 | awk`, keeping page rows whose **daily total is at least 200 views**
   (`--min-daily`), and drops the dump's placeholder title `-`. A day is about 64 million lines,
   nearly all of them pages seen once or twice; without a threshold the week unpivots to well over a billion rows.
3. Unpivots each line's hourly string (`A2B4...`, A = 00:00 UTC) into one row per page, access method and hour,
   and writes one file per day: **zstd, row groups of 100,000 rows, sorted by project, hour**, then the two small tables.

Columns: `project` (VARCHAR), `page_title` (VARCHAR), `access` (`desktop`, `mobile-web`, `mobile-app`),
`hour` (TIMESTAMP, UTC), `views` (INTEGER).

## Measured (the build of 2026-10-21)

Totals over the seven day files (identical to the former single file):

| | |
|---|---|
| `SELECT count(*)` | **35,918,302** rows |
| Day files | 28.2 to 32.6 MB each, 208.3 MB in all with the two small tables (hourly 0.4 MB, top pages 0.16 MB) |
| Row groups | 49 to 55 per day |
| First / last hour | 2026-09-21 00:00 / 2026-09-27 23:00 (UTC) |
| Projects | 873 |
| Distinct page titles | 255,803 |
| Sum of `views` | 1,136,764,611 |

Re-running the build reproduces these figures; a different `--start` Monday or `--min-daily` changes them, and
`src/config.js` and the page footer name the week.
