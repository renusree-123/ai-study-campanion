import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "pdfjs-dist"],

  /**
   * Next compiles `instrumentation.ts` for BOTH the Node and Edge runtimes,
   * even though the worker it starts is guarded by a `NEXT_RUNTIME` check and
   * never executes on Edge. Webpack's Edge compilation then tries to resolve
   * the `node:` URIs the worker's dependencies import (`node:crypto`, and so
   * on) and fails with UnhandledSchemeError — which breaks the module graph
   * and turns every page into a 500 under `next dev` with webpack.
   *
   * Marking `node:` builtins external for the Edge compilation lets that build
   * complete. Nothing is thereby made runnable on Edge: the guard still stops
   * the worker from starting there. Turbopack (the default for `npm run dev`)
   * handles this correctly on its own; this keeps the webpack path working too.
   */
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === "edge") {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        ({ request }: { request?: string }, callback: (err?: unknown, result?: string) => void) =>
          request?.startsWith("node:")
            ? callback(undefined, `commonjs ${request}`)
            : callback(),
      ];
    }
    return config;
  },
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
