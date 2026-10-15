/**
 * The "?" next to the Variables heading: a short guide, for someone new to the app, to the three views and to every
 * shape of data the Graph view can draw. A native popover (top layer, so the panel's overflow cannot clip it; Escape
 * and an outside click close it), placed under its button. Every example here is checked by tests.
 */
import { useEffect, useRef } from 'react';

const VIEWS = [
  ['Memory', 'How your data is stored: each array or object is a box, and arrows show what refers to what. Shown first.'],
  ['Boxes', 'The values themselves, nested inside each other.'],
  ['Graph', 'Circles and arrows (nodes and edges). This button only appears when your data has one of the shapes below.'],
];

/** [title, [[example, explanation], …]] — the shapes the Graph view recognises */
export const SHAPES = [
  ['A list of neighbours for each name', [
    ['{ A: ["B", "C"], B: ["C"], C: [] }', 'A points to B and C, B points to C. A Map, or Sets instead of arrays, work too.'],
    ['{ A: { B: 4, C: 2 }, B: { C: 1 } }', 'The same, with a number (weight) on each arrow. [["B", 4]] pairs work too.'],
    ['{ A: [{ to: "B", start: 0, end: 3 }], B: [] }', 'Each arrow written as an object; its other fields are written on the arrow.'],
  ]],
  ['Objects inside objects', [
    ['{ val: 1, next: { val: 2, next: null } }', 'A linked list.'],
    ['{ val: 1, left: { val: 2 }, right: { val: 3 } }', 'A binary tree.'],
    ['{ name: "a", children: [{ name: "b" }, { name: "c" }] }', 'A tree.'],
    ['a = { id: "A", nbrs: [b, c] }', 'Objects that list other objects: any graph.'],
  ]],
  ['Objects that name each other', [
    ['{ a: { next: ["b"] }, b: { next: [] } }', 'By key.'],
    ['[{ id: "test", deps: ["build"] }, { id: "build", deps: [] }]', 'By an id, key or name field.'],
    ['[{ v: "a", out: [1] }, { v: "b", out: [] }]', 'By position in the array.'],
  ]],
  ['Lists of numbers (the variable\'s name decides)', [
    ['const adj = [[1, 2], [2], []]', 'The neighbours of node 0, 1, 2… The name must contain adj, graph, neigh or tree, or be g.'],
    ['const adj = [[[0, 3, 1], [1, 5, 2]], [[4, 7, 2]], []]', 'The same with lists of values: the node is the first position where every list holds a node number (here the last). One other number is a weight; more are written on the arrow.'],
    ['const edges = [[0, 1], [1, 2]]', 'One [from, to] pair per arrow. The name must contain edge.'],
  ]],
];

