import { access, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next/standalone");
const entry = path.join(standalone, "server.js");
try {
  await access(entry);
} catch {
  console.error("请先执行 pnpm build，再执行 pnpm start。");
  process.exit(1);
}

for (const file of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  try { process.loadEnvFile(path.join(root, file)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
process.env.HOSTNAME = option("--hostname") || process.env.LISTEN_HOST || "127.0.0.1";
process.env.PORT = option("--port") || process.env.PORT || "3000";
process.env.NEXT_TELEMETRY_DISABLED ??= "1";

// Next standalone output intentionally leaves public and static assets separate.
await cp(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
await cp(path.join(root, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });
await import(pathToFileURL(entry).href);
