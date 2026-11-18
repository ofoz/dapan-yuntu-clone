import { getMarketDataStatus } from "@/lib/market-heatmap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(getMarketDataStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
