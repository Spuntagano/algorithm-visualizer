/**
 * The "i" next to the Language picker: what runs the language picked, what of it is included and what is not. A native
 * popover like the graph help (GraphHelp.jsx). Each entry sums up the language's section of the README; keep the two
 * in step. tests/components.test.jsx checks that every language in the picker has one.
 */
import { useRef } from 'react';
import { usePopover } from '../hooks/usePopover.js';

/** Per language: `runs` (what runs it), `has` (included) and `not` (not included). */
export const LANG_INFO = {
  javascript: {
    runs: 'Your browser’s own JavaScript engine, in a worker, offline.',
    has: [
      'All of the language: classes, closures, destructuring, generators, getters and setters, BigInt, regular expressions',
      'The built-in library: Array, Map, Set, Math, JSON, String, Date…',
      'console.log, console.error and the like in the output',
    ],
    not: [
      'Steps inside async functions and generators are shown, but they get no frame in the call stack',
      'Code that runs after the program ends (setTimeout, promises still waiting)',
      'The page itself: there is no DOM, fetch or input',
    ],
  },
  typescript: {
    runs: 'The types are removed (by Sucrase) and the JavaScript runs as above, offline.',
    has: [
      'Everything JavaScript has, written with types: interfaces, generics, enums, type aliases, parameter properties',
      'Lines stay where you wrote them, so steps and breakpoints match your code',
    ],
    not: [
      'Type checking: like compiling with type errors allowed, only syntax errors stop a run',
      'Modules and imports, decorators, namespaces across files',
      'The page itself: there is no DOM, fetch or input',
    ],
  },
  lua: {
    runs: 'Lua 5.3 in Fengari (Lua written in JavaScript), offline.',
    has: [
      'All of Lua 5.3: tables, metatables and classes made with them, closures, coroutines, varargs, goto',
      'The standard library: string, table, math, utf8, os.time and os.clock',
    ],
    not: [
      'Reading input (io.read) and files',
      'C modules and require of other files',
    ],
  },
  python: {
    runs: 'Real CPython (Pyodide), downloaded the first time Python runs (about 12 MB).',
    has: [
      'All of Python: classes, dataclasses, generators, comprehensions, decorators, match',
      'The standard library: collections (deque, Counter, defaultdict), heapq, bisect, itertools, functools, math…',
    ],
    not: [
      'input() and reading files: there is no input',
      'Packages from pip (numpy and the like)',
      'Threads and the network',
    ],
  },
  ruby: {
    runs: 'Real Ruby 3.4 (ruby.wasm), downloaded the first time Ruby runs (about 8 MB).',
    has: [
      'All of Ruby: classes, modules, blocks and procs, Structs, Comparable and Enumerable, pattern matching',
      'The core library and Set; your $globals and constants are shown',
    ],
    not: [
      'gets and reading files: there is no input',
      'Gems',
      'Threads and the network',
    ],
  },
  php: {
    runs: 'Real PHP 8.4 (php-wasm), downloaded the first time PHP runs (about 3 MB).',
    has: [
      'All of PHP: classes, interfaces, traits, enums, closures and arrow functions, match',
      'Arrays, the string and array functions, and the SPL structures (SplStack, SplQueue, SplPriorityQueue…)',
      'Warnings in the output; exit and die end the run',
    ],
    not: [
      'Reading input (STDIN, fgets) and files',
      'The network and extensions the WebAssembly build does not have',
    ],
  },
  java: {
    runs: 'An interpreter written for this page, offline.',
    has: [
      'Classes, inheritance, interfaces, nested and anonymous classes, generics, enums, records',
      'Lambdas and method references, both kinds of switch, try / catch / finally, var, text blocks',
      'java.util collections (ArrayList, HashMap, TreeMap, PriorityQueue, ArrayDeque…), String, StringBuilder, Math, Random, printf',
      'Java’s int overflow, HashMap order, Random numbers and exception messages',
    ],
    not: [
      'Streams, threads and reflection',
      'Scanner: there is no input',
      'Classes outside java.util, java.lang, java.io and java.math',
      'Compile errors are found when their line runs, not before',
    ],
  },
  kotlin: {
    runs: 'An interpreter written for this page (Kotlin 2 on the JVM), offline.',
    has: [
      'Classes (data, sealed, enum, open, abstract), objects and companions, interfaces, extension functions',
      'Lambdas, when, ranges, string templates, null safety, destructuring, scope functions',
      'The collection functions, lists, sets, maps, ArrayDeque, PriorityQueue, sequences, kotlin.math, Random',
      'The JVM’s overflow, HashMap order, number printing and exception messages',
    ],
    not: [
      'Coroutines and reflection',
      'Regular expressions',
      'Reading input',
      'Compile errors are found when their line runs, not before',
    ],
  },
  swift: {
    runs: 'An interpreter written for this page (Swift 6), offline.',
    has: [
      'Structs (copied when assigned), classes with inheritance, enums with raw and associated values, protocols and extensions, generics',
      'Optionals (if let, guard let, ?., ??, !), closures with $0 and trailing closures, switch with patterns, throws / do / catch, inout, defer',
      'Array, Dictionary, Set, tuples, ranges and stride, String and Character, map / filter / reduce / sorted…, Foundation’s math and String(format:)',
      'Swift’s Int overflow and index-out-of-range stops, Optional(…) in print, and its error messages',
    ],
    not: [
      'async / await, actors and concurrency',
      'Key paths, result builders, property wrappers and macros; deinit never runs',
      'Reading input: readLine() returns nil',
      'Random Dictionary and Set order: they keep insertion order',
      'Compile errors are found when their line runs, not before',
    ],
  },
  csharp: {
    runs: 'An interpreter written for this page (C# 12, .NET 8), offline.',
    has: [
      'Top-level statements or a Main, classes, structs, records, interfaces, enums, generics, properties',
      'Lambdas, tuples, pattern matching and switch expressions, ref / out, string interpolation',
      'List, Dictionary, HashSet, Queue, Stack, PriorityQueue, SortedDictionary, LINQ, Math, Random',
      '.NET’s overflow, Dictionary order, number formatting and exception messages',
    ],
    not: [
      'async / await and iterators (yield)',
      'decimal, events, unsafe code',
      'Reading input',
      'Most compile errors are found when their line runs, not before',
    ],
  },
  go: {
    runs: 'An interpreter written for this page (Go 1.23), offline.',
    has: [
      'Structs, methods, interfaces, generics, closures, several results, defer / panic / recover',
      'Slices that share their backing array, maps, strings as bytes, exact constants',
      'fmt, strings, strconv, sort, slices, math, unicode, errors, container/heap, math/rand',
    ],
    not: [
      'Goroutines, channels and select',
      'goto, reading input, other packages',
      'Random map order: ranging over a map goes in insertion order',
    ],
  },
  c: {
    runs: 'An interpreter written for this page (C99 on 64-bit Linux), offline.',
    has: [
      'Structs, unions, enums, typedefs, pointers, arrays, malloc / free, function pointers, #define',
      'stdio, stdlib, string, ctype and math',
      'Every memory access checked: out of bounds, NULL or freed memory stops the run with an explanation',
    ],
    not: [
      'goto and bit fields',
      'scanf: there is no input',
      '#include of your own files',
    ],
  },
  cpp: {
    runs: 'The C interpreter with its C++ parts switched on, offline.',
    has: [
      'Classes with constructors, destructors and operator overloading, references, new / delete, lambdas, try / catch',
      'string, vector, map, set, unordered_map, queue, stack, deque, priority_queue, cout, <algorithm>',
      'Vectors that reallocate like libstdc++, with stale references caught',
    ],
    not: [
      'Templates of your own',
      'Inheritance and virtual functions',
      'Namespaces other than std',
      'cin: there is no input',
    ],
  },
};

/** @param lang  a key of LANG_INFO; @param name  the language's name as the picker shows it */
export function LangInfo({ lang, name }) {
  const info = LANG_INFO[lang] || LANG_INFO.javascript;
  const btn = useRef(null), pop = useRef(null);
  usePopover(btn, pop, 440);
  return (
    <>
      <button ref={btn} type="button" className="help-btn" id="langInfoBtn" popoverTarget="langInfo"
        title={`What ${name} includes`} aria-label={`What ${name} includes`}>i</button>
      <div ref={pop} id="langInfo" className="help-pop" popover="auto" role="dialog" aria-labelledby="langInfoTitle">
        <h3 id="langInfoTitle">What {name} includes</h3>
        <div className="help-runs">{info.runs}</div>
        <h4>Included</h4>
        <ul className="help-notes help-has">{info.has.map(t => <li key={t}>{t}</li>)}</ul>
        <h4>Not included</h4>
        <ul className="help-notes help-not">{info.not.map(t => <li key={t}>{t}</li>)}</ul>
      </div>
    </>
  );
}
