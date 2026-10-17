# Algorithm Visualizer

Write an algorithm, then step through it one statement at a time and watch your arrays, objects, maps and sets change as
it runs.

**Try it: https://algorithmvisualizer.io/**

![The Binary heap example played from start to finish: values pushed into a min-heap sift up the tree, then are popped back out in order as the root sifts down](docs/demo.gif)

Everything runs in your browser, and nothing you write is uploaded. Supported languages: JavaScript, TypeScript, Lua,
Python, Ruby, PHP, Java, Kotlin, Swift, C#, Go, C and C++ ([details per language](#languages)).

## Features
- **Five ways to look at a value.** Each variable can be shown as:
  - **Memory**: how the values are stored (nesting, shared objects, cycles)
  - **Boxes**: just the values
  - **Grid**: rows and columns, for an array of arrays of plain values
  - **Heap**: an array as the binary tree it stands for
  - **Graph**: nodes and edges (trees, linked lists and graphs built from the keys and values)
- **Sensible defaults.** Arrays, objects, Maps and Sets start in Memory (`DEFAULT_VIEW` in
  `src/components/Variables.jsx`), an array of arrays in Grid, and an array named like a heap in Heap. Your choice is kept
  per variable while you step and edit.
- **Live editing.** The editor is always editable; an edit re-runs the code after a short pause and goes back to step 1.
- **Call tree** to see recursion and repeated subproblems.
- **Breakpoints**, and stepping backwards as easily as forwards.
- **Share links and embeds**, with no server involved.

## Getting started

    npm install
    npm run dev          # watch + unminified build (shows React warnings), served on http://localhost:8000/

Other commands:

    npm run build        # dist/algorithm-visualizer.html (one self-contained file, ~1.7 MB; Python, Ruby and PHP are downloaded on first use)
    npm run check        # lint + unit tests
    npm run test:browser # Playwright against the built file
    node tools/og-images.mjs   # after a build: public/og-image.png (the link preview) and public/apple-touch-icon.png, published beside the page
    node tools/demo-gif.mjs    # after a build: docs/demo.gif, the animation at the top of this README

## Deployment
The site is hosted on GitHub Pages, with the domain set in the repo's Pages settings. Every push to `master` is checked
(`npm run check`) and deployed by `.github/workflows/pages.yml`.

## Using the app

### Call tree
The Calls section shows either the call stack at the current step or the **call tree**: every call made so far, placed
under the call that made it (`src/graph/calltree.js`, `src/components/CallTree.jsx`).

- The tree is laid out once for the whole run, so calls keep their places while you step.
- Calls still running are tinted, the current one most.
- A finished call shows what it returned (`fib(3) → 2`).
- A call with the same arguments as an earlier one is dashed, which is how repeated subproblems (and memo hits) show up.
- The tree is shown first for a program that recurses, and is one click away for any other.

Every engine gives each stack frame an `id`, and the trace a `rets` map from that id to a preview of the returned value.
Lua and PHP rebuild their stack from the VM at each step and give no ids, so there a frame is the same call while its
name and arguments stay the same, and no return values are shown.

### Grid view
An array of arrays of plain values (a matrix, a board, a dynamic-programming table) is shown as a table with its row
and column numbers (`src/graph/grid.js`, `src/components/GridView.jsx`).

- Variables holding a valid index are tagged on the side they index: `i`, `r`, `row`, `y` on a row; `j`, `c`, `col`, `x`
  on a column; any other name on both.
- Where one tagged row meets one tagged column, that cell is outlined.
- A cell that just changed is marked.
- Rows of different lengths leave empty cells.

It works for every language's 2D arrays, from C's `int g[3][4]` to C#'s `int[3, 4]`.

### Heap view
An array of plain values, or of short tuples like `(priority, item)`, can be drawn as the binary tree it stands for: the
children of the k-th cell are the (2k + 1)-th and (2k + 2)-th, counted from the first cell whatever the array's base
(`src/graph/heap.js`). It is offered for any such array and shown first for one named like a heap (`heap`, `pq`,
`minHeap`…).

