export const siteConfig = {
  name: "大盘云图",
  shortName: "大盘云图",
  tagline: "用一张可交互的市场云图观察 A 股全市场涨跌、板块轮动和权重分布",
  url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ogImage: "/og-image.png",
  author: {
    name: "wenyuanw",
    site: "https://wenyuanw.me",
    email: "hi@wenyuanw.me",
  },
} as const;

export type NavLink = {
  href: string;
  label: string;
  description: string;
};

export const marketingNav: NavLink[] = [
  { href: "/features", label: "功能", description: "了解热力图的能力与适用场景" },
  { href: "/guide", label: "教程", description: "热力图怎么看，从入门到熟练" },
  { href: "/changelog", label: "更新日志", description: "每一次迭代的完整记录" },
  { href: "/whats-new", label: "博客", description: "功能介绍与使用心得" },
];
