/**
 * Build data/pageviews-<first day>.parquet from the Wikimedia pageview_complete
 * dumps.
 *
 * This is a developer tool. The page never runs it: it reads the Parquet file
 * that this writes, with DuckDB-Wasm, over HTTP range requests. The PM re-runs
 * it on the release box and uploads the output to
 * https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-pageviews/
 *
 *   node tools/build-parquet.mjs                       # the week in src/config.js
 *   node tools/build-parquet.mjs --start 2026-09-21    # a different Monday
 *   node tools/build-parquet.mjs --min-daily 200       # the per-day threshold
 *   node tools/build-parquet.mjs --keep                # keep the filtered text
 *
 * What it does:
 *
 *   1. Downloads the seven `pageviews-YYYYMMDD-user.bz2` files of one week from
 *      dumps.wikimedia.org (about 730 MB each, user traffic only), unless a
 *      copy is already in .cache/. Needs the `bzip2` and `awk` commands.
 *   2. Streams each file through bzip2 and awk, keeping only the page rows
 *      whose daily total is at least --min-daily views. A day is 60+ million
 *      lines, nearly all of them pages seen once or twice; the threshold is
 *      what brings the week to tens of millions of hourly rows.
 *   3. Reads the seven filtered files with DuckDB, unpivots each line's
 *      hourly string into one row per page, access method and hour, and writes
 *      ONE Parquet file: zstd, row groups of 100,000 rows, sorted by project
 *      and hour.
 *
 * Lines whose title is the dump's placeholder "-" (traffic with no page
 * attached) are dropped: they would top every ranking and say nothing.
 *
 * The sort and the row-group size are the point. DuckDB-Wasm reads the file
 * over HTTP and can skip a row group only when its min/max statistics rule it
 * out. Sorted by project then hour, a filter on a project, or on a project and
 * a time window, touches a few row groups instead of all of them.
 *
 * The dump's line is: wiki code, page title, page id, access method, daily
 * total, then the hours as a letter (A = 00:00 UTC ... X = 23:00 UTC) and the
 * views in that hour. A line may lack the page id; the awk step reads the last
 * three fields from the end so both shapes parse. Nothing is invented: every
 * value is copied from the dump or unpacked from it.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cache = join(root, '.cache');

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const start = flag('--start', '2026-09-21');
const minDaily = Number(flag('--min-daily', '200'));
const keep = args.includes('--keep');
if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`--start wants YYYY-MM-DD, got "${start}"`);
if (!Number.isInteger(minDaily) || minDaily < 1) throw new Error(`--min-daily wants a whole number, got "${flag('--min-daily')}"`);

const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

const run = (command, argv, stdio = ['ignore', 'inherit', 'inherit']) => new Promise((ok, fail) => {
  const child = spawn(command, argv, { stdio });
  child.on('error', fail);
  child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))));
});

await mkdir(cache, { recursive: true });
await mkdir(join(root, 'data'), { recursive: true });

/* ----------------------------------------------------- download and filter */

const filtered = days.map((day) => join(cache, `filtered-${day.replaceAll('-', '')}-min${minDaily}.txt`));
/* Downloads go one at a time (dumps.wikimedia.org answers 429 to parallel
   fetches from one client); the bzip2 filtering after each still runs in
   parallel, since bzip2 is single-threaded. */
let downloadTurn = Promise.resolve();
/**
 * Run one download after the previous one finishes.
 * @param {() => Promise<void>} job the download
 * @returns {Promise<void>} settles when this download is done
 */
