import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  poweredByHeader: false,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default config;
