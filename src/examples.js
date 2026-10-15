/**
 * Example programs offered in the dropdown, per language.
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

/** The same kind of examples in Python (same names where there is a JavaScript twin, so switching language keeps them). */
export const PY_EXAMPLES = {
"Bubble sort": `def bubble_sort(arr):
    n = len(arr)
    for i in range(n - 1):
        swapped = False
        for j in range(n - 1 - i):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
                swapped = True
        if not swapped:
            break
    return arr

data = [5, 2, 9, 1, 6]
bubble_sort(data)
print(data)`,

"Binary search": `def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        if arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1

nums = [1, 3, 5, 7, 9, 11, 13]
print(binary_search(nums, 9))`,

"Two sum (dict)": `def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        need = target - x
        if need in seen:
            return [seen[need], i]
        seen[x] = i
    return None

result = two_sum([3, 8, 11, 4, 7], 15)
print(result)`,

"Fibonacci with memo": `memo = {}

def fib(n):
    if n <= 1:
        return n
    if n in memo:
        return memo[n]
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]

print(fib(6))`,

"Reverse a linked list": `class Node:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next

head = Node(1, Node(2, Node(3)))

prev = None
curr = head
while curr is not None:
    next_node = curr.next
    curr.next = prev
    prev = curr
    curr = next_node
head = prev
print(head.val)`,

"Breadth-first search": `from collections import deque

graph = {
    "A": ["B", "C"],
    "B": ["D"],
    "C": ["D", "E"],
    "D": ["F"],
    "E": ["F"],
    "F": [],
}

def bfs(start):
    visited = {start}
    queue = deque([start])
    order = []
    while queue:
        cur = queue.popleft()
        order.append(cur)
        for nxt in graph[cur]:
            if nxt not in visited:
                visited.add(nxt)
                queue.append(nxt)
    return order

print(bfs("A"))`,

"Data structures": `# ---- Memory / Boxes: any value ----
nums = [5, 2, 9, 1, 6]
i, j = 1, 3                           # pointer tags under nums[1] and nums[3]
point = (1, 2)
person = {"name": "Ada", "tags": {"math", "code"}}
scores = {1: "gold", 2: "silver"}     # keys that are not strings
shared = {"n": 1}
pair = [shared, shared]               # the same object twice

# ---- Graph: neighbour lists in a dict ----
g1 = {"A": ["B", "C"], "B": ["D"], "C": ["D"], "D": []}
g2 = {"A": {"B": 4, "C": 2}, "B": {"D": 5}, "C": {"B": 1}}        # weighted
g3 = {"A": [("B", 4), ("C", 2)], "B": [("C", 1)]}                 # (name, weight) pairs

# ---- Graph: lists of numbers (the name decides) ----
adj = [[1, 2], [3], [3], []]
edges = [(0, 1), (1, 2), (2, 0)]

# ---- Graph: objects that point at each other ----
class TreeNode:
    def __init__(self, val, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

class ListNode:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next

tree = TreeNode(1, TreeNode(2, TreeNode(4)), TreeNode(3))
linked = ListNode(1, ListNode(2, ListNode(3)))

# ---- Graph: data in the nodes and on the arrows ----
jobs = [{"id": "A", "color": "red", "next": ["B", "C"]},
        {"id": "B", "color": "blue", "next": ["C"]},
        {"id": "C", "color": "green", "next": []}]
intervals = {"0": [{"v": 1, "start": 0, "end": 3}, {"v": 2, "start": 1, "end": 5}],
             "1": [{"v": 3, "start": 7, "end": 8}], "2": [{"v": 3, "start": 4, "end": 7}]}

cur = "B"                             # tags node B in g1, g2, g3
visited = {"A", "C"}                  # ∈ visited tags
print("done")`
};