const oneAtATime = (job) => (downloadTurn = downloadTurn.then(job, job));
await Promise.all(days.map(async (day) => {
  const compact = day.replaceAll('-', '');
  const name = `pageviews-${compact}-user.bz2`;
  const url = `https://dumps.wikimedia.org/other/pageview_complete/${day.slice(0, 4)}/${day.slice(0, 7)}/${name}`;
  const bz = join(cache, name);
  const text = join(cache, `filtered-${compact}-min${minDaily}.txt`);

  if (await exists(text)) {
    console.log(`${day}: using ${text}`);
    return;
  }
  if (!(await exists(bz))) await oneAtATime(async () => {
    console.log(`${day}: downloading ${url}`);
    let response;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      response = await fetch(url, { headers: { 'User-Agent': 'lattice-grid-demo-duckdb-pageviews/1.0 (https://www.latticegrid.dev; demo data build)' } });
      if (response.ok) break;
      console.log(`  ${response.status}, retrying (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 30000 * attempt));
    }
    if (!response.ok) throw new Error(`Wikimedia answered ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${bz}.part`));
    await run('mv', [`${bz}.part`, bz]);
    console.log(`  ${mb((await stat(bz)).size)}`);
  });
  console.log(`${day}: keeping page rows with at least ${minDaily} views that day`);
  /* project, title, access, daily total, hourly string, and the day. The page
     id is dropped: it is absent on some lines and the page does not use it. */
  const awkProgram = `{ t = $(NF-1); if (t + 0 >= ${minDaily}) print $1, $2, $(NF-2), t, $NF, "${day}" }`;
  await run('sh', ['-c', `bzip2 -dc "${bz}" | awk '${awkProgram}' > "${text}.part" && mv "${text}.part" "${text}"`]);
  console.log(`${day}: ${mb((await stat(text)).size)} kept`);
}));

/* ----------------------------------------------------------------- convert */

const { DuckDBInstance } = await import('@duckdb/node-api');
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
await conn.run("SET preserve_insertion_order = false");

const q = (path) => path.replaceAll("'", "''");
const dayFiles = days.map((day) => join(root, 'data', `pageviews-${day}.parquet`));

/* One file per day, each sorted by project then hour with row groups of 100,000
   rows, so the page opens only the days in the selected window and, inside a
   day, skips row groups by their min/max statistics. */
for (const [i, day] of days.entries()) {
  console.log(`${day}: unpivoting the hours and writing ${dayFiles[i]}`);
  await conn.run(`
    COPY (
      SELECT
        project::VARCHAR                                        AS project,
        page_title::VARCHAR                                     AS page_title,
        access::VARCHAR                                         AS access,
        (day::DATE::TIMESTAMP
          + to_hours((ascii(substr(tok, 1, 1)) - 65)::BIGINT))  AS hour,
        substr(tok, 2)::INTEGER                                 AS views
      FROM (
        SELECT project, page_title, access, day,
               unnest(regexp_extract_all(hourly, '[A-X][0-9]+')) AS tok
        FROM read_csv('${q(filtered[i])}', delim = ' ', header = false, quote = '', escape = '',
                      columns = { 'project': 'VARCHAR', 'page_title': 'VARCHAR', 'access': 'VARCHAR',
                                  'total': 'BIGINT', 'hourly': 'VARCHAR', 'day': 'VARCHAR' },
                      strict_mode = false)
      )
      WHERE page_title <> '-'
      ORDER BY project, hour, page_title, access
    ) TO '${q(dayFiles[i])}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000, WRITE_BLOOM_FILTER false)
  `);
}

/* A small pre-aggregated table for the trend chart and the whole-week figures:
   views and row counts per project, access method and hour. */
const hourlyFile = join(root, 'data', `hourly-by-project-${start}.parquet`);
console.log(`Writing ${hourlyFile}`);
const dayList = dayFiles.map((f) => `'${q(f)}'`).join(', ');
await conn.run(`
  COPY (
    SELECT project, access, hour, sum(views)::BIGINT AS views, count(*)::INTEGER AS pages
    FROM read_parquet([${dayList}])
    GROUP BY project, access, hour
    ORDER BY project, hour, access
  ) TO '${q(hourlyFile)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000, WRITE_BLOOM_FILTER false)
`);

/* The whole week's most-viewed pages, for the whole-week ranking: the 50 top
   pages of each project, in each access method and over all of them (access is
   '' for all). The ranking for any project and access choice is exact from this,
   because the top 12 of a union is inside the union of the top 12s, and it
   spares the page a GROUP BY over every row of the week. */
const topFile = join(root, 'data', `top-pages-${start}.parquet`);
console.log(`Writing ${topFile}`);
await conn.run(`
  COPY (
    SELECT project, page_title, coalesce(access, '') AS access, views FROM (
      SELECT project, page_title, access, views,
             row_number() OVER (PARTITION BY project, access ORDER BY views DESC, page_title) AS rank
      FROM (
        SELECT project, page_title, access, sum(views)::BIGINT AS views
        FROM read_parquet([${dayList}]) GROUP BY GROUPING SETS ((project, page_title, access), (project, page_title))
      ) AS sums (project, page_title, access, views)
    ) WHERE rank <= 50
    ORDER BY project, access, views DESC
  ) TO '${q(topFile)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000, WRITE_BLOOM_FILTER false)
`);

/* ------------------------------------------------------------------ report */

const facts = (await conn.runAndReadAll(`
  SELECT count(*) AS rows, min(hour) AS first_hour, max(hour) AS last_hour,
         count(DISTINCT project) AS projects, count(DISTINCT page_title) AS titles,
         sum(views)::HUGEINT AS views
  FROM read_parquet([${dayList}])
`)).getRowObjects();
let report = `${new Date().toISOString()}\n`;
let totalBytes = 0;
for (const f of [...dayFiles, hourlyFile, topFile]) {
  const groups = (await conn.runAndReadAll(`SELECT count(DISTINCT row_group_id) AS n FROM parquet_metadata('${q(f)}')`)).getRowObjects()[0].n;
  const rows = (await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${q(f)}')`)).getRowObjects()[0].n;
  const size = (await stat(f)).size;
  totalBytes += size;
  const line = `${f.split('/').pop()}: ${mb(size)} (${size} bytes), ${groups} row groups, ${rows} rows`;
  console.log(line);
  report += `${line}\n`;
}
const show = (v) => (typeof v === 'bigint' ? v.toString() : String(v));
console.log(`total ${mb(totalBytes)}`);
for (const [k, v] of Object.entries(facts[0])) { console.log(`  ${k}: ${show(v)}`); report += `${k}: ${show(v)}\n`; }
await writeFile(join(root, 'data', 'build-report.txt'), report);

if (!keep) {
  for (const f of filtered) await rm(f, { force: true });
  console.log('Removed the filtered text files (use --keep to keep them).');
}
