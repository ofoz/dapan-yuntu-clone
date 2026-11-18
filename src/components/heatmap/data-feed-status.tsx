"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import type { MarketDataSource } from "@/lib/market-heatmap";
import type { Locale } from "@/lib/i18n";

type FeedStatus = {
  provider: "tencent" | "eastmoney" | null;
  quoteCount: number;
  stockCount: number;
  cacheSeconds: number;
};

export function DataFeedStatus({ source, updatedAt, locale }: {
  source: MarketDataSource | null;
  updatedAt: string;
  locale: Locale;
}) {
  const [feed, setFeed] = useState<FeedStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void fetch("/api/heatmap/status", { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          if (response.ok) setFeed(await response.json());
        }).catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  const zh = locale === "zh";
  const name = feed?.provider === "eastmoney" ? (zh ? "东方财富" : "Eastmoney")
    : feed?.provider === "tencent" ? (zh ? "腾讯行情" : "Tencent") : (zh ? "行情数据" : "Market data");
  const isLive = source === "direct";
  const label = source === "fallback" ? (zh ? "内置快照" : "Bundled snapshot")
    : source === "stale" ? (zh ? "缓存行情" : "Cached quotes")
    : isLive ? name : (zh ? "连接行情中" : "Connecting");
  const time = updatedAt ? new Date(updatedAt).toLocaleString(zh ? "zh-CN" : "en-GB", {
    timeZone: "Asia/Shanghai", hour12: false,
  }) : "—";
  const detail = zh
    ? `${name} · 报价时间 ${time}（北京时间） · ${feed?.quoteCount ?? 0}/${feed?.stockCount ?? 0} 只已更新 · 缓存 ${feed?.cacheSeconds ?? 15} 秒`
    : `${name} · Quote time ${time} (Asia/Shanghai) · ${feed?.quoteCount ?? 0}/${feed?.stockCount ?? 0} quotes · ${feed?.cacheSeconds ?? 15}s cache`;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[10px] text-muted-foreground" title={detail} aria-label={detail} data-testid="data-feed-status">
      <Database className="hidden size-3 shrink-0 sm:block" aria-hidden />
      <span className={`size-1.5 shrink-0 rounded-full ${isLive ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
