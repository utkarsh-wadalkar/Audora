export const GITHUB_URL = 'https://github.com/utkarsh-wadalkar/Audora';
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const GUIDE_URL = `${GITHUB_URL}#before-you-start`;
export const RELEASE_VERSION = '2.0.0';

// Set SITE_URL when assigning a custom domain. Vercel supplies the deployment
// origin automatically; localhost remains useful for a complete local build.
export const SITE_URL = process.env.SITE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  || 'http://localhost:3000';

export const description = 'Download Apple Music in lossless FLAC. Build a local library and play your music in Audora for Windows and Linux.';
