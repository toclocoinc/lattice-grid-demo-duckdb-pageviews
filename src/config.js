/**
 * Where the data is, and which week it describes.
 *
 * **`DATA_URL` is the only place the data file is named.** `tools/verify.mjs`
 * imports it rather than repeating it, so pointing the page at a different
 * file is this one line.
 *
 * The file is not in the repository. `tools/build-parquet.mjs` writes it, and
 * the release box uploads it to data.latticegrid.dev, which answers HTTP range
 * requests (GitHub Pages cannot, so it cannot serve a Parquet file this way).
 * While developing, `?data=local` swaps in the copy under data/, served by
 * `tools/serve.mjs`.
 */

export const DATA_URL =
  'https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-pageviews/pageviews-2026-09-21.parquet';

/** What `?data=local` reads: the file `npm run build-data` writes. */
export const LOCAL_DATA_URL = './data/pageviews-2026-09-21.parquet';

/** The week on show, in UTC, as the data's own first and last hour. */
export const WEEK_START = '2026-09-21';
export const WEEK_LABEL = '21–27 September 2026';

/** The address DuckDB reads, absolute because it resolves paths inside a worker. */
export function dataUrl(search = location.search) {
  const wanted = new URLSearchParams(search).get('data');
  return new URL(wanted === 'local' ? LOCAL_DATA_URL : DATA_URL, location.href).href;
}