/** The JavaScript examples with types (same names, so switching language keeps them). */
export const TS_EXAMPLES = {
"Bubble sort": `function bubbleSort(arr: number[]): number[] {
  const n = arr.length;
  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      if (arr[j] > arr[j + 1]) {
        const tmp: number = arr[j];
        arr[j] = arr[j + 1];
        arr[j + 1] = tmp;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return arr;
}

const data: number[] = [5, 2, 9, 1, 6];
bubbleSort(data);
console.log(data);`,

"Binary search": `function binarySearch(arr: readonly number[], target: number): number {
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

const sorted: number[] = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91];
const found = binarySearch(sorted, 23);
console.log("found at index", found);`,

"Two sum (Map)": `function twoSum(nums: number[], target: number): [number, number] | null {
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) {
      return [seen.get(need)!, i];
    }
    seen.set(nums[i], i);
  }
  return null;
}

const result = twoSum([3, 8, 11, 4, 7], 15);
console.log(result);`,

"Fibonacci with memo": `const memo: Record<number, number> = {};

function fib(n: number): number {
  if (n <= 1) return n;
  if (memo[n] !== undefined) return memo[n];
  memo[n] = fib(n - 1) + fib(n - 2);
  return memo[n];
}

console.log(fib(6));`,

"Reverse a linked list": `class ListNode {
  constructor(public val: number, public next: ListNode | null = null) {}
}

let list: ListNode | null = new ListNode(1, new ListNode(2, new ListNode(3)));

let prev: ListNode | null = null;
let curr = list;
while (curr !== null) {
  const nextNode: ListNode | null = curr.next;
  curr.next = prev;
  prev = curr;
  curr = nextNode;
}
console.log(prev!.val);`,

"Breadth-first search": `type Graph = Record<string, string[]>;

const graph: Graph = {
  A: ["B", "C"],
  B: ["D"],
  C: ["D", "E"],
  D: ["F"],
  E: ["F"],
  F: []
};

function bfs(start: string): string[] {
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
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

"Data structures": `// ---- Memory / Boxes: any value ----
const nums: number[] = [5, 2, 9, 1, 6];
let i = 1, j = 3;                                  // pointer tags under nums[1] and nums[3]
const scores = new Map<string, number>([["ada", 90], ["alan", 85]]);
enum Color { Red, Green, Blue }
const favourite: Color = Color.Green;
const shared = { n: 1 }, pair = [shared, shared];  // the same object twice

// ---- Graph: neighbour lists ----
type Graph = Record<string, string[]>;
const g1: Graph = { A: ["B", "C"], B: ["D"], C: ["D"], D: [] };
const g2: Record<string, Record<string, number>> = { A: { B: 4, C: 2 }, B: { D: 5 }, C: { B: 1 } };   // weighted
const adj: number[][] = [[1, 2], [3], [3], []];
const edges: [number, number][] = [[0, 1], [1, 2], [2, 0]];

// ---- Graph: objects that point at each other ----
interface TreeNode { val: number; left: TreeNode | null; right: TreeNode | null; }
const tree: TreeNode = { val: 1, left: { val: 2, left: null, right: null }, right: { val: 3, left: null, right: null } };
class ListNode {
  constructor(public val: number, public next: ListNode | null = null) {}
}
const linked = new ListNode(1, new ListNode(2, new ListNode(3)));

// ---- Graph: data in the nodes and on the arrows ----
interface Job { id: string; color: string; next: string[]; }
const jobs: Job[] = [{ id: "A", color: "red", next: ["B", "C"] }, { id: "B", color: "blue", next: ["C"] }, { id: "C", color: "green", next: [] }];
type Interval = { v: number; start: number; end: number };
const intervals: Record<string, Interval[]> = { "0": [{ v: 1, start: 0, end: 3 }, { v: 2, start: 1, end: 5 }], "1": [{ v: 3, start: 7, end: 8 }], "2": [{ v: 3, start: 4, end: 7 }] };

let cur = "B";                                     // tags node B in g1, g2
const visited = new Set<string>(["A", "C"]);       // ∈ visited tags
console.log("done");`
};

/** The same kind of examples in Lua (same names where there is a JavaScript twin). Lua tables count from 1. */
export const LUA_EXAMPLES = {
"Bubble sort": `local function bubble_sort(arr)
  local n = #arr
  for i = 1, n - 1 do
    local swapped = false
    for j = 1, n - i do
      if arr[j] > arr[j + 1] then
        arr[j], arr[j + 1] = arr[j + 1], arr[j]
        swapped = true
      end
    end
    if not swapped then break end
  end
  return arr
end

local data = {5, 2, 9, 1, 6}
bubble_sort(data)
print(table.concat(data, ", "))`,

"Binary search": `local function binary_search(arr, target)
  local lo, hi = 1, #arr
  while lo <= hi do
    local mid = (lo + hi) // 2
    if arr[mid] == target then
      return mid
    elseif arr[mid] < target then
      lo = mid + 1
    else
      hi = mid - 1
    end
  end
  return nil
end

local sorted = {2, 5, 8, 12, 16, 23, 38, 56, 72, 91}
local found = binary_search(sorted, 23)
print("found at index", found)`,

"Two sum (table)": `local function two_sum(nums, target)
  local seen = {}
  for i, x in ipairs(nums) do
    local need = target - x
    if seen[need] then
      return {seen[need], i}
    end
    seen[x] = i
  end
  return nil
end

local result = two_sum({3, 8, 11, 4, 7}, 15)
print(result[1], result[2])`,

"Fibonacci with memo": `local memo = {}

local function fib(n)
  if n <= 1 then return n end
  if memo[n] then return memo[n] end
  memo[n] = fib(n - 1) + fib(n - 2)
  return memo[n]
end

print(fib(6))`,

"Reverse a linked list": `local function node(val, next)
  return {val = val, next = next}
end

local list = node(1, node(2, node(3, nil)))

local prev = nil
local curr = list
while curr ~= nil do
  local next_node = curr.next
  curr.next = prev
  prev = curr
  curr = next_node
end
print(prev.val)`,

"Breadth-first search": `local graph = {
  A = {"B", "C"},
  B = {"D"},
  C = {"D", "E"},
  D = {"F"},
  E = {"F"},
  F = {},
}

local function bfs(start)
  local visited = {[start] = true}
  local queue = {start}
  local order = {}
  while #queue > 0 do
    local cur = table.remove(queue, 1)
    order[#order + 1] = cur
    for _, nxt in ipairs(graph[cur]) do
      if not visited[nxt] then
        visited[nxt] = true
        queue[#queue + 1] = nxt
      end
    end
  end
  return order
end

print(table.concat(bfs("A"), " "))`,

"Data structures": `-- ---- Memory / Boxes: any value (tables count from 1) ----
local nums = {5, 2, 9, 1, 6}
local i, j = 2, 4                          -- pointer tags under nums[2] and nums[4]
local person = {name = "Ada", tags = {"math", "code"}}
local scores = {[1] = "gold", [3] = "bronze"}   -- keys that are not 1..n
local shared = {n = 1}
local pair = {shared, shared}              -- the same table twice

-- ---- Graph: neighbour lists ----
local g1 = {A = {"B", "C"}, B = {"D"}, C = {"D"}, D = {}}
local g2 = {A = {B = 4, C = 2}, B = {D = 5}, C = {B = 1}}    -- weighted
local adj = {{2, 3}, {4}, {4}, {}}                           -- by position, from 1
local edges = {{1, 2}, {2, 3}, {3, 1}}

-- ---- Graph: tables that point at each other ----
local tree = {val = 1, left = {val = 2, left = {val = 4}}, right = {val = 3}}
local linked = {val = 1, next = {val = 2, next = {val = 3}}}

-- ---- Graph: data in the nodes and on the arrows ----
local jobs = {
  {id = "A", color = "red", next = {"B", "C"}},
  {id = "B", color = "blue", next = {"C"}},
  {id = "C", color = "green", next = {}},
}
local intervals = {
  ["1"] = {{v = 2, start = 0, finish = 3}, {v = 3, start = 1, finish = 5}},
  ["2"] = {{v = 4, start = 7, finish = 8}},
  ["3"] = {{v = 4, start = 4, finish = 7}},
}

local cur = "B"                             -- tags node B in g1, g2
local visited = {A = true, C = true}        -- a set: ∈ visited tags
print("done")`
};

/** The same kind of examples in Ruby (same names where there is a JavaScript twin). */
export const RB_EXAMPLES = {
"Bubble sort": `def bubble_sort(arr)
  n = arr.size
  (n - 1).times do |i|
    swapped = false
    (n - 1 - i).times do |j|
      if arr[j] > arr[j + 1]
        arr[j], arr[j + 1] = arr[j + 1], arr[j]
        swapped = true
      end
    end
    break unless swapped
  end
  arr
end

data = [5, 2, 9, 1, 6]
bubble_sort(data)
p data`,

"Binary search": `def binary_search(arr, target)
  lo = 0
  hi = arr.size - 1
  while lo <= hi
    mid = (lo + hi) / 2
    if arr[mid] == target
      return mid
    elsif arr[mid] < target
      lo = mid + 1
    else
      hi = mid - 1
    end
  end
  nil
end

sorted = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]
found = binary_search(sorted, 23)
puts "found at index #{found}"`,

"Two sum (Hash)": `def two_sum(nums, target)
  seen = {}
  nums.each_with_index do |x, i|
    need = target - x
    return [seen[need], i] if seen.key?(need)
    seen[x] = i
  end
  nil
end

result = two_sum([3, 8, 11, 4, 7], 15)
p result`,

"Fibonacci with memo": `MEMO = {}

def fib(n)
  return n if n <= 1
  return MEMO[n] if MEMO.key?(n)
  MEMO[n] = fib(n - 1) + fib(n - 2)
end

puts fib(6)`,

"Reverse a linked list": `Node = Struct.new(:val, :next)

list = Node.new(1, Node.new(2, Node.new(3, nil)))

prev = nil
curr = list
until curr.nil?
  next_node = curr.next
  curr.next = prev
  prev = curr
  curr = next_node
end
puts prev.val`,

"Breadth-first search": `require "set"

GRAPH = {
  a: [:b, :c],
  b: [:d],
  c: [:d, :e],
  d: [:f],
  e: [:f],
  f: []
}

def bfs(start)
  visited = Set[start]
  queue = [start]
  order = []
  until queue.empty?
    cur = queue.shift
    order << cur
    GRAPH[cur].each do |nxt|
      next if visited.include?(nxt)
      visited << nxt
      queue << nxt
    end
  end
  order
end

p bfs(:a)`,

"Data structures": `require "set"

# ---- Memory / Boxes: any value ----
nums = [5, 2, 9, 1, 6]
i, j = 1, 3                               # pointer tags under nums[1] and nums[3]
person = { name: "Ada", tags: Set["math", "code"] }
scores = { 1 => "gold", 2 => "silver" }   # keys that are not names
shared = { n: 1 }
pair = [shared, shared]                   # the same object twice

# ---- Graph: neighbour lists in a Hash ----
g1 = { "A" => ["B", "C"], "B" => ["D"], "C" => ["D"], "D" => [] }
g2 = { a: { b: 4, c: 2 }, b: { d: 5 }, c: { b: 1 } }       # weighted, symbol keys
adj = [[1, 2], [3], [3], []]                                 # by position
edges = [[0, 1], [1, 2], [2, 0]]

# ---- Graph: objects that point at each other ----
TreeNode = Struct.new(:val, :left, :right)
ListNode = Struct.new(:val, :next)
tree = TreeNode.new(1, TreeNode.new(2, TreeNode.new(4)), TreeNode.new(3))
linked = ListNode.new(1, ListNode.new(2, ListNode.new(3)))

# ---- Graph: data in the nodes and on the arrows ----
jobs = [
  { id: "A", color: "red", next: ["B", "C"] },
  { id: "B", color: "blue", next: ["C"] },
  { id: "C", color: "green", next: [] }
]
intervals = {
  "0" => [{ v: 1, start: 0, end: 3 }, { v: 2, start: 1, end: 5 }],
  "1" => [{ v: 3, start: 7, end: 8 }],
  "2" => [{ v: 3, start: 4, end: 7 }]
}

cur = "B"                                 # tags node B in g1
visited = Set["A", "C"]                   # ∈ visited tags
puts "done"`
};

/** The same kind of examples in C (same names where there is a JavaScript twin). C has no hash map, so two sum uses a lookup table. */
export const C_EXAMPLES = {
"Bubble sort": `#include <stdio.h>

void bubble_sort(int arr[], int n) {
    for (int i = 0; i < n - 1; i++) {
        int swapped = 0;
        for (int j = 0; j < n - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                int tmp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = tmp;
                swapped = 1;
            }
        }
        if (!swapped) break;
    }
}

int main(void) {
    int data[] = {5, 2, 9, 1, 6};
    int n = sizeof data / sizeof data[0];
    bubble_sort(data, n);
    for (int i = 0; i < n; i++) printf("%d ", data[i]);
    printf("\\n");
    return 0;
}`,

"Binary search": `#include <stdio.h>

int binary_search(const int *arr, int n, int target) {
    int lo = 0;
    int hi = n - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) {
            return mid;
        } else if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return -1;
}

