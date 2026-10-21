import type { CSSProperties, ReactNode } from 'react';
import type { LoginLayout } from '@kb/shared';
import { BrandMark } from '../brand';
import { Card } from '../ui';

/** Ztmavení a rozostření vlastního obrázku pozadí jako CSS proměnné (bez pevných hodnot v komponentě). */
export function loginFrameVars(layout: LoginLayout, bgImage: string | null): CSSProperties {
  const vars: Record<string, string> = {
    '--login-overlay': String(layout.bgOverlayPercent / 100),
    '--login-blur': `${layout.bgBlur / 10}rem`,
  };
  if (layout.background === 'image' && bgImage) vars['--login-bg-url'] = `url(/api/public/brand/background?v=${bgImage})`;
  return vars as CSSProperties;
}

/**
 * Rozložení přihlašovací a registrační stránky podle nastavení: pozadí, poloha a šířka karty, umístění a velikost loga, uvítací text.
 * Používá ho skutečná stránka i živý náhled ve správě (`preview`).
 */
export function LoginFrame({ layout, bgImage, title, children, preview = false }: { layout: LoginLayout; bgImage: string | null; title: string; children: ReactNode; preview?: boolean }) {
  const mode = layout.background === 'image' && !bgImage ? 'felt' : layout.background;
  const mark = layout.logoPlacement === 'none' ? null : <BrandMark large link={false} scalePercent={layout.logoSizePercent} showName={layout.showName} />;
  const brandBlock = (extra = '') => (
    <div className={`tk-login-brand ${extra}`}>
      {mark && <h1 className="flex justify-center">{mark}</h1>}
      {layout.tagline && <p className="tk-login-tagline text-center">{layout.tagline}</p>}
    </div>
  );
  const above = layout.logoPlacement === 'above' || layout.logoPlacement === 'side';
  return (
    <div className={`tk-login-bg ${preview ? 'tk-login-preview' : ''}`} data-login-bg={mode} data-tone={layout.bgTone} data-plate={layout.logoPlate} style={loginFrameVars(layout, bgImage)}>
      <div className="tk-login-wrap" data-pos={layout.cardPosition}>
        <main className="tk-login-main" data-width={layout.cardWidth} data-placement={layout.logoPlacement}>
          {above && brandBlock()}
          <Card title={title}>
            {layout.logoPlacement === 'inside' && brandBlock('mb-3')}
            {layout.logoPlacement === 'none' && layout.tagline && <p className="tk-login-tagline mb-3">{layout.tagline}</p>}
            {children}
          </Card>
        </main>
      </div>
    </div>
  );
}
