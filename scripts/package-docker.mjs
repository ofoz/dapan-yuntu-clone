import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination) {
  throw new Error("用法：pnpm package:docker /绝对路径/全新部署目录（先执行生产构建）");
}
if (process.platform !== "linux") {
  throw new Error("预构建部署包需要在 Linux 上生成，以匹配运行镜像的原生依赖。");
}
const output = path.resolve(destination);
const relativeOutput = path.relative(root, output);
if (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== "..") {
  throw new Error("部署目录必须位于项目文件夹之外，避免将部署包再次打入镜像。");
}
await access(path.join(root, ".next/standalone/server.js"));
const preview = await readFile(path.join(root, ".next/server/app/features.html"), "utf8");
const canonical = preview.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
if (!canonical) throw new Error("生产构建缺少 canonical，无法核对部署地址。");
const siteUrl = new URL(canonical[1]).origin;
if (process.env.NEXT_PUBLIC_SITE_URL && new URL(process.env.NEXT_PUBLIC_SITE_URL).origin !== siteUrl) {
  throw new Error("构建地址与 NEXT_PUBLIC_SITE_URL 不一致，请先使用目标站点地址重新构建。");
}
await mkdir(output);
const app = path.join(output, "app");
await cp(path.join(root, ".next/standalone"), app, {
  recursive: true,
  verbatimSymlinks: true,
  filter: (source) => {
    const relative = path.relative(path.join(root, ".next/standalone"), source);
    return !relative.split(path.sep).some((part) => part.startsWith(".env"))
      && relative !== "public" && !relative.startsWith(`public${path.sep}`)
      && relative !== path.join(".next", "static")
      && !relative.startsWith(`${path.join(".next", "static")}${path.sep}`);
  },
});
await cp(path.join(root, "public"), path.join(app, "public"), { recursive: true });
await cp(path.join(root, ".next/static"), path.join(app, ".next/static"), { recursive: true });
for (const name of ["Dockerfile", "compose.yaml", "openresty.conf"]) {
  await cp(path.join(root, "deploy", name), path.join(output, name));
}
await cp(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
const manifest = {
  createdAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  siteUrl,
  buildId: (await readFile(path.join(root, ".next/BUILD_ID"), "utf8")).trim(),
};
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, ...manifest }, null, 2));