int main(void) {
    int sorted[] = {2, 5, 8, 12, 16, 23, 38, 56, 72, 91};
    int found = binary_search(sorted, 10, 23);
    printf("found at index %d\\n", found);
    return 0;
}`,

"Two sum (lookup table)": `#include <stdio.h>

#define MAX_VALUE 16

/* seen[v] is the index where the value v was met, or -1 */
int two_sum(const int *nums, int n, int target, int result[2]) {
    int seen[MAX_VALUE];
    for (int v = 0; v < MAX_VALUE; v++) seen[v] = -1;
    for (int i = 0; i < n; i++) {
        int need = target - nums[i];
        if (need >= 0 && need < MAX_VALUE && seen[need] != -1) {
            result[0] = seen[need];
            result[1] = i;
            return 1;
        }
        seen[nums[i]] = i;
    }
    return 0;
}

int main(void) {
    int nums[] = {3, 8, 11, 4, 7};
    int result[2];
    if (two_sum(nums, 5, 15, result)) {
        printf("[%d, %d]\\n", result[0], result[1]);
    }
    return 0;
}`,

"Fibonacci with memo": `#include <stdio.h>

long long memo[50];          /* 0 means "not worked out yet" */

long long fib(int n) {
    if (n <= 1) return n;
    if (memo[n] != 0) return memo[n];
    memo[n] = fib(n - 1) + fib(n - 2);
    return memo[n];
}

