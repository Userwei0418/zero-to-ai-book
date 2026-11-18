import type { NextConfig } from 'next';
import path from 'node:path';

const containerBuild = process.env.BOOK_CONTAINER_BUILD === '1';

const nextConfig: NextConfig = containerBuild ? {
  output: 'standalone',
  poweredByHeader: false,
  experimental: { cpus: 2 },
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /^cloudflare:workers$/,
      path.resolve('deploy/web/node-env.mjs'),
    ));
    return config;
  },
} : {};

export default nextConfig;
