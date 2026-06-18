import type { MetadataRoute } from 'next';

/** Web App Manifest (served at /manifest.webmanifest, auto-linked) — makes the app installable to the
 *  home screen and run standalone. Colours match the Graphite theme so the splash/chrome blend in. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Meteora LP Monitor',
    short_name: 'LP Monitor',
    description: 'Real-time Meteora DLMM portfolio — live PnL, fees, ranges, on-chain.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#14161b',
    theme_color: '#14161b',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
