/*
 * NashNet UI runtime
 * ------------------
 * A tiny renderer for our screen templates:
 *   {{path}}            value lookup (dotted path into renderVals())
 *   <sc-for list as>    repeat children for each element of a list
 *   <sc-if value>       render children only when value is truthy
 *   onClick / onInput   event handlers returned by renderVals()
 * Each screen defines `class Component extends Screen` with renderVals(), setState(),
 * forceUpdate() and React-style mount/unmount hooks. Rendering goes through a small
 * index-based virtual DOM diff so inputs keep focus and CSS transitions keep working.
 * Screens are switched by URL hash: #/welcome, #/world, #/showdown, #/lab.
 */
(function () {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };

  var decoder = document.createElement('textarea');
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    decoder.innerHTML = s;
    return decoder.value;
  }

  /* ---------- template parsing ---------- */
  function parse(src) {
    var root = { tag: '#root', attrs: [], children: [] };
    var stack = [root];
    var i = 0, n = src.length;
    var isSpace = function (c) { return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f'; };
    while (i < n) {
      if (src.startsWith('<!--', i)) {
        var ce = src.indexOf('-->', i);
        i = ce < 0 ? n : ce + 3;
        continue;
      }
      if (src[i] === '<' && src[i + 1] === '/') {
        var ge = src.indexOf('>', i);
        var ctag = src.slice(i + 2, ge).trim();
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === ctag) { stack.length = k; break; }
        }
        i = ge + 1;
        continue;
      }
      if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] || '')) {
        var j = i + 1;
        while (j < n && !isSpace(src[j]) && src[j] !== '>' && src[j] !== '/') j++;
        var tag = src.slice(i + 1, j);
        var attrs = [];
        var selfClose = false;
        while (j < n) {
          while (j < n && isSpace(src[j])) j++;
          if (src[j] === '>') { j++; break; }
          if (src[j] === '/' && src[j + 1] === '>') { j += 2; selfClose = true; break; }
          var s0 = j;
          while (j < n && !isSpace(src[j]) && src[j] !== '=' && src[j] !== '>' && !(src[j] === '/' && src[j + 1] === '>')) j++;
          var name = src.slice(s0, j);
          var value = '';
          var save = j;
          while (j < n && isSpace(src[j])) j++;
          if (src[j] === '=') {
            j++;
            while (j < n && isSpace(src[j])) j++;
            var q = src[j];
            if (q === '"' || q === "'") {
              var qe = src.indexOf(q, j + 1);
              value = src.slice(j + 1, qe);
              j = qe + 1;
            } else {
              var ue = j;
              while (ue < n && !isSpace(src[ue]) && src[ue] !== '>') ue++;
              value = src.slice(j, ue);
              j = ue;
            }
          } else {
            j = save;
          }
          if (name) attrs.push([name, decode(value)]);
          else j++;
        }
        var node = { tag: tag, attrs: attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        var lower = tag.toLowerCase();
        if (lower === 'style' || lower === 'script') {
          var re = src.indexOf('</' + tag, j);
          node.raw = src.slice(j, re);
          i = src.indexOf('>', re) + 1;
          continue;
        }
        if (!VOID[lower] && !selfClose) stack.push(node);
        i = j;
        continue;
      }
      var te = src.indexOf('<', i + 1);
      if (te < 0) te = n;
      var text = src.slice(i, te);
      if (!(/^\s*$/.test(text) && text.indexOf('\n') >= 0)) {
        stack[stack.length - 1].children.push({ text: decode(text) });
      }
      i = te;
    }
    return root;
  }

  /* ---------- holes ---------- */
  var SINGLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  function prep(str) {
    var m = str.match(SINGLE);
    if (m) return { single: m[1] };
    if (str.indexOf('{{') < 0) return { stat: str };
    var parts = [], last = 0, mm;
    HOLE.lastIndex = 0;
    while ((mm = HOLE.exec(str))) {
      if (mm.index > last) parts.push(str.slice(last, mm.index));
      parts.push({ e: mm[1] });
      last = mm.index + mm[0].length;
    }
    if (last < str.length) parts.push(str.slice(last));
    return { parts: parts };
  }
  function lookup(scope, expr) {
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return +expr;
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    var segs = expr.split('.');
    var v = scope[segs[0]];
    for (var i = 1; i < segs.length; i++) {
      if (v == null) return undefined;
      v = v[segs[i]];
    }
    return v;
  }
  function evalRaw(tp, scope) {
    if (!tp) return undefined;
    if (tp.single !== undefined) return lookup(scope, tp.single);
    return evalStr(tp, scope);
  }
  function evalStr(tp, scope) {
    if (tp.stat !== undefined) return tp.stat;
    if (tp.single !== undefined) { var v = lookup(scope, tp.single); return v == null ? '' : String(v); }
    var out = '';
    for (var i = 0; i < tp.parts.length; i++) {
      var p = tp.parts[i];
      if (typeof p === 'string') out += p;
      else { var x = lookup(scope, p.e); out += x == null ? '' : String(x); }
    }
    return out;
  }
  function compile(node) {
    if (node.text !== undefined) { node.tp = prep(node.text); return; }
    node.cattrs = node.attrs.filter(function (a) { return a[0].indexOf('hint-') !== 0; }).map(function (a) { return [a[0], prep(a[1])]; });
    node.amap = {};
    node.cattrs.forEach(function (a) { node.amap[a[0]] = a[1]; });
    (node.children || []).forEach(compile);
  }

  /* ---------- render to virtual nodes ---------- */
  function renderNodes(nodes, scope, out, ns) {
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.text !== undefined) {
        var s = evalStr(nd.tp, scope);
        if (s !== '') out.push({ t: s });
        continue;
      }
      if (nd.tag === 'x-head' || nd.tag === 'style' || nd.tag === 'script' || nd.tag === 'link') continue;
      if (nd.tag === 'sc-for') {
        var list = evalRaw(nd.amap.list, scope) || [];
        var as = nd.amap.as ? evalStr(nd.amap.as, scope) : 'item';
        for (var li = 0; li < list.length; li++) {
          var sc = Object.create(scope);
          sc[as] = list[li];
          sc.$index = li;
          renderNodes(nd.children, sc, out, ns);
        }
        continue;
      }
      if (nd.tag === 'sc-if') {
        if (evalRaw(nd.amap.value, scope)) renderNodes(nd.children, scope, out, ns);
        continue;
      }
      var cns = nd.tag === 'svg' ? SVGNS : ns;
      var v = { tag: nd.tag, ns: cns, attrs: {}, ev: {}, props: {}, ch: [] };
      for (var a = 0; a < nd.cattrs.length; a++) {
        var name = nd.cattrs[a][0], tp = nd.cattrs[a][1];
        if (/^on[A-Z]/.test(name)) { v.ev[name.slice(2).toLowerCase()] = evalRaw(tp, scope); continue; }
        var val = tp.single !== undefined ? lookup(scope, tp.single) : evalStr(tp, scope);
        if (name === 'disabled' || name === 'checked') { v.props[name] = val === '' ? true : !!val; continue; }
        if (name === 'value' && (nd.tag === 'input' || nd.tag === 'select' || nd.tag === 'textarea')) { v.props.value = val == null ? '' : String(val); continue; }
        if (val === undefined || val === null || typeof val === 'function') continue;
        v.attrs[name] = String(val);
      }
      renderNodes(nd.children, scope, v.ch, cns);
      out.push(v);
    }
  }

  /* ---------- patch real DOM ---------- */
  function setEv(el, type, fn) {
    if (!el._ev) el._ev = {};
    if (!(type in el._ev)) {
      el.addEventListener(type, function (e) {
        var f = el._ev[type];
        if (typeof f === 'function') f(e);
      });
    }
    el._ev[type] = fn;
  }
  function create(v) {
    if (v.t !== undefined) { var tn = document.createTextNode(v.t); tn._v = v; return tn; }
    var el = v.ns ? document.createElementNS(v.ns, v.tag) : document.createElement(v.tag);
    for (var k in v.attrs) el.setAttribute(k, v.attrs[k]);
    for (var e in v.ev) setEv(el, e, v.ev[e]);
    el._kids = [];
    for (var i = 0; i < v.ch.length; i++) { var c = create(v.ch[i]); el.appendChild(c); el._kids.push(c); }
    for (var p in v.props) el[p] = v.props[p];
    el._v = v;
    return el;
  }
  function patch(el, nv) {
    var ov = el._v;
    if (nv.t !== undefined || ov.t !== undefined) {
      if (nv.t !== undefined && ov.t !== undefined) {
        if (ov.t !== nv.t) el.nodeValue = nv.t;
        el._v = nv;
        return el;
      }
      var r = create(nv); el.parentNode.replaceChild(r, el); return r;
    }
    if (ov.tag !== nv.tag || ov.ns !== nv.ns) {
      var r2 = create(nv); el.parentNode.replaceChild(r2, el); return r2;
    }
    var k;
    for (k in nv.attrs) if (ov.attrs[k] !== nv.attrs[k]) el.setAttribute(k, nv.attrs[k]);
    for (k in ov.attrs) if (!(k in nv.attrs)) el.removeAttribute(k);
    for (k in nv.ev) setEv(el, k, nv.ev[k]);
    for (k in ov.ev) if (!(k in nv.ev)) el._ev[k] = null;
    patchChildren(el, nv.ch);
    for (k in nv.props) if (el[k] !== nv.props[k]) el[k] = nv.props[k];
    el._v = nv;
    return el;
  }
  function patchChildren(parent, newCh) {
    var kids = parent._kids || (parent._kids = []);
    var i;
    for (i = 0; i < newCh.length; i++) {
      if (i < kids.length) kids[i] = patch(kids[i], newCh[i]);
      else { var c = create(newCh[i]); parent.appendChild(c); kids.push(c); }
    }
    for (var j = kids.length - 1; j >= newCh.length; j--) { parent.removeChild(kids[j]); kids.pop(); }
  }

  /* ---------- component base class ---------- */
  function Screen(props) { this.props = props || {}; this.state = undefined; }
  Screen.prototype.setState = function (p) {
    var upd = typeof p === 'function' ? p(this.state || {}, this.props) : p;
    this.state = Object.assign({}, this.state || {}, upd || {});
    if (this._schedule) this._schedule();
  };
  Screen.prototype.forceUpdate = function () { if (this._schedule) this._schedule(); };

  /* ---------- screens & routing ---------- */
  var app = document.getElementById('app');
  var styleEl = document.getElementById('screen-style');
  var current = null;

  function showError(err) {
    console.error(err);
    var box = document.getElementById('nn-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nn-error';
      box.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:99;padding:14px 16px;border-radius:12px;background:#3a1410;color:#ffd9cf;font:13px/1.5 monospace;white-space:pre-wrap;border:1px solid #ff6b4a';
      document.body.appendChild(box);
    }
    box.textContent = 'Something went wrong on this screen: ' + (err && err.message ? err.message : err) + '\nTry reloading the page.';
  }

  function prepareScreen(S) {
    if (S.ast) return;
    S.ast = parse(S.template);
    compile(S.ast);
    S.Comp = new Function('Screen', 'makeEngine', S.script + '\n;return Component;')(Screen, window.makeEngine);
  }

  function mount(route) {
    var S = window.NASHNET_SCREENS[route] || window.NASHNET_SCREENS.welcome;
    if (current) {
      try { if (current.inst.componentWillUnmount) current.inst.componentWillUnmount(); } catch (e) { console.error(e); }
      current.inst._dead = true;
    }
    var old = document.getElementById('nn-error'); if (old) old.remove();
    try { prepareScreen(S); } catch (e) { showError(e); return; }
    styleEl.textContent = S.style;
    document.title = S.title;
    app.innerHTML = '';
    var host = document.createElement('div');
    host._kids = [];
    app.appendChild(host);
    var inst = new S.Comp({});
    var pending = false;
    function render() {
      var vals;
      try { vals = inst.renderVals(); } catch (e) { showError(e); return; }
      var out = [];
      try { renderNodes(S.ast.children, vals, out, null); patchChildren(host, out); } catch (e2) { showError(e2); }
    }
    inst._schedule = function () {
      if (pending || inst._dead) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; if (!inst._dead) render(); });
    };
    current = { inst: inst, route: route };
    render();
    window.scrollTo(0, 0);
    try { if (inst.componentDidMount) inst.componentDidMount(); } catch (e) { showError(e); }
  }

  function routeFromHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    return window.NASHNET_SCREENS[h] ? h : 'welcome';
  }
  window.addEventListener('hashchange', function () { mount(routeFromHash()); });
  mount(routeFromHash());
})();