int main(void) {
    printf("%lld\\n", fib(6));
    return 0;
}`,

"Reverse a linked list": `#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int val;
    struct Node *next;
} Node;

Node *node(int val, Node *next) {
    Node *n = malloc(sizeof(Node));
    n->val = val;
    n->next = next;
    return n;
}

int main(void) {
    Node *list = node(1, node(2, node(3, NULL)));

    Node *prev = NULL;
    Node *curr = list;
    while (curr != NULL) {
        Node *next_node = curr->next;
        curr->next = prev;
        prev = curr;
        curr = next_node;
    }
    printf("%d\\n", prev->val);
    return 0;
}`,

"Breadth-first search": `#include <stdio.h>
#include <stdbool.h>

#define N 6

/* graph[a][b] is 1 when there is an edge from a to b (A is 0, B is 1…) */
int graph[N][N] = {
    {0, 1, 1, 0, 0, 0},   /* A: B, C */
    {0, 0, 0, 1, 0, 0},   /* B: D */
    {0, 0, 0, 1, 1, 0},   /* C: D, E */
    {0, 0, 0, 0, 0, 1},   /* D: F */
    {0, 0, 0, 0, 0, 1},   /* E: F */
    {0, 0, 0, 0, 0, 0},   /* F */
};

void bfs(int start) {
    bool visited[N] = {false};
    int queue[N];
    int head = 0, tail = 0;
    visited[start] = true;
    queue[tail++] = start;
    while (head < tail) {
        int cur = queue[head++];
        printf("%c ", 'A' + cur);
        for (int next = 0; next < N; next++) {
            if (graph[cur][next] && !visited[next]) {
                visited[next] = true;
                queue[tail++] = next;
            }
        }
    }
    printf("\\n");
}

