import { BUILTIN_THEMES, resolveTokens } from '@kb/tokens';
import { t } from '@kb/shared';

/**
 * Manifest PWA. Barvy se berou z výchozího motivu (tmavý režim), takže se instalovaná aplikace
 * (úvodní obrazovka, lišta) přizpůsobí vzhledu herny.
 */
export function buildManifest(themeId: string): Record<string, unknown> {
  const theme = BUILTIN_THEMES.find((x) => x.id === themeId) ?? BUILTIN_THEMES[0]!;
  const tokens = resolveTokens(theme, 'dark');
  const bg = tokens['color.bg'] ?? '#000000';
  return {
    id: '/',
    name: t('app.name'),
    short_name: t('pwa.shortName'),
    description: t('pwa.description'),
    lang: 'cs',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    categories: ['games'],
    background_color: bg,
    theme_color: bg,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      { name: t('nav.lobby'), url: '/' },
      { name: t('nav.tables'), url: '/stoly' },
      { name: t('nav.chat'), url: '/chat' },
    ].map((s) => ({ ...s, icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] })),
  };
}
