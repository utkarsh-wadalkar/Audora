import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { SITE_URL, description } from '../lib/site';
import './globals.css';
import './turntable.css';

const geist = localFont({ src: './fonts/geist-latin.woff2', variable: '--font-geist', display: 'swap' });
const caveat = localFont({ src: './fonts/caveat-700.woff2', variable: '--font-caveat', display: 'swap', weight: '700' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Audora — Your music. All the detail.',
  description,
  applicationName: 'Audora',
  alternates: { canonical: '/' },
  icons: { icon: [{ url: '/favicon.png', sizes: '64x64', type: 'image/png' }], apple: '/apple-touch-icon.png' },
  openGraph: {
    type: 'website', locale: 'en_US', url: '/', siteName: 'Audora',
    title: 'Your music. All the detail.', description,
    images: [{ url: '/social-preview.png', width: 1200, height: 630, alt: 'Audora: lossless FLAC and local listening for Windows and Linux.' }],
  },
  twitter: { card: 'summary_large_image', title: 'Audora — Your music. All the detail.', description, images: ['/social-preview.png'] },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: '#111110', colorScheme: 'dark' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${geist.variable} ${caveat.variable}`}><body>{children}</body></html>;
}