int main(void) {
    bfs(0);
    return 0;
}`,

"Data structures": `#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>

struct Point { int x, y; };
enum Color { RED, GREEN, BLUE };

struct TreeNode { int val; struct TreeNode *left, *right; };
struct ListNode { int val; struct ListNode *next; };
struct Vertex { char name; struct Vertex *nbrs[2]; };
struct Job { char id; const char *color; char next[3]; };
struct Item { int val; int next; };

int main(void) {
    // ---- Memory / Boxes: any value ----
    int nums[] = {5, 2, 9, 1, 6};
    int i = 1, *p = &nums[3];                  // pointer tags under nums[1] and nums[3]
    char word[] = "hi";
    double ratio = 2.0 / 3;
    bool done = false;
    enum Color color = GREEN;
    struct Point pt = {1, 2};
    struct Point *ptp = &pt;                   // the same struct twice: #id badge
    int *heap = calloc(3, sizeof(int));        // memory from malloc / calloc
    heap[0] = 7;

    // ---- Graph: numbers (the variable's name decides) ----
    int adj[4][4] = {{0, 1, 1, 0}, {0, 0, 0, 1}, {0, 0, 0, 1}, {0, 0, 0, 0}};   // adjacency matrix
    int graph_w[3][3] = {{0, 4, 2}, {0, 0, 5}, {0, 1, 0}};                     // weights, 0: no edge
    int edges[3][2] = {{0, 1}, {1, 2}, {2, 0}};                                // one {from, to} per arrow

    // ---- Graph: structs that point at each other ----
    struct TreeNode n4 = {4, NULL, NULL}, n3 = {3, NULL, NULL};
    struct TreeNode n2 = {2, &n4, NULL};
    struct TreeNode tree = {1, &n2, &n3};
    struct ListNode l3 = {3, NULL}, l2 = {2, &l3};
    struct ListNode linked = {1, &l2};
    struct Vertex va = {'A'}, vb = {'B'}, vc = {'C'};
    va.nbrs[0] = &vb; va.nbrs[1] = &vc; vb.nbrs[0] = &vc; vc.nbrs[0] = &va;

    // ---- Graph: structs that name each other by id, or by index ----
    struct Job jobs[3] = {{'A', "red", "BC"}, {'B', "blue", "C"}, {'C', "green", ""}};
    struct Item pool[3] = {{5, 2}, {9, -1}, {7, 1}};        // a list kept in an array: 5 -> 7 -> 9

    printf("done\\n");
    free(heap);
    return 0;
}`
};

/** The same kind of examples in PHP (same names where there is a JavaScript twin). An array with keys is PHP's map. */
export const PHP_EXAMPLES = {
"Bubble sort": `<?php

