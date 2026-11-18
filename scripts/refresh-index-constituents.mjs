import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../src/lib/data/market-index-constituents.json", import.meta.url));
const definitions = {
  hs300: { type: "1", count: 300, name: "沪深300" },
  zza500: { type: "6", count: 500, name: "中证A500" },
};
const snapshot = JSON.parse(await readFile(target, "utf8"));

for (const [market, definition] of Object.entries(definitions)) {
  const params = new URLSearchParams({
    reportName: "RPT_INDEX_TS_COMPONENT", columns: "SECUCODE,SECURITY_NAME_ABBR,TYPE",
    pageNumber: "1", pageSize: "500", filter: `(TYPE="${definition.type}")`,
    sortColumns: "SECURITY_CODE", sortTypes: "1", source: "WEB", client: "WEB",
  });
  const response = await fetch(`https://datacenter.eastmoney.com/api/data/v1/get?${params}`, {
    headers: { Referer: "https://data.eastmoney.com/other/index/", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${market}: HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.result;
  if (!payload.success || !Array.isArray(result?.data) || result.count !== definition.count || result.pages !== 1) {
    throw new Error(`${market}: incomplete response; saved snapshot unchanged`);
  }
  const rows = result.data;
  const codes = [...new Set(rows.map((row) => row.SECUCODE))];
  if (codes.length !== definition.count || codes.some((code) => !/^\d{6}\.(SH|SZ)$/.test(code)) ||
      rows.some((row) => String(row.TYPE) !== definition.type)) {
    throw new Error(`${market}: invalid or duplicated constituents; saved snapshot unchanged`);
  }
  snapshot[market] = {
    name: definition.name, count: codes.length,
    source: `东方财富 RPT_INDEX_TS_COMPONENT / TYPE=${definition.type}`,
    sourceUrl: "https://data.eastmoney.com/other/index/", codes,
  };
  console.log(`${definition.name}: ${codes.length} 只成分股通过校验`);
}
snapshot.updatedAt = new Date().toISOString();
if (process.argv.includes("--check")) {
  console.log("仅校验，未修改快照。");
} else {
  await writeFile(`${target}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
  console.log("成分股快照已更新；重启开发服务或重新构建后生效。");
}