- The array is repeated as a strip of numbered cells under the tree.
- Variables holding a position (`i`, `j`, `p`, `parent`, `child`, `left`, `right`, `smallest`, `largest`, `root`, names
  ending in `idx` or `index`) are tagged on it; values (`x`, `top`, `last`) never are.
- A cell that just changed is marked, so a swap shows as two.
- Cells past a variable like `size`, `heapSize`, `n`, `count` or `end` that is smaller than the array are dashed
  (heapsort's sorted end).
- A parent out of order with its child is red. Min or max comes from the name (`maxHeap`), otherwise from how most
  parents compare with their children over the whole run, so the order wins even mid-swap.

The *Binary heap* example pushes seven values into a min-heap and pops them back out in order, in every language.

### Breakpoints
- Click a line number (or press **F9** on a line) to toggle a breakpoint.
- **Continue** (**F8**) jumps to the next step on a marked line; **previous** (**Shift+F8**) to the one before.
- Play pauses when it reaches a breakpoint, and the timeline has a tick for every hit.

Because the whole run is recorded first, going back to an earlier breakpoint is as instant as going forward.
Breakpoints follow their code as you edit (`breakpointField` in `src/editor.js`) and are cleared when an example is
loaded.

### Share and embed
**Share**, next to the pickers, gives a link that opens the code as it is, in its language, and an `<iframe>` that puts
the same thing in another page (`src/share.js`, `src/components/Share.jsx`).

- The code is compressed (deflate) into the part of the link after the `#`, so nothing is uploaded and the static site
  can open any link: `https://algorithmvisualizer.io/#lang=python&z=…`.
- **Open at step N** adds `&step=N` (counted from 1, like the timeline) to both, so the link opens on the step you were
  looking at (or the last one, for a shorter run).
- An embed link starts with `#embed&`: a slim bar replaces the header (with a link to the full page), no consent is
  asked and nothing is counted.
- Editing a shared program drops the link from the address bar, so reloading keeps the edit.

### What gets drawn as a graph
**Boxes** works for every value and **Memory** for every array, object, Map and Set. **Graph** is offered only when the
value has one of the shapes below. A Graph choice survives a step where the value is not a graph (a list shrunk to one
node): the card shows boxes and says so.

The rules live in `src/graph/semantic.js`; the same summary is behind the **?** next to *Variables* in the app. Most
shapes are recognised by shape alone; names matter only where noted.

| Shape | Example | Notes |
|---|---|---|
| Object or Map of neighbour lists (arrays or Sets) | `{ A: ["B", "C"], B: ["C"] }` | keys are the nodes |
| …a listed name with no entry of its own | `{ a: ["b", "c"], b: ["c"] }` | `c` is still a node |
| …weighted, as objects or `[name, weight]` pairs | `{ A: { B: 4 } }`, `{ A: [["B", 4]] }` | weights on the edges |
| …A→B and B→A both listed | `{ A: ["B", "C"], B: ["A", "C"], C: ["A", "B"] }` | one edge without arrowheads |
| …neighbours written as edge objects | `{ A: [{ node: "B", weight: 4 }], B: [] }` | target and weight fields† |
| Array of index arrays | `const adj = [[1, 2], [2], []]` | **variable name** must contain `graph`, `adj`, `neigh`, `tree`, or be `g` |
| …neighbours as lists of values | `const adj = [[[1, 0, 3]], [[4, 2]], []]` | the node is the first position where every list holds a node number (first, middle or last); one other number is a weight, more go on the arrow (`0, 3`) |
| Array of `[from, to]` / `[from, to, weight]` | `const edges = [[0, 1], [1, 2, 7]]` | **variable name** must contain `edge` |
| Objects holding similar objects | `{ val: 1, next: { val: 2, next: null } }` | linked lists, doubly linked lists |
| …with `left` / `right` fields | `{ val: 1, left: {…}, right: {…} }` | binary tree, sides kept |
| …with an array of children or neighbours | `{ name: "r", children: [{…}, {…}] }`, `a.nbrs = [b, c]` | n-ary trees, node-and-neighbour graphs |
| Records naming each other by key | `{ a: { next: ["b"] }, b: { next: [] } }` | keys are the nodes |
| Records naming each other by index | `[{ v: "a", out: [1, 2] }, { v: "b", out: [] }]` | **field name** must look like a link\* |
| Records naming each other by a unique `id`, `key` or `name` | `[{ id: "test", deps: ["build"] }, { id: "build", deps: [] }]` | numeric ids need a link-like field name\* |
| …with edge objects | `[{ id: "A", edges: [{ to: "B", w: 4 }] }, { id: "B", edges: [] }]` | target and weight fields† |

\* `next`, `prev`, `out`, `adj`, `neigh`, `nbr`, `edge`, `link`, `child`, `kid`, `parent`, `left`, `right`, `succ`, `pred`, `dep`, or exactly `to` / `from` / `in`.
Numbers in other fields are data, so `[{ name: "A", age: 1 }]` stays as boxes.

† An edge object's target is the first of `to`, `node`, `target`, `dest`, `id`, `key`, `name`, `vertex`, `neighbor` / `neighbour`, `v`, `n`
that names a node (or else the one field whose value is a node's key); its weight is a `weight`, `w`, `cost`, `dist`, `distance`,
`len`, `length`, `capacity`, `cap` or `time` field. Its other values are drawn on the arrow as `key value` lines
(`{ v: 1, start: 0, end: 3 }` → `start 0` / `end 3`); an edge with only a weight shows the bare number.

- **Layout** follows the shape, whichever row matched: one chain from one start is drawn as a Linked list, a branching structure with one start as a Tree, anything else as a Graph (Undirected graph when no edge has a direction).
- **Labels**: nodes named by a key or id show it; other nodes take their label from a field named `val`, `value`, `data`, `key`, `name`, `id`, `label`, `title`, `v`, `x`, `n`, `item`, `char`, `letter` or `weight`; those fields are never links. Field names match in any case, so Go's `Val`, `Next`, `Left` and `ID` count.
- **Tags**: another variable holding a node (or its name / index) shows on it as `↑ cur`; an array or Set containing nodes, or a map of flags (Go's `map[string]bool`), shows as `∈ visited`.
- **Values in a node**: each node lists its own plain values as `key value` rows (numbers, strings, booleans, short arrays; not links), up to 8 rows.
  When a node has values besides its label, the label field is a row too, so `{ id: 1, weight: 3 }` reads `id 1` / `weight 3`; a node with only a label (`{ val: 1, left, right }`) keeps the compact title.
  A value that changed since the last step is marked. Other variables never add rows to a node (they only tag it: `↑ cur`, `∈ visited`).
- **Not a graph**: lists of values that never name another entry (`{ fruits: ["apple"] }`), lone numbers (`memo = { 2: 1, 3: 2 }`), nested arrays of nodes (`kids: [[x], [y]]`).
- **Limits**: 60 nodes in Graph, 50 boxes in Memory; snapshots expand 5 levels deep, 60 items / 30 entries per container.

## Project structure
- `src/engine/` – tracing for every language. Plain JS, no DOM, no React.
  - JavaScript: acorn instrumentation and snapshotting (`typescript.js` strips TypeScript's types first).
  - `lua/`, `python/`, `ruby/`, `php/`: hosted runtimes, each with its tracer and where its runtime is loaded from.
  - `java/`, `kotlin/`, `swift/`, `cs/`, `go/`: interpreters of their own.
  - `c/`: an interpreter of its own for C and C++, with `stl.js` for the C++ library.
  - `runner.js` runs the tracers in Web Workers (bundled from `worker.js` by `build.mjs`; the page itself does not bundle
    a tracer) so an infinite loop is stopped after 3 s: a fresh worker per JavaScript run, one long-lived module worker
    each for Python, Ruby and PHP.
  - `sync.js` traces JavaScript on the current thread, for tests.
- `src/graph/` – graph math (general graphs and the Memory view are laid out by dagre, trees and lists by a small
  tidy-tree layout) and **view-model builders**. They return drawable primitives (`{tag, p, text}`), so geometry is
  testable without a DOM.
- `src/hooks/useStepper.js` – trace, step index, playback, re-runs.
- `src/editor.js` – CodeMirror 6 setup: highlighting, keys, and the current/previous step lines (the step state is
  testable without a DOM).
- `src/components/` – React UI. `CallTree.jsx` is the Calls section (stack or tree), `GridView.jsx` the Grid view,
  `Share.jsx` the Share popover. `CodePanel.jsx` hosts the CodeMirror editor, always editable: an edit re-runs the code
  (after a short pause in typing) and goes back to step 1; `Graph.jsx` turns primitives into SVG.
- `css/` – styles, inlined into the build.

### Recipes
- New example: add it to `src/examples.js`.
- New view of a value: add a builder in `src/graph/` returning `{width, height, prims}` and render it with `<Graph>`.

## Languages
Pick a language in the **Language** menu. Switching language swaps an untouched example for its twin; code you wrote or
edited is kept.

| Language | How it runs | Offline? |
|---|---|---|
| JavaScript | Instrumented and run directly | Yes |
| [TypeScript](#typescript) | Types stripped by Sucrase, then run as JavaScript | Yes |
| [Lua](#lua) | Lua 5.3 in Fengari | Yes |
| [Python](#python) | CPython via Pyodide | ~12 MB download on first run |
| [Ruby](#ruby) | Ruby 3.4 as ruby.wasm | ~8 MB download on first run |
| [PHP](#php) | PHP 8.4 as php-wasm | ~3 MB download on first run |
| [Java](#java) | Interpreter written for this page | Yes |
| [Kotlin](#kotlin) | Interpreter written for this page | Yes |
| [Swift](#swift) | Interpreter written for this page | Yes |
| [C#](#c) | Interpreter written for this page | Yes |
| [Go](#go) | Interpreter written for this page | Yes |
| [C](#c-1) | Interpreter written for this page | Yes |
| [C++](#c-2) | Same interpreter as C | Yes |

### TypeScript
The types are stripped by [Sucrase](https://github.com/alangpierce/sucrase) (`src/engine/typescript.js`) and the
JavaScript tracer runs the rest, so everything works as for JavaScript, offline.

- Sucrase keeps every line where it was (interfaces become blank lines; enums and constructor parameter properties stay
  on their lines), so steps, breakpoints and the current line point at the TypeScript you wrote.
- Types are not checked: like compiling with type errors allowed, only syntax errors stop a run.

### Lua
Lua 5.3 runs in [Fengari](https://fengari.io) (Lua written in JavaScript), bundled into the worker, so it works offline.
`src/engine/lua/tracer.js` records a snapshot before every line with a line hook, in the same format as the other
tracers.

- Tables are shown as arrays when their keys are 1…n (numbered from 1, as in Lua: Memory labels, pointer tags and
  index-based graphs all count from 1), as objects when the keys are strings, and as maps otherwise.
- A table whose metatable is a global class gets the class's name.
- A set written as a table of `true`s tags the nodes it contains.
- Lua itself reports a `function … end` definition on its `end` line.

### Python
Real CPython via [Pyodide](https://pyodide.org) (version pinned in `src/engine/python/pyodide.js`, the same as the
`pyodide` devDependency). It is downloaded from the jsDelivr CDN the first time Python is run (about 12 MB; the banner
says so) and kept loaded, so later runs are instant.

`src/engine/python/tracer.py` records a snapshot before every line with `sys.settrace`, in the same format as the
JavaScript tracer, so Memory, Boxes, Graph, breakpoints and the timeline all work the same:

- lists, tuples and deques are arrays
- dicts are objects (string keys) or maps
- sets are sets
- class instances are objects with their class name

### Ruby
Ruby 3.4 runs as [ruby.wasm](https://github.com/ruby/ruby.wasm) (version pinned in `src/engine/ruby/ruby.js`, the same
as the `@ruby/wasm-wasi` and `@ruby/3.4-wasm-wasi` devDependencies). It is downloaded from jsDelivr the first time Ruby
is run (about 8 MB) and compiled once; every run then gets a fresh VM (a few hundred ms), so classes and globals never
leak between runs.

`src/engine/ruby/tracer.rb` records a snapshot before every line with a `TracePoint`:

- arrays are arrays, hashes are objects (string or symbol keys) or maps, `Set`s are sets
- Structs and objects with instance variables are objects with their class name
- symbols name graph nodes like strings do (`{ a: [:b] }`)
- methods show `self`, and the program's own `$globals` and constants are shown

A loop with no lines in its body (`while true; end`) is only stopped by the 3 s time limit.

### PHP
PHP 8.4 runs as WebAssembly from the [php-wasm](https://github.com/seanmorris/php-wasm) project (version pinned in
`src/engine/php/php.js`, the same as the `php-wasm` devDependency), downloaded from jsDelivr the first time PHP is run
(about 3 MB) and compiled once; every run then gets a fresh PHP (about 100 ms).

PHP has no hook that can see a function's local variables, so `src/engine/php/tracer.php` rewrites the program first,
from PHP's own tokens: a call with `get_defined_vars()` goes in before every statement, on that statement's line, so
line numbers and messages are those of the code as written.

- Lists are arrays; arrays with keys are objects (string keys) or maps.
- Objects show their properties (private ones too) with their class name.
- `SplStack`, `SplQueue` and the other SPL structures are lists.
- Warnings are shown in the output, and `exit` / `die` end the run like the end of the program.
- The `<?php` tag is optional.

### Java
Java runs in an interpreter written for this page (`src/engine/java/`: `parse.js`, `interp.js`, and `lib.js` for the
library), so it works offline.

**Language:** classes with inheritance, abstract classes, interfaces (with default methods), nested, inner and anonymous
classes, generics (of one's own too: they are erased, as in Java), enums, records, lambdas and method references,
`switch` (both kinds, and switch expressions), labels, `try` / `catch` / `finally`, `var`, text blocks, `instanceof`
patterns, and a compact `void main()` file.

**Library:** `String`, `StringBuilder`, `ArrayList`, `LinkedList`, `ArrayDeque`, `Stack`, `PriorityQueue`, `HashMap`,
`LinkedHashMap`, `TreeMap`, `HashSet`, `LinkedHashSet`, `TreeSet`, `Map.Entry`, `Arrays`, `Collections`, `Math`,
`Integer` and the other wrappers, `Comparator`, `Random`, `System.out.printf`.

**Faithful to Java:** int and long overflow, integer division, char arithmetic, `==` on Strings and boxed numbers (with
the Integer cache), HashMap's own iteration order, `java.util.Random`'s numbers, the order constructors and field
initializers run in, `ConcurrentModificationException`, and Java's exceptions with their messages. What javac would
refuse (an int given a String…) is reported when the line runs.

**Not supported:** streams, threads, reflection, `Scanner` (there is no input) and classes outside `java.util`,
`java.lang`, `java.io` and `java.math`.

### Kotlin
Kotlin runs in an interpreter written for this page (`src/engine/kotlin/`: `parse.js`, `interp.js`, and `lib.js` for the
library), so it works offline.

**Language (Kotlin 2):** `fun main`, top-level functions and properties, classes (data, open, abstract, sealed, enum,
with companions), objects, interfaces, primary and secondary constructors, properties with `get()` / `set()` and
`lateinit` and `by lazy`, extension functions and properties, operators and `infix` functions, lambdas (with `it`,
trailing, labelled), function references, `when` and `if` / `try` as expressions, ranges (`..`, `until`, `downTo`,
`step`), string templates and raw strings, null safety (`?.`, `?:`, `!!`, `as?`), destructuring, labelled `break` and
`continue`, and a plain `return` from an inline lambda.

**Library:** the collection functions (`map`, `filter`, `groupBy`, `sortedBy`, `fold`, `joinToString`…), lists, sets,
maps, arrays, `ArrayDeque`, `java.util.PriorityQueue`, `StringBuilder`, `Pair` / `Triple`, comparators (`compareBy`,
`thenBy`), sequences, scope functions (`let`, `apply`…), `kotlin.math`, `Math`, `String.format`, and
`kotlin.random.Random`.

**Faithful to Kotlin on the JVM:** Int overflow, Char arithmetic (`'a' + 1` is `'b'`), doubles printed as Java prints
them (`1.0E10`), `mutableMapOf()` and `setOf()` keeping insertion order while `hashMapOf()` and `hashSetOf()` iterate in
Java's bucket order (sized as Kotlin sizes them), PriorityQueue's heap order, `Random(42)`'s numbers, `"%.2f".format`
rounding half up, the order classes initialize in, changing a list inside its `for` loop, and the JVM's exceptions with
their messages.

**Compile errors:** what the compiler would refuse is reported as Kotlin 2 words it, when the line runs: `'val' cannot
be reassigned`, `initializer type mismatch: expected 'kotlin.Double', actual 'kotlin.Int'`, a call on a nullable value
without `?.`, a `when` expression that is not exhaustive, `add` on a read-only `List`.

**Not supported:** coroutines, reflection, regular expressions, reading input, and libraries beyond those listed.

### Swift
Swift runs in an interpreter written for this page (`src/engine/swift/`: `parse.js`, `interp.js`, `values.js`, and
`lib.js` for the library), so it works offline.

**Language (Swift 6, a `main.swift` file of top-level code):** functions with argument labels, defaults, variadics,
`inout` and `throws`; structs (with memberwise inits and `mutating` methods), classes with inheritance, `init` /
`convenience init` / `super.init`, `override` and `static` members; enums with raw values, associated values, `indirect`
cases and `CaseIterable`; protocols with extensions (and default methods), extensions of the program's own and of the
library's types (`extension Int { … }`, `extension Array where …`), generics (erased), stored, computed, `lazy` and
observed (`willSet` / `didSet`) properties, subscripts, operator functions; optionals (`if let`, `guard let`, `while
let`, `?.`, `??`, `!`, `if case`), closures (with `$0`, trailing ones, captures), `switch` with patterns (tuples, ranges,
`let`, `where`, enum cases, `fallthrough`), `if` and `switch` expressions, `for … in … where`, `stride`, labels,
`defer`, `do` / `catch` / `try?` / `try!`, and tuples.

**Library:** `print`, `Int` and the other integer types, `Double` and `Float`, `Bool`, `Character`, `String` (counted in
Characters, with `String.Index`), `Array`, `Dictionary`, `Set`, ranges, the sequence functions (`map`, `filter`,
`reduce`, `sorted`, `compactMap`, `enumerated`, `zip`…), `min` / `max` / `abs` / `swap`, and Foundation's math,
`String(format:)`, `components(separatedBy:)` and `trimmingCharacters(in:)` (after `import Foundation`, as in Swift).

**Faithful to Swift:** arrays, dictionaries, sets, strings, tuples and structs are values (a copy is changed on its own;
the views draw each in its own box), class instances are shared, Int is 64 bits and overflow stops the program,
literals take the type their place needs (`let x: Double = 1`, `d * 2`), `print` writes `Optional(3)`, `[main.P(x: 1)]`
and doubles as Swift does (`1e+16`, `0.30000000000000004`), a method dispatches on the object's own class, and the
runtime's fatal errors have its words (`Fatal error: Index out of range`, `Unexpectedly found nil while unwrapping an
Optional value`).

**Compile errors:** reported as Swift words them. A function that can end without returning its value is caught before
the program runs; the rest (`cannot assign to value: 'x' is a 'let' constant`, `binary operator '*' cannot be applied
to operands of type 'Double' and 'Int'`, a missing argument label, a call to a throwing function without `try`) when
the line runs.

**Differences:** a Dictionary or Set keeps insertion order here, where real Swift picks a random order on purpose; an
arithmetic overflow, which real Swift stops on without a message, says so. `deinit` never runs.

**Not supported:** `async` / `await` and actors, key paths, property wrappers, result builders, macros, regular
expressions, reading input (`readLine()` returns nil), and libraries beyond those listed.

### C#
C# runs in an interpreter written for this page (`src/engine/cs/`: `parse.js`, `interp.js`, and `lib.js` for the
library), so it works offline.

**Language (C# 12):** top-level statements (with local functions) or a class with `Main`, classes with inheritance,
abstract and virtual members, interfaces, structs, records (with `with`), enums, generics (erased), properties (auto,
computed, `init`), constructors (`: base(…)`, `: this(…)`, primary ones), operator overloads, indexers, extension
methods, lambdas and method groups (`Func`, `Action`, `Predicate`), tuples and deconstruction, `ref` / `out` / `params`
/ named and default arguments, `switch` statements and expressions with patterns (`is int n`, `{ Length: 0 }`, `(0,
_)`, `> 5 and < 10`), nullable value types, `?.` and `??`, string interpolation with alignment and formats, collection
expressions, ranges and `^1`, `try` / `catch` (with `when`) / `finally`, `checked`.

**Library:** `Console`, `string` and `StringBuilder`, `Math`, `int.Parse` / `TryParse` and the like, `Convert`, `List`,
`Dictionary`, `HashSet`, `SortedDictionary`, `SortedSet`, `Queue`, `Stack`, `PriorityQueue`, `Array`, `Random`, and
LINQ (lazy, as in .NET: a query sees later changes to its source).

**Faithful to .NET 8:** int overflow, integer division, char arithmetic, structs and tuples copied when assigned, the
order C# runs field initializers and constructors in (the derived class's fields first), Dictionary and HashSet
enumerating in .NET's entry order (a removed entry's slot is the next one used), PriorityQueue's 4-ary heap order,
List.Sort's introsort (not stable, where OrderBy is), `new Random(42)`'s numbers, a `for` loop's variable shared by its
closures (a `foreach` one is not), changing a collection inside its `foreach`, and .NET's exceptions with their
messages. Numbers print and format as .NET 8 does with the invariant culture (`0.30000000000000004`, `1E+17`, `F2`
rounding an exact tie to even, `12.3 %`, `Infinity`), and strings compare as it does (`apple`, `Apple`, `banana`).

**Compile errors:** some are reported before the program runs (`; expected`, a switch section that falls through, not
all code paths returning a value), the rest (`Cannot implicitly convert type 'double' to 'int'`, an unassigned local,
an unknown name) when the line runs.

**Not supported:** `async` / `await`, iterators (`yield`), `decimal`, events and delegates of one's own, unsafe code,
reading input, and libraries beyond those listed.

### Go
Go runs in an interpreter written for this page (`src/engine/go/`: `parse.js`, `interp.js`, and `lib.js` for the
library), so it works offline.

**Language:** structs (with embedding), methods with value and pointer receivers (on a nil pointer too), interfaces, type
switches and assertions, generics (erased), closures, several results and named results, variadic functions, `defer` /
`panic` / `recover`, `switch` with `fallthrough`, labels, `range` over slices, maps, strings, ints, and `const` with
`iota`.

**Library:** `fmt` (Go's verbs, widths and flags), `strings` (and `Builder`), `strconv`, `sort`, `slices`, `math`,
`unicode`, `errors` (`Is`, `As`, `%w`), `container/heap`, `math/rand` and `os.Exit`.

**Faithful to Go:** a slice is a view of a backing array that `append` shares until it grows (by Go's rule: 1, 2, 4,
8…), structs and arrays are copied when assigned, each loop round has its own variable, ints wrap at their size,
constants are exact (`0.1 + 0.2` is 0.3, two float64 variables give 0.30000000000000004), strings are bytes (`len("é")`
is 2, `range` gives runes), and floats print as Go prints them (`1e+06`). fmt prints a map with its keys sorted, as Go
does. Panics have Go's messages.

**Compile errors:** the ones Go is strict about (an unused variable or import, an int where a float64 is needed, a
missing comma) are reported, the unused ones before the program runs and the others when their line runs.

**Differences:** ranging over a map goes in insertion order here, where real Go picks a random order on purpose.
`sort.Slice` keeps equal elements in order (Go's may not).

**In the views:** a rune shows as `'a'`, a slice's title gives its `len` and `cap`, a pointer to a struct is an arrow to
it, `&a[i]` tags that cell, and a `map[string]bool` tags the nodes it holds.

**Not supported:** goroutines, channels and `select`, `goto`, reading input, and packages beyond those listed.

### C
C runs in an interpreter written for this page (`src/engine/c/`: `parse.js` is the preprocessor and parser,
`interp.js` runs the tree, `printf.js` formats like glibc), so it works offline.

**Language (C99, as algorithms use it):** structs, unions, enums, typedefs, pointers and pointer arithmetic, arrays (also
variable-length and 2-D), `malloc`/`calloc`/`realloc`/`free`, function pointers, `switch`, `static` locals, `#define`
with arguments and `#ifdef`, and the usual parts of `<stdio.h>`, `<stdlib.h>`, `<string.h>`, `<ctype.h>` and
`<math.h>` (`printf`, `qsort`, `strcpy`, `sqrt`…).

**Memory:** a set of blocks with a type per byte offset, laid out like on a 64-bit Linux machine (`sizeof(int)` is 4,
`sizeof(long)` and pointers 8, structs padded), and ints wrap around like on the real machine.

**Safety:** every access is checked, so where real C silently goes wrong the run stops with an explanation: out of
bounds, NULL, use after free, double free, a pointer to a local that no longer exists, reading a variable before it is
set, division by zero, a printf `%d` given a double.

**In the views:** a pointer to a struct (or to the start of an array or of a `malloc`'d block) is drawn as that memory,
so linked structs become arrows and graphs; a pointer into an array is shown as `&a[2]` and tags that cell. Memory from
`malloc` is named by its `#id`, and an adjacency matrix (`int graph[N][N]` of 0s and 1s, or of weights) is a graph.

**Not supported:** `goto`, bit fields, `scanf` (there is no input) and `#include` of your own files.

### C++
C++ runs in the same interpreter as C, with its C++ parts switched on, so it works offline too.

**Language:** classes and structs with methods, constructors (with member initializer lists and default member
initializers), destructors, static members and operator overloading; references; `new` / `delete`; overloading and
default arguments; `auto`, range-for and structured bindings; lambdas (with captures) and `function<…>`; `try` /
`catch` / `throw`.

**Library (`src/engine/c/stl.js`):** `string`, `vector`, `pair`, `map`, `set`, their `unordered_` and `multi` kinds,
`queue`, `stack`, `deque`, `priority_queue` (with `greater<>`), `cout` with `endl`, `setw`, `setprecision` and `fixed`,
and `sort`, `reverse`, `swap`, `min` / `max`, `find`, `count`, `accumulate`, `lower_bound`, `next_permutation` and
their kin.

**Faithful to libstdc++:** a `vector` or `string` keeps its elements in a heap buffer that grows by doubling, so `&v[i]`
and `v.begin()` are ordinary pointers (shown as tags on the vector's cells), and a reference or iterator kept across a
`push_back` that reallocates is caught and explained.

**Not supported:** templates of your own, inheritance and virtual functions, namespaces other than `std`, and `cin`
(there is no input).
