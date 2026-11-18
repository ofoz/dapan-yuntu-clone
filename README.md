# 大盘云图

基于 Next.js 的 A 股市场热力图项目，支持全市场与主要指数/板块视图、周期切换、搜索和腾讯/东方财富行情数据。生产地址：https://dp.192163.xyz。

## 本地开发

需要 Node.js 24 与 pnpm 11。

~~~sh
pnpm install --frozen-lockfile
NEXT_PUBLIC_SITE_URL=http://localhost:3000 pnpm dev
~~~

## 检查

~~~sh
pnpm lint
pnpm typecheck
pnpm test
~~~

## Docker 部署

正式服务器使用独立的 Linux 生产包，避免在小内存服务器上编译 Next.js。按 README-Docker部署.md 从 GitHub Release 下载生产包并启动容器。应用仅绑定 127.0.0.1:3000，由 1Panel 配置 HTTPS 反向代理。

行情默认腾讯优先、东方财富备用；生产缓存间隔 15 秒。
