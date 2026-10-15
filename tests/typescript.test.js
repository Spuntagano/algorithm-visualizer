/** TypeScript: types stripped by Sucrase (src/engine/typescript.js), then traced as JavaScript. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { stripTypes } from '../src/engine/typescript.js';
import { EXAMPLES, TS_EXAMPLES } from '../src/examples.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';

const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('every TypeScript example runs, prints what its JavaScript twin prints, and finds the same graphs', () => {
  assert.deepEqual(Object.keys(TS_EXAMPLES), Object.keys(EXAMPLES), 'one TypeScript twin per JavaScript example');
  for (const [name, code] of Object.entries(TS_EXAMPLES)) {
    const ts = traceCode(code, 'typescript'), js = traceCode(EXAMPLES[name]);
    assert.ok(ts.trace, name + ': ' + ts.error);
    assert.equal(ts.trace.error, null, name);
    assert.deepEqual(ts.trace.logs.map(l => l.s), js.trace.logs.map(l => l.s), name + ' prints the same');
  }
  const ds = traceCode(TS_EXAMPLES['Data structures'], 'typescript').trace.steps.at(-1);
  for (const [n, k] of [['g1', 'Graph'], ['g2', 'Graph'], ['adj', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['jobs', 'Graph'], ['intervals', 'Graph']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'scores', 'Color', 'pair']) assert.equal(kind(ds, n), null, n + ' is data (an enum too)');
});

test('line numbers are the TypeScript ones: steps never land on types, lines after them keep their numbers', () => {
  for (const [name, code] of Object.entries(TS_EXAMPLES)) {
    assert.equal(stripTypes(code).split('\n').length, code.split('\n').length, name + ': same number of lines');
    const lines = code.split('\n');
    for (const s of traceCode(code, 'typescript').trace.steps) {
      if (s.line < 1) continue;
      const src = lines[s.line - 1].trim();
      assert.ok(src && !/^(interface|type)\s/.test(src) && !src.startsWith('//'), `${name}: step on line ${s.line} "${src}" is code`);
    }
  }
  const code = 'interface P {\n  x: number;\n}\nconst p: P = { x: 1 };\nlet y = p.x + 1;';
  assert.deepEqual(traceCode(code, 'typescript').trace.steps.map(s => s.line), [4, 5, -1], 'the interface takes up its lines, the code keeps its numbers');
});

test('TypeScript-only features run: enums, parameter properties, generics, as / !, and type errors do not stop a run', () => {
  const t = traceCode([
    'enum Dir { Up, Down = 5 }',
    'class Box<T> { constructor(public value: T, private tag = "box") {} }',
    'const b = new Box<number>(Dir.Down);',
    'const n = (b.value as number)!;',
    'let wrong: number = "not a number" as any;',
    'console.log(n, Dir[5]);',
  ].join('\n'), 'typescript');
  assert.equal(t.trace.error, null);
  assert.deepEqual(t.trace.logs.map(l => l.s), ['5 Down']);
  const box = t.trace.steps.at(-1).vars.find(v => v.name === 'b').node;
  assert.equal(box.cls, 'Box'); assert.deepEqual(box.entries.map(e => e[0]), ['value', 'tag'], 'parameter properties become fields');
  assert.match(traceCode('let x: = 1;', 'typescript').error, /^Syntax error: Unexpected token \(1:8\)/, 'syntax errors say where (line 1, column 8: the =)');
});
