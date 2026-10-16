/**
 * Step 1 of tracing: rewrite the user's program so that every statement first reports
 * "I am about to run line N, and these variables are in scope".
 * Uses acorn to find statements, functions and scopes.
 */
import * as acorn from 'acorn';

function patNames(p, out) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': out.add(p.name); break;
    case 'AssignmentPattern': patNames(p.left, out); break;
    case 'RestElement': patNames(p.argument, out); break;
    case 'ArrayPattern': p.elements.forEach(e => patNames(e, out)); break;
    case 'ObjectPattern': p.properties.forEach(pr => patNames(pr.type === 'RestElement' ? pr.argument : pr.value, out)); break;
  }
}

const isFn = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

function collectVar(node, out) {
  if (!node || typeof node.type !== 'string' || isFn(node)) return out;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') node.declarations.forEach(d => patNames(d.id, out));
  for (const k in node) {
    if (k === 'loc') continue;
    const c = node[k];
    if (Array.isArray(c)) c.forEach(x => collectVar(x, out));
    else if (c && typeof c.type === 'string') collectVar(c, out);
  }
  return out;
}

function lexical(stmts) {
  const out = new Set();
  for (const s of stmts) {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') s.declarations.forEach(d => patNames(d.id, out));
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.add(s.id.name);
  }
  return out;
}

function hintFor(parent, child) {
  switch (parent.type) {
    case 'VariableDeclarator': return parent.init === child && parent.id.type === 'Identifier' ? parent.id.name : undefined;
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition':
      return parent.value === child && !parent.computed && parent.key && parent.key.name ? parent.key.name : undefined;
    case 'AssignmentExpression':
      if (parent.right !== child) return undefined;
      if (parent.left.type === 'Identifier') return parent.left.name;
      if (parent.left.type === 'MemberExpression' && !parent.left.computed) return parent.left.property.name;
  }
  return undefined;
}

export function instrument(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, locations: true });
  const ins = []; let order = 0;
  const add = (pos, text, prio = 1) => ins.push({ pos, text, prio, order: order++ });
  let topScope = null;
  let tracked = false;   // inside a function that has a frame: its returns report their value (__ret)

  const snapText = (line, scopes, fd) => {
    const m = new Map();
    for (const sc of scopes) for (const n of sc.names) m.set(n, sc.fd);
    const parts = [];
    for (const [n, f] of m) parts.push('[' + JSON.stringify(n) + ',()=>' + n + ',' + f + ']');
    return '__t(' + line + ',' + fd + ',[' + parts.join(',') + ']);';
  };
  const list = (stmts, scopes, fd) => {
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration' || s.type === 'EmptyStatement' || s.directive) continue;
      add(s.start, snapText(s.loc.start.line, scopes, fd));
    }
  };
  const wrap = (body, scopes, fd) => {
    if (body.type === 'BlockStatement') { walk(body, scopes, fd); return; }
    if (body.type === 'EmptyStatement') return;
    add(body.start, '{' + snapText(body.loc.start.line, scopes, fd));
    add(body.end, '}', 0);
    walk(body, scopes, fd);
  };
  const declNames = (d) => {
    const names = new Set();
    if (d && d.type === 'VariableDeclaration' && d.kind !== 'var') d.declarations.forEach(x => patNames(x.id, names));
    return names;
  };

  function walk(n, scopes, fd, hint) {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'Program': {
        const names = new Set([...collectVar(n, new Set()), ...lexical(n.body)]);
        topScope = { names, fd: 0 };
        const sc = scopes.concat([topScope]);
        list(n.body, sc, 0);
        n.body.forEach(s => walk(s, sc, 0));
        return;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const params = new Set(); n.params.forEach(p => patNames(p, params));
        const body = n.body, isBlock = body.type === 'BlockStatement';
        const names = new Set(params);
        if (isBlock) { collectVar(body, names); lexical(body.body).forEach(x => names.add(x)); }
        const nfd = fd + 1;
        const sc = scopes.concat([{ names, fd: nfd }]);
        n.params.forEach(p => walk(p, sc, nfd));
        if (isBlock) {
          const fname = (n.id && n.id.name) || hint || '(anonymous)';
          const track = !n.async && !n.generator;
          if (track) {
            const ents = [...params].map(p => '[' + JSON.stringify(p) + ',()=>' + p + ']').join(',');
            add(body.start + 1, '__enter(' + JSON.stringify(fname) + ',[' + ents + ']);try{');
          }
          const outer = tracked; tracked = track;
          list(body.body, sc, nfd);
          body.body.forEach(s => walk(s, sc, nfd));
          tracked = outer;
          if (track) add(body.end - 1, '}finally{__exit();}', 0);
        } else { const outer = tracked; tracked = false; walk(body, sc, nfd); tracked = outer; }
        return;
      }
      case 'BlockStatement': {
        const sc = scopes.concat([{ names: lexical(n.body), fd }]);
        list(n.body, sc, fd);
        n.body.forEach(s => walk(s, sc, fd));
        return;
      }
      case 'ForStatement': {
        const sc = scopes.concat([{ names: declNames(n.init), fd }]);
        walk(n.init, sc, fd); walk(n.test, sc, fd); walk(n.update, sc, fd);
        wrap(n.body, sc, fd);
        return;
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const sc = scopes.concat([{ names: declNames(n.left), fd }]);
        walk(n.left, sc, fd); walk(n.right, sc, fd);
        wrap(n.body, sc, fd);
        return;
      }
      case 'ReturnStatement':
        if (n.argument && tracked) { add(n.argument.start, '__ret(', 2); add(n.argument.end, ')', 0); }
        walk(n.argument, scopes, fd);
        return;
      case 'WhileStatement': walk(n.test, scopes, fd); wrap(n.body, scopes, fd); return;
      case 'DoWhileStatement': wrap(n.body, scopes, fd); walk(n.test, scopes, fd); return;
      case 'IfStatement':
        walk(n.test, scopes, fd);
        wrap(n.consequent, scopes, fd);
        if (n.alternate) { if (n.alternate.type === 'IfStatement') walk(n.alternate, scopes, fd); else wrap(n.alternate, scopes, fd); }
        return;
      case 'SwitchStatement': {
        walk(n.discriminant, scopes, fd);
        const names = new Set(); n.cases.forEach(c => lexical(c.consequent).forEach(x => names.add(x)));
        const sc = scopes.concat([{ names, fd }]);
        n.cases.forEach(c => { walk(c.test, sc, fd); list(c.consequent, sc, fd); c.consequent.forEach(s => walk(s, sc, fd)); });
        return;
      }
      case 'CatchClause': {
        const names = new Set(); patNames(n.param, names);
        walk(n.body, scopes.concat([{ names, fd }]), fd);
        return;
      }
      default:
        for (const k in n) {
          if (k === 'loc' || k === 'type') continue;
          const c = n[k];
          if (Array.isArray(c)) c.forEach(x => walk(x, scopes, fd, x && typeof x.type === 'string' ? hintFor(n, x) : undefined));
          else if (c && typeof c.type === 'string') walk(c, scopes, fd, hintFor(n, c));
        }
    }
  }

  walk(ast, [], 0);
  ins.sort((a, b) => a.pos - b.pos || a.prio - b.prio || a.order - b.order);
  let out = code;
  for (let i = ins.length - 1; i >= 0; i--) out = out.slice(0, ins[i].pos) + ins[i].text + out.slice(ins[i].pos);
  out += '\n;' + snapText(-1, [topScope], 0);
  return out;
}
