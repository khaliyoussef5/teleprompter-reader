import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const required = [
  'scriptInput', 'speedRange', 'sizeRange', 'startBtn', 'readerScreen',
  'readerScroller', 'readerText', 'playPauseBtn', 'closeReader',
  'readerSlower', 'readerFaster', 'restartBtn', 'mirrorInput', 'lightInput',
  'focusInput', 'focusToggleBtn', 'readerSpeedRange'
];
for (const id of required) {
  assert(ids.includes(id), `Missing element: ${id}`);
}
assert.equal(new Set(ids).size, ids.length, 'HTML has duplicate IDs');
const source = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert(source, 'Missing inline JavaScript');
new Script(source, { filename: 'teleprompter.js' });
for (const [, id] of source.matchAll(/\bel\('([^']+)'\)/g)) {
  assert(ids.includes(id), `JavaScript references missing element: ${id}`);
}
assert(html.includes('requestAnimationFrame'), 'Autoscroll frame loop missing');
assert(html.includes('localStorage'), 'Local script persistence missing');
console.log('PASS — HTML element IDs, JavaScript syntax, autoscroll, and persistence.');