function bubble_sort(array $arr): array
{
    $n = count($arr);
    for ($i = 0; $i < $n - 1; $i++) {
        $swapped = false;
        for ($j = 0; $j < $n - 1 - $i; $j++) {
            if ($arr[$j] > $arr[$j + 1]) {
                [$arr[$j], $arr[$j + 1]] = [$arr[$j + 1], $arr[$j]];
                $swapped = true;
            }
        }
        if (!$swapped) break;
    }
    return $arr;
}

$data = [5, 2, 9, 1, 6];
$sorted = bubble_sort($data);
echo implode(", ", $sorted), "\\n";`,

"Binary search": `<?php

function binary_search(array $arr, int $target): int
{
    $lo = 0;
    $hi = count($arr) - 1;
    while ($lo <= $hi) {
        $mid = intdiv($lo + $hi, 2);
        if ($arr[$mid] === $target) {
            return $mid;
        } elseif ($arr[$mid] < $target) {
            $lo = $mid + 1;
        } else {
            $hi = $mid - 1;
        }
    }
    return -1;
}

$sorted = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91];
$found = binary_search($sorted, 23);
echo "found at index $found\\n";`,

"Two sum (array)": `<?php

function two_sum(array $nums, int $target): ?array
{
    $seen = [];                       // value => index
    foreach ($nums as $i => $x) {
        $need = $target - $x;
        if (isset($seen[$need])) {
            return [$seen[$need], $i];
        }
        $seen[$x] = $i;
    }
    return null;
}

$result = two_sum([3, 8, 11, 4, 7], 15);
echo json_encode($result), "\\n";`,

"Fibonacci with memo": `<?php

$memo = [];

function fib(int $n): int
{
    global $memo;
    if ($n <= 1) return $n;
    if (isset($memo[$n])) return $memo[$n];
    $memo[$n] = fib($n - 1) + fib($n - 2);
    return $memo[$n];
}

echo fib(6), "\\n";`,

"Reverse a linked list": `<?php

class Node
{
    public function __construct(public int $val, public ?Node $next = null) {}
}

$list = new Node(1, new Node(2, new Node(3)));

$prev = null;
$curr = $list;
while ($curr !== null) {
    $nextNode = $curr->next;
    $curr->next = $prev;
    $prev = $curr;
    $curr = $nextNode;
}
echo $prev->val, "\\n";`,

"Breadth-first search": `<?php

$graph = [
    'A' => ['B', 'C'],
    'B' => ['D'],
    'C' => ['D', 'E'],
    'D' => ['F'],
    'E' => ['F'],
    'F' => [],
];

