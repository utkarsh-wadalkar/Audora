import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default config;
