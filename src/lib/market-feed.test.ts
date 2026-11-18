import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketDataProvider, getQuoteCacheMs } from "./market-data-config";

vi.mock("@/lib/data/market-heatmap-fallback.json", () => ({ default: {
  updatedAt: "2026-11-02T06:00:00Z", stockCount: 3, boardCount: 3,
  stocks: [
    { code: "600519.SH", exchange: "SH", name: "Maotai", boardName: "Food" },
    { code: "000001.SZ", exchange: "SZ", name: "Pingan", boardName: "Banks" },
    { code: "603999.SH", exchange: "SH", name: "Nonmember", boardName: "Media" },
  ].map((stock) => ({ ...stock, price: 10, changePct: 0, totalMarketCap: 2e9, floatMarketCap: 1e9 })),
} }));
vi.mock("@/lib/data/market-heatmap-subboards.json", () => ({ default: { subboards: {} } }));
vi.mock("@/lib/data/stock-listing-status.json", () => ({ default: { stocks: [] } }));
vi.mock("@/lib/market-constituents", () => ({
  getZza50ConstituentSnapshot: vi.fn(async () => ({ codes: ["600519.SH", "000001.SZ"] })),
  getZza50ConstituentStatus: vi.fn(),
}));

function quote(symbol: string, change = 1.3) {
  const fields = Array.from({ length: 88 }, () => "");
  Object.assign(fields, {
    0: "1", 1: symbol, 2: symbol.slice(2), 3: "1453.90", 4: "1435.26",
    30: "20261116150000", 32: String(change), 37: "12345", 44: "18174.94",
    45: "20000", 57: "576730.5714", 62: "7.76", 63: "0.62", 70: "9.73",
  });
  return `v_${symbol}="${fields.join("~")}";`;
}

function tencentFetch() {
  return vi.fn(async (rawUrl: string | URL | Request) => {
    const url = String(rawUrl);
    if (!url.startsWith("https://qt.gtimg.cn/q=")) throw new Error("Unexpected provider");
    return new Response(url.split("q=")[1].split(",").map((symbol) => quote(symbol,
      symbol === "sh000001" ? -0.87 : 1.3)).join("\n"));
  });
}

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, "__dapanMarketRuntime");
  vi.stubEnv("MARKET_DATA_PROVIDER", "tencent");
  vi.stubEnv("MARKET_CACHE_SECONDS", "15");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("行情配置", () => {
  it("拒绝无效来源和过短缓存，避免静默配置错误", () => {
    expect(getMarketDataProvider("auto")).toBe("auto");
    expect(getMarketDataProvider("eastmoney")).toBe("eastmoney");
    expect(() => getMarketDataProvider("sina")).toThrow("MARKET_DATA_PROVIDER");
    expect(getQuoteCacheMs("15")).toBe(15_000);
    expect(() => getQuoteCacheMs("0")).toThrow("MARKET_CACHE_SECONDS");
    expect(() => getQuoteCacheMs("NaN")).toThrow("MARKET_CACHE_SECONDS");
  });
});

describe("腾讯行情接入", () => {
  it("用真实报价及流通市值更新色块，并合并并发请求", async () => {
    const fetchMock = tencentFetch();
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./market-heatmap");
    await api.getQuoteData("all");
    const results = await Promise.all([api.getQuoteData("all"), api.getQuoteData("all")]);
    expect(results.every((result) => result.source === "direct")).toBe(true);
    expect(results[0].quotes["600519.SH"]).toEqual({
      price: 1453.9, changePct: 1.3, turnoverAmount: 5_767_305_714,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tree = await api.getTreemapData("all");
    const stock = tree.nodes.flatMap((node) => node.children).find((item) => item.code === "600519.SH");
    expect(stock?.value).toBeCloseTo(18_174.94 * 100_000_000);
    expect(api.getMarketDataStatus()).toMatchObject({
      provider: "tencent", source: "direct", quoteCount: 3, stockCount: 3, lastError: null,
    });
  });

  it("保留上证与沪深300指数，指数不混入个股列表", async () => {
    const fetchMock = tencentFetch();
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./market-heatmap");
    await api.getQuoteData("all");
    await api.getQuoteData("all");
    const overview = await api.getOverviewData();
    expect(overview.markets.find((market) => market.market === "sse")?.changePct).toBe(-0.87);
    const stocks = await api.getQuoteData("all");
    expect(Object.keys(stocks.quotes).sort()).toEqual(["000001.SZ", "600519.SH", "603999.SH"]);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("qt.gtimg.cn"))).toBe(true);
  });

  it("近5日、20日、年初至今分别使用独立字段", async () => {
    vi.stubGlobal("fetch", tencentFetch());
    const api = await import("./market-heatmap");
    expect((await api.getQuoteData("all", "week")).quotes["600519.SH"].changePct).toBe(0.62);
    expect((await api.getQuoteData("all", "month")).quotes["600519.SH"].changePct).toBe(9.73);
    expect((await api.getQuoteData("all", "year")).quotes["600519.SH"].changePct).toBe(7.76);
  });

  it("指数视图按真实成分筛选，其他股票不会因市值排序入池", async () => {
    vi.stubGlobal("fetch", tencentFetch());
    const api = await import("./market-heatmap");
    const hs300 = await api.getQuoteData("hs300", "month");
    const a500 = await api.getQuoteData("zza500", "month");
    expect(Object.keys(hs300.quotes).sort()).toEqual(["000001.SZ", "600519.SH"]);
    expect(Object.keys(a500.quotes).sort()).toEqual(["000001.SZ", "600519.SH"]);
  });

  it("断网保留缓存并标为 stale，退避期间不重复请求", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchMock = tencentFetch();
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./market-heatmap");
    await api.getQuoteData("all");
    await api.getQuoteData("all");
    vi.setSystemTime(Date.now() + 16_000);
    fetchMock.mockRejectedValue(new Error("Network offline"));
    const cached = await api.getQuoteData("all");
    expect(cached.source).toBe("stale");
    expect(cached.quotes["600519.SH"].price).toBe(1453.9);
    expect(api.getMarketDataStatus()).toMatchObject({ provider: "tencent", source: "stale" });
    const attempts = fetchMock.mock.calls.length;
    await api.getQuoteData("all");
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  });

  it("固定腾讯源时不访问其他供应商，失败保留内置快照", async () => {
    const fetchMock = vi.fn(async (url: string) => { throw new Error(`Offline ${url}`); });
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./market-heatmap");
    await api.getQuoteData("all");
    expect((await api.getQuoteData("all")).source).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("qt.gtimg.cn");
  });
});