function bfs(array $graph, string $start): array
{
    $visited = [$start => true];
    $queue = [$start];
    $order = [];
    while ($queue) {
        $cur = array_shift($queue);
        $order[] = $cur;
        foreach ($graph[$cur] as $next) {
            if (!isset($visited[$next])) {
                $visited[$next] = true;
                $queue[] = $next;
            }
        }
    }
    return $order;
}

echo implode(" ", bfs($graph, 'A')), "\\n";`,

"Data structures": `<?php

// ---- Memory / Boxes: any value ----
$nums = [5, 2, 9, 1, 6];
$i = 1; $j = 3;                                // pointer tags under $nums[1] and $nums[3]
$person = ['name' => 'Ada', 'tags' => ['math', 'code']];
$scores = [90 => 'gold', 80 => 'silver'];      // number keys: a map
$stack = new SplStack(); $stack->push(1); $stack->push(2);
$queue = new SplQueue(); $queue->enqueue('a');
class Point { public function __construct(public int $x = 0, public int $y = 0) {} }
$p = new Point(1, 2);
$pair = [$p, $p];                              // the same object twice: #id badge

// ---- Graph: neighbour lists in an array ----
$g1 = ['A' => ['B', 'C'], 'B' => ['D'], 'C' => ['D'], 'D' => []];
$g2 = ['a' => ['b' => 4, 'c' => 2], 'b' => ['d' => 5], 'c' => ['b' => 1]];   // weighted
$adj = [[1, 2], [3], [3], []];                                             // by position
$edges = [[0, 1], [1, 2], [2, 0]];

// ---- Graph: objects that point at each other ----
class TreeNode { public function __construct(public int $val, public ?TreeNode $left = null, public ?TreeNode $right = null) {} }
class ListNode { public function __construct(public int $val, public ?ListNode $next = null) {} }
$tree = new TreeNode(1, new TreeNode(2, new TreeNode(4)), new TreeNode(3));
$linked = new ListNode(1, new ListNode(2, new ListNode(3)));

// ---- Graph: data in the nodes and on the arrows ----
$jobs = [
    ['id' => 'A', 'color' => 'red', 'next' => ['B', 'C']],
    ['id' => 'B', 'color' => 'blue', 'next' => ['C']],
    ['id' => 'C', 'color' => 'green', 'next' => []],
];
$intervals = [
    'a' => [['to' => 'b', 'start' => 0, 'end' => 3], ['to' => 'c', 'start' => 1, 'end' => 5]],
    'b' => [['to' => 'c', 'start' => 7, 'end' => 8]],
    'c' => [],
];

$cur = 'B';                                    // tags node B in $g1
$visited = ['A' => true, 'C' => true];         // ∈ $visited tags
echo "done\\n";`
};

/** The same kind of examples in C++ (same names where there is a JavaScript twin), with the standard library. */
export const CPP_EXAMPLES = {
"Bubble sort": `#include <iostream>
#include <vector>
using namespace std;

void bubble_sort(vector<int>& arr) {
    int n = arr.size();
    for (int i = 0; i < n - 1; i++) {
        bool swapped = false;
        for (int j = 0; j < n - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                swap(arr[j], arr[j + 1]);
                swapped = true;
            }
        }
        if (!swapped) break;
    }
}

int main() {
    vector<int> data = {5, 2, 9, 1, 6};
    bubble_sort(data);
    for (int x : data) cout << x << " ";
    cout << endl;
    return 0;
}`,

"Binary search": `#include <iostream>
#include <vector>
using namespace std;

int binary_search(const vector<int>& arr, int target) {
    int lo = 0;
    int hi = arr.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) {
            return mid;
        } else if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return -1;
}

int main() {
    vector<int> sorted = {2, 5, 8, 12, 16, 23, 38, 56, 72, 91};
    int found = binary_search(sorted, 23);
    cout << "found at index " << found << endl;
    return 0;
}`,

"Two sum (unordered_map)": `#include <iostream>
#include <unordered_map>
#include <vector>
using namespace std;

vector<int> two_sum(const vector<int>& nums, int target) {
    unordered_map<int, int> seen;          // value -> index
    for (int i = 0; i < nums.size(); i++) {
        int need = target - nums[i];
        if (seen.count(need)) {
            return {seen[need], i};
        }
        seen[nums[i]] = i;
    }
    return {};
}

