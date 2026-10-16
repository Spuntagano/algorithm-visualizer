/** The call tree (src/graph/calltree.js): built from the steps' stacks and the engines' call ids and return values. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { callTree, callTreeView, layoutCallTree, valuesOnly } from '../src/graph/calltree.js';

const treeOf = (code, lang) => { const t = traceCode(code, lang).trace; return { t, tree: callTree(t.steps, t.rets || {}) }; };
const labels = tree => tree.nodes.map(n => n.label + (n.ret != null ? '=' + n.ret : ''));
const FIB = {
  javascript: 'function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nconsole.log(fib(3));',
  typescript: 'function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nconsole.log(fib(3));',
  lua: 'local function fib(n)\n  if n < 2 then return n end\n  return fib(n - 1) + fib(n - 2)\nend\nprint(fib(3))',
  java: 'class Main { static int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\n  public static void main(String[] a) { System.out.println(fib(3)); } }',
  kotlin: 'fun fib(n: Int): Int = if (n < 2) n else fib(n - 1) + fib(n - 2)\nfun main() { println(fib(3)) }',
  swift: 'func fib(_ n: Int) -> Int { if n < 2 { return n }; return fib(n - 1) + fib(n - 2) }\nprint(fib(3))',
  csharp: 'using System;\nclass P { static int Fib(int n) { if (n < 2) return n; return Fib(n - 1) + Fib(n - 2); }\n  static void Main() { Console.WriteLine(Fib(3)); } }',
  go: 'package main\nimport "fmt"\nfunc fib(n int) int { if n < 2 { return n }; return fib(n-1) + fib(n-2) }\nfunc main() { fmt.Println(fib(3)) }',
  c: '#include <stdio.h>\nint fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nint main(void) { printf("%d\\n", fib(3)); return 0; }',
  cpp: '#include <iostream>\nint fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nint main() { std::cout << fib(3) << std::endl; }',
};

test('every call is a node under the call that made it, with what it returned', () => {
  const { tree } = treeOf(FIB.javascript);
  assert.deepEqual(labels(tree), ['fib(3)=2', 'fib(2)=1', 'fib(1)=1', 'fib(0)=0', 'fib(1)=1']);
  assert.deepEqual(tree.nodes.map(n => n.parent), [-1, 0, 1, 1, 0]);
  assert.deepEqual(tree.nodes[0].kids, [1, 4]);
  assert.ok(tree.recursive, 'fib calls itself');
  assert.equal(tree.nodes[4].repeat, 2, 'the second fib(1) points at the first: a repeated subproblem');
  assert.equal(tree.nodes[2].repeat, -1);
});

test('in every language the engine gives each call an id and its return value', () => {
  for (const [lang, code] of Object.entries(FIB)) {
    const { t, tree } = treeOf(code, lang);
    assert.equal(t.error, null, lang);
    const fib = labels(tree).filter(l => /^fib|^Fib|\.fib/i.test(l)).map(l => l.replace(/^\w+\./, '').replace(/^Fib/, 'fib'));
    const want = lang === 'lua' ? ['fib(3)', 'fib(2)', 'fib(1)', 'fib(0)', 'fib(1)'] : ['fib(3)=2', 'fib(2)=1', 'fib(1)=1', 'fib(0)=0', 'fib(1)=1'];
    assert.deepEqual(fib, want, lang + ': ' + labels(tree).join(' '));
    assert.ok(tree.recursive, lang);
  }
});

test('two calls with the same arguments one after the other are still two calls (the ids tell them apart)', () => {
  const { tree } = treeOf('function one(x) { return x; }\nfunction two() { return one(1) + one(1); }\ntwo();');
  assert.deepEqual(labels(tree), ['two()=2', 'one(1)=1', 'one(1)=1']);
  assert.equal(tree.recursive, false, 'no function calls itself');
});

test('without ids (Lua), a frame is the same call while its name and arguments stay', () => {
  const { tree } = treeOf('local function f(n)\n  local x = n\n  return x\nend\nlocal a = f(1)\nlocal b = f(2)\nlocal c = f(1)', 'lua');
  assert.deepEqual(tree.nodes.map(n => n.label), ['f(1)', 'f(2)', 'f(1)']);
  assert.ok(tree.nodes.every(n => n.parent === -1), 'three calls from the top level');
  assert.equal(tree.nodes[2].repeat, 0);
});

test('a call that throws has no return value', () => {
  const { tree } = treeOf('function bad() { throw new Error("no"); }\nfunction safe() { try { bad(); } catch (e) {} return 7; }\nsafe();');
  assert.deepEqual(labels(tree), ['safe()=7', 'bad()']);
});

test('the arguments read like the call: names dropped, values kept', () => {
  assert.equal(valuesOnly('n=3, memo={…}'), '3, {…}');
  assert.equal(valuesOnly('$graph=[…], $start="A"'), '[…], "A"');
  assert.equal(valuesOnly(''), '');
});

test('the layout keeps every box apart and each parent over its children', () => {
  const { tree } = treeOf('function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nfib(5);');
  const lay = layoutCallTree(tree);
  assert.equal(tree.nodes.length, 15);
  for (let a = 0; a < tree.nodes.length; a++) for (let b = a + 1; b < tree.nodes.length; b++) {
    const p = lay.pos[a], q = lay.pos[b];
    if (p.y === q.y) assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x, `boxes ${a} and ${b} overlap`);
  }
  tree.nodes.forEach((n, i) => {
    const p = lay.pos[i];
    assert.ok(p.x >= 0 && p.x + p.w <= lay.width && p.y + 42 <= lay.height, 'inside the drawing');
    if (n.kids.length) {
      const first = lay.pos[n.kids[0]], last = lay.pos[n.kids.at(-1)];
      const mid = (first.x + first.w / 2 + last.x + last.w / 2) / 2, c = p.x + p.w / 2;
      assert.ok(Math.abs(c - mid) < 0.5 || (c >= first.x + first.w / 2 && c <= last.x + last.w / 2), 'over its children');
      assert.ok(n.kids.every(k => lay.pos[k].y > p.y), 'children below');
    }
  });
});

test('a recursion hundreds deep lays out without overflowing the JavaScript stack', () => {
  const { tree } = treeOf('function down(n) { if (n === 0) return 0; return down(n - 1); }\ndown(250);');
  assert.equal(tree.nodes.length, 251);
  const lay = layoutCallTree(tree);
  assert.ok(lay.height > 250 * 42);
});

test('the view at a step: calls made so far, the stack marked, the finished ones with their return values', () => {
  const { t, tree } = treeOf(FIB.javascript);
  const lay = layoutCallTree(tree);
  const s = t.steps.findIndex(st => st.stack.length === 3 && st.stack[2].args === 'n=0');   // inside fib(0)
  const v = callTreeView(tree, lay, s);
  assert.equal(v.shown, 4, 'fib(3), fib(2), fib(1), fib(0): the last fib(1) has not been called yet');
  assert.equal(v.top, 3);
  const g = v.prims.filter(p => p.tag === 'g');
  const rect = i => g.find(x => x.p['data-call'] === i).kids.find(k => k.tag === 'rect').p.className;
  assert.match(rect(3), /\bcur\b/, 'the running call');
  assert.match(rect(0), /\bon\b/, 'its callers are on the stack');
  assert.doesNotMatch(rect(2), /\bon\b|\bcur\b/, 'fib(1) has returned');
  const text = JSON.stringify(g.find(x => x.p['data-call'] === 2));
  assert.match(text, /→ /, 'a finished call shows what it returned');
  assert.doesNotMatch(JSON.stringify(g.find(x => x.p['data-call'] === 1)), /→ /, 'a running one does not yet');
  const end = callTreeView(tree, lay, t.steps.length - 1);
  assert.equal(end.shown, 5);
  assert.equal(end.repeats, 1);
  assert.match(end.caption, /^5 calls so far · 1 repeated/);
  assert.match(JSON.stringify(end.prims), /ct-node done rep/, 'the repeated call is dashed');
});
