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

console.log(bfs("A"));`
};
