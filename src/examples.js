/**
 * Example programs offered in the dropdown.
 */

export const EXAMPLES = {
"Bubble sort": `function bubbleSort(arr) {
  const n = arr.length;
  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      if (arr[j] > arr[j + 1]) {
        const tmp = arr[j];
        arr[j] = arr[j + 1];
        arr[j + 1] = tmp;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return arr;
}

const data = [5, 2, 9, 1, 6];
bubbleSort(data);
console.log(data);`,

"Binary search": `function binarySearch(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] === target) {
      return mid;
    } else if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

const sorted = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91];
const found = binarySearch(sorted, 23);
console.log("found at index", found);`,

"Two sum (Map)": `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) {
      return [seen.get(need), i];
    }
    seen.set(nums[i], i);
  }
  return null;
}

const result = twoSum([3, 8, 11, 4, 7], 15);
console.log(result);`,

"Fibonacci with memo": `const memo = {};

function fib(n) {
  if (n <= 1) return n;
  if (memo[n] !== undefined) return memo[n];
  memo[n] = fib(n - 1) + fib(n - 2);
  return memo[n];
}

console.log(fib(6));`,

"Reverse a linked list": `function node(val, next) {
  return { val, next };
}

let list = node(1, node(2, node(3, null)));

let prev = null;
let curr = list;
while (curr !== null) {
  const nextNode = curr.next;
  curr.next = prev;
  prev = curr;
  curr = nextNode;
}
console.log(prev.val);`,

"Breadth-first search": `const graph = {
  A: ["B", "C"],
  B: ["D"],
  C: ["D", "E"],
  D: ["F"],
  E: ["F"],
  F: []
};

function bfs(start) {
  const visited = new Set([start]);
  const queue = [start];
  const order = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    order.push(cur);
    for (const next of graph[cur]) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return order;
}

console.log(bfs("A"));`,

"Data structures": `// ---- Boxes: any value ----
const nums = [5, 2, 9, 1, 6];
let i = 1, j = 3;                      // pointer tags under nums[1] and nums[3]
const typed = new Int32Array([1, 2, 3]);
const person = { name: "Ada", born: new Date(0), tags: new Set(["math", "code"]) };
const scores = new Map([["ada", 90], ["alan", 85]]);
class Point { constructor(x, y) { this.x = x; this.y = y; } }
const p = new Point(1, 2);
const shared = { n: 1 }, pair = [shared, shared];   // same object twice: #id badge

// ---- Graph: adjacency in an object or Map ----
const g1 = { A: ["B", "C"], B: ["D"], C: ["D"], D: [] };
const g2 = { a: ["b", "c"], b: ["c"] };                              // c has no entry
const g3 = { A: { B: 4, C: 2 }, B: { D: 5 }, C: { B: 1 } };          // weighted
const g4 = { A: [["B", 4], ["C", 2]], B: [["C", 1]] };               // weighted pairs
const g5 = new Map([["x", ["y", "z"]], ["y", ["z"]], ["z", []]]);
const g6 = { A: new Set(["B", "C"]), B: new Set(["C"]), C: new Set() };
const g7 = { A: ["B", "C"], B: ["A", "C"], C: ["A", "B"] };          // undirected

// ---- Graph: index-based (the name matters) ----
const adj = [[1, 2], [3], [3], []];
const edgeList = [[0, 1], [1, 2], [2, 0, 7]];

// ---- Graph: objects that point at each other ----
const tree = { val: 1, left: { val: 2, left: { val: 4, left: null, right: null }, right: null }, right: { val: 3, left: null, right: null } };
const family = { name: "root", children: [{ name: "a", children: [] }, { name: "b", children: [] }, { name: "c", children: [] }] };
const list = { val: 1, next: { val: 2, next: { val: 3, next: null } } };
const va = { id: "A", nbrs: [] }, vb = { id: "B", nbrs: [] }, vc = { id: "C", nbrs: [] };
va.nbrs.push(vb, vc); vb.nbrs.push(vc); vc.nbrs.push(va);

// ---- Graph: objects naming each other by key, index or id ----
const byKey = { a: { next: ["b", "c"] }, b: { next: ["c"] }, c: { next: [] } };
const byIndex = [{ v: "a", out: [1, 2] }, { v: "b", out: [2] }, { v: "c", out: [] }];
const tasks = [{ id: "build", deps: [] }, { id: "test", deps: ["build"] }, { id: "lint", deps: [] }, { id: "ship", deps: ["test", "lint"] }];

// ---- Graph: nodes with data (shown inside each node) ----
const towns = { a: { color: "red", cost: 2, next: ["b", "c"] }, b: { color: "blue", cost: 5, next: ["c"] }, c: { color: "green", cost: 1, next: [] } };
const jobs = [{ id: "A", color: "red", next: ["B", "C"] }, { id: "B", color: "blue", next: ["C"] }, { id: "C", color: "green", next: [] }];
const weightedNodes = [{ id: 1, weight: 3, next: [2, 3] }, { id: 2, weight: 5, next: [3] }, { id: 3, weight: 1, next: [] }];
const chain = { val: 1, color: "red", next: { val: 2, color: "blue", next: null } };          // a linked list with data

// ---- Graph: edges with data (shown on each arrow) ----
const intervals = { "0": [{ v: 1, start: 0, end: 3 }, { v: 2, start: 1, end: 5 }], "1": [{ v: 3, start: 7, end: 8 }], "2": [{ v: 3, start: 4, end: 7 }] };
const roads = { A: [{ node: "B", weight: 4 }, { node: "C", weight: 2 }], B: [{ node: "C", weight: 1 }], C: [] };

// ---- Memory: nesting, shared objects and cycles ----
const cyc = { n: 1, kids: [] };
cyc.self = cyc;
cyc.kids.push({ parent: cyc, name: "c1" }, { parent: cyc, name: "c2" });

let cur = "B";                         // tags node B in g1, g3, g7…
const visited = new Set(["A", "C"]);   // ∈ visited tags
console.log("done");`
};
