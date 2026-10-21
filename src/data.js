/**
 * What the data is, and how the grid should read it.
 *
 * One week of the Wikimedia `pageview_complete` user-traffic files, converted
 * to a single Parquet file by tools/build-parquet.mjs: one row per page, access
 * method and hour, sorted by project and hour. Every column here exists in that
 * file; the two window-function columns exist only in the SQL below.
 */

import { WEEK_START } from './config.js';

const DAY = 24 * 3600 * 1000;
export const WEEK_START_MS = Date.parse(`${WEEK_START}T00:00:00Z`);
export const WEEK_END_MS = WEEK_START_MS + 7 * DAY;

export const ACCESS = [
  { id: 'desktop', label: 'Desktop' },
  { id: 'mobile-web', label: 'Mobile web' },
  { id: 'mobile-app', label: 'Mobile app' },
];

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The time-window presets: whole week, each day, the weekend. Bounds are UTC, end exclusive. */
export const WINDOWS = [
  { id: 'week', label: 'Whole week', from: WEEK_START_MS, to: WEEK_END_MS },
  ...DAY_NAMES.map((name, i) => ({
    id: `d${i}`,
    label: `${name} ${new Date(WEEK_START_MS + i * DAY).getUTCDate()}`,
    from: WEEK_START_MS + i * DAY,
    to: WEEK_START_MS + (i + 1) * DAY,
  })),
  { id: 'weekend', label: 'Weekend', from: WEEK_START_MS + 5 * DAY, to: WEEK_END_MS },
];

/**
 * The window the page opens on: one day. A whole-week ranking is a scan of every
 * row in the file; one day is a seventh of it, and the file is sorted by hour
 * inside each project, so the rest is skipped by row group.
 */
export const DEFAULT_WINDOW = WINDOWS.find((w) => w.id === 'd2');

/**
 * The views of the grid. Each is one grid over the same file.
 *
 * There is no grouped view. Grouping by project and by access method is pushed
 * to DuckDB by the grid, but over this file the expanded group's child rows
 * never load ("Loading rows 1 to 27" for good), so it is left out rather than
 * worked around; see the README.
 */
export const MODES = [
  { id: 'rows', label: 'Rows' },
  { id: 'spikes', label: 'Spike detection' },
];

/** Spike detection scans one project's hours with a window function; this is the one it opens on. */
export const SPIKE_DEFAULT_PROJECT = 'es.wikipedia';
/** A page below this many views in the hour is not a spike worth ranking. */
export const SPIKE_MIN_VIEWS = 50;

export const TOP_PAGES = 12;

/** Columns the adapter selects. Naming them keeps a page fetch to the column chunks it needs. */
export const BASE_FIELDS = ['project', 'page_title', 'access', 'hour', 'views'];
export const SPIKE_FIELDS = [...BASE_FIELDS, 'avg24', 'spike'];

/** The whole file as a FROM expression. */
export const fromFile = (url) => `read_parquet('${url.replaceAll("'", "''")}')`;

/**
 * One project's hours with the trailing-24-hour comparison alongside.
 *
 * `avg24` is the page's average views per hour over the 24 hours before this
 * one, counting an hour with no row as zero (the file has a row only for an
 * hour a page was seen), so it is the sum over the trailing range divided by
 * 24, and only the selected window plus the 24 hours before it is read. `spike` is this hour's views over that average. A frame is a RANGE on
 * the timestamp, not a count of rows, so a gap in a page's rows is a gap in
 * time. The first day has no 24 hours behind it, so it carries no ratio.
 *
 * The project is a literal, not a bound value, because it sits in the FROM
 * clause; it is only ever one of the names read from the file itself.
 */
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function spikeFrom(url, project, fromMs = WEEK_START_MS, toMs = WEEK_END_MS) {
  const literal = String(project).replaceAll("'", "''");
  const firstFull = stamp(WEEK_START_MS + DAY);
  return `(SELECT project, page_title, access, hour, views,
    sum(views) OVER w24 / 24.0 AS avg24,
    CASE WHEN hour >= TIMESTAMP '${firstFull}'
         THEN views / nullif(sum(views) OVER w24 / 24.0, 0) END AS spike
  FROM ${fromFile(url)}
  WHERE project = '${literal}'
    AND hour >= TIMESTAMP '${stamp(fromMs - DAY)}' AND hour < TIMESTAMP '${stamp(toMs)}'
  WINDOW w24 AS (PARTITION BY page_title, access ORDER BY hour
    RANGE BETWEEN INTERVAL 24 HOURS PRECEDING AND INTERVAL 1 HOUR PRECEDING))`;
}

const noGroup = { allowGroup: false };

/**
 * The grid's columns.
 *
 * Every filter here is one the DuckDB adapter pushes, so the whole filter tree
 * is a bound WHERE and `lastPlan().unpushed` stays empty.
 */
export function columns({ mode }) {
  const spikes = mode === 'spikes';
  return [
    { field: 'project', title: 'Project', filter: { type: 'set' }, layout: { width: 170 }, ...noGroup },
    { field: 'page_title', title: 'Page', filter: { type: 'text' }, layout: { width: 300 }, facet: false, ...noGroup },
    { field: 'access', title: 'Access', filter: { type: 'set' }, layout: { width: 130 }, ...noGroup },
    {
      field: 'hour', title: 'Hour (UTC)', type: 'datetime', filter: { type: 'date' },
      layout: { width: 190 }, ...noGroup,
    },
    {
      field: 'views', title: 'Views', type: 'number', filter: { type: 'number' }, total: 'sum',
      format: { decimals: 0 }, layout: { width: 130 }, ...noGroup,
    },
    ...(spikes ? [
      {
        field: 'avg24', title: 'Trailing 24h avg', type: 'number', format: { decimals: 1 },
        layout: { width: 150 }, facet: false, ...noGroup,
      },
      {
        field: 'spike', title: 'vs trailing 24h', type: 'number', format: { decimals: 1, suffix: '×' },
        filter: { type: 'number' }, layout: { width: 150 }, facet: false, ...noGroup,
        /* The threshold is a plain reading of the ratio: three times the page's
           own recent average is notable, ten times is a spike. */
        cell: {
          decoration: 'pill',
          variant: { when: [{ op: 'gte', value: 10, use: 'danger' }, { op: 'gte', value: 3, use: 'warning' }], default: 'none' },
        },
      },
    ] : []),
  ];
}

export const fmt = {
  int: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US')),
  ms: (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`),
  compact: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} billion`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
    return v.toLocaleString('en-US');
  },
};

/** A DuckDB `count(*)` or `sum` arrives as a BigInt; everything downstream wants a number. */
export const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));