int main() {
    vector<int> result = two_sum({3, 8, 11, 4, 7}, 15);
    cout << "[" << result[0] << ", " << result[1] << "]" << endl;
    return 0;
}`,

"Fibonacci with memo": `#include <iostream>
#include <unordered_map>
using namespace std;

unordered_map<int, long long> memo;

long long fib(int n) {
    if (n <= 1) return n;
    if (memo.count(n)) return memo[n];
    memo[n] = fib(n - 1) + fib(n - 2);
    return memo[n];
}

int main() {
    cout << fib(6) << endl;
    return 0;
}`,

"Reverse a linked list": `#include <iostream>
using namespace std;

struct Node {
    int val;
    Node* next;
    Node(int v, Node* n = nullptr) : val(v), next(n) {}
};

int main() {
    Node* list = new Node(1, new Node(2, new Node(3)));

    Node* prev = nullptr;
    Node* curr = list;
    while (curr != nullptr) {
        Node* nextNode = curr->next;
        curr->next = prev;
        prev = curr;
        curr = nextNode;
    }
    cout << prev->val << endl;
    return 0;
}`,

"Breadth-first search": `#include <iostream>
#include <map>
#include <queue>
#include <set>
#include <vector>
using namespace std;

map<char, vector<char>> graph = {
    {'A', {'B', 'C'}},
    {'B', {'D'}},
    {'C', {'D', 'E'}},
    {'D', {'F'}},
    {'E', {'F'}},
    {'F', {}},
};

vector<char> bfs(char start) {
    set<char> visited = {start};
    queue<char> q;
    q.push(start);
    vector<char> order;
    while (!q.empty()) {
        char cur = q.front();
        q.pop();
        order.push_back(cur);
        for (char next : graph[cur]) {
            if (!visited.count(next)) {
                visited.insert(next);
                q.push(next);
            }
        }
    }
    return order;
}

int main() {
    for (char c : bfs('A')) cout << c << " ";
    cout << endl;
    return 0;
}`,

"Data structures": `#include <bits/stdc++.h>
using namespace std;

struct Point {
    int x, y;
    Point(int x = 0, int y = 0) : x(x), y(y) {}
};
struct TreeNode {
    int val;
    TreeNode *left = nullptr, *right = nullptr;
    TreeNode(int v) : val(v) {}
};
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v, ListNode* n = nullptr) : val(v), next(n) {}
};
struct Job { string id; string color; vector<string> next; };

int main() {
    // ---- Memory / Boxes: any value ----
    vector<int> nums = {5, 2, 9, 1, 6};
    int i = 1;
    auto it = nums.begin() + 3;                       // tags nums[1] and nums[3]
    string word = "hi";
    map<string, int> scores = {{"ada", 90}, {"alan", 85}};
    set<int> primes = {2, 3, 5};
    pair<int, string> pr = {1, "one"};
    stack<int> st; st.push(1); st.push(2);
    Point p(1, 2);
    Point* pp = &p;                                   // the same object twice: #id badge

    // ---- Graph: neighbour lists ----
    map<string, vector<string>> g1 = {{"A", {"B", "C"}}, {"B", {"D"}}, {"C", {"D"}}, {"D", {}}};
    map<char, map<char, int>> g2 = {{'a', {{'b', 4}, {'c', 2}}}, {'b', {{'d', 5}}}, {'c', {{'b', 1}}}};
    vector<vector<int>> adj = {{1, 2}, {3}, {3}, {}};  // by position
    vector<pair<int, int>> edges = {{0, 1}, {1, 2}, {2, 0}};

    // ---- Graph: objects that point at each other ----
    TreeNode* tree = new TreeNode(1);
    tree->left = new TreeNode(2);
    tree->right = new TreeNode(3);
    tree->left->left = new TreeNode(4);
    ListNode* linked = new ListNode(1, new ListNode(2, new ListNode(3)));

    // ---- Graph: data in the nodes ----
    vector<Job> jobs = {{"A", "red", {"B", "C"}}, {"B", "blue", {"C"}}, {"C", "green", {}}};

    string cur = "B";                                 // tags node B in g1
    set<string> visited = {"A", "C"};                 // ∈ visited tags
    cout << "done" << endl;
    return 0;
}`
};
