/**
 * A headless Chrome driven over the DevTools protocol, with nothing to install.
 *
 * Used by tools/verify.mjs. It needs Node 22 for the global WebSocket. Input
 * goes through `Input.dispatch*`, so a click here is a real pointer event the
 * page cannot tell from a person's, not a call into the grid's API.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try { await access(path); return path; } catch { /* next */ }
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH.`);
}

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/**
 * Start a browser and attach to one page.
 *
 * @param {{width: number, height: number, mobile?: boolean, colorScheme?: 'light'|'dark'}} viewport
 */
export async function launchBrowser(viewport = { width: 1440, height: 900 }) {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`This check needs Node 22 or newer for its WebSocket. You are on ${process.version}.`);
  }
  const chromePath = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'pageviews-verify-'));
  const port = await freePort();
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    socket.onopen = ok;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  const consoleLogs = [];

  socket.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the browser went away before it answered'));
    pending.clear();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type !== 'error') {
      consoleLogs.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(`${message.params.entry.text} ${message.params.entry.url ?? ''}`.trim());
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((ok, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: ok, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: Boolean(viewport.mobile),
  });
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: viewport.colorScheme ?? 'light' }],
  });

  const evaluate = async (expression, ms = 30000) => {
    const result = await Promise.race([
      call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => { throw new Error('the page did not answer in time'); }),
    ]);
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      try { if (await evaluate(expression, 15000)) return true; } catch (error) { last = error; }
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
  };

  /** The centre of the first element matching a selector, in viewport pixels. */
  const centreOf = async (selector, index = 0) => {
    const box = await evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    return box;
  };

  const click = async (selector, index = 0) => {
    const { x, y } = await centreOf(selector, index);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  const clickAt = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  /** Focus an input by a real click, select what is in it, and type over it. */
  const type = async (selector, text, { submit = false } = {}) => {
    await click(selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).select?.()`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    if (text) await call('Input.insertText', { text });
    if (submit) await press('Enter');
  };

  const press = async (key) => {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
    const params = { key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 };
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  };

  const screenshot = async (file, { full = true } = {}) => {
    await mkdir(dirname(file), { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    await writeFile(file, Buffer.from(data, 'base64'));
  };

  const close = async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  return {
    chromePath, call, evaluate, waitFor, click, clickAt, centreOf, type, press, screenshot, close,
    navigate: (url) => call('Page.navigate', { url }),
    consoleErrors, pageErrors, consoleLogs,
  };
}
