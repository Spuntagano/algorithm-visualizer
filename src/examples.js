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
