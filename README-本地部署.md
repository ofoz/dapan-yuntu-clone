# 大盘云图 · 本地复刻版

基于 MIT 开源项目 [wenyuanw/a-share-heatmap](https://github.com/wenyuanw/a-share-heatmap) 复刻 dpyt.org 的 A 股热力图布局与交互，保留上游 LICENSE。使用 Next.js、React、Canvas；前端与行情后端运行在同一个服务中。

## 启动

要求 Node.js 24 和 pnpm。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

打开 `http://localhost:3000`。

生产环境：

```bash
pnpm build
pnpm start --hostname 0.0.0.0
```

也可以执行 `docker compose up -d --build`。已部署的正式站点为 `https://dp.192163.xyz`，由 1Panel 管理反向代理和自动续期的 HTTPS 证书。低内存服务器的预构建镜像部署和维护步骤见 `README-Docker部署.md`。

## 行情设置

编辑 `.env.local` 后重新启动服务：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MARKET_DATA_PROVIDER` | `auto` | `auto` 腾讯优先、东财备用；`tencent` 或 `eastmoney` 固定单一来源 |
| `MARKET_CACHE_SECONDS` | `15` | 全市场快照缓存与失败退避，允许 3~600 秒 |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | 自己部署的站点地址 |

腾讯源请求 `https://qt.gtimg.cn/q=sh600519,sz000001,...`，后端以 GBK 解码，分批并发抓取；价格、涨跌幅、成交额、总市值和流通市值随报价更新。近 5 日、近 20 日、今年以来使用各自独立字段。东财适配 `clist`/`ulist` 接口，并支持多个镜像主机。行情请求由本地服务发出，浏览器只访问本服务的 `/api/heatmap/*`。

默认前端每 15 秒刷新，可在设置里调整。相同进程内的并发请求共用缓存与进行中的抓取。涨跌家数和成交额从同一股票池计算。昨日成交额暂未提供，页面显示 `--`。报价时间使用供应商返回的真实时间；非交易时段保留最后报价。

## 使用

- 市场切换、一级/二级行业分组、涨跌方向和涨跌幅筛选。
- 流通市值或成交额决定面积；可缩放、拖动、全屏查看。
- 自选股保存于当前浏览器，支持名称/代码搜索与导入导出。
- 悬浮查看个股，双击个股跳转雪球；截图预览、下载、复制。
- 深浅色、配色、边框、缩略图、多周期和快捷键设置。
- 底栏显示供应商；悬浮可查看更新时间、覆盖数量与缓存间隔。

## 数据状态

`GET /api/heatmap/status` 返回当前供应商、最后报价与抓取时间、覆盖数量、缓存间隔、刷新状态及错误摘要。

行情接口：

```text
GET /api/heatmap/treemap?market=all&period=day
GET /api/heatmap/quotes?market=hs300&period=week
GET /api/heatmap/quotes?codes=600519.SH,000001.SZ&period=day
GET /api/heatmap/overview?period=day
GET /api/heatmap/search?q=茅台
GET /api/heatmap/quotes/stream?market=all&period=day
```

`source=direct` 表示成功抓取的报价，`stale` 表示抓取失败后保留的上次报价，`fallback` 表示内置占位快照。后两种响应不进入 HTTP 公共缓存；界面也会区分标注。双源都不可用时保留可浏览的结构与快照，不生成随机行情。

## 股票池与边界

仓库内含股票、行业和退市状态快照。腾讯接口更新名册内的报价；新上市股票的发现、行业信息的补充依赖东财全市场接口与快照维护。上游刷新脚本使用交易所名册核对退市，网络受限时会中止以保护已有快照。

```bash
pnpm check:data --source=tencent
pnpm refresh:data --source=eastmoney
```

中证 A50 保留上游成分股同步。沪深 300 使用中证指数官方名单（文件日期 2026-11-11），中证 A500 使用东财真实 500 只成分股名单（2026-11-16 读取），均已核验全部代码包含在当前股票池中。侧栏指数涨跌也使用供应商真实指数。

可通过 `pnpm check:indices` 只校验最新成分股，或 `pnpm refresh:indices` 更新两组名单后重新构建。脚本核验 300/500 只数量、唯一代码、接口类型和分页完整性，两组均成功才原子写入快照，失败保留旧名单。名单不会随每次报价抓取而刷新。

本地版本不加载上游站点的第三方分析脚本。页面已移除微信赞赏码、赞赏入口与 GitHub 链接，设置中的「项目」页已移除，原赞助页地址跳转至功能介绍页。原项目署名与许可证保留。

## 验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
# 服务启动后执行实际接口验收
pnpm smoke
```

新增测试覆盖腾讯字段与市值单位、指数代码保留、多周期、并发合并、断网缓存和固定来源边界。

本机已完成 96 项单元测试、类型检查、Lint、生产构建，以及真实腾讯行情接口验收。浏览器已检查行业筛选、自选股搜索/添加/移除、截图生成与下载、桌面和 390×844 移动布局。东财成分股接口也已实际校验；东财 `push2` 行情在当前网络下连接失败，保留适配器供其他网络使用。2026-11-16 已在目标服务器实际构建 Docker 镜像并上线，健康检查及公网真实行情验收通过，维护方式见 `README-Docker部署.md`。
