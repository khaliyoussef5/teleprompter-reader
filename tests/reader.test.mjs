import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/i)[1];

// Exercise the real application with a deterministic animation clock and a
// browser that rounds scrollTop to whole pixels (the low-speed regression).
function reader({ saved, storageFails = false, navigator = {} } = {}) {
  const nodes = new Map();
  const frames = new Map();
  const events = new Map();
  let frameId = 0;
  let time = 0;
  let stored = saved;
  const document = {
    hidden: false, body: { style: {} }, activeElement: { tagName: 'BODY' },
    getElementById: id => nodes.get(id),
    addEventListener: (name, fn) => events.set(name, fn),
  };
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    let top = 0;
    const listeners = new Map();
    const classes = new Set();
    const node = {
      value: '', checked: false, textContent: '', disabled: false, hidden: id === 'readerScreen',
      tagName: id === 'scriptInput' ? 'TEXTAREA' : 'BUTTON',
      scrollHeight: 2400, clientHeight: 600, attributes: {},
      style: { setProperty(k, v) { this[k] = v; } },
      classList: { toggle(k, enabled) { enabled ? classes.add(k) : classes.delete(k); }, contains: k => classes.has(k) },
      addEventListener: (name, fn) => listeners.set(name, fn),
      setAttribute(k, v) { this.attributes[k] = v; },
      focus() { document.activeElement = node; },
      emit(name, detail = {}) { listeners.get(name)?.({ target: node, ...detail }); },
      get scrollTop() { return top; },
      set scrollTop(v) { top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, Math.round(v))); },
    };
    nodes.set(id, node);
  }
  nodes.get('readerScroller').tagName = 'DIV';
  runInNewContext(source, {
    document, navigator, confirm: () => true,
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    localStorage: {
      getItem() { if (storageFails) throw Error('blocked'); return stored ?? null; },
      setItem(_k, value) { if (storageFails) throw Error('blocked'); stored = value; },
    },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const node = id => nodes.get(id);
  const click = id => node(id).emit('click');
  const input = (id, value) => { node(id).value = value; node(id).emit('input'); };
  const tick = (count = 1, ms = 1000 / 60) => {
    for (let i = 0; i < count; i++) {
      time += ms;
      const current = [...frames.values()]; frames.clear();
      current.forEach(fn => fn(time));
    }
  };
  return { node, click, input, tick, frames, events, stored: () => JSON.parse(stored), document };
}

test('slow scrolling accumulates fractional pixels instead of stalling', () => {
  const r = reader(); r.input('speedRange', '2'); r.click('startBtn'); r.tick(301);
  assert(Math.abs(r.node('readerScroller').scrollTop - 10) <= 1);
});
test('pause/resume preserves position and ignores time spent paused', () => {
  const r = reader(); r.click('startBtn'); r.tick(61); r.click('playPauseBtn');
  const top = r.node('readerScroller').scrollTop; r.tick(600);
  assert.equal(r.node('readerScroller').scrollTop, top);
  r.click('playPauseBtn'); r.tick(61);
  assert(Math.abs(r.node('readerScroller').scrollTop - top - 30) <= 1);
  assert.equal(r.frames.size, 1);
});
test('zero speed remains zero on open and does not silently start scrolling', () => {
  const r = reader(); r.input('speedRange', '0'); r.click('startBtn'); r.tick(61);
  assert.equal(r.node('readerScroller').scrollTop, 0);
  assert.equal(r.node('speedRange').value, 0);
  assert.equal(r.frames.size, 0);
});
test('manual scroll becomes the next animation position; restart returns to zero', () => {
  const r = reader(); r.click('startBtn'); r.tick(30);
  r.node('readerScroller').scrollTop = 500; r.node('readerScroller').emit('scroll'); r.tick(61);
  assert(Math.abs(r.node('readerScroller').scrollTop - 530) <= 1);
  r.click('restartBtn'); assert.equal(r.node('readerScroller').scrollTop, 0);
});
test('end of text and non-scrollable text stop the frame loop', () => {
  const r = reader(); r.node('readerScroller').scrollHeight = 610;
  r.click('startBtn'); r.tick(100);
  assert.equal(r.frames.size, 0); assert.equal(r.node('progressTrack').attributes['aria-valuenow'], '100');
  r.node('readerScroller').scrollHeight = 600; r.click('restartBtn'); r.tick(3);
  assert.equal(r.frames.size, 0);
});
test('Space controls reading while a reader button has focus', () => {
  const r = reader(); r.click('startBtn'); r.node('closeReader').focus();
  let prevented = false;
  r.events.get('keydown')({ code: 'Space', key: ' ', preventDefault() { prevented = true; } });
  assert(prevented); assert.equal(r.frames.size, 0); assert.equal(r.node('readerScreen').hidden, false);
});
test('dragging to scroll does not toggle playback', () => {
  const r = reader(); r.click('startBtn');
  r.node('readerScroller').emit('pointerdown', { clientX: 50, clientY: 100 });
  r.node('readerScroller').emit('pointermove', { clientX: 50, clientY: 180 });
  r.node('readerScroller').emit('pointerup'); r.click('readerScroller');
  assert.equal(r.frames.size, 1);
});
test('Arabic text, preferences and mirror survive reload; empty text stays empty', () => {
  const r = reader(); r.input('scriptInput', 'نص اختبار عربي\nNiveau de ton'); r.input('sizeRange', '60');
  r.node('mirrorInput').checked = true; r.node('mirrorInput').emit('change');
  const next = reader({ saved: JSON.stringify(r.stored()) }); next.click('startBtn');
  assert.equal(next.node('readerText').textContent, 'نص اختبار عربي\nNiveau de ton');
  assert.equal(next.node('sizeRange').value, 60); assert(next.node('readerText').classList.contains('mirrored'));
  next.click('closeReader'); next.input('scriptInput', '');
  assert(reader({ saved: JSON.stringify(next.stored()) }).node('startBtn').disabled);
});
test('invalid saved settings and unavailable storage do not break startup', () => {
  for (const saved of ['{broken', 'null', '[]', '"text"', '{"speed":null,"size":null}']) {
    const r = reader({ saved }); assert.equal(r.node('speedRange').value, 30); assert.equal(r.node('sizeRange').value, 44);
  }
  const r = reader({ storageFails: true }); r.click('startBtn'); r.tick(61);
  assert(r.node('readerScroller').scrollTop > 0);
});
test('a wake lock arriving after pause is released', async () => {
  let resolve; let releases = 0;
  const r = reader({ navigator: { wakeLock: { request: () => new Promise(r => { resolve = r; }) } } });
  r.click('startBtn'); r.click('playPauseBtn'); resolve({ release: async () => { releases++; } });
  await new Promise(r => setImmediate(r)); assert.equal(releases, 1);
});

test('reader speed slider and +/- buttons change live scroll speed noticeably', () => {
  const r = reader();
  r.click('startBtn'); r.tick(61);
  const start = r.node('readerScroller').scrollTop;
  assert(Math.abs(start - 30) <= 1);
  r.click('readerFaster');
  assert.equal(r.node('readerSpeedRange').value, 50);
  assert.equal(r.node('readerSpeedOutput').textContent, '50 px/s');
  r.tick(61);
  assert(Math.abs(r.node('readerScroller').scrollTop - start - 50) <= 1);
  const next = r.node('readerScroller').scrollTop;
  r.input('readerSpeedRange', '180');
  assert.equal(r.node('speedRange').value, 180);
  assert.equal(r.node('readerSpeedOutput').textContent, '180 px/s');
  // The animation clock is already running: 60 frames = one second.
  r.tick(60);
  assert(Math.abs(r.node('readerScroller').scrollTop - next - 180) <= 1);
});

test('speed zero stops, restoring speed restarts, manual pause stays paused', () => {
  const r = reader();
  r.click('startBtn');
  r.input('readerSpeedRange', '0');
  assert.equal(r.frames.size, 0);
  r.input('readerSpeedRange', '80');
  assert.equal(r.frames.size, 1);
  r.tick(61);
  assert(Math.abs(r.node('readerScroller').scrollTop - 80) <= 1);
  r.click('playPauseBtn');
  r.input('readerSpeedRange', '220');
  assert.equal(r.frames.size, 0);
  assert.equal(r.node('readerSpeedRange').value, 220);
});

test('reader speed remains visible on compact screens', () => {
  assert(html.includes('id="readerSpeedRange"'));
  assert(html.includes('id="readerSpeedOutput"'));
  assert(!html.includes('.read-speed{display:none}'));
});

test('focus mode defaults on and can be toggled without leaving the reader', () => {
  const r = reader();
  assert.equal(r.node('focusInput').checked, true);
  assert.equal(r.node('focusToggleBtn').attributes['aria-pressed'], 'true');
  r.click('startBtn');
  assert(r.node('readerScreen').classList.contains('focus-on'));
  r.tick(61);
  const top = r.node('readerScroller').scrollTop;
  r.click('focusToggleBtn');
  assert.equal(r.node('focusInput').checked, false);
  assert.equal(r.node('focusToggleBtn').attributes['aria-pressed'], 'false');
  assert.equal(r.node('readerScreen').classList.contains('focus-on'), false);
  assert.equal(r.node('readerScroller').scrollTop, top);
  assert.equal(r.frames.size, 1);
  r.tick(60);
  assert(Math.abs(r.node('readerScroller').scrollTop - top - 30) <= 1);
});

test('focus preference persists and works with mirror/light and live speed', () => {
  const r = reader();
  r.node('focusInput').checked = false; r.node('focusInput').emit('change');
  assert.equal(r.stored().focus, false);
  const reloaded = reader({ saved: JSON.stringify(r.stored()) });
  reloaded.click('startBtn');
  assert.equal(reloaded.node('readerScreen').classList.contains('focus-on'), false);
  reloaded.click('focusToggleBtn');
  assert.equal(reloaded.stored().focus, true);
  reloaded.input('readerSpeedRange', '160');
  reloaded.node('mirrorInput').checked = true; reloaded.node('mirrorInput').emit('change');
  reloaded.node('lightInput').checked = true; reloaded.node('lightInput').emit('change');
  assert(reloaded.node('readerScreen').classList.contains('focus-on'));
  assert(reloaded.node('readerScreen').classList.contains('light'));
  assert(reloaded.node('readerText').classList.contains('mirrored'));
  assert.equal(reloaded.node('speedRange').value, 160);
});
