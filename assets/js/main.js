/* 大盘云图 —— 应用层
 * 结构：状态 → 数据装载 → 模型构建 → Canvas 渲染 → 侧栏/底栏水合 → 交互 → 弹窗
 */
(function () {
  'use strict';
  const D = window.DPYT;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = D.clamp;

  /* ------------------------------- 常量 ------------------------------- */
  const MARKETS = [
    { id: 'all', label: 'A 股全图', index: '国证Ａ指' },
    { id: 'sse', label: '上证 A 股', index: '上证指数' },
    { id: 'szse', label: '深证 A 股', index: '深证Ａ指' },
    { id: 'hs300', label: '沪深 300', index: '沪深300' },
    { id: 'zza50', label: '中证 A50', index: '中证A50' },
    { id: 'zza500', label: '中证 A500', index: '中证A500' },
    { id: 'main', label: 'A 股主板', index: 'A 股主板' },
    { id: 'cyb', label: '创业板', index: '创业板指' },
    { id: 'kcb', label: '科创板', index: '科创综指' },
    { id: 'watch', label: '自选', index: '自选股' }
  ];
  const PERIODS = [
    { id: 'day', label: '日', title: '当日涨跌' },
    { id: 'week', label: '周', title: '近 5 日涨跌' },
    { id: 'month', label: '月', title: '近 20 日涨跌' },
    { id: 'year', label: '年', title: '今年以来' }
  ];
  const ACCENTS = {
    red: { light: '#ef4444', dark: '#ef4444' },
    green: { light: '#10b981', dark: '#10b981' },
    blue: { light: '#3b82f6', dark: '#3b82f6' },
    purple: { light: '#a855f7', dark: '#a855f7' }
  };
  const BTN_MARKET = 'flex w-full min-w-0 items-center justify-between border px-1.5 py-1.5 text-left transition-colors ';
  const BTN_MARKET_IDLE = BTN_MARKET + 'border-border bg-background hover:bg-muted';
  const BTN_MARKET_ACTIVE = BTN_MARKET + 'border-brand/55 bg-brand/12 text-foreground';

  /* ------------------------------- 状态 ------------------------------- */
  const store = {
    market: 'all',
    period: 'day',
    metric: 'value',
    mode: 'dark',
    polarity: 'red-rise',
    themeId: 'classic',
    accent: 'red',
    thumbnail: false,
    collapse: false,
    showStats: true,
    showBorder: true,
    autoRefresh: 10,
    filterOpen: 'click',
    boards: [],            // 选中的一级板块（空=全部）
    trend: 'all',          // all | up | down
    rangeMin: null,
    rangeMax: null,
    focusBoard: null,
    selected: null,        // 选中的个股 code
    hover: null,           // 悬浮的个股
    view: { x: 0, y: 0, scale: 1 },
    watchlist: []
  };

  const cache = {};        // market+period -> dataset
  const overview = {};     // period -> overview payload
  let model = { boardRects: [], subBoardRects: [], stockRects: [], nodes: [] };
  let quotes = {};
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let needsPaint = false, rafId = 0;

  /* ------------------------------ 工具函数 ------------------------------ */
  const invert = () => store.polarity === 'red-rise';
  const theme = () => D.getTheme(store.themeId);
  const palette = () => (store.mode === 'light' ? D.CANVAS.light : D.CANVAS.dark);
  function accentColor(kind) { // kind: 'up' | 'down' | 'flat'
    const pal = theme()[store.mode === 'light' ? 'light' : 'dark'];
    if (kind === 'flat') return D.rgbStr(pal.flat);
    const up = kind === 'up' ? invert() : !invert();
    return D.rgbStr(D.lerp(up ? pal.positiveSoft : pal.negativeSoft, up ? pal.positiveStrong : pal.negativeStrong, 0.62));
  }
  const metricOf = s => (store.metric === 'turnover' ? (s.turnoverAmount || 0) : s.value);
  const key = () => store.market + '-' + store.period;

  function readLS(k, d) { try { const v = localStorage.getItem('dpyt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem('dpyt.' + k, JSON.stringify(v)); } catch (e) {} }

  function persist() {
    writeLS('prefs', {
      market: store.market, period: store.period, metric: store.metric, mode: store.mode,
      polarity: store.polarity, themeId: store.themeId, accent: store.accent,
      thumbnail: store.thumbnail, collapse: store.collapse, showStats: store.showStats,
      showBorder: store.showBorder, autoRefresh: store.autoRefresh, filterOpen: store.filterOpen
    });
    writeLS('watchlist', store.watchlist);
  }
  function restore() {
    const p = readLS('prefs', null);
    if (p) Object.keys(p).forEach(k => { if (k in store) store[k] = p[k]; });
    store.watchlist = readLS('watchlist', []) || [];
  }

  /* ------------------------------ 数据装载 ------------------------------ */
  /* ============================ 网络层（实时数据） ============================ */
  const NET = {
    online: location.protocol !== 'file:',   // file:// 下无同源 API，直接走离线快照
    source: 'local',                         // live | stale | local
    lastAt: 0,
    lastError: null,
    failCount: 0
  };
  async function apiJSON(path, ms) {
    if (!NET.online) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 12000);
    try {
      const r = await fetch('/api/heatmap/' + path, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const snap = (r.headers.get('x-heatmap-snapshot') || '').toLowerCase();
      const j = await r.json();
      NET.failCount = 0; NET.lastAt = Date.now(); NET.lastError = null;
      NET.source = snap === 'stale' ? 'stale' : 'live';
      return j;
    } catch (e) {
      NET.lastError = String(e && e.message || e);
      NET.failCount += 1;
      if (NET.failCount >= 3) { NET.online = false; NET.retryAt = Date.now(); }  // 连续失败 → 降级为离线快照
      return null;
    } finally { clearTimeout(timer); }
  }
  async function fetchDataset(market, period) {
    const ds = await apiJSON('treemap?period=' + encodeURIComponent(period) + '&market=' + encodeURIComponent(market));
    return ds && ds.nodes && ds.nodes.length ? ds : null;
  }
  async function fetchOverview(period) {
    const o = await apiJSON('overview?period=' + encodeURIComponent(period));
    return o && o.markets && o.markets.length ? o : null;
  }
  /* 个股实时报价：NDJSON 快照（start / quotes / complete 三行） */
  async function fetchQuotes(period) {
    if (!NET.online) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch('/api/heatmap/quotes/stream?period=' + encodeURIComponent(period), { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const map = {};
      let got = 0;
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.charCodeAt(0) !== 123) continue;
        let o; try { o = JSON.parse(t); } catch (e) { continue; }
        if (!o.quotes) continue;
        for (const key of Object.keys(o.quotes)) {
          const q = o.quotes[key];
          if (!q) continue;
          map[key] = q;
          const bare = key.indexOf('.') > 0 ? key.slice(0, key.indexOf('.')) : key;
          if (!map[bare]) map[bare] = q;
          got += 1;
        }
        if (o.updatedAt) NET.quoteAt = o.updatedAt;
      }
      return got ? map : null;
    } catch (e) {
      NET.lastError = String(e && e.message || e);
      return null;
    } finally { clearTimeout(timer); }
  }
  function injectScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('load fail ' + src));
      document.head.appendChild(s);
    });
  }
  // 仅本地/缓存：首屏立刻有图，实时数据由 refreshLive() 并行预取后覆盖
  async function loadDataset(market, period, force) {
    const k = market + '-' + period;
    if (market === 'watch') return buildWatchlistDataset();
    if (!force && cache[k]) return cache[k];
    const g = window.DPYT_DATA || {};
    if (g[k]) { cache[k] = g[k]; return cache[k]; }
    const file = 'assets/data/' + market + '-' + period + '.js';
    try {
      await injectScript(file);
    } catch (e) { /* 离线缺文件 */ }
    const gg = window.DPYT_DATA || {};
    if (gg[k]) { cache[k] = gg[k]; return cache[k]; }
    // 回退：该市场仅打包了日线数据
    if (period !== 'day') {
      try { await injectScript('assets/data/' + market + '-day.js'); } catch (e) {}
      if (gg[market + '-day']) { cache[k] = gg[market + '-day']; return cache[k]; }
    }
    return null;
  }
  async function loadOverview(period, force) {
    if (!force && overview[period]) return overview[period];
    const g = window.DPYT_OVERVIEW || {};
    if (g[period]) { overview[period] = g[period]; return overview[period]; }
    try { await injectScript('assets/data/overview.js'); } catch (e) {}
    const gg = window.DPYT_OVERVIEW || {};
    overview[period] = gg[period] || null;
    return overview[period];
  }
  function allStocks() {
    const ds = cache['all-day'];
    return ds ? ds.nodes.reduce((a, n) => a.concat(n.children), []) : [];
  }
  function buildWatchlistDataset() {
    const base = cache['all-day'] || (window.DPYT_DATA && window.DPYT_DATA['all-day']);
    if (!base) return null;
    const set = new Set(store.watchlist.map(c => c.toUpperCase()));
    const byCode = new Map();
    base.nodes.forEach(n => n.children.forEach(s => byCode.set(String(s.code).toUpperCase(), s)));
    const picked = [...set].map(c => byCode.get(c)).filter(Boolean);
    if (!picked.length) return { market: 'watch', period: store.period, updatedAt: base.updatedAt, stockCount: 0, boardCount: 0, nodes: [], summary: { advanceCount: 0, flatCount: 0, declineCount: 0, turnoverAmount: 0, turnoverPreviousAmount: 0 } };
    const boards = new Map();
    picked.forEach(s => {
      const b = s.boardName || '自选';
      if (!boards.has(b)) boards.set(b, { code: 'W' + boards.size, name: b, value: 0, stockCount: 0, children: [] });
      const node = boards.get(b);
      node.children.push(s); node.value += s.value; node.stockCount += 1;
    });
    const nodes = [...boards.values()].sort((a, b) => b.value - a.value);
    const counts = D.trendCountsOf(picked);
    return { market: 'watch', period: store.period, updatedAt: base.updatedAt, stockCount: picked.length, boardCount: nodes.length, nodes,
      summary: Object.assign({ turnoverAmount: picked.reduce((a, s) => a + (s.turnoverAmount || 0), 0), turnoverPreviousAmount: 0 }, counts) };
  }

  /* ------------------------------ 模型构建 ------------------------------ */
  const FLAT = D.FLAT_THRESHOLD;
  function filteredNodes(ds) {
    if (!ds) return [];
    let nodes = ds.nodes.slice();
    if (store.boards.length) {
      const set = new Set(store.boards);
      nodes = nodes.filter(n => set.has(n.name));
    }
    const min = store.rangeMin, max = store.rangeMax;
    nodes = nodes.map(n => {
      let kids = n.children.filter(s => {
        const v = s.changePct;
        if (store.trend === 'up' && !(v > FLAT)) return false;
        if (store.trend === 'down' && !(v < -FLAT)) return false;
        if (min != null && !(v >= min)) return false;
        if (max != null && !(v <= max)) return false;
        return true;
      });
      kids = kids.map(s => Object.assign({}, s, { value: metricOf(s) }));
      return Object.assign({}, n, { children: kids, stockCount: kids.length, value: kids.reduce((a, s) => a + s.value, 0) });
    }).filter(n => n.children.length && n.value > 0);
    return nodes.sort((a, b) => b.value - a.value);
  }
  function rebuildModel() {
    const ds = cache[key()];
    const nodes = filteredNodes(ds);
    model = Object.assign({ nodes }, D.buildRects(nodes, W, H, {
      borders: store.showBorder, collapse: store.collapse, market: store.market, quotes
    }));
  }

  /* ------------------------------- 渲染 ------------------------------- */
  const canvas = $('#heatmap-canvas');
  const ctx = canvas.getContext('2d');
  const cwrap = canvas.parentElement;

  function invalidate() {
    if (needsPaint) return;
    needsPaint = true;
    rafId = requestAnimationFrame(() => { needsPaint = false; paint(); });
  }
  function measure() {
    const r = cwrap.getBoundingClientRect();
    const nw = Math.max(1, Math.floor(r.width)), nh = Math.max(1, Math.floor(r.height));
    if (nw !== W || nh !== H) {
      W = nw; H = nh;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      rebuildModel();
    }
  }
  function visible(r, vx, vy, vw, vh, m) {
    return r.x + r.width > vx - m && r.x < vx + vw + m && r.y + r.height > vy - m && r.y < vy + vh + m;
  }
  function paint() {
    const c = palette(), v = store.view;
    /* 只在与当前后备缓冲尺寸不同时才赋值 canvas.width/height：
       给它们赋值会丢弃整个后备缓冲并重建（一帧空白），每轮刷新都赋值就会整屏闪。 */
    const cw = Math.max(1, Math.floor(W * dpr)), chh = Math.max(1, Math.floor(H * dpr));
    if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    bg.addColorStop(0, c.backgroundStart); bg.addColorStop(1, c.backgroundEnd);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);
    const vx = -v.x / v.scale - 4, vy = -v.y / v.scale - 4;
    const vw = W / v.scale + 8, vh = H / v.scale + 8;
    const th = theme(), inv = invert(), mode = store.mode;
    const collapse = store.collapse, borders = store.showBorder, stats = store.showStats;
    const noBoardFilter = store.boards.length === 0;

    // ① 一级板块底板
    ctx.fillStyle = c.boardFill;
    for (const b of model.boardRects) {
      if (!visible(b, vx, vy, vw, vh, 0)) continue;
      ctx.fillRect(b.x, b.y, b.width, b.height);
    }
    // ② 二级板块底板
    for (const s of model.subBoardRects) {
      if (!visible(s, vx, vy, vw, vh, 0)) continue;
      ctx.fillStyle = collapse ? D.titleFill(th, s.changePct, inv, mode) : c.subBoardFill;
      ctx.fillRect(s.x, s.y, s.width, s.height);
    }
    // ③ 个股色块 + 标签
    if (!collapse) {
      for (const s of model.stockRects) {
        if (!visible(s, vx, vy, vw, vh, 0)) continue;
        const q = quotes[s.code];
        const pct = q && q.changePct != null ? q.changePct : s.changePct;
        ctx.fillStyle = D.stockFill(th, pct, inv, mode);
        ctx.fillRect(s.x, s.y, s.width, s.height);
        if (store.selected === s.code) {
          ctx.fillStyle = mode === 'light' ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.13)';
          ctx.fillRect(s.x, s.y, s.width, s.height);
          const t = Math.min(11 / v.scale, 0.28 * s.width, 0.28 * s.height);
          if (t >= 2 / v.scale) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.beginPath();
            ctx.moveTo(s.x + s.width, s.y);
            ctx.lineTo(s.x + s.width - t, s.y);
            ctx.lineTo(s.x + s.width, s.y + t);
            ctx.closePath();
            ctx.fill();
          }
        }
        D.drawStockLabel(ctx, s, v.scale, store.selected === s.code, q);
      }
    }
    // ④ 二级板块标题条 / 边框 / 文字
    for (const s of model.subBoardRects) {
      if (!visible(s, vx, vy, vw, vh, 0)) continue;
      const active = store.focusBoard === s.name;
      if (!collapse && s.titleHeight > 0) {
        ctx.fillStyle = D.titleFill(th, s.changePct, inv, mode);
        ctx.fillRect(s.x, s.y, s.width, s.titleHeight);
      }
      if (borders) {
        ctx.strokeStyle = active ? c.activeSubBoardStroke : c.subBoardBorder;
        ctx.lineWidth = active ? 2 : collapse ? 1.1 : 0.9;
        ctx.strokeRect(s.x + 0.5, s.y + 0.5, Math.max(0, s.width - 1), Math.max(0, s.height - 1));
      }
      if (collapse) {
        D.drawSubBoardBlock(ctx, s, {
          name: s.name, changePct: s.changePct, advanceCount: s.advanceCount, declineCount: s.declineCount
        }, v.scale);
      } else if (s.width > 44 && s.titleHeight > 8) {
        D.drawBoardTitle(ctx, s, {
          name: s.name, changePct: s.changePct, advanceCount: s.advanceCount, declineCount: s.declineCount,
          compact: true, showStats: stats
        });
      }
    }
    // ⑤ 一级板块标题条 / 边框 / 文字
    for (const b of model.boardRects) {
      if (!visible(b, vx, vy, vw, vh, 0)) continue;
      const focused = store.focusBoard === b.name;
      const active = focused;
      if (b.titleHeight > 0) {
        ctx.fillStyle = D.titleFill(th, b.changePct, inv, mode);
        ctx.fillRect(b.x, b.y, b.width, b.titleHeight);
        if (active) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.fillRect(b.x, b.y, b.width, b.titleHeight);
        }
      }
      if (borders) {
        ctx.strokeStyle = active ? c.activeBoardStroke : c.boardBorder;
        ctx.lineWidth = active ? 1.8 : 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(0, b.width - 1), Math.max(0, b.height - 1));
      }
      const drill = noBoardFilter && b.width > 72 && b.titleHeight > 10;
      if (b.width > 56 && b.titleHeight > 10) {
        let label = b.name;
        if (store.boards.length) label = store.boards.length === 1 ? '‹ 全部板块 - ' + b.name : '‹ ' + b.name;
        D.drawBoardTitle(ctx, b, {
          name: label, changePct: b.changePct, advanceCount: b.advanceCount, declineCount: b.declineCount,
          compact: false, showStats: collapse || stats, showDrillHint: drill
        });
        if (drill) {
          ctx.fillStyle = active ? 'rgba(255, 255, 255, 0.95)' : 'rgba(247, 250, 252, 0.72)';
          ctx.font = D.fontOf(700, Math.max(10, clamp(Math.floor(0.52 * b.titleHeight), 10, 15)));
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText('›', b.x + b.width - 8, b.y + b.titleHeight / 2 + 0.5);
          ctx.textAlign = 'left';
        }
      }
    }
    // ⑥ 悬浮个股高亮
    const hr = store.hover ? findStock(store.hover.code) : null;
    if (hr && borders) {
      ctx.strokeStyle = c.highlightOuter; ctx.lineWidth = 4;
      ctx.strokeRect(hr.x + 1, hr.y + 1, Math.max(0, hr.width - 2), Math.max(0, hr.height - 2));
      ctx.strokeStyle = c.highlightInner; ctx.lineWidth = 2;
      ctx.strokeRect(hr.x + 1, hr.y + 1, Math.max(0, hr.width - 2), Math.max(0, hr.height - 2));
    }
    ctx.restore();
  }
  function findStock(code) {
    for (const s of model.stockRects) if (s.code === code) return s;
    return null;
  }
  function toLogical(clientX, clientY) {
    const r = cwrap.getBoundingClientRect();
    const v = store.view;
    return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale };
  }
  function stockAt(px, py) {
    for (let i = model.stockRects.length - 1; i >= 0; i--) {
      const s = model.stockRects[i];
      if (px >= s.x && px <= s.x + s.width && py >= s.y && py <= s.y + s.height) return s;
    }
    return null;
  }
  function boardAt(px, py) {
    for (const b of model.boardRects) {
      if (b.titleHeight > 0 && px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.titleHeight) return b;
    }
    return null;
  }

  /* ============================ 侧栏水合 ============================ */
  const fmtUpdated = iso => D.updatedShort(iso);
  function currentSummary() {
    const ds = cache[key()];
    if (ds && ds.summary) return { summary: ds.summary, updatedAt: ds.updatedAt };
    const ov = overview[store.period];
    if (ov) {
      const it = ov.markets.find(m => m.market === store.market);
      return { summary: null, updatedAt: it ? it.updatedAt : ov.updatedAt };
    }
    return { summary: null, updatedAt: null };
  }
  function hydrateMarkets() {
    const box = $('#market-list'); if (!box) return;
    const ov = overview[store.period];
    const list = MARKETS;
    const ds = cache[key()];
    setHtml(box, list.map(m => {
      let pct = '--', color = accentColor('flat'), title = m.index, upd = '';
      if (m.id === 'watch') {
        title = '自选';
        const wd = buildWatchlistDataset();
        if (wd && wd.stockCount) {
          const v = D.weightedChange(wd.nodes.reduce((a, n) => a.concat(n.children), []));
          if (v != null) { pct = D.pctShort(v); color = v > 0 ? accentColor('up') : v < 0 ? accentColor('down') : accentColor('flat'); }
        }
      } else if (ov) {
        const it = ov.markets.find(x => x.market === m.id);
        if (it) {
          pct = D.pctShort(it.changePct);
          color = it.changePct > 0 ? accentColor('up') : it.changePct < 0 ? accentColor('down') : accentColor('flat');
          title = it.indexName || title;
          upd = fmtUpdated(it.updatedAt);
        }
      } else if (ds && ds.summary) {
        const v = ds.summary.indexChangePct;
        if (v != null) {
          pct = D.pctShort(v); color = v > 0 ? accentColor('up') : v < 0 ? accentColor('down') : accentColor('flat');
          upd = fmtUpdated(ds.updatedAt);
        }
      }
      const active = store.market === m.id;
      return '<button type="button" data-market="' + m.id + '" class="' + (active ? BTN_MARKET_ACTIVE : BTN_MARKET_IDLE) + '"'
        + (upd ? ' title="' + title + ' · 更新时间 ' + upd + '"' : ' title="' + title + '"') + '>'
        + '<span class="min-w-0 pr-2 text-[12px]">' + m.label + '</span>'
        + '<span class="shrink-0 font-semibold tabular-nums text-[12px]" style="color:' + color + '">' + pct + '</span>'
        + '</button>';
    }).join(''));
  }
  function hydrateUpdate() {
    const g = $('#update-group'); if (!g) return;
    const spans = $$('span', g);
    const target = spans[spans.length - 1];
    const { updatedAt } = currentSummary();
    const txt = updatedAt ? fmtUpdated(updatedAt) : '--.-- --:--';
    if (target) {
      let svg = target.querySelector('svg');
      /* 首次加载才转圈；后续刷新不插/拔图标，否则时间文字会左右跳动 */
      const spin = isLoading() && !hasPaintedOnce;
      if (target.textContent !== txt) {
        target.textContent = txt;
        svg = null;
      }
      if (spin) {
        if (!target.querySelector('svg')) target.insertBefore(makeLoader(), target.firstChild);
      } else if (target.querySelector('svg')) { target.querySelector('svg').remove(); }
    }
    const fromApi = NET.online && (NET.source === 'live' || NET.source === 'stale');
    const srcText = !NET.online
      ? '本地离线快照'
      : NET.source === 'live'
        ? '实时接口'
        : NET.source === 'stale'
          ? '接口快照（非交易时段，最新行情时间）'
          : '本地快照（接口暂不可用）';
    g.setAttribute('data-source', fromApi ? NET.source : 'local');
    g.setAttribute('title', '更新时间 ' + fmtUpdated(updatedAt) + ' · 数据来源：' + srcText);
    g.setAttribute('aria-label', '更新时间 ' + fmtUpdated(updatedAt) + ' · 数据来源：' + srcText);
  }
  function makeLoader() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'lucide lucide-loader-circle size-2.5 animate-spin text-brand');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M21 12a9 9 0 1 1-6.219-8.56');
    svg.appendChild(p);
    return svg;
  }
  function hydrateStats() {
    const box = $('#stats-block'); if (!box) return;
    const s = currentSummary().summary;
    const ds = cache[key()];
    let up = s ? s.advanceCount : null, flat = s ? s.flatCount : null, down = s ? s.declineCount : null;
    if (ds && ds.nodes) {
      up = 0; flat = 0; down = 0;
      /* 实测原站两种视图的判平口径不同：
         · A 股全图：严格零（|涨跌| 恰为 0 才算平盘），并剔除无成交的停牌股；
         · 各子市场 / 指数成分：|涨跌| ≤ 0.1% 即算平盘。
         这里按市场分流，才能与线上逐项一致。 */
      /* 实测原站判平口径：仅「A 股全图 + 日周期」用严格零并剔除停牌股，
         其余（子市场、以及周/月/年周期）统一用 0.1% 阈值且不剔除停牌股。 */
      const strictZero = store.market === 'all' && store.period === 'day';
      const eps = 0.1;
      for (const n of ds.nodes) {
        for (const c of n.children) {
          const v = c.changePct;
          if (v == null || !Number.isFinite(v)) continue;
          if (strictZero) {
            if (!c.turnoverAmount) continue; /* 停牌股不计入涨跌统计（与原站一致） */
            if (v > 0) up += 1; else if (v < 0) down += 1; else flat += 1;
          } else if (v > eps) up += 1;
          else if (v < -eps) down += 1;
          else flat += 1;
        }
      }
    }
    const cUp = accentColor('up'), cDown = accentColor('down');
    const delta = s ? (s.turnoverAmount - (s.turnoverPreviousAmount || 0)) : null;
    /* 无历史成交额时（非全图市场）原站只留「--」，不显示「持平」 */
    let deltaLabel = '', deltaColor = 'var(--muted-foreground)', deltaText = '--';
    if (s && s.turnoverPreviousAmount > 0 && delta !== null) {
      if (delta > 0) { deltaLabel = '放量'; deltaColor = cUp; }
      else if (delta < 0) { deltaLabel = '缩量'; deltaColor = cDown; }
      deltaText = D.turnoverStr(Math.abs(delta));
    }
    setHtml(box, '<div class="grid grid-cols-3 gap-2">'
      + '<div class="flex min-w-0 flex-col items-center text-center"><p class="tracking-[0.06em] text-[11px]" style="color:' + cUp + '">上涨</p><p class="mt-1 font-semibold tabular-nums text-base" style="color:' + cUp + '">' + (up == null ? '--' : D.num(up)) + '</p></div>'
      + '<div class="flex min-w-0 flex-col items-center text-center"><p class="tracking-[0.06em] text-muted-foreground text-[11px]">平盘</p><p class="mt-1 font-semibold tabular-nums text-foreground text-base">' + (flat == null ? '--' : D.num(flat)) + '</p></div>'
      + '<div class="flex min-w-0 flex-col items-center text-center"><p class="tracking-[0.06em] text-[11px]" style="color:' + cDown + '">下跌</p><p class="mt-1 font-semibold tabular-nums text-base" style="color:' + cDown + '">' + (down == null ? '--' : D.num(down)) + '</p></div>'
      + '</div>'
      + '<div class="mt-2 grid gap-1.5 border-t border-border/70 pt-2">'
      + '<div class="flex min-w-0 items-center justify-between gap-1"><p class="whitespace-nowrap text-muted-foreground text-[10px]">成交额</p><p class="shrink-0 whitespace-nowrap font-semibold tabular-nums tracking-[-0.01em] text-foreground text-[13px] sm:text-[14px]">' + (s ? D.turnoverStr(s.turnoverAmount) : '--') + '</p></div>'
      + '<div class="flex min-w-0 items-center justify-between gap-1"><p class="text-[10px] whitespace-nowrap leading-tight text-muted-foreground">比昨日' + (deltaLabel ? '<span class="ml-1 font-semibold" style="color:' + deltaColor + '">' + deltaLabel + '</span>' : '') + '</p><p class="shrink-0 whitespace-nowrap font-semibold tabular-nums tracking-[-0.01em] text-[13px] sm:text-[14px]" style="color:' + deltaColor + '">' + deltaText + '</p></div>'
      + '</div>');
  }
  function hydrateFilterHint() {
    const el = $('#filter-hint'); if (!el) return;
    setText(el, filterHint());
  }
  function filterHint() {
    const parts = [];
    if (store.boards.length) parts.push(store.boards.length === 1 ? store.boards[0] : store.boards.length + ' 个板块');
    if (store.trend === 'up') parts.push('仅上涨');
    if (store.trend === 'down') parts.push('仅下跌');
    if (store.rangeMin != null || store.rangeMax != null) {
      parts.push('涨跌幅 ' + (store.rangeMin == null ? '' : store.rangeMin + '%') + '~' + (store.rangeMax == null ? '' : store.rangeMax + '%'));
    }
    if (store.metric === 'turnover') parts.push('面积：成交额');
    if (store.thumbnail) parts.push('缩略图');
    return parts.length ? parts.join(' · ') : '未额外筛选';
  }
  function hydrateLegend() {
    const g = $('#legend-gradient');
    if (g) {
      const grad = D.legendGradient(theme(), invert(), store.mode, D.LEGEND_STOPS);
      if (g.dataset.grad !== grad) { g.dataset.grad = grad; g.style.background = grad; }
    }
    const down = $('#legend-down'), up = $('#legend-up');
    const cd = accentColor('down'), cu = accentColor('up');
    if (down && down.style.color !== cd) down.style.color = cd;
    if (up && up.style.color !== cu) up.style.color = cu;
  }
  function applyTheme() {
    const root = document.documentElement;
    root.classList.toggle('dark', store.mode === 'dark');
    const acc = ACCENTS[store.accent] || ACCENTS.red;
    root.style.setProperty('--brand', store.mode === 'dark' ? acc.dark : acc.light);
    root.style.setProperty('--brand-foreground', '#fff');
    const wrap = canvas.parentElement;
    if (wrap) wrap.style.backgroundColor = palette().chrome;
    const foot = $('#app-footer');
    if (foot) foot.style.backgroundColor = store.mode === 'dark' ? '#151a21' : '#f1f5f9';
    const modeBtn = $('[data-act="mode"]');
    const modeTitle = (store.mode === 'dark' ? '明亮模式' : '暗黑模式') + ' (D)';
    if (modeBtn && modeBtn.getAttribute('title') !== modeTitle) {
      modeBtn.setAttribute('title', modeTitle);
      modeBtn.setAttribute('aria-label', store.mode === 'dark' ? '明亮模式' : '暗黑模式');
      const svg = modeBtn.querySelector('svg');
      if (svg) svg.innerHTML = store.mode === 'dark'
        ? '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>'
        : '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>';
    }
    const thumbBtn = $('[data-act="thumb"]');
    if (thumbBtn) thumbBtn.setAttribute('aria-pressed', String(store.thumbnail));
  }
  function hydrateAll() {
    applyTheme(); hydrateMarkets(); hydrateUpdate(); hydrateStats(); hydrateFilterHint(); hydrateLegend();
  }

  /* 写入去抖：DOM 内容与上次相同时不重写，避免自动刷新时反复重建节点产生重排/重绘 */
  const lastHtml = new WeakMap();
  function setHtml(el, html) {
    if (!el) return;
    if (lastHtml.get(el) === html) return;
    lastHtml.set(el, html);
    el.innerHTML = html;
  }
  function setText(el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  }

  /* ============================ 数据装载流程 ============================ */
  let loading = 0;
  let hasPaintedOnce = false;   // 首屏是否已上屏：之后的数据刷新不再遮挡画布
  let lastSig = '';             // 上一次上屏的数据指纹（跳过无变化的重绘）
  const isLoading = () => loading > 0;
  function dataSig() {
    const ds = cache[key()];
    const ov = overview[store.period];
    return [store.market, store.period,
      ds ? ds.updatedAt : '-', ds ? ds.nodes.length : 0,
      ov ? ov.updatedAt : '-', Object.keys(quotes).length].join('|');
  }
  /* 全屏加载遮罩：仅首屏显示。数据刷新时若也显示，每轮都会整屏模糊一次（看起来就是闪烁） */
  function setLoading(on) {
    loading += on ? 1 : -1;
    if (loading < 0) loading = 0;
    const ov = $('#loading-overlay');
    if (ov) {
      const want = (loading > 0 && !hasPaintedOnce) ? '' : 'none';
      if (ov.style.display !== want) ov.style.display = want;   // 同值不写，避免无谓的样式重算
    }
    hydrateUpdate();
  }
  // 并行拉取实时数据：overview + treemap（+ 盘中报价流），写回缓存
  async function refreshLive() {
    if (location.protocol === 'file:') return false;   // file:// 直开没有同源后端，直接用打包快照
    if (!NET.online && Date.now() - (NET.retryAt || 0) > 30000) {
      NET.online = true; NET.failCount = 0;
    }
    if (!NET.online) return false;
    if (store.market === 'watch') return false;   // 自选用本地 all-day 数据聚合
    const mk = store.market, p = store.period;
    let changed = false;
    const [ov, ds] = await Promise.all([fetchOverview(p), fetchDataset(mk, p)]);
    /* 只有行情时间真的变了才算「有变化」：否则每轮都会多一次无意义的整屏重绘 */
    if (ov && ov.markets && ov.markets.length) {
      const prevOv = overview[p];
      if (!prevOv || prevOv.updatedAt !== ov.updatedAt) { overview[p] = ov; changed = true; }
    }
    if (ds && ds.nodes && ds.nodes.length) {
      const prev = cache[mk + '-' + p];
      if (!prev || prev.updatedAt !== ds.updatedAt || prev.nodes.length !== ds.nodes.length) {
        cache[mk + '-' + p] = ds;
        changed = true;
        NET.changedAt = Date.now();
      }
    }
    if (NET.source === 'stale') {
      quotes = {};                                  // 非交易时段：报价流与快照同源，无需拉
    } else {
      const qs = await fetchQuotes(p);
      if (qs && Object.keys(qs).length) { quotes = qs; changed = true; }
    }
    return changed;
  }

  async function refresh(opts) {
    setLoading(true);
    let painted = false;
    try {
      // 第一步：本地/缓存快照立刻上屏（后端起得慢也不会白屏）
      const local = await loadDataset(store.market, store.period);
      await loadOverview(store.period);
      if (local) {
        const sig = dataSig();
        if (sig !== lastSig) {
          measure(); rebuildModel(); hydrateAll(); invalidate();
          lastSig = sig;
        }
        painted = true; hasPaintedOnce = true;
      }
      // 第二步：并行拉实时数据；只有行情真的变了才重绘（否则页面完全静止）
      const changed = await refreshLive();
      if (changed || !painted) {
        const sig = dataSig();
        if (sig !== lastSig || !painted) {
          measure(); rebuildModel(); hydrateAll(); invalidate();
          lastSig = sig;
        }
      } else {
        hydrateUpdate();          // 仅刷新「数据来源/更新时间」标注，不动画面
      }
    } catch (e) {
      NET.lastError = String(e && e.message || e);
    }
    setLoading(false);
    if (!painted) { measure(); rebuildModel(); hydrateAll(); invalidate(); lastSig = dataSig(); }
  }

  /* ============================ 悬浮卡 ============================ */
  let tip = null;
  function ensureTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'dp-tip';
      tip.style.display = 'none';
      document.body.appendChild(tip);
    }
    return tip;
  }
  function siblingsOf(stock) {
    const ds = cache[key()];
    if (!ds) return [];
    for (const n of ds.nodes) {
      if (n.name !== stock.boardName) continue;
      return n.children.filter(s => (s.subBoardName || s.boardName) === (stock.subBoardName || stock.boardName));
    }
    return [];
  }
  function fullStock(code) {
    const nodes = (model && model.nodes) || [];
    for (const n of nodes) for (const c of n.children) if (c.code === code) return c;
    return null;
  }
  function showTip(stock, ev) {
    const full = fullStock(stock.code) || stock;
    stock = Object.assign({}, full, { x: stock.x, y: stock.y, width: stock.width, height: stock.height });
    const el = ensureTip();
    const q = quotes[stock.code] || {};
    const pct = q.changePct != null ? q.changePct : stock.changePct;
    const price = q.price != null ? q.price : stock.price;
    const cUp = accentColor('up'), cDown = accentColor('down');
    const col = pct > FLAT ? cUp : pct < -FLAT ? cDown : accentColor('flat');
    const sibs = siblingsOf(stock).slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    const shown = sibs.slice(0, 8);
    el.innerHTML =
      '<div class="dp-tip-head"><span class="dp-tip-name">' + esc(stock.name) + '</span><span class="dp-tip-pct" style="color:' + col + '">' + D.pctFull(pct) + '</span></div>'
      + '<div class="dp-tip-meta"><span>' + esc(stock.code) + '</span><span>' + D.priceStr(price) + '</span></div>'
      + '<div class="dp-tip-grid">'
      + '<span>成交额</span><span>' + D.turnoverStr(stock.turnoverAmount || 0) + '</span>'
      + '<span>流通市值</span><span>' + D.turnoverStr(stock.value || 0) + '</span>'
      + '<span>板块</span><span>' + esc(stock.boardName || '') + (stock.subBoardName && stock.subBoardName !== stock.boardName ? ' / ' + esc(stock.subBoardName) : '') + '</span>'
      + '</div>'
      + (shown.length > 1 ? '<div class="dp-tip-list">' + shown.map(s => {
        const p = s.changePct;
        const cc = p > FLAT ? cUp : p < -FLAT ? cDown : 'var(--muted-foreground)';
        return '<div class="dp-tip-li' + (s.code === stock.code ? ' dp-tip-cur' : '') + '"><b>' + esc(s.name) + '</b><i style="color:' + cc + '">' + D.pctFull(p) + '</i></div>';
      }).join('') + '</div>' : '');
    el.style.display = '';
    placeTip(ev);
  }
  function placeTip(ev) {
    if (!tip) return;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = Math.max(8, ev.clientY - h - pad);
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ============================ 画布交互 ============================ */
  let drag = null;
  /**
 * 个股行情外链。
 * 原站跳雪球（https://xueqiu.com/S/<交易所前缀+代码>），但雪球对本机来源做了反爬拦截
 * （实测返回 405「访问被阻断」/567「安全策略拦截」），故改跳东方财富个股行情页：
 *   SH → https://quote.eastmoney.com/sh688256.html
 *   SZ → https://quote.eastmoney.com/sz000001.html
 *   BJ → https://quote.eastmoney.com/bj/920067.html（北交所路径带斜杠）
 */
function stockUrl(code) {
  const parts = String(code || '').split('.');
  const num = parts[0];
  let ex = (parts[1] || '').toUpperCase();
  if (!ex) {                                   // 无后缀时按代码段推断
    if (/^[689]/.test(num)) ex = /^9/.test(num) ? 'BJ' : 'SH';
    else ex = 'SZ';
  }
  if (ex === 'BJ') return 'https://quote.eastmoney.com/bj/' + num + '.html';
  return 'https://quote.eastmoney.com/' + (ex === 'SZ' ? 'sz' : 'sh') + num + '.html';
}

function bindCanvas() {
    canvas.addEventListener('wheel', ev => {
      ev.preventDefault();
      const v = store.view;
      const r = cwrap.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const factor = Math.exp(-ev.deltaY * 0.0015);
      const next = clamp(v.scale * factor, 1, 24);
      const k = next / v.scale;
      v.x = mx - (mx - v.x) * k;
      v.y = my - (my - v.y) * k;
      v.scale = next;
      clampPan();
      invalidate();
      hideTip();
    }, { passive: false });

    canvas.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, vx: store.view.x, vy: store.view.y, moved: false };
    });
    window.addEventListener('mousemove', ev => {
      if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.moved) {
          store.view.x = drag.vx + dx; store.view.y = drag.vy + dy;
          clampPan(); invalidate(); hideTip();
          canvas.style.cursor = 'grabbing';
        }
        return;
      }
      if (ev.target !== canvas) { if (store.hover) { store.hover = null; hideTip(); invalidate(); } return; }
      const p = toLogical(ev.clientX, ev.clientY);
      const s = stockAt(p.x, p.y);
      if (!s) {
        if (store.hover) { store.hover = null; hideTip(); invalidate(); }
        canvas.style.cursor = boardAt(p.x, p.y) ? 'pointer' : (store.view.scale > 1 ? 'grab' : 'default');
        return;
      }
      const changed = !store.hover || store.hover.code !== s.code;
      store.hover = s;
      canvas.style.cursor = 'pointer';
      if (changed) invalidate();
      showTip(s, ev);
    });
    window.addEventListener('mouseup', () => {
      if (drag && !drag.moved && store.view.scale > 1) { /* 点击空白 */ }
      drag = null;
      canvas.style.cursor = store.view.scale > 1 ? 'grab' : 'default';
    });
    canvas.addEventListener('mouseleave', () => { store.hover = null; hideTip(); invalidate(); });
    canvas.addEventListener('click', ev => {
      const p = toLogical(ev.clientX, ev.clientY);
      const b = boardAt(p.x, p.y);
      if (b) { focusBoard(b); return; }
      const s = stockAt(p.x, p.y);
      store.selected = s ? s.code : null;
      invalidate();
    });
    canvas.addEventListener('dblclick', ev => {
      const p = toLogical(ev.clientX, ev.clientY);
      const s = stockAt(p.x, p.y);
      if (s) window.open(stockUrl(s.code), '_blank', 'noopener');
    });
    new ResizeObserver(() => { measure(); rebuildModel(); invalidate(); }).observe(cwrap);
  }
  function clampPan() {
    const v = store.view;
    const maxX = 0, maxY = 0;
    const minX = Math.min(0, W - W * v.scale), minY = Math.min(0, H - H * v.scale);
    v.x = clamp(v.x, minX, maxX);
    v.y = clamp(v.y, minY, maxY);
    if (v.scale <= 1.0001) { v.x = 0; v.y = 0; }
  }
  function focusBoard(b) {
    store.focusBoard = store.focusBoard === b.name ? null : b.name;
    if (store.focusBoard) {
      const s = Math.min(W / b.width, H / (b.height || 1)) * 0.96;
      store.view.scale = clamp(s, 1, 24);
      store.view.x = -b.x * store.view.scale + (W - b.width * store.view.scale) / 2;
      store.view.y = -b.y * store.view.scale + (H - b.height * store.view.scale) / 2;
      clampPan();
    } else resetView();
    invalidate();
  }
  function resetView() {
    store.view = { x: 0, y: 0, scale: 1 };
    store.focusBoard = null;
    invalidate();
  }

  /* ============================ 弹窗框架 ============================ */
  let portal = null, onCloseDialog = null;
  function openLayer(kind) {
    closeLayer();
    portal = document.createElement('div');
    portal.className = 'dp-portal';
    document.body.appendChild(portal);
    const back = document.createElement('div');
    back.className = 'dp-backdrop';
    portal.appendChild(back);
    back.addEventListener('click', closeLayer);
    return portal;
  }
  function closeLayer() {
    if (portal) { portal.remove(); portal = null; }
    if (onCloseDialog) { const f = onCloseDialog; onCloseDialog = null; f(); }
  }
  function seg(options, value, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'dp-seg';
    options.forEach(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      if (o.title) b.title = o.title;
      b.setAttribute('aria-pressed', String(String(o.value) === String(value)));
      b.addEventListener('click', () => {
        $$('button', wrap).forEach(x => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        onPick(o.value);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function sec(title, hint) {
    const s = document.createElement('section');
    s.className = 'dp-sec';
    const h = document.createElement('h3');
    h.textContent = title;
    if (hint) { const sp = document.createElement('span'); sp.className = 'dp-hint'; sp.textContent = ' ' + hint; h.appendChild(sp); }
    s.appendChild(h);
    return s;
  }
  function head(title, sub) {
    const h = document.createElement('div');
    h.className = 'dp-head';
    h.innerHTML = '<div><div class="dp-title">' + esc(title) + '</div>' + (sub ? '<div class="dp-sub">' + esc(sub) + '</div>' : '') + '</div>';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'dp-x'; x.setAttribute('aria-label', '关闭'); x.innerHTML = '&times;';
    x.addEventListener('click', closeLayer);
    h.appendChild(x);
    return h;
  }

  /* ------------------------------ 筛选面板 ------------------------------ */
  function openFilters() {
    const p = openLayer('filter');
    const sheet = document.createElement('div');
    sheet.className = 'dp-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', '筛选');
    const hd = head('筛选');
    const badge = document.createElement('span'); badge.className = 'dp-kbd'; badge.textContent = 'L';
    hd.querySelector('.dp-title').appendChild(badge);
    sheet.appendChild(hd);
    const body = document.createElement('div');
    body.className = 'dp-body';
    sheet.appendChild(body);
    p.appendChild(sheet);

    const ds = cache['all-day'] || cache[key()];
    const boardNames = ds ? ds.nodes.map(n => n.name) : [];
    const boardCounts = new Map(ds ? ds.nodes.map(n => [n.name, n.stockCount]) : []);

    // 一级板块
    const s1 = sec('一级板块');
    const chips = document.createElement('div');
    chips.className = 'dp-chips';
    const allChip = document.createElement('button');
    allChip.type = 'button'; allChip.className = 'dp-chip'; allChip.textContent = '全部板块';
    allChip.setAttribute('aria-pressed', String(store.boards.length === 0));
    allChip.addEventListener('click', () => { store.boards = []; syncAll(); });
    chips.appendChild(allChip);
    boardNames.forEach(name => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dp-chip';
      b.innerHTML = esc(name) + ' <span class="dp-chip-n" style="color:var(--muted-foreground)">' + (boardCounts.get(name) || '') + '</span>';
      b.setAttribute('aria-pressed', String(store.boards.indexOf(name) >= 0));
      b.addEventListener('click', () => {
        const i = store.boards.indexOf(name);
        if (i >= 0) store.boards.splice(i, 1); else store.boards.push(name);
        syncAll();
      });
      chips.appendChild(b);
    });
    function syncAll() {
      allChip.setAttribute('aria-pressed', String(store.boards.length === 0));
      $$('.dp-chip', chips).forEach((el, i) => {
        if (i === 0) return;
        el.setAttribute('aria-pressed', String(store.boards.indexOf(boardNames[i - 1]) >= 0));
      });
      applyFilters();
    }
    s1.appendChild(chips);
    body.appendChild(s1);

    // 涨跌区间（周期）
    const s2 = sec('涨跌区间');
    const ptxt = document.createElement('p');
    ptxt.className = 'dp-note';
    const cur = PERIODS.find(x => x.id === store.period);
    ptxt.textContent = cur ? cur.title : '';
    s2.appendChild(ptxt);
    s2.appendChild(seg(PERIODS.map(x => ({ label: x.label, value: x.id, title: x.title })), store.period, v => {
      store.period = v; persist(); refresh();
      const c2 = PERIODS.find(x => x.id === v);
      ptxt.textContent = c2 ? c2.title : '';
    }));
    body.appendChild(s2);

    // 涨跌筛选
    const s3 = sec('涨跌筛选');
    s3.appendChild(seg([{ label: '全部', value: 'all' }, { label: '上涨', value: 'up' }, { label: '下跌', value: 'down' }], store.trend, v => {
      store.trend = v; applyFilters();
    }));
    body.appendChild(s3);

    // 涨跌幅范围
    const s4 = sec('涨跌幅范围');
    const rangeRow = document.createElement('div');
    rangeRow.className = 'dp-range';
    const minI = document.createElement('input'); minI.className = 'dp-input'; minI.inputMode = 'decimal';
    minI.value = store.rangeMin == null ? '' : String(store.rangeMin);
    const maxI = document.createElement('input'); maxI.className = 'dp-input'; maxI.inputMode = 'decimal';
    maxI.value = store.rangeMax == null ? '' : String(store.rangeMax);
    rangeRow.appendChild(minI);
    const u1 = document.createElement('span'); u1.textContent = '%'; rangeRow.appendChild(u1);
    const tilde = document.createElement('span'); tilde.textContent = '~'; rangeRow.appendChild(tilde);
    rangeRow.appendChild(maxI);
    const u2 = document.createElement('span'); u2.textContent = '%'; rangeRow.appendChild(u2);
    s4.appendChild(rangeRow);
    const ticks = document.createElement('div');
    ticks.className = 'dp-note dp-ticks';
    ticks.textContent = '-20%   -10%   0%   +10%   +20%';
    s4.appendChild(ticks);
    const presets = document.createElement('div');
    presets.className = 'dp-seg';
    presets.style.marginTop = '6px';
    [['±3%', -3, 3], ['±5%', -5, 5], ['0~5%', 0, 5], ['5~10%', 5, 10], ['-5~0%', -5, 0], ['-10~-5%', -10, -5]].forEach(([label, lo, hi]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.setAttribute('aria-pressed', String(store.rangeMin === lo && store.rangeMax === hi));
      b.addEventListener('click', () => {
        if (store.rangeMin === lo && store.rangeMax === hi) { store.rangeMin = null; store.rangeMax = null; }
        else { store.rangeMin = lo; store.rangeMax = hi; }
        minI.value = store.rangeMin == null ? '' : String(store.rangeMin);
        maxI.value = store.rangeMax == null ? '' : String(store.rangeMax);
        $$('button', presets).forEach(x => x.setAttribute('aria-pressed', 'false'));
        if (store.rangeMin != null) b.setAttribute('aria-pressed', 'true');
        applyFilters();
      });
      presets.appendChild(b);
    });
    s4.appendChild(presets);
    const commit = () => {
      const parse = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
      store.rangeMin = parse(minI.value); store.rangeMax = parse(maxI.value);
      $$('button', presets).forEach(x => x.setAttribute('aria-pressed', 'false'));
      applyFilters();
    };
    minI.addEventListener('change', commit); maxI.addEventListener('change', commit);
    body.appendChild(s4);

    // 面积指标
    const s5 = sec('面积指标');
    s5.appendChild(seg([{ label: '流通市值', value: 'value' }, { label: '成交额', value: 'turnover' }], store.metric, v => {
      store.metric = v; applyFilters();
    }));
    body.appendChild(s5);

    // 缩略图
    const s6 = sec('缩略图');
    s6.appendChild(seg([{ label: '关', value: 'off' }, { label: '开', value: 'on' }], store.thumbnail ? 'on' : 'off', v => {
      setThumbnail(v === 'on');
    }));
    body.appendChild(s6);
  }
  function applyFilters() {
    measure();
    rebuildModel();
    hydrateFilterHint();
    hydrateMarkets();
    invalidate();
  }

  /* ------------------------------ 设置抽屉 ------------------------------ */
  function openSettings(tab) {
    const p = openLayer('settings');
    const sheet = document.createElement('div');
    sheet.className = 'dp-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', '设置');
    sheet.appendChild(head('设置', '调整热力图的显示、语言和看盘偏好。'));
    const body = document.createElement('div');
    body.className = 'dp-body';
    sheet.appendChild(body);
    p.appendChild(sheet);

    const tabRow = document.createElement('div');
    tabRow.className = 'dp-tabs';
    body.appendChild(tabRow);
    const holder = document.createElement('div');
    body.appendChild(holder);

    const TABS = [{ label: '外观', v: 'look' }, { label: '自选', v: 'watch' }, { label: '快捷键', v: 'keys' }, { label: '帮助', v: 'help' }];
    let current = tab || 'look';
    TABS.forEach(t => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dp-tab'; b.textContent = t.label;
      b.dataset.tab = t.v;
      b.addEventListener('click', () => { current = t.v; render(); });
      tabRow.appendChild(b);
    });

    function render() {
      $$('.dp-tab', tabRow).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === current)));
      holder.innerHTML = '';
      if (current === 'look') renderLook();
      else if (current === 'watch') renderWatch();
      else if (current === 'keys') renderKeys();
      else renderHelp();
    }

    function renderLook() {
      const s0 = sec('显示模式');
      s0.appendChild(seg([{ label: '明亮模式', value: 'light' }, { label: '暗黑模式', value: 'dark' }], store.mode, v => {
        store.mode = v; persist(); applyTheme(); hydrateLegend(); hydrateMarkets(); hydrateStats(); invalidate();
      }));
      holder.appendChild(s0);

      const s1 = sec('板块标题栏统计');
      s1.appendChild(seg([{ label: '关', value: 'off' }, { label: '开', value: 'on' }], store.showStats ? 'on' : 'off', v => {
        store.showStats = v === 'on'; persist(); invalidate();
      }));
      holder.appendChild(s1);

      const sB = sec('热力图边框');
      sB.appendChild(seg([{ label: '隐藏', value: 'off' }, { label: '显示', value: 'on' }], store.showBorder ? 'on' : 'off', v => {
        store.showBorder = v === 'on'; persist(); rebuildModel(); invalidate();
      }));
      const bh = document.createElement('p');
      bh.className = 'dp-note';
      bh.textContent = '隐藏实线边框，仅保留一级板块间隙；当前股票会以柔和提亮进行标识。';
      sB.appendChild(bh);
      holder.appendChild(sB);

      const s3 = sec('自动刷新');
      const row = document.createElement('div');
      row.className = 'dp-range';
      const num = document.createElement('input');
      num.className = 'dp-input'; num.type = 'number'; num.min = '3'; num.max = '600';
      num.value = String(store.autoRefresh);
      num.setAttribute('aria-label', '自动刷新');
      num.addEventListener('change', () => {
        const v = clamp(parseInt(num.value, 10) || 10, 3, 600);
        num.value = String(v); store.autoRefresh = v; persist(); startAutoRefresh();
      });
      row.appendChild(num);
      const unit = document.createElement('span'); unit.textContent = '秒'; row.appendChild(unit);
      s3.appendChild(row);
      const ah = document.createElement('p');
      ah.className = 'dp-note';
      ah.textContent = '页面可见时自动刷新行情，范围 3–600 秒；修改后立即生效并马上刷新一次。';
      s3.appendChild(ah);
      holder.appendChild(s3);

      const s4 = sec('筛选面板打开方式');
      s4.appendChild(seg([{ label: '点击（推荐）', value: 'click' }, { label: '悬停', value: 'hover' }], store.filterOpen, v => {
        store.filterOpen = v; persist();
      }));
      holder.appendChild(s4);

      const s5 = sec('强调色');
      const accentOpts = [['green', '绿色'], ['red', '红色'], ['blue', '蓝色'], ['purple', '紫色']].map(([id, label]) => ({ label: label, value: id }));
      s5.appendChild(seg(accentOpts, store.accent, v => {
        store.accent = v; persist(); applyTheme(); hydrateMarkets(); hydrateStats(); hydrateLegend(); invalidate();
      }));
      holder.appendChild(s5);

      const s6 = sec('涨跌极性');
      s6.appendChild(seg([{ label: '红涨绿跌 +2.4% / -1.8%', value: 'red-rise' }, { label: '绿涨红跌 +2.4% / -1.8%', value: 'green-rise' }], store.polarity, v => {
        store.polarity = v; persist(); hydrateMarkets(); hydrateStats(); hydrateLegend(); invalidate();
      }));
      holder.appendChild(s6);

      const s7 = sec('热力图配色');
      const grid = document.createElement('div');
      grid.className = 'dp-chips';
      D.THEMES.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'dp-chip';
        b.textContent = t.nameZh || t.id;
        b.setAttribute('aria-pressed', String(store.themeId === t.id));
        b.addEventListener('click', () => {
          store.themeId = t.id; persist(); hydrateLegend(); hydrateMarkets(); hydrateStats(); invalidate();
          $$('.dp-chip', grid).forEach(x => x.setAttribute('aria-pressed', String(x.textContent === (t.nameZh || t.id))));
        });
        grid.appendChild(b);
      });
      s7.appendChild(grid);
      const acts = document.createElement('div');
      acts.className = 'dp-seg';
      acts.style.marginTop = '6px';
      [['基于当前自定义', () => { toast('已基于当前配色创建自定义主题'); }], ['导出主题', () => { exportTheme(); }], ['导入主题', () => { importTheme(); }]].forEach(([label, fn]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'dp-btn'; b.textContent = label;
        b.addEventListener('click', fn);
        acts.appendChild(b);
      });
      s7.appendChild(acts);
      holder.appendChild(s7);
    }

    function renderWatch() {
      const s = sec('自选', '通过股票名称或代码添加，生成你的专属热力图。');
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'dp-btn dp-primary'; add.textContent = '添加股票';
      add.addEventListener('click', () => openWatchlist());
      const fromShot = document.createElement('button');
      fromShot.type = 'button'; fromShot.className = 'dp-btn'; fromShot.textContent = '从截图添加';
      fromShot.style.marginLeft = '6px';
      fromShot.addEventListener('click', () => { closeLayer(); openShare(); });
      const cnt = document.createElement('p');
      cnt.className = 'dp-note';
      cnt.textContent = '已添加 ' + store.watchlist.length;
      s.appendChild(add); s.appendChild(fromShot); s.appendChild(cnt);
      const list = document.createElement('div');
      list.className = 'dp-list';
      if (!store.watchlist.length) {
        const e = document.createElement('div');
        e.className = 'dp-note';
        e.textContent = '还没有自选股票';
        list.appendChild(e);
      } else {
        const byCode = new Map(allStocks().map(x => [String(x.code).toUpperCase(), x]));
        store.watchlist.forEach(code => {
          const st = byCode.get(String(code).toUpperCase()) || { code: code, name: code };
          const r = document.createElement('div');
          r.className = 'dp-li';
          r.innerHTML = '<span class="dp-li-name">' + esc(st.name) + '</span><span class="dp-li-sub">' + esc(st.code) + '</span>';
          list.appendChild(r);
        });
      }
      s.appendChild(list);
      const cnt2 = document.createElement('p');
      cnt2.className = 'dp-note';
      cnt2.textContent = store.watchlist.length + '/80';
      s.appendChild(cnt2);
      holder.appendChild(s);
      const acts = document.createElement('div');
      acts.className = 'dp-seg';
      [['导入', () => importWatchlist()], ['导出', () => exportWatchlist()]].forEach(([label, fn]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'dp-btn'; b.textContent = label;
        b.addEventListener('click', fn);
        acts.appendChild(b);
      });
      holder.appendChild(acts);
    }

    function renderKeys() {
      const s = sec('快捷键');
      const list = document.createElement('div');
      list.className = 'dp-list';
      [['B', '收起/展开菜单'], ['L', '打开筛选'], ['F', '全屏'], ['C', '截图分享'], ['R', '重置视图'], ['D', '明亮/暗黑模式'], [',', '打开设置'], ['W', '打开自选'], ['↑ / ↓ 或 J / K', '滚动弹窗列表'], ['S / Shift+S', '弹窗列表切换排序']].forEach(([k, v]) => {
        const r = document.createElement('div');
        r.className = 'dp-li';
        r.innerHTML = '<span class="dp-li-name">' + v + '</span><span class="dp-li-sub">' + k + '</span>';
        list.appendChild(r);
      });
      s.appendChild(list);
      holder.appendChild(s);
    }

    function renderHelp() {
      const s = sec('帮助');
      const list = document.createElement('div');
      list.className = 'dp-list';
      ['面积代表流通市值', '颜色代表涨跌幅度', '开启缩略图可查看已筛选的一、二级板块统计，面积对应市值或成交额', '单击一级板块标题可聚焦；侧栏可同时选择多个板块；双击个股前往东方财富', '滚轮缩放查看细节', '缩放后按住鼠标可拖动画布', '悬浮个股后，可用 ↑/↓ 或 J/K 滚动弹窗列表'].forEach(t => {
        const r = document.createElement('div');
        r.className = 'dp-li';
        r.innerHTML = '<span class="dp-li-name">' + esc(t) + '</span>';
        list.appendChild(r);
      });
      s.appendChild(list);
      holder.appendChild(s);
    }

    render();
  }

  /* ------------------------------ 通用小工具 ------------------------------ */
  function toast(text) {
    let t = document.getElementById('dp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dp-toast';
      t.className = 'dp-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.setAttribute('data-show', '1');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.removeAttribute('data-show'), 1800);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportWatchlist() {
    download('dapan-watchlist.json', JSON.stringify(store.watchlist, null, 2));
  }
  function importWatchlist() {
    pickFile(text => {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) {
          store.watchlist = arr.map(x => String(typeof x === 'string' ? x : x.code || '')).filter(Boolean).slice(0, 80);
          persist(); toast('已导入 ' + store.watchlist.length + ' 只股票'); hydrateMarkets(); refresh();
        }
      } catch (e) { toast('导入失败：文件格式不正确'); }
    });
  }
  function exportTheme() {
    const t = D.getTheme(store.themeId);
    download('dapan-theme.json', JSON.stringify({ version: 1, type: 'a-share-heatmap-theme', theme: { id: t.id, nameZh: t.nameZh, nameEn: t.nameZh, dark: t.dark, light: t.light } }, null, 2));
  }
  function importTheme() {
    pickFile(text => {
      try {
        const o = JSON.parse(text);
        const th = o.theme || o;
        if (th && th.dark && th.light) {
          const id = 'custom-' + Date.now().toString(36);
          D.THEMES.push({ id: id, nameZh: th.nameZh || '自定义', dark: th.dark, light: th.light });
          store.themeId = id; persist(); hydrateLegend(); hydrateMarkets(); hydrateStats(); invalidate(); toast('已导入主题');
        } else { toast('导入失败：缺少配色数据'); }
      } catch (e) { toast('导入失败：文件格式不正确'); }
    });
  }
  function pickFile(cb) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => cb(String(fr.result));
      fr.readAsText(f);
    });
    input.click();
  }

  /* ------------------------------ 截图分享 ------------------------------ */
  function openShare() {
    const p = openLayer('share');
    const dlg = document.createElement('div');
    dlg.className = 'dp-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', '截图预览');
    dlg.appendChild(head('截图预览', '当前视图将导出为 PNG'));
    const body = document.createElement('div');
    body.className = 'dp-body';
    const img = document.createElement('img');
    img.className = 'dp-share-img';
    body.appendChild(img);
    const actions = document.createElement('div');
    actions.className = 'dp-seg';
    const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'dp-btn dp-primary'; dl.textContent = '下载图片';
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'dp-btn'; cp.textContent = '复制图片';
    actions.appendChild(dl); actions.appendChild(cp);
    body.appendChild(actions);
    dlg.appendChild(body);
    p.appendChild(dlg);
    const src = composeShare();
    img.src = src;
    dl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = src; a.download = 'dapan-heatmap-' + Date.now() + '.png';
      a.click();
    });
    cp.addEventListener('click', async () => {
      try {
        const blob = await (await fetch(src)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        cp.textContent = '已复制';
      } catch (e) { cp.textContent = '复制失败'; }
    });
  }
  function composeShare() {
    const src = canvas;
    const out = document.createElement('canvas');
    const pad = 16, headH = 46;
    out.width = src.width; out.height = src.height + Math.round((headH + pad) * dpr);
    const c = out.getContext('2d');
    const pal = palette();
    c.fillStyle = pal.chrome;
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(src, 0, 0);
    c.fillStyle = store.mode === 'dark' ? 'rgba(247, 250, 252, 0.92)' : 'rgba(15, 23, 42, 0.86)';
    c.font = '700 ' + Math.round(13 * dpr) + 'px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
    c.fillText('大盘云图', pad * dpr, Math.round((headH - 22) * dpr));
    c.font = '600 ' + Math.round(11 * dpr) + 'px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
    c.fillStyle = store.mode === 'dark' ? 'rgba(247, 250, 252, 0.6)' : 'rgba(15, 23, 42, 0.55)';
    const m = MARKETS.find(x => x.id === store.market);
    const u = currentSummary();
    c.fillText((m ? m.label : '') + ' · 更新 ' + (u.updatedAt ? fmtUpdated(u.updatedAt) : '--'), pad * dpr, Math.round((headH - 6) * dpr));
    return out.toDataURL('image/png');
  }

  /* ------------------------------ 自选管理 ------------------------------ */
  function openWatchlist() {
    const p = openLayer('watch');
    const dlg = document.createElement('div');
    dlg.className = 'dp-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', '自选');
    dlg.appendChild(head('自选', '通过股票名称或代码添加，生成你的专属热力图。'));
    const body = document.createElement('div');
    body.className = 'dp-body';
    const addRow = document.createElement('div');
    addRow.className = 'dp-range';
    const input = document.createElement('input');
    input.className = 'dp-input'; input.placeholder = '股票名称或代码';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'dp-btn dp-primary'; add.textContent = '添加股票';
    const fromShot = document.createElement('button');
    fromShot.type = 'button'; fromShot.className = 'dp-btn'; fromShot.textContent = '从截图添加';
    fromShot.addEventListener('click', () => { closeLayer(); openShare(); });
    addRow.appendChild(input); addRow.appendChild(add); addRow.appendChild(fromShot);
    body.appendChild(addRow);
    const countLine = document.createElement('p');
    countLine.className = 'dp-note';
    body.appendChild(countLine);
    const listBox = document.createElement('div');
    listBox.className = 'dp-list';
    body.appendChild(listBox);
    const foot = document.createElement('div');
    foot.className = 'dp-seg';
    const exp = document.createElement('button'); exp.type = 'button'; exp.className = 'dp-btn'; exp.textContent = '导出';
    const imp = document.createElement('button'); imp.type = 'button'; imp.className = 'dp-btn'; imp.textContent = '导入';
    foot.appendChild(exp); foot.appendChild(imp);
    body.appendChild(foot);
    dlg.appendChild(body);
    p.appendChild(dlg);

    function render() {
      const all = allStocks();
      const byCode = new Map(all.map(s => [String(s.code).toUpperCase(), s]));
      const rows = store.watchlist.map(c => byCode.get(String(c).toUpperCase()) || { code: c, name: c, changePct: null });
      countLine.textContent = '已添加 ' + rows.length + '  ·  ' + rows.length + '/80';
      listBox.innerHTML = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'dp-li';
        empty.innerHTML = '<span class="dp-li-name" style="color:var(--muted-foreground)">还没有自选股票</span>';
        listBox.appendChild(empty);
      }
      rows.forEach(s => {
        const r = document.createElement('div');
        r.className = 'dp-li';
        const col = s.changePct == null ? 'var(--muted-foreground)' : (s.changePct > FLAT ? accentColor('up') : s.changePct < -FLAT ? accentColor('down') : accentColor('flat'));
        r.innerHTML = '<span class="dp-li-name">' + esc(s.name) + '</span><span class="dp-li-sub">' + esc(s.code) + '</span>'
          + '<span class="dp-li-pct" style="color:' + col + '">' + (s.changePct == null ? '--' : D.pctFull(s.changePct)) + '</span>';
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = '移除';
        del.addEventListener('click', () => {
          store.watchlist = store.watchlist.filter(c => String(c).toUpperCase() !== String(s.code).toUpperCase());
          persist(); render(); hydrateMarkets();
          if (store.market === 'watch') refresh();
        });
        r.appendChild(del);
        listBox.appendChild(r);
      });
    }
    function addByName(q) {
      const all = allStocks();
      const key = String(q).trim().toLowerCase();
      if (!key) return;
      const hit = all.find(s => String(s.code).toLowerCase() === key)
        || all.find(s => String(s.name).toLowerCase() === key)
        || all.find(s => String(s.code).toLowerCase().indexOf(key) === 0)
        || all.find(s => String(s.name).toLowerCase().indexOf(key) >= 0);
      if (!hit) return;
      if (store.watchlist.length >= 80) return;
      if (store.watchlist.some(c => String(c).toUpperCase() === String(hit.code).toUpperCase())) return;
      store.watchlist.push(hit.code);
      persist(); render(); input.value = ''; hydrateMarkets();
    }
    add.addEventListener('click', () => addByName(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addByName(input.value); });
    exp.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store.watchlist, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'dapan-watchlist.json'; a.click();
    });
    imp.addEventListener('click', () => {
      const f = document.createElement('input');
      f.type = 'file'; f.accept = '.json,application/json';
      f.addEventListener('change', async () => {
        const file = f.files && f.files[0];
        if (!file) return;
        try {
          const arr = JSON.parse(await file.text());
          if (Array.isArray(arr)) { store.watchlist = arr.slice(0, 80).map(String); persist(); render(); hydrateMarkets(); }
        } catch (e) {}
      });
      f.click();
    });
    render();
  }

  /* ============================ 缩略图 / 全屏 / 侧栏 ============================ */
  function setThumbnail(on) {
    store.thumbnail = !!on;
    store.collapse = !!on;
    persist();
    measure(); rebuildModel(); hydrateFilterHint(); applyTheme(); invalidate();
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    else document.exitFullscreen && document.exitFullscreen();
  }
  let sidebarHidden = false;
  function toggleSidebar() {
    const aside = $('#sidebar'); if (!aside) return;
    sidebarHidden = !sidebarHidden;
    if (window.innerWidth < 768) {
      aside.classList.toggle('-translate-x-full', sidebarHidden);
    } else {
      aside.style.width = sidebarHidden ? '0px' : '';
      aside.style.opacity = sidebarHidden ? '0' : '';
      aside.style.borderRightColor = sidebarHidden ? 'transparent' : '';
    }
    measure(); rebuildModel(); invalidate();
  }

  /* ============================ 事件绑定 ============================ */
  function bindActions() {
    document.addEventListener('click', ev => {
      const mb = ev.target.closest('[data-market]');
      if (mb) {
        const mk = mb.getAttribute('data-market');
        /* 自选为空时只弹出自选面板，不改变当前市场（否则状态切到空的「自选」，画面会莫名变空） */
        if (mk === 'watch' && !store.watchlist.length) { openWatchlist(); return; }
        store.market = mk;
        resetView(); persist(); refresh(); return;
      }
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'share') openShare();
      else if (act === 'reset') { resetView(); }
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'watchlist') openWatchlist();
      else if (act === 'settings') openSettings();
      else if (act === 'filters') openFilters();
      else if (act === 'mode') {
        store.mode = store.mode === 'dark' ? 'light' : 'dark';
        persist(); applyTheme(); hydrateLegend(); hydrateStats(); hydrateMarkets(); invalidate();
      } else if (act === 'thumb') setThumbnail(!store.thumbnail);
      else if (act === 'collapse' || act === 'expand') toggleSidebar();
    });
    const ft = $('#filter-trigger');
    if (ft) {
      ft.addEventListener('click', () => { if (store.filterOpen === 'click') openFilters(); });
      ft.addEventListener('mouseenter', () => { if (store.filterOpen === 'hover') openFilters(); });
    }
    let tipIndex = 0;
    window.addEventListener('keydown', ev => {
      const tag = (ev.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key;
      if (k === 'Escape') {
        if (portal) { closeLayer(); return; }
        resetView(); store.selected = null; hideTip(); store.hover = null; invalidate(); return;
      }
      if (k === 'b' || k === 'B') { toggleSidebar(); return; }
      if (k === 'l' || k === 'L') { openFilters(); return; }
      if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
      if (k === 'c' || k === 'C') { openShare(); return; }
      if (k === 'r' || k === 'R') { resetView(); return; }
      if (k === 'd' || k === 'D') {
        store.mode = store.mode === 'dark' ? 'light' : 'dark';
        persist(); applyTheme(); hydrateLegend(); hydrateStats(); hydrateMarkets(); invalidate(); return;
      }
      if (k === ',') { openSettings(); return; }
      if (tip && tip.style.display !== 'none') {
        const list = tip.querySelector('.dp-tip-list');
        if (list) {
          if (k === 'ArrowDown' || k === 'j' || k === 'J') { list.scrollTop += 18; ev.preventDefault(); }
          if (k === 'ArrowUp' || k === 'k' || k === 'K') { list.scrollTop -= 18; ev.preventDefault(); }
        }
      }
    });
  }

  /* ============================ 自动刷新 ============================ */
  let timer = 0;
  function startAutoRefresh() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refresh({ force: true });
    }, Math.max(3, store.autoRefresh) * 1000);
  }

  /* ============================ 启动 ============================ */
  function findFooter() {
    const btn = document.querySelector('[aria-label="展开菜单"]');
    const f = btn && btn.closest('div[class*="bg-[#151a21]"]');
    if (f) f.id = 'app-footer';
    return f;
  }
  async function boot() {
    restore();
    findFooter();
    W = 0; H = 0;
    measure();
    await refresh();
    bindCanvas();
    bindActions();
    startAutoRefresh();
    document.documentElement.setAttribute('data-dpyuntu-clone', '1');
    window.__DPYT_APP__ = { net: NET, store, model: () => model, paint, rebuildModel, invalidate, refresh, cache, hydrateAll };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
