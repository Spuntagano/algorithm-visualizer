/** C: parsed by src/engine/c/parse.js and run by the interpreter in src/engine/c/interp.js, with checked memory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCode } from '../src/engine/sync.js';
import { runCTrace } from '../src/engine/c/interp.js';
import { HELP } from '../src/components/GraphHelp.jsx';
import { C_EXAMPLES, EXAMPLES } from '../src/examples.js';
import { markersFor } from '../src/model.js';
import { semanticGraph } from '../src/graph/semantic.js';
import { buildSemanticView } from '../src/graph/semantic-view.js';
import { buildMemoryView, buildVarGraph } from '../src/graph/memory.js';

const main = body => '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n' + body + '\n    return 0;\n}';
const last = code => runCTrace(code).steps.at(-1);
const vars = step => Object.fromEntries(step.vars.map(v => [v.name, v]));
const out = code => { const r = runCTrace(code); assert.equal(r.error, null, code); return r.logs.map(l => l.s); };
const errorOf = code => runCTrace(code).error.msg;
const kind = (step, name) => {
  const sem = semanticGraph(step, name);
  return sem ? buildSemanticView(step, null, name, sem, true).caption.split(' · ')[0] : null;
};

test('a snapshot before every statement and loop test, with the call stack, locals and globals', () => {
  const r = runCTrace('#include <stdio.h>\nint base = 10;\nint add(int x) {\n    int y = x + base;\n    return y;\n}\nint main(void) {\n    int r = add(5);\n    for (int i = 0; i < 2; i++) r++;\n    printf("%d\\n", r);\n    return 0;\n}');
  assert.equal(r.error, null);
  assert.deepEqual(r.logs, [{ type: 'log', s: '17' }]);
  assert.deepEqual(r.steps.map(s => s.line), [8, 4, 5, 9, 9, 9, 10, 11, -1],
    'the for line before each test (a body on the same line takes no step of its own), then the end');
  const inside = r.steps[2];
  assert.deepEqual(inside.stack, [{ name: 'main', args: '' }, { name: 'add', args: 'x=5' }]);
  assert.deepEqual(inside.vars.map(v => [v.name, v.scope, v.node.s]), [['x', 'local', '5'], ['y', 'local', '15'], ['base', 'global', '10']]);
  assert.ok(!r.steps[1].vars.some(v => v.name === 'y'), 'a variable appears once its declaration has run');
  assert.deepEqual(r.steps[5].vars.map(v => v.name), ['r', 'i', 'base'], 'the loop variable lives in the loop');
  assert.deepEqual(r.steps.at(-1).vars.map(v => [v.name, v.node.s]), [['r', '17'], ['base', '10']], 'the end shows main\'s variables');
  assert.deepEqual(r.steps.at(-1).stack, []);
});

test('C values become snapshot nodes: numbers, chars, bools, enums, arrays, structs, strings, uninitialized memory', () => {
  const s = last('#include <stdbool.h>\nenum Color { RED, GREEN };\nstruct P { int x; double y; };\ntypedef struct { char c; } Wrap;\nint main(void) {\n' +
    '    int n = -3; unsigned u = -1; char c = \'a\'; char nl = \'\\n\'; double d = 2; float f = 0.1f; bool b = true; long long big = 1LL << 40;\n' +
    '    enum Color col = GREEN; int arr[3] = {1}; struct P p = {1, 2.5}; Wrap w = {\'z\'}; char word[] = "hi"; int unset; const char *lit = "text";\n' +
    '    return 0;\n}');
  const v = vars(s);
  const prims = Object.fromEntries(['n', 'u', 'c', 'nl', 'd', 'f', 'b', 'big', 'col', 'unset', 'lit'].map(k => [k, [v[k].node.k, v[k].node.s]]));
  assert.deepEqual(prims, {
    n: ['num', '-3'], u: ['num', '4294967295'], c: ['char', "'a'"], nl: ['char', "'\\n'"], d: ['num', '2.0'], f: ['num', '0.1'],
    b: ['bool', 'true'], big: ['num', '1099511627776'], col: ['sym', 'GREEN'], unset: ['undef', '?'], lit: ['str', '"text"'],
  });
  assert.equal(v.arr.node.tn, 'int[3]');
  assert.deepEqual(v.arr.node.items.map(x => x.s), ['1', '0', '0'], 'the rest of an initialized array is 0');
  assert.deepEqual([v.p.node.cls, v.p.node.entries.map(([k, x]) => k + '=' + x.s)], ['struct P', ['x=1', 'y=2.5']]);
  assert.equal(v.w.node.cls, 'Wrap', 'a typedef names an anonymous struct');
  assert.deepEqual(v.word.node.items.map(x => x.s), ["'h'", "'i'", "'\\0'"], 'a char array shows its cells, with the \\0');
  assert.equal(buildVarGraph(s, 'arr').root.title, 'int[3]', 'Memory titles an array with its C type');
  assert.ok(buildMemoryView(s, null, 'arr', true).prims.length > 0);
});

test('pointers: to a struct or an array\'s start they show that memory; into an array they name and tag the cell', () => {
  const s = last(main([
    '    struct N { int val; struct N *next; } c = {3, NULL}, b = {2, &c};',
    '    int nums[4] = {5, 6, 7, 8};',
    '    int *start = nums, *third = &nums[2], *end = nums + 4, x = 9, *px = &x, *none = NULL;',
    '    int *heap = malloc(3 * sizeof(int)); heap[0] = 1;',
    '    int *mid = heap + 1, *gone = malloc(4); free(gone);',
    '    int grid[2][2] = {{1, 2}, {3, 4}}; int *cell = &grid[1][0];',
  ].join('\n')));
  const v = vars(s);
  assert.deepEqual(v.b.node.entries[1][1], { t: 'ref', id: v.c.node.id }, 'b.next is the struct c itself, so lists are arrows');
  assert.deepEqual(v.start.node, { t: 'ref', id: v.nums.node.id }, 'a pointer to an array\'s start is that array');
  assert.deepEqual(v.third.node, { t: 'p', k: 'ptr', s: '&nums[2]', to: v.nums.node.id, at: 2 });
  assert.equal(v.end.node.s, '&nums[4]', 'one past the end is a valid pointer');
  assert.deepEqual([v.px.node.s, v.none.node.s, v.gone.node.s], ['&x', 'NULL', 'dangling']);
  assert.deepEqual([v.heap.node.tn, v.heap.node.items.map(x => x.s)], ['int[3]', ['1', '?', '?']], 'malloc\'d memory is seen through its pointer, not set yet');
  assert.equal(v.mid.node.s, '&#' + v.heap.node.id + '[1]', 'memory from malloc is named by its #id');
  assert.equal(v.cell.node.s, '&grid[1][0]');
  assert.deepEqual(markersFor(v.nums.node, s.vars, 'nums'), { 2: ['third'] }, 'a pointer into an array tags its cell (one past the end does not)');
  assert.deepEqual(markersFor(v.heap.node, s.vars, 'heap'), { 1: ['mid'] });
  const idx = last(main('    int a[3] = {1, 2, 3};\n    int i = 2;'));
  assert.deepEqual(markersFor(vars(idx).a.node, idx.vars, 'a'), { 2: ['i'] }, 'an int index tags its cell too');
});

test('C arithmetic: integer division, wraparound, conversions, 64-bit, floats, pointers', () => {
  assert.deepEqual(out(main([
    '    printf("%d %d %d %d\\n", 7 / 2, -7 / 2, -7 % 2, 7 / 2 * 2);',
    '    int big = 2147483647; big++; unsigned char uc = 300; char sc = 200; unsigned u = -1;',
    '    printf("%d %d %d %u %d\\n", big, uc, sc, u, -5 >> 1);',
    '    long long f = 1; for (int i = 1; i <= 20; i++) f *= i;',
    '    printf("%lld %llu %zu\\n", f, 18446744073709551615ULL, sizeof(long));',
    '    double half = 1 / 2, real = 1.0 / 2; float third = 1.0f / 3;',
    '    printf("%.1f %.2f %.7f %d\\n", half, real, third, (int)3.99);',
    '    int a[5] = {1, 2, 3, 4, 5}; int *p = a + 1, *q = &a[4];',
    '    printf("%ld %d %d %d\\n", q - p, *(p + 2), p[-1], q > p);',
    '    printf("%d %d %d\\n", (int)sizeof(struct { char c; int i; }), (int)sizeof(int *), (int)sizeof a / (int)sizeof a[0]);',
    "    printf(\"%c%c %d\\n\", 'a' + 1, 'A' + 25, '0' + 5 - '0');",
  ].join('\n'))), ['3 -3 -1 6', '-2147483648 44 -56 4294967295 -3', '2432902008176640000 18446744073709551615 8', '0.0 0.50 0.3333333 3', '3 4 1 1', '8 8 5', 'bZ 5']);
});

test('the language: structs by value, pointers to change a caller\'s variables, recursion, switch, do-while, static, function pointers', () => {
  assert.deepEqual(out([
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '#define SQUARE(x) ((x) * (x))',
    '#define N 3',
    'typedef struct { int x, y; } P;',
    'typedef int (*Op)(int, int);',
    'void move(P p) { p.x = 99; }',
    'void move_ptr(P *p) { p->x = 99; }',
    'void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }',
    'int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }',
    'int next_id(void) { static int id = 0; return ++id; }',
    'int add(int a, int b) { return a + b; }',
    'int by_value(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }',
    'P make(int x) { P p = {x, x * 2}; return p; }',
    'int main(void) {',
    '    P p = {1, 2}, q = p;',
    '    q.y = 5; move(p); printf("%d %d %d\\n", p.x, p.y, q.y);',
    '    move_ptr(&p); printf("%d\\n", p.x);',
    '    int a = 1, b = 2; swap(&a, &b); printf("%d %d\\n", a, b);',
    '    printf("%d %d\\n", fact(5), SQUARE(N + 1));',
    '    next_id(); next_id(); printf("%d\\n", next_id());',
    '    for (int k = 1; k <= 4; k++) switch (k) { case 1: printf("one "); case 2: printf("two "); break; default: printf("many "); }',
    '    printf("\\n");',
    '    int n = 0; do { n += 3; } while (n < 10); printf("%d\\n", n);',
    '    Op op = add; printf("%d %d\\n", op(2, 3), (*op)(4, 5));',
    '    int v[] = {5, 1, 4, 2}; qsort(v, 4, sizeof v[0], by_value); printf("%d %d %d %d\\n", v[0], v[1], v[2], v[3]);',
    '    P m = make(4); printf("%d %d\\n", m.x, m.y);',
    '    P c = (P){.y = 7}; int vla[n]; vla[n - 1] = c.y; printf("%d %d %zu\\n", c.x, vla[11], sizeof vla);',
    '    return 0;',
    '}',
  ].join('\n')), ['1 2 5', '99', '2 1', '120 16', '3', 'one two two many many ', '12', '5 9', '1 2 4 5', '4 8', '0 7 48']);
});

test('strings and the standard library', () => {
  assert.deepEqual(out(main([
    '    char buf[20] = "ab";',
    '    strcat(buf, "cd"); char copy[20]; strcpy(copy, buf);',
    '    printf("%s %zu %d %d %s\\n", copy, strlen(copy), strcmp("abc", "abd") < 0, strncmp("abc", "abd", 2), strchr(copy, \'c\'));',
    '    char line[32]; sprintf(line, "%s=%03d", "x", 7); puts(line);',
    '    int *zeros = calloc(3, sizeof(int)); int *more = realloc(zeros, 5 * sizeof(int)); more[4] = 1;',
    '    int arr[4]; memset(arr, 0, sizeof arr); int dst[4]; memcpy(dst, arr, sizeof arr);',
    '    printf("%d %d %d %d\\n", more[0], more[4], arr[3], dst[2]);',
    '    printf("%d %d %c %d %.1f %.0f %.3f\\n", abs(-4), atoi("42"), toupper(\'q\'), isdigit(\'7\') != 0, sqrt(2.25), pow(2, 10), fabs(-0.5));',
    '    printf("[%5d|%-5d|%+d|%x|%X|%o|%#x|%5.1f|%e|%g|%s|%c|%%]\\n", 42, 42, 42, 255, 255, 8, 255, 3.14159, 1234.5, 0.0001, "hi", 65);',
    '    printf("%10.3s|%-4s|%.2e|%g|%g\\n", "abcdef", "x", 123456.0, 100000.0, 1e-5);',
    '    putchar(\'o\'); putchar(\'k\'); putchar(\'\\n\');',
    '    fprintf(stderr, "careful\\n");',
    '    printf("no newline at the end");',
  ].join('\n'))), ['abcd 4 1 0 cd', 'x=007', '0 1 0 0', '4 42 Q 1 1.5 1024 0.500',
    '[   42|42   |+42|ff|FF|10|0xff|  3.1|1.234500e+03|0.0001|hi|A|%]', '       abc|x   |1.23e+05|100000|1e-05', 'ok', 'careful', 'no newline at the end']);
  assert.equal(runCTrace(main('    fprintf(stderr, "careful\\n");')).logs[0].type, 'error', 'stderr is shown as an error line');
  assert.match(runCTrace(main('    char s[8];\n    sprintf(s, "%d", 1);\n    int x = 2;')).steps.at(-1).vars[0].node.items.map(x => x.s).join(''), /^'1''\\0'\?/);
});

test('memory errors are caught where C would silently go wrong, with the line and a plain explanation', () => {
  const cases = [
    ['int a[5];\n    for (int i = 0; i <= 5; i++) a[i] = i;', /^Error on line 6: a\[5\] is out of bounds: a has 5 elements \(indexes 0 to 4\)$/],
    ['int *p = NULL;\n    *p = 1;', /line 6: \*p: p is NULL \(a crash in C: segmentation fault\)/],
    ['struct N { int v; struct N *next; } n = {1, NULL};\n    int v = n.next->v;', /n\.next->v: n\.next is NULL/],
    ['int *p = malloc(sizeof(int));\n    free(p);\n    *p = 2;', /line 7: \*p is in memory that was freed on line 6 \(use after free\)/],
    ['int *p = malloc(4);\n    free(p);\n    free(p);', /free\(p\): this memory was already freed on line 6 \(double free\)/],
    ['int x = 1;\n    free(&x);', /free\(&x\): &x points to x, not to memory from malloc/],
    ['int sum;\n    sum += 1;', /line 6: sum is used before it is given a value/],
    ['int *p = malloc(2 * sizeof(int));\n    int x = p[0];', /p\[0\] is used before it is given a value \(malloc does not clear memory: calloc does\)/],
    ['int *p = malloc(2 * sizeof(int));\n    p[2] = 1;', /p\[2\] is out of bounds: the block malloc gave on line 5 holds 8 bytes \(2 ints, indexes 0 to 1\)/],
    ['char *s = "abc";\n    s[0] = \'x\';', /s\[0\] is inside a string literal, which cannot be changed/],
    ['int z = 0;\n    int r = 10 / z;', /line 6: 10 \/ z: division by zero/],
    ['char s[3];\n    strcpy(s, "abc");', /strcpy\(\)'s destination s is out of bounds: s has 3 elements/],
    ['double d = 2.5;\n    printf("%d\\n", d);', /printf\(\): %d prints an integer, but d is a double \(use %f, or \(int\)d\)/],
    ['int n = 3;\n    printf("%s\\n", n);', /%s prints a string, but n is an int/],
    ['printf("%d %d\\n", 1);', /has more % conversions than there are values/],
  ];
  for (const [body, re] of cases) assert.match(errorOf(main('    ' + body)), re, body);
  assert.match(errorOf('int *f(void) { int x = 1; return &x; }\nint main(void) {\n    int *p = f();\n    return *p;\n}'),
    /line 4: \*p is in x, a local variable of f\(\) that no longer exists/);
  assert.match(errorOf('int f(void) { }\nint main(void) {\n    return f();\n}'), /f\(\) ended without returning a value/);
  assert.match(errorOf('int f(int a) { return a; }\nint main(void) {\n    return f(1, 2);\n}'), /f\(\) takes 1 argument, but is given 2/);
  assert.match(errorOf(main('    y = 1;')), /y is not declared/);
  assert.match(errorOf(main('    int n = 2;\n    assert(n == 3);')), /Assertion failed: n == 3/);
  const r = runCTrace(main('    int i = 0;\n    i = 1;\n    i = i / 0;'));
  assert.equal(r.steps.at(-1).line, 7, 'the last step is the line that failed');
  assert.equal(vars(r.steps.at(-1)).i.node.s, '1');
});

test('runaway programs are stopped; exit() ends the run', () => {
  assert.match(errorOf(main('    while (1);')), /Trace stopped after 3000 steps/);
  assert.match(errorOf(main('    for (;;) {}')), /Trace stopped after 3000 steps/, 'an empty loop still takes a step per round');
  assert.match(errorOf('int f(int n) { return f(n + 1); }\nint main(void) { return f(0); }'), /more than 300 nested calls/);
  const ok = runCTrace(main('    int x = 1;\n    exit(0);\n    x = 2;'));
  assert.equal(ok.error, null);
  assert.equal(vars(ok.steps.at(-1)).x.node.s, '1', 'the end shows the variables when exit() was called');
  assert.deepEqual(runCTrace(main('    exit(3);')).error, { msg: 'The program called exit(3).', soft: true });
});

test('syntax errors say where and what', () => {
  const syntax = code => traceCode(code, 'c').error;
  assert.equal(syntax('int main(void) {\n    int x = 1\n    return x;\n}'), "Syntax error: line 2: expected ';' at the end of the line");
  assert.equal(syntax('int main(void) {\n    int x = = 1;\n}'), "Syntax error: line 2: expected an expression before '='");
  assert.equal(syntax('int main(void) {\n    if (1 {\n    }\n}'), "Syntax error: line 2: expected ')' after the condition before '{'");
  assert.equal(syntax('int main(void) {\n    return 0;\n'), "Syntax error: line 2: expected '}' at the end of the program");
  assert.match(syntax('x = 1;'), /line 1: expected a declaration \(a type\) before 'x': statements go inside a function such as int main\(void\)/);
  assert.match(syntax('#include "mine.h"\nint main(void) { return 0; }'), /line 1: #include "mine.h": only the standard headers/);
  assert.match(syntax('int f(void) { return 1; }'), /there is no main\(\) function/);
  assert.match(syntax('int main(void) {\n    goto end;\n}'), /line 2: goto is not supported/);
  assert.match(syntax('int main(void) {\n    char c = \'ab\';\n}'), /line 2: a character constant holds one character/);
  assert.deepEqual(traceCode('   \n', 'c'), { empty: true }, 'no code is not an error');
});

test('the preprocessor: #define with arguments, #ifdef, #if, predefined limits', () => {
  assert.deepEqual(out([
    '#include <stdio.h>',
    '#include <limits.h>',
    '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
    '#define STR(x) #x',
    '#define DEBUG 1',
    '#if DEBUG && defined(MAX)',
    '#define NAME "debug"',
    '#else',
    '#define NAME "release"',
    '#endif',
    '#ifndef MISSING',
    '#define LIMIT 10',
    '#endif',
    'int main(void) {',
    '    printf("%d %s %s %d %d %d\\n", MAX(3, LIMIT), NAME, STR(a + b), INT_MAX, INT_MIN, RAND_MAX > 0);',
    '    return 0;',
    '}',
  ].join('\n')), ['10 debug a + b 2147483647 -2147483648 1']);
});

test('graphs: linked structs, adjacency matrices, edge lists and structs that name each other', () => {
  const s = last(main([
    '    struct T { int val; struct T *left, *right; } l = {2, NULL, NULL}, r = {3, NULL, NULL}, root = {1, &l, &r};',
    '    int adj[3][3] = {{0, 1, 1}, {0, 0, 1}, {0, 0, 0}};',
    '    int graph[3][3] = {{0, 4, 0}, {0, 0, 7}, {2, 0, 0}};',
    '    int grid[3][3] = {{0, 1, 1}, {0, 0, 1}, {0, 0, 0}};',
    '    _Bool visited[3] = {1, 0, 1};',
  ].join('\n')));
  assert.equal(kind(s, 'root'), 'Tree');
  const m = semanticGraph(s, 'adj');
  assert.deepEqual(m.edges.map(e => e.from + '>' + e.to), ['0>1', '0>2', '1>2'], 'adj[a][b] = 1 is an arrow from a to b');
  assert.deepEqual(semanticGraph(s, 'graph').edges.map(e => e.from + '>' + e.to + ':' + e.weight), ['0>1:4', '1>2:7', '2>0:2'], 'other numbers are weights');
  assert.equal(semanticGraph(s, 'grid'), null, 'the name decides: a grid is data');
  const text = buildSemanticView(s, null, 'adj', m, true).prims.map(q => q.text);
  assert.equal(text.filter(t => t === '∈ visited').length, 2, 'an array of bool flags tags the nodes whose flag is true');
  const js = traceCode('const adj = [[0, 1], [1, 0]];\nconst g = [[1], [0]];').trace.steps.at(-1);
  const edges = name => semanticGraph(js, name).edges.map(e => [e.from, e.to, !!e.undirected]);
  assert.deepEqual(edges('adj'), edges('g'), 'a matrix in any language: [[0, 1], [1, 0]] is the same graph as the neighbour lists [[1], [0]]');
  assert.equal(edges('g').length, 1, '(0 → 1 and 1 → 0: one line)');
});

test('every C example runs, prints like its twin, and its graphs are found', () => {
  assert.deepEqual(Object.keys(C_EXAMPLES).map(n => n.replace(/ \(.*\)/, '')), Object.keys(EXAMPLES).map(n => n.replace(/ \(.*\)/, '')),
    'one C twin per JavaScript example, in the same order');
  for (const [name, code] of Object.entries(C_EXAMPLES)) {
    const r = runCTrace(code);
    assert.equal(r.error, null, name);
    assert.ok(r.steps.length > 3 && r.logs.length > 0, name);
  }
  const logs = name => runCTrace(C_EXAMPLES[name]).logs.map(l => l.s);
  assert.deepEqual(logs('Bubble sort'), ['1 2 5 6 9 ']);
  assert.deepEqual(logs('Binary search'), ['found at index 5']);
  assert.deepEqual(logs('Two sum'), ['[2, 3]']);
  assert.deepEqual(logs('Fibonacci with memo'), ['8']);
  assert.deepEqual(logs('Reverse a linked list'), ['3']);
  assert.deepEqual(logs('Breadth-first search'), ['A B C D E F ']);
  const bfs = runCTrace(C_EXAMPLES['Breadth-first search']).steps.find(s => s.stack.length === 2 && s.vars.some(v => v.name === 'cur'));
  assert.equal(kind(bfs, 'graph'), 'Graph');
  const ds = last(C_EXAMPLES['Data structures']);
  for (const [n, k] of [['adj', 'Graph'], ['graph_w', 'Graph'], ['edges', 'Graph'], ['tree', 'Tree'], ['linked', 'Linked list'], ['va', 'Graph'], ['jobs', 'Graph'], ['pool', 'Linked list']])
    assert.equal(kind(ds, n), k, n);
  for (const n of ['nums', 'word', 'pt', 'heap']) assert.equal(kind(ds, n), null, n + ' is data');
});

test('every C example in the graph help really is drawn as a graph', () => {
  for (const [, items] of HELP.c.shapes) for (const [code, , full, name] of items) {
    const program = full || main('    ' + code);
    const r = runCTrace(program);
    assert.equal(r.error, null, code);
    const v = name || code.match(/(\w+)\s*\[/)[1];
    assert.ok(semanticGraph(r.steps.at(-1), v), 'not a graph: ' + code);
  }
  assert.equal(semanticGraph(last(main('    struct { int age; } x = {1};')), 'x'), null, HELP.c.age + ' is data');
  assert.equal(semanticGraph(last(main('    const char *x[] = ' + HELP.c.fruits + ';')), 'x'), null, HELP.c.fruits + ' is data');
});
