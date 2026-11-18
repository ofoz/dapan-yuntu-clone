export const marketDataProviders = ["auto", "tencent", "eastmoney"] as const;
export type MarketDataProvider = (typeof marketDataProviders)[number];
export type QuoteProvider = Exclude<MarketDataProvider, "auto">;

export function getMarketDataProvider(value = process.env.MARKET_DATA_PROVIDER): MarketDataProvider {
  const provider = value?.trim() || "auto";
  if (!marketDataProviders.includes(provider as MarketDataProvider)) {
    throw new Error("MARKET_DATA_PROVIDER must be auto, tencent or eastmoney");
  }
  return provider as MarketDataProvider;
}

export function getQuoteCacheMs(value = process.env.MARKET_CACHE_SECONDS) {
  const seconds = value?.trim() ? Number(value) : 15;
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 600) {
    throw new Error("MARKET_CACHE_SECONDS must be between 3 and 600");
  }
  return Math.round(seconds * 1_000);
}
