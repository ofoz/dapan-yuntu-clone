/* ============================================================================
 * core.js — 大盘云图复刻：配色 / 布局算法 / Canvas 渲染 / 格式化
 * 算法与常量均按原站 page bundle 反解，保持像素级一致：
 *   - 颜色：|涨跌幅|/10 归一后 0.82 次幂插值，soft→strong
 *   - 布局：按市值切分的二叉递归（非 squarify），gap 内缩
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ----------------------------- 基础工具 ----------------------------- */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const rnd = v => Math.min(255, Math.max(0, Math.round(v)));
  const mk = (r, g, b) => ({ r, g, b });
  const lerp = (a, b, t) => {
    const k = clamp(t, 0, 1);
    return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
  };
  const dimmed = (c, t) => { const k = 1 - clamp(t, 0, 1); return { r: c.r * k, g: c.g * k, b: c.b * k }; };
  const rgbStr = c => `rgb(${rnd(c.r)}, ${rnd(c.g)}, ${rnd(c.b)})`;
  const hexStr = c => '#' + [c.r, c.g, c.b].map(v => rnd(v).toString(16).padStart(2, '0')).join('');

  /* ----------------------------- 配色主题 ----------------------------- */
  // 原站内置 4 套 + 种子 3 套；默认 classic
  const THEMES = [
    { id: 'classic', nameZh: '经典',
      dark:  { flat: mk(72, 79, 92), positiveSoft: mk(140, 72, 76), positiveStrong: mk(255, 30, 34), negativeSoft: mk(40, 126, 76), negativeStrong: mk(26, 214, 66) },
      light: { flat: mk(120, 132, 148), positiveSoft: mk(190, 78, 82), positiveStrong: mk(245, 42, 48), negativeSoft: mk(42, 148, 98), negativeStrong: mk(30, 220, 80) } },
    { id: 'soft', nameZh: '柔和',
      dark:  { flat: mk(78, 86, 98), positiveSoft: mk(148, 78, 82), positiveStrong: mk(234, 44, 48), negativeSoft: mk(48, 128, 92), negativeStrong: mk(36, 190, 154) },
      light: { flat: mk(148, 156, 168), positiveSoft: mk(188, 118, 116), positiveStrong: mk(216, 84, 88), negativeSoft: mk(78, 142, 128), negativeStrong: mk(60, 180, 112) } },
    { id: 'muted', nameZh: '低饱和',
      dark:  { flat: mk(84, 90, 100), positiveSoft: mk(138, 96, 98), positiveStrong: mk(188, 92, 96), negativeSoft: mk(72, 118, 108), negativeStrong: mk(68, 148, 128) },
      light: { flat: mk(156, 160, 168), positiveSoft: mk(186, 142, 140), positiveStrong: mk(196, 118, 114), negativeSoft: mk(124, 152, 146), negativeStrong: mk(96, 154, 136) } },
    { id: 'high-contrast', nameZh: '高对比',
      dark:  { flat: mk(64, 70, 82), positiveSoft: mk(160, 48, 52), positiveStrong: mk(255, 56, 48), negativeSoft: mk(24, 140, 96), negativeStrong: mk(16, 220, 140) },
      light: { flat: mk(140, 148, 160), positiveSoft: mk(210, 88, 84), positiveStrong: mk(228, 48, 42), negativeSoft: mk(48, 156, 118), negativeStrong: mk(20, 168, 108) } },
    { id: 'seed-sunset', nameZh: '日落',
      dark:  { flat: mk(78, 74, 88), positiveSoft: mk(168, 86, 72), positiveStrong: mk(242, 112, 54), negativeSoft: mk(72, 78, 148), negativeStrong: mk(92, 108, 220) },
      light: { flat: mk(156, 148, 160), positiveSoft: mk(210, 118, 88), positiveStrong: mk(228, 96, 52), negativeSoft: mk(108, 118, 178), negativeStrong: mk(86, 98, 198) } },
    { id: 'seed-aurora', nameZh: '极光',
      dark:  { flat: mk(70, 82, 96), positiveSoft: mk(156, 72, 132), positiveStrong: mk(232, 64, 168), negativeSoft: mk(32, 132, 138), negativeStrong: mk(28, 206, 186) },
      light: { flat: mk(148, 156, 168), positiveSoft: mk(188, 102, 156), positiveStrong: mk(208, 72, 148), negativeSoft: mk(48, 148, 152), negativeStrong: mk(24, 168, 158) } },
    { id: 'seed-ink', nameZh: '水墨',
      dark:  { flat: mk(90, 90, 92), positiveSoft: mk(132, 78, 72), positiveStrong: mk(176, 68, 58), negativeSoft: mk(68, 102, 98), negativeStrong: mk(58, 138, 118) },
      light: { flat: mk(168, 166, 162), positiveSoft: mk(176, 120, 110), positiveStrong: mk(168, 92, 82), negativeSoft: mk(112, 140, 132), negativeStrong: mk(78, 132, 116) } },
  ];
  const getTheme = id => THEMES.find(t => t.id === id) || THEMES[0];

  // 画布 chrome 配色（原站 canvas 主题表）
  const CANVAS = {
    dark: {
      backgroundStart: '#171b22', backgroundEnd: '#10141b', boardFill: '#20252d',
      subBoardFill: 'rgba(18, 23, 31, 0.62)', subBoardBorder: 'rgba(148, 163, 184, 0.3)',
      activeSubBoardStroke: '#5eead4', activeSubBoardInner: 'rgba(8, 47, 73, 0.92)',
      boardBorder: 'rgba(148, 163, 184, 0.48)', activeBoardStroke: '#f6d36d',
      highlightOuter: 'rgba(2, 6, 23, 0.92)', highlightInner: '#f8fafc', chrome: '#10141b',
    },
    light: {
      backgroundStart: '#f6f8fb', backgroundEnd: '#e8eef6', boardFill: '#d8e0eb',
      subBoardFill: 'rgba(255, 255, 255, 0.82)', subBoardBorder: 'rgba(100, 116, 139, 0.26)',
      activeSubBoardStroke: '#0f766e', activeSubBoardInner: 'rgba(15, 118, 110, 0.28)',
      boardBorder: 'rgba(71, 85, 105, 0.34)', activeBoardStroke: '#b45309',
      highlightOuter: 'rgba(15, 23, 42, 0.42)', highlightInner: '#ffffff', chrome: '#e8eef6',
    },
  };

  const FLAT_THRESHOLD = 0.1;   // |pct| < 0.1 视为平盘
  const LEGEND_STOPS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

  /* ------------------------- 颜色函数（原站 ah.*） ------------------------- */
  // 个股填充色
  function stockFill(theme, pct, invert, mode) {
    const pal = mode === 'light' ? theme.light : theme.dark;
    if (!Number.isFinite(pct)) return rgbStr(pal.flat);
    const t = Math.pow(Math.min(1, Math.max(0, Math.abs(pct) / 10)), 0.82);
    if (Math.abs(pct) < FLAT_THRESHOLD) return rgbStr(pal.flat);
    const up = invert ? pct > 0 : !(pct > 0);
    const soft = up ? pal.positiveSoft : pal.negativeSoft;
    const strong = up ? pal.positiveStrong : pal.negativeStrong;
    return rgbStr(lerp(soft, strong, t));
  }
  // 板块/二级板块标题条填充色（压暗）
  function titleFill(theme, pct, invert, mode) {
    const pal = mode === 'light' ? theme.light : theme.dark;
    const t = Math.pow(Math.min(1, Math.max(0, Math.abs(pct) / 10)), 0.82);
    if (Math.abs(pct) < FLAT_THRESHOLD) return rgbStr(dimmed(pal.flat, mode === 'light' ? 0.18 : 0.12));
    const up = invert ? pct > 0 : !(pct > 0);
    const soft = up ? pal.positiveSoft : pal.negativeSoft;
    const strong = up ? pal.positiveStrong : pal.negativeStrong;
    return rgbStr(dimmed(lerp(soft, strong, t), mode === 'light' ? 0.12 : 0.08));
  }
  // 图例渐变色串
  function legendGradient(theme, invert, mode, stops) {
    return 'linear-gradient(to right, ' + stops.map((v, i) => {
      const p = (i / (stops.length - 1)) * 100;
      return `${stockFill(theme, v, invert, mode)} ${p.toFixed(2)}%`;
    }).join(', ') + ')';
  }

  /* ----------------------------- 格式化 ----------------------------- */
  const num = (v, zh = true) => new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US').format(v);
  function pctFull(v) {
    if (v === null || !Number.isFinite(v)) return '—';
    return v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  }
  function pctShort(v) {
    if (v === null || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    let s = v.toFixed(abs >= 10 ? 1 : 2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    return v > 0 ? `+${s}%` : `${s}%`;
  }
  const priceStr = v => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(v >= 100 ? 1 : 2);
  function turnoverStr(v) {
    if (!Number.isFinite(v) || v <= 0) return '--';
    const trim = s => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    const unit = (d, label) => { const r = v / d; const o = r >= 100 ? 0 : r >= 10 ? 1 : 2; return `${trim(r.toFixed(o))} ${label}`; };
    if (v >= 1e12) return unit(1e12, '万亿');
    if (v >= 1e8) return unit(1e8, '亿');
    if (v >= 1e4) return unit(1e4, '万');
    return trim(v.toFixed(0));
  }
  function updatedShort(iso) {
    if (!iso) return '--.-- --:--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--.-- --:--';
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    return p.slice(5, 16).replace('-', '.');
  }
  const trendCounts = (adv, dec) => `涨${adv} 跌${dec}`;

  /* ----------------------------- 布局算法 ----------------------------- */
  const sumValue = list => list.reduce((a, x) => a + x.value, 0);

  // 内缩 gap（每边 gap/2）
  function inset(rect, gap) {
    const h = gap / 2;
    return { ...rect, x: rect.x + h, y: rect.y + h, width: Math.max(0, rect.width - gap), height: Math.max(0, rect.height - gap) };
  }
  // 按累计市值最接近一半的位置分组
  function pivotIndex(list) {
    if (list.length <= 1) return list.length;
    const half = sumValue(list) / 2;
    let acc = 0, best = 1, bestDiff = Infinity;
    for (let i = 1; i < list.length; i += 1) {
      acc += list[i - 1].value;
      const diff = Math.abs(half - acc);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }
  function splitRect(rect, ratio) {
    if (rect.width >= rect.height) {
      const w = rect.width * ratio;
      return { first: { x: rect.x, y: rect.y, width: w, height: rect.height },
               second: { x: rect.x + w, y: rect.y, width: Math.max(0, rect.width - w), height: rect.height } };
    }
    const h = rect.height * ratio;
    return { first: { x: rect.x, y: rect.y, width: rect.width, height: h },
             second: { x: rect.x, y: rect.y + h, width: rect.width, height: Math.max(0, rect.height - h) } };
  }
  // items: [{item, value}] → 递归二叉切分
  function splitLayout(items, x, y, width, height, gap) {
    const walk = (list, rect) => {
      if (!list.length || rect.width <= 1 || rect.height <= 1) return [];
      if (list.length === 1) return [inset({ item: list[0].item, x: rect.x, y: rect.y, width: rect.width, height: rect.height }, gap)];
      const idx = pivotIndex(list);
      const first = list.slice(0, idx), second = list.slice(idx);
      if (!first.length || !second.length) {
        const h = rect.height / list.length;
        return list.map((it, i) => inset({ item: it.item, x: rect.x, y: rect.y + h * i, width: rect.width, height: h }, gap));
      }
      const total = sumValue(list);
      const { first: r1, second: r2 } = splitRect(rect, sumValue(first) / total);
      return [...walk(first, r1), ...walk(second, r2)];
    };
    return walk([...items].filter(i => i.value > 0).sort((a, b) => b.value - a.value), { x, y, width, height })
      .filter(r => r.width > 1 && r.height > 1);
  }

  /* ----------------------------- 聚合计算 ----------------------------- */
  function weightedChange(list) {
    let sum = 0, weight = 0;
    for (const it of list) { const v = it.changePct; if (v !== null && Number.isFinite(v)) { sum += v * it.value; weight += it.value; } }
    return weight <= 0 ? null : sum / weight;
  }
  function trendCountsOf(list, quotes) {
    let up = 0, flat = 0, down = 0;
    for (const it of list) {
      const v = (quotes && quotes[it.code] && quotes[it.code].changePct != null) ? quotes[it.code].changePct : it.changePct;
      if (v === null || v === undefined) continue;
      if (v > FLAT_THRESHOLD) up += 1; else if (v < -FLAT_THRESHOLD) down += 1; else flat += 1;
    }
    return { advanceCount: up, flatCount: flat, declineCount: down };
  }

  /* ----------------------- 板块 / 二级板块 / 个股 矩形 ----------------------- */
  function buildRects(nodes, W, H, opts) {
    const { borders = false, collapse = false, market = 'all', quotes = {} } = opts || {};
    const boardRects = [], subBoardRects = [], stockRects = [];
    const outerGap = borders ? 6 : 3;

    for (const r of splitLayout(nodes.map(n => ({ item: n, value: n.value })), 0, 0, W, H, outerGap)) {
      const changePct = weightedChange(r.item.children);
      const counts = trendCountsOf(r.item.children, quotes);
      const titleHeight = (r.width < 84 || r.height < 54) ? 0 : clamp(Math.round(Math.min(Math.max(0.1 * r.height, 16), 26)), 14, 26);
      const pad = borders ? (r.width > 110 && r.height > 90 ? 3 : 2) : 0;
      const cx = r.x + pad, cy = r.y + titleHeight + pad;
      const cw = Math.max(0, r.width - 2 * pad), ch = Math.max(0, r.height - titleHeight - 2 * pad);
      boardRects.push({ name: r.item.name, x: r.x, y: r.y, width: r.width, height: r.height, stockCount: r.item.stockCount, titleHeight, changePct, ...counts });
      if (cw <= 2 || ch <= 2) continue;

      // 二级板块分组
      const groupsMap = new Map();
      for (const s of r.item.children) {
        const key = s.subBoardName || s.boardName;
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(s);
      }
      const groups = Array.from(groupsMap.entries()).map(([name, list]) => ({
        name, boardName: list[0] ? list[0].boardName : '', stockCount: list.length,
        value: list.reduce((a, x) => a + x.value, 0), changePct: weightedChange(list),
        children: [...list].sort((a, b) => b.value - a.value),
      })).sort((a, b) => b.value - a.value);

      const flatMode = !(market !== 'zza50' && (collapse || groups.length > 1));
      if (flatMode) {
        if (collapse) {
          subBoardRects.push({ name: r.item.name, boardName: r.item.name, x: cx, y: cy, width: cw, height: ch, stockCount: r.item.stockCount, titleHeight: 0, changePct, ...counts });
          continue;
        }
        for (const s of splitLayout(r.item.children.map(c => ({ item: c, value: c.value })), cx, cy, cw, ch, borders ? 1.5 : 0)) {
          stockRects.push({ code: s.item.code, name: s.item.name, boardName: r.item.name,
            subBoardName: market === 'zza50' ? r.item.name : s.item.subBoardName,
            value: s.item.value, x: s.x, y: s.y, width: s.width, height: s.height, price: s.item.price, changePct: s.item.changePct });
        }
        continue;
      }

      const groupGap = borders ? (r.width > 96 && r.height > 72 ? (collapse ? 3 : 2) : (collapse ? 2 : 1)) : 0;
      for (const g of splitLayout(groups.map(x => ({ item: x, value: x.value })), cx, cy, cw, ch, groupGap)) {
        const gCounts = trendCountsOf(g.item.children, quotes);
        const gTitle = (collapse || g.width < 52 || g.height < 40) ? 0 : clamp(Math.round(Math.min(Math.max(0.14 * g.height, 14), 22)), 12, 22);
        const pad2 = (!borders || collapse) ? 0 : (g.width > 82 && g.height > 56 ? 2 : 1);
        const sx = g.x + pad2, sy = g.y + gTitle + pad2;
        const sw = Math.max(0, g.width - 2 * pad2), sh = Math.max(0, g.height - gTitle - 2 * pad2);
        subBoardRects.push({ name: g.item.name, boardName: r.item.name, x: g.x, y: g.y, width: g.width, height: g.height, stockCount: g.item.stockCount, titleHeight: gTitle, changePct: g.item.changePct, ...gCounts });
        if (collapse || sw <= 2 || sh <= 2) continue;
        const stockGap = borders ? (g.width > 56 && g.height > 38 ? 1 : 0.5) : 0;
        for (const s of splitLayout(g.item.children.map(c => ({ item: c, value: c.value })), sx, sy, sw, sh, stockGap)) {
          stockRects.push({ code: s.item.code, name: s.item.name, boardName: r.item.name, subBoardName: s.item.subBoardName,
            value: s.item.value, x: s.x, y: s.y, width: s.width, height: s.height, price: s.item.price, changePct: s.item.changePct });
        }
      }
    }
    return { boardRects, subBoardRects, stockRects };
  }

  /* ----------------------------- 文本绘制 ----------------------------- */
  const fontOf = (weight, size) => `${weight} ${size}px "Avenir Next Condensed", "DIN Condensed", "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;

  // 二分截断（无省略号，与原站一致）
  function truncate(ctx, text, maxWidth) {
    if (maxWidth <= 0 || !text.length) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 1, hi = text.length, fit = '';
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const cut = text.slice(0, mid);
      if (ctx.measureText(cut).width <= maxWidth) { fit = cut; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (fit) return fit;
    const first = text.slice(0, 1);
    return ctx.measureText(first).width <= maxWidth ? first : '';
  }
  // 缩字号以适应宽度
  function fitFontSize(ctx, text, weight, size, minSize, maxWidth) {
    if (maxWidth <= 0 || !text.length) return size;
    ctx.font = fontOf(weight, size);
    const w = ctx.measureText(text).width;
    if (w <= maxWidth) return size;
    return clamp(size * maxWidth / w, minSize, size);
  }
  /**
   * 完整显示文字：宽度不够时先按比例缩小字号（绝不截断丢字），
   * 只有缩到 minSize（默认 0 = 无下限）仍放不下才退化为截断。
   * 用户要求「个股名称在任何缩放下都必须完整显示」，故默认无限缩小。
   */
  function fitText(ctx, text, weight, size, maxWidth, minSize = 0) {
    if (!text || maxWidth <= 0) return { text: '', size };
    ctx.font = fontOf(weight, size);
    const w = ctx.measureText(text).width;
    if (w <= maxWidth || w <= 0) return { text, size };
    const scaled = size * maxWidth / w;
    if (scaled >= minSize && scaled > 0) return { text, size: scaled };
    return { text: truncate(ctx, text, maxWidth), size: Math.max(scaled, minSize) };
  }
  function clipFill(ctx, text, x, y, cx, cy, cw, ch) {
    ctx.save(); ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip(); ctx.fillText(text, x, y); ctx.restore();
  }
  // 大字块：多行居中
  function drawCenteredLines(ctx, lines, cx, cy, gap, clip) {
    const metas = lines.map(l => {
      ctx.font = l.font;
      const m = ctx.measureText(l.text);
      const ascent = Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : 0.8 * l.fallbackFontSize;
      const descent = Number.isFinite(m.actualBoundingBoxDescent) && m.actualBoundingBoxDescent >= 0 ? m.actualBoundingBoxDescent : 0.2 * l.fallbackFontSize;
      return { ...l, ascent, descent };
    });
    let y = cy - (metas.reduce((a, m) => a + m.ascent + m.descent, 0) + gap * Math.max(0, metas.length - 1)) / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const m of metas) {
      ctx.font = m.font;
      clipFill(ctx, m.text, cx, y + m.ascent, clip.x, clip.y, clip.width, clip.height);
      y += m.ascent + m.descent + gap;
    }
  }

  // 个股标签（原站内联函数）
  function drawStockLabel(ctx, rect, scale, selected, quote) {
    const price = quote && quote.price != null ? quote.price : rect.price;
    const pct = quote && quote.changePct != null ? quote.changePct : rect.changePct;
    const w = rect.width * scale, h = rect.height * scale, p = 1 / scale;
    const padX = (w > 110 ? 5 : w > 54 ? 3 : 2) * p;
    const insetX = (w > 110 ? 6 : w > 54 ? 4 : 3) * p;
    const topY = (h > 56 ? 4.5 : h > 26 ? 3 : 2) * p;
    const limW = Math.max(0, rect.width - 2 * padX), limH = Math.max(0, rect.height - 2 * padX);
    if (w < 16 || h < 8 || limW <= 2 || limH <= 2) return;
    const big = w >= 108 && h >= 58, medium = w >= 28 && h >= 20, small = w >= 24 && h >= 10;
    const weightName = selected ? 800 : 700, weightNum = selected ? 750 : 650;

    ctx.save();
    try {
      ctx.fillStyle = 'rgba(247, 250, 252, 0.96)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
      ctx.shadowBlur = (h < 14 ? 0.45 : 1.2) * p;
      ctx.shadowOffsetY = 0.6 * p;
      if (big) {
        const nameSize = clamp(Math.floor(0.26 * Math.min(w, h)), 15, 30) * p;
        const numSize = Math.min(clamp(Math.floor(0.19 * Math.min(w, h)), 11, 23) * p, 1.08 * nameSize);
        const nameFit = fitText(ctx, rect.name, weightName, nameSize, limW);
        ctx.font = fontOf(weightName, nameFit.size);
        const lines = [
          { text: nameFit.text, font: fontOf(weightName, nameFit.size), fallbackFontSize: nameFit.size },
          { text: pctFull(pct), font: fontOf(weightNum, numSize), fallbackFontSize: numSize },
        ];
        if (w > 180 && h > 100) {
          const ps = Math.max(11 * p, numSize - p);
          lines.push({ text: priceStr(price), font: fontOf(550, ps), fallbackFontSize: ps });
        }
        drawCenteredLines(ctx, lines, rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(3 * p, 0.12 * Math.min(nameSize, numSize)), { x: rect.x + padX, y: rect.y + padX, width: limW, height: limH });
        return;
      }
      if (medium) {
        const size = clamp(Math.floor(Math.min(0.19 * w, 0.43 * h)), 7.5, 16) * p;
        const nameFit = fitText(ctx, rect.name, weightName, size, limW - (insetX - padX));
        const nameSize = nameFit.size;
        const numSize = Math.min(clamp(Math.floor(0.33 * h), 7, 13) * p, 1.08 * nameSize);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = fontOf(weightName, nameSize);
        clipFill(ctx, nameFit.text, rect.x + insetX, rect.y + topY + nameSize, rect.x + padX, rect.y + padX, limW, limH);
        if (h >= 20) {
          ctx.font = fontOf(weightNum, numSize);
          const t = w >= 58 ? pctFull(pct) : pctShort(pct);
          clipFill(ctx, t, rect.x + insetX, rect.y + topY + nameSize + numSize + 1.5 * p, rect.x + padX, rect.y + padX, limW, limH);
        }
        return;
      }
      if (small) {
        const size = clamp(Math.floor(Math.min(0.18 * w, 0.68 * h)), 6.5, 11) * p;
        const txt = pctShort(pct), gap = 3 * p;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.font = fontOf(weightNum, size);
        const tw = ctx.measureText(txt).width;
        const nameW = ctx.measureText(rect.name).width;
        // 名称必须完整：只有名称与涨跌幅同行都能放下时才显示涨跌幅
        const showPct = w >= 32 && tw + gap < 0.72 * limW && nameW + tw + gap <= limW;
        const nameMax = showPct ? Math.max(0, limW - tw - gap) : limW;
        const nameFit = fitText(ctx, rect.name, weightNum, size, nameMax);
        const yMid = rect.y + rect.height / 2 + 0.06 * size;
        if (nameFit.text) { ctx.font = fontOf(weightNum, nameFit.size); clipFill(ctx, nameFit.text, rect.x + insetX, yMid, rect.x + padX, rect.y + padX, limW, limH); }
        if (showPct) { ctx.textAlign = 'right'; clipFill(ctx, txt, rect.x + rect.width - insetX, yMid, rect.x + padX, rect.y + padX, limW, limH); }
        return;
      }
      if (w >= 18 && h >= 8) {
        const size = clamp(Math.floor(0.72 * h), 6, 9) * p;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.font = fontOf(weightNum, size);
        const nameFit = fitText(ctx, rect.name, weightNum, size, limW);
        if (nameFit.text) { ctx.font = fontOf(weightNum, nameFit.size); clipFill(ctx, nameFit.text, rect.x + insetX, rect.y + rect.height / 2 + 0.06 * size, rect.x + padX, rect.y + padX, limW, limH); }
      }
    } finally { ctx.restore(); }
  }

  // 板块标题条文字（原站 aq）
  function drawBoardTitle(ctx, rect, info) {
    const compact = !!info.compact;
    if (rect.width <= 44 || rect.titleHeight <= 8) return;
    const nameSize = compact ? clamp(Math.floor(0.56 * rect.titleHeight), 9, 12) : clamp(Math.floor(0.52 * rect.titleHeight), 10, 15);
    const numSize = compact ? clamp(Math.floor(0.48 * rect.titleHeight), 8, 11) : clamp(Math.floor(0.46 * rect.titleHeight), 9, 13);
    const padX = compact ? 5 : 8;
    const rightPad = info.showDrillHint ? 18 : compact ? 5 : 8;
    const avail = Math.max(0, rect.width - padX - rightPad);
    const baseY = rect.y + rect.titleHeight / 2 + nameSize * (compact ? 0.06 : 0.08);
    const tx = rect.x + (compact ? 3 : 4);
    const ty = rect.y + (compact ? 1 : 2);
    const tw = Math.max(0, rect.width - (compact ? 6 : 8));
    const th = Math.max(0, rect.titleHeight - (compact ? 2 : 4));
    const statsText = trendCounts(info.advanceCount ?? 0, info.declineCount ?? 0);
    const pctText = compact && rect.width < 132 ? pctShort(info.changePct) : pctFull(info.changePct);

    ctx.textBaseline = 'middle';
    ctx.font = fontOf(650, numSize);
    const statsW = ctx.measureText(statsText).width;
    const pctW = ctx.measureText(pctText).width;
    const gap = compact ? 5 : 7;
    const showStats = !!info.showStats && avail > (compact ? 108 : 148) && statsW + pctW + gap < 0.64 * avail;
    const statsRoom = !!info.showStats && avail > (compact ? 72 : 96);
    const reserve = statsRoom ? pctW + (showStats ? statsW + gap : 0) : 0;
    const nameMax = Math.max(0, avail - (reserve > 0 ? reserve + (compact ? 6 : 8) : 0));

    ctx.fillStyle = 'rgba(247, 250, 252, 0.96)';
    ctx.textAlign = 'left';
    const nameFit = fitText(ctx, info.name, 700, nameSize, nameMax);
    ctx.font = fontOf(700, nameFit.size);
    if (nameFit.text) clipFill(ctx, nameFit.text, tx, baseY, tx, ty, tw, th);
    if (!statsRoom) return;

    ctx.font = fontOf(650, numSize);
    ctx.textAlign = 'right';
    const rightX = rect.x + rect.width - rightPad;
    clipFill(ctx, pctText, rightX, baseY, tx, ty, tw, th);
    if (showStats) {
      ctx.fillStyle = 'rgba(247, 250, 252, 0.86)';
      clipFill(ctx, statsText, rightX - pctW - gap, baseY, tx, ty, tw, th);
    }
  }

  // 折叠模式（缩略图）下二级板块块：名称/涨跌幅/统计
  function drawSubBoardBlock(ctx, rect, info, scale) {
    const w = rect.width * scale, h = rect.height * scale, p = 1 / scale;
    const padX = (w > 110 ? 6 : w > 54 ? 4 : 3) * p;
    const padY = (w > 110 ? 8 : w > 54 ? 5 : 4) * p;
    const limW = Math.max(0, rect.width - 2 * padX), limH = Math.max(0, rect.height - 2 * padX);
    if (w < 18 || h < 12 || limW <= 2 || limH <= 2) return;
    const stats = trendCounts(info.advanceCount, info.declineCount);
    const pctText = w >= 72 ? pctFull(info.changePct) : pctShort(info.changePct);
    const huge = w >= 96 && h >= 64, mid = w >= 44 && h >= 36;
    ctx.save();
    try {
      ctx.fillStyle = 'rgba(247, 250, 252, 0.96)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
      ctx.shadowBlur = (h < 20 ? 0.5 : 1.3) * p;
      ctx.shadowOffsetY = 0.6 * p;
      if (huge) {
        const nameSize = clamp(Math.floor(0.2 * Math.min(w, h)), 13, 26) * p;
        const pctSize = Math.min(clamp(Math.floor(0.16 * Math.min(w, h)), 11, 22) * p, 1.05 * nameSize);
        const statsSize = Math.max(10 * p, 0.78 * pctSize);
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const nameFit = fitText(ctx, info.name, 700, nameSize, limW);
        ctx.font = fontOf(700, nameFit.size);
        clipFill(ctx, nameFit.text, cx, cy - 0.95 * pctSize, rect.x + padX, rect.y + padY, limW, limH);
        ctx.font = fontOf(700, pctSize);
        clipFill(ctx, pctText, cx, cy + 0.18 * pctSize, rect.x + padX, rect.y + padY, limW, limH);
        if (h >= 78) {
          ctx.fillStyle = 'rgba(247, 250, 252, 0.88)';
          ctx.font = fontOf(600, statsSize);
          clipFill(ctx, stats, cx, cy + 1.18 * pctSize, rect.x + padX, rect.y + padY, limW, limH);
        }
        return;
      }
      if (mid) {
        const nameSize = clamp(Math.floor(Math.min(0.2 * w, 0.28 * h)), 8, 16) * p;
        const pctSize = Math.min(clamp(Math.floor(0.22 * h), 8, 14) * p, 1.08 * nameSize);
        const statsSize = Math.max(7 * p, 0.86 * pctSize);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const nameFit = fitText(ctx, info.name, 700, nameSize, limW - (padY - padX));
        ctx.font = fontOf(700, nameFit.size);
        clipFill(ctx, nameFit.text, rect.x + padX, rect.y + padY + nameSize, rect.x + padX, rect.y + padY, limW, limH);
        ctx.font = fontOf(700, pctSize);
        clipFill(ctx, pctText, rect.x + padX, rect.y + padY + nameSize + pctSize + 1.5 * p, rect.x + padX, rect.y + padY, limW, limH);
        if (h >= 52 && w >= 64) {
          ctx.fillStyle = 'rgba(247, 250, 252, 0.88)';
          ctx.font = fontOf(600, statsSize);
          clipFill(ctx, stats, rect.x + padX, rect.y + padY + nameSize + pctSize + statsSize + 4.5 * p, rect.x + padX, rect.y + padY, limW, limH);
        }
        return;
      }
      const size = clamp(Math.floor(Math.min(0.2 * w, 0.58 * h)), 7, 12) * p;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = fontOf(700, size);
      const useName = w >= 40 && h >= 16;
      const tFit = fitText(ctx, useName ? info.name : pctText, 700, size, limW - (padY - padX));
      ctx.font = fontOf(700, tFit.size);
      if (tFit.text) clipFill(ctx, tFit.text, rect.x + padX, rect.y + rect.height / 2 + 0.06 * size, rect.x + padX, rect.y + padY, limW, limH);
    } finally { ctx.restore(); }
  }

  global.DPYT = {
    clamp, THEMES, getTheme, CANVAS, LEGEND_STOPS, FLAT_THRESHOLD,
    stockFill, titleFill, legendGradient, rgbStr, hexStr, lerp, mk,
    num, pctFull, pctShort, priceStr, turnoverStr, updatedShort, trendCounts,
    splitLayout, buildRects, weightedChange, trendCountsOf,
    fontOf, truncate, fitFontSize, fitText, clipFill, drawStockLabel, drawBoardTitle, drawSubBoardBlock,
  };
})(window);
