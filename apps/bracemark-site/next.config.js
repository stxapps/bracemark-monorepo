//@ts-check

/**
 * @type {import('next').NextConfig}
 **/
const nextConfig = {
  // Static export, same as bracemark-web: the whole marketing site prerenders to
  // `out/` and is served from S3 + CloudFront (docs/hosting.md). Nothing here
  // is per-request — it's a content site — so no Next server runs on the apex.
  output: 'export',
  images: {
    unoptimized: true,
  },
  devIndicators: false,
};

module.exports = nextConfig;