export function GraphHelp() {
  const btn = useRef(null), pop = useRef(null);

  useEffect(() => {
    const p = pop.current;
    /* Placed in page coordinates (position: absolute in the top layer), so it scrolls along with its button; closing it on
       scroll instead would also close it right after it opens when a tap follows a scroll, or when a phone's address bar moves. */
    const place = () => {
      const r = btn.current.getBoundingClientRect(), w = Math.min(520, window.innerWidth - 32);
      Object.assign(p.style, {
        width: w + 'px',
        left: window.scrollX + Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)) + 'px',
        top: window.scrollY + r.bottom + 6 + 'px',
        maxHeight: Math.max(160, window.innerHeight - r.bottom - 22) + 'px',   // fits below the button; longer text scrolls inside
      });
    };
    const onToggle = e => { if (e.newState === 'open') place(); };
    // follow the button when the window is resized or the debugger panel it sits in scrolls (never when the help itself scrolls)
    const follow = e => { if (p.matches(':popover-open') && !(e.target instanceof Node && p.contains(e.target))) place(); };
    p.addEventListener('beforetoggle', onToggle);
    window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true);
    return () => { p.removeEventListener('beforetoggle', onToggle); window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, []);

  return (
    <>
      <button ref={btn} type="button" className="help-btn" id="graphHelpBtn" popoverTarget="graphHelp"
        title="How to see your data as a graph" aria-label="How to see your data as a graph">?</button>
      <div ref={pop} id="graphHelp" className="help-pop" popover="auto" role="dialog" aria-labelledby="graphHelpTitle">
        <h3 id="graphHelpTitle">How to see your data as a graph</h3>
        <p>Every array, object, Map and Set in your code gets buttons to choose how it is drawn:</p>
        <dl className="help-views">
          {VIEWS.map(([name, what]) => <div key={name}><dt>{name}</dt><dd>{what}</dd></div>)}
        </dl>

        <h4>Shapes that can be drawn as a graph</h4>
        {SHAPES.map(([title, items], i) => (
          <section key={title} className="help-group">
            <h5>{i + 1}. {title}</h5>
            <ul>
              {items.map(([code, what]) => <li key={code}><code>{code}</code><span>{what}</span></li>)}
            </ul>
          </section>
        ))}

        <h4>How connections are found</h4>
        <p>The app checks the shapes in the order 1, 4, 2, 3 and uses the first one that fits. For each one:</p>
        <ul className="help-notes">
          <li><b>1. Neighbour lists:</b> every key is a node. Each name in a key's list is an arrow from that key to the node with
            that name. A name that has no key of its own still becomes a node. In <code className="inline">{'{ to: "B", w: 4 }'}</code>,
            the target is the first of <i>to, node, target, dest, id, key, name, vertex, neighbor, v, n</i>; the weight is
            a <i>weight, w, cost, dist, length, capacity</i> or <i>time</i> field.</li>
          <li><b>2. Objects inside objects:</b> every object is a node, and a field holding another object (or a list of them)
            is an arrow, labelled with the field's name. The same object is always the same node, so shared objects and
            loops connect correctly.</li>
          <li><b>3. Objects that name each other:</b> a node is named by its key, by a field <i>id</i>, <i>key</i> or <i>name</i> that
            every object has and that is different in each, or else by its position. A field becomes arrows when every value in
            it is the name of another node.</li>
          <li><b>4. Lists of numbers:</b> in <code className="inline">adj</code>, list number <i>i</i> holds the neighbours of
            node <i>i</i>, as numbers or as lists of values. In those lists the node is the first position where every list holds a
            number of a node that exists (<i>[1, 0, 3]</i>, <i>[0, 3, 1]</i> and <i>[0, 1, 3]</i> all work); if several positions fit, the
            first one is used. In <code className="inline">edges</code>, each <i>[from, to]</i> is
            one arrow, and a third number is its weight.</li>
        </ul>

        <h5>Making sure the right values are connected</h5>
        <ul className="help-notes">
          <li><b>All or nothing:</b> a list counts as connections only if every value in it is a node's name. In shape 1, one
            value that is not a name means the data is not a graph at all; in shape 3, that field is shown as data instead.</li>
          <li><b>Names must match:</b> an arrow is only drawn to a node that exists, matched by its exact name (or number).
            At least one arrow must lead to another entry, so lists of plain values are never mistaken for a graph.</li>
          <li><b>Numbers are careful:</b> a number is a connection only in a field named like a link (<i>next, out, to, parent,
            deps</i>…), or in a number list named <i>adj</i> or <i>edges</i>. Elsewhere it stays a number.</li>
          <li><b>Labels are never links:</b> <i>val, value, data, key, name, id, label, title, weight</i> and similar fields name
            or describe the node itself.</li>
          <li><b>Objects must look alike:</b> objects inside objects are only drawn as a graph when they share at least half of their
            fields (or one is a smaller version of the other, like a leaf), so ordinary nested settings stay as data.</li>
          <li><b>Two-way and repeated arrows:</b> A → B and B → A with the same values become one line without arrowheads; the same
            arrow listed twice is drawn once, but arrows with different values stay separate.</li>
          <li><b>Size:</b> up to 60 nodes.</li>
        </ul>

        <h4>What you see in a graph</h4>
        <ul className="help-notes">
          <li><b>Data in a node:</b> a node <code className="inline">{'{ id: 1, weight: 3 }'}</code> shows <i>id 1</i> and <i>weight 3</i> inside it.</li>
          <li><b>Data on an arrow:</b> <code className="inline">{'{ to: "B", start: 0, end: 3 }'}</code> shows <i>start 0</i> and <i>end 3</i> on the arrow.</li>
          <li><b>Tags:</b> <i>↑ cur</i> marks the node a variable points at, <i>∈ visited</i> the nodes an array or Set contains. Untick <i>Pointer tags</i> to hide them.</li>
          <li><b>Changes</b> since the last step are highlighted.</li>
          <li><b>The layout adapts:</b> a chain is drawn as a list, one start that branches as a tree, anything else as a graph.</li>
        </ul>

        <h4>Good to know</h4>
        <ul className="help-notes">
          <li>A number only counts as a link in a field named like one: <i>next, prev, out, in, to, from, adj, neighbours, edges, links, children,
            parent, left, right, deps</i>… So <code className="inline">{'{ age: 1 }'}</code> stays a plain number.</li>
          <li>Lists of plain values, like <code className="inline">{'{ fruits: ["apple"] }'}</code>, are data, not a graph.</li>
          <li>If your data stops being a graph while you step, the card shows its values and says so.</li>
        </ul>
      </div>
    </>
  );
}
