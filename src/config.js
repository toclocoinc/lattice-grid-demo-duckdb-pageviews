/**
 * Where the data is, and which week it describes.
 *
 * **`DATA_BASE` and the file names below are the only place the data is named.**
 * `tools/verify.mjs` imports them rather than repeating them.
 *
 * The data is one Parquet file per day plus a small hourly table. None of it is
 * in the repository: `tools/build-parquet.mjs` writes it, and the release box
 * uploads it to data.latticegrid.dev, which answers HTTP range requests (GitHub
 * Pages cannot, so it cannot serve a Parquet file this way). The page opens only
 * the days inside the selected window. While developing, `?data=local` swaps in
 * the copies under data/, served by `tools/serve.mjs`.
 */

export const DATA_BASE = 'https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-pageviews/';

/** What `?data=local` reads: the files `npm run build-data` writes. */
export const LOCAL_DATA_BASE = './data/';

/** The Monday the week starts on, as the file names carry it. */
const FIRST_DAY = '2026-09-21';

/** The file for day `i` of the week (0 is Monday): one Parquet file per UTC day. */
export const dayFileName = (i) => {
  const d = new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + i * 24 * 3600 * 1000);
  return `pageviews-${d.toISOString().slice(0, 10)}.parquet`;
};

/** The week's top pages per project and access method: the whole-week ranking reads this instead of every row. */
export const TOP_FILE = `top-pages-${FIRST_DAY}.parquet`;

/** Views and page counts per project, access method and hour: a few thousand rows for the whole week. */
export const HOURLY_FILE = `hourly-by-project-${FIRST_DAY}.parquet`;

/** The week on show, in UTC, as the data's own first and last hour. */
export const WEEK_START = '2026-09-21';
export const WEEK_LABEL = '21–27 September 2026';

/**
 * The addresses DuckDB reads, absolute because it resolves paths inside a worker.
 *
 * @returns {{days: string[], hourly: string, top: string}} the seven day files, Monday first, the hourly table and the top-pages table
 */
export function dataUrls(search = location.search) {
  const wanted = new URLSearchParams(search).get('data');
  const base = new URL(wanted === 'local' ? LOCAL_DATA_BASE : DATA_BASE, location.href).href;
  return {
    days: Array.from({ length: 7 }, (_, i) => new URL(dayFileName(i), base).href),
    hourly: new URL(HOURLY_FILE, base).href,
    top: new URL(TOP_FILE, base).href,
  };
}
