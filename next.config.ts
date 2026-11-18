import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Keep full type checking without the CLI subprocess used by Next 16.3.
    useTypeScriptCli: false,
    cpus: 2,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Origin-Agent-Cluster",
            value: "?1",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
