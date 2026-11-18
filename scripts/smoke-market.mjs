import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const checks = [];
async function request(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
async function json(path) { return (await request(path)).json(); }

await json("/api/heatmap/quotes?market=all&period=day");
const tree = await json("/api/heatmap/treemap?market=all&period=day");
assert.equal(tree.source, "direct", "Full-market data must come from the live provider");
assert(tree.stockCount > 5_000);
assert.equal(tree.nodes.reduce((sum, node) => sum + node.children.length, 0), tree.stockCount);
assert.equal(tree.summary.advanceCount + tree.summary.flatCount + tree.summary.declineCount, tree.stockCount);
assert(tree.summary.turnoverAmount > 0);
checks.push({ name: "全市场真实行情与统计", passed: true, count: tree.stockCount, boards: tree.boardCount });

for (const [market, count] of [["hs300", 300], ["zza500", 500]]) {
  const data = await json(`/api/heatmap/treemap?market=${market}&period=day`);
  assert.equal(data.stockCount, count);
  assert.equal(data.source, "direct");
  checks.push({ name: `${market} 成分股数量`, passed: true, count: data.stockCount });
}

for (const period of ["day", "week", "month", "year"]) {
  const data = await json(`/api/heatmap/quotes?codes=600519.SH,000001.SZ&period=${period}`);
  assert.equal(data.source, "direct");
  assert.equal(Object.keys(data.quotes).length, 2);
  assert(Number.isFinite(data.quotes["600519.SH"].changePct));
  checks.push({ name: `${period} 独立涨跌周期`, passed: true, maotaiChange: data.quotes["600519.SH"].changePct });
}

const search = await json(`/api/heatmap/search?q=${encodeURIComponent("茅台")}`);
assert(search.items.some((stock) => stock.code === "600519.SH"));
checks.push({ name: "名称检索", passed: true });

const invalid = await fetch(`${base}/api/heatmap/treemap?market=invalid`, { signal: AbortSignal.timeout(10_000) });
assert.equal(invalid.status, 400);
checks.push({ name: "非法参数返回400", passed: true });

const stream = await request("/api/heatmap/quotes/stream?market=hs300&period=day");
const events = (await stream.text()).trim().split("\n").map((line) => JSON.parse(line));
assert.equal(events[0].type, "start");
assert.equal(events.at(-1).type, "complete");
assert.equal(events.at(-1).totalCount, 300);
assert.equal(events.at(-1).source, "direct");
checks.push({ name: "流式报价完成", passed: true, quoteCount: events.at(-1).loadedCount });

const status = await json("/api/heatmap/status");
assert(status.provider === "tencent" || status.provider === "eastmoney");
assert(status.quoteCount / status.stockCount >= 0.9);
assert.equal(status.lastError, null);
console.log(JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), status, checks }, null, 2));
