import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/marketing/button-link";
import { CodeBlock } from "@/components/marketing/code-block";
import { PageHero } from "@/components/marketing/page-hero";
import { PageTransition } from "@/components/marketing/page-transition";
import { Reveal } from "@/components/marketing/reveal";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: `自部署指南：运行自己的大盘云图 | ${siteConfig.name}`,
  description:
    "A 股市场热力图开源免费，支持本地运行与云端部署，腾讯与东方财富行情自动刷新，MIT 协议。",
  alternates: {
    canonical: "/self-host",
  },
  openGraph: {
    title: `自部署指南 | ${siteConfig.name}`,
    description: "部署你自己的 A 股大盘云图，支持腾讯与东方财富行情。",
    url: "/self-host",
    images: [{ url: siteConfig.ogImage, width: 1200, height: 630 }],
  },
};

export default function SelfHostPage() {
  return (
    <PageTransition>
      <PageHero
        eyebrow="SELF-HOST"
        title="部署你自己的大盘云图"
        description="项目遵循 MIT 协议，基于 Next.js 构建，无需数据库。准备源码后可在本地或云端运行，行情由服务端自动更新。"
        align="center"
        size="sm"
      />

      <div className="mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6 sm:pb-20">
        <Reveal className="mdx-content mt-10 text-[15px]">
          <h2>本地运行</h2>
          <p>想在本地跑起来也很简单，装好 Node.js 与 pnpm 后：</p>
          <CodeBlock
            label="终端"
            code={`pnpm install
cp .env.example .env.local
pnpm dev        # http://localhost:3000
pnpm build      # 生产构建
pnpm start      # 运行生产构建`}
          />
          <p>
            技术栈是 Next.js（App Router）+ Canvas 2D + Tailwind CSS，任何能跑 Node.js
            的平台都可以部署，不限于 Vercel。
          </p>

          <h2>云端部署</h2>
          <p>
            将源码上传至支持 Node.js 的云平台，使用 pnpm build 构建、pnpm start 启动；
            也可以通过项目中的 Dockerfile 与 Compose 配置部署容器。
          </p>

          <h2>行情数据</h2>
          <ul>
            <li>
              页面通过 Next.js API Routes 获取公开行情快照，服务端做了秒级缓存，避免频繁刷新打爆接口。
            </li>
            <li>
              股票名册和指数成分股保存在内置快照中，可使用项目脚本校验并更新。
            </li>
            <li>
              默认优先获取腾讯行情，失败后尝试东方财富；远端全部失败时保留旧报价或内置快照，并在界面标注数据状态。
            </li>
          </ul>
          <p>
            本地也可以手动维护内置快照：
          </p>
          <CodeBlock
            label="终端"
            code={`pnpm check:data    # 只拉取并校验，不写文件
pnpm refresh:data  # 校验通过后更新内置快照`}
          />

          <h2>常见问题</h2>
          <ul>
            <li>
              <strong>要配置环境变量吗？</strong>
              ：复制 .env.example 为 .env.local 即可使用默认配置；可通过 MARKET_DATA_PROVIDER 调整数据源。
            </li>
            <li>
              <strong>会存储用户数据吗？</strong>
              ：不会。自选股、配色、快捷键等全部保存在访问者本地浏览器。
            </li>
            <li>
              <strong>可以商用吗？</strong>
              ：代码遵循 MIT 协议，可自由使用与修改；请自行遵守数据源的服务条款，行情数据仅供研究参考。
            </li>
            <li>
              <strong>部署后想给别人用？</strong>
              ：欢迎。也可以直接
              <Link
                href="/embed"
                className="mx-1 font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:text-brand"
              >
                嵌入 iframe
              </Link>
              到你已有的站点。
            </li>
          </ul>
        </Reveal>

        <Reveal className="mt-14">
          <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/60 px-6 py-10 text-center sm:px-12">
            <div aria-hidden className="marketing-glow absolute inset-0" />
            <div className="relative">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">部署好了？打开看看</h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                也可以先在官方站点体验完整功能，再决定要不要部署自己的版本。
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <ButtonLink href="/" prefetch={false} className="h-10 px-5 text-[15px]">
                  打开热力图
                </ButtonLink>
                <Link
                  href="/guide"
                  className="inline-flex h-10 items-center px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  阅读使用教程
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </PageTransition>
  );
}
