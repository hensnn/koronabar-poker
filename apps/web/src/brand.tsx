import { useEffect, useState, type CSSProperties } from 'react';
import { t } from '@kb/shared';
import { Link } from './router';

export interface Brand {
  /** Identifikátor nahraného loga (mění se s každým novým obrázkem), nebo null. */
  logo: string | null;
  showName: boolean;
  heightPercent: number;
}

let current: Brand | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const publish = (b: Brand) => {
  current = b;
  listeners.forEach((l) => l());
};

/** Načte značku aplikace (logo, velikost) z veřejné adresy: funguje i před přihlášením. */
export function refreshBrand(): Promise<void> {
  loading = fetch('/api/public/brand')
    .then((r) => (r.ok ? (r.json() as Promise<Brand>) : null))
    .then((b) => {
      if (b) publish(b);
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function useBrand(): Brand | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    if (!current && !loading) void refreshBrand();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return current;
}

/** Velikost loga jako CSS proměnná (měřítko), aby v komponentách nebyly pevné rozměry. */
export const brandVars = (b: Brand | null): CSSProperties => ({ ['--brand-scale' as string]: String((b?.heightPercent ?? 100) / 100) });

/** Značka aplikace: logo (je-li nahrané) a případně název; bez loga jen název. `large` je větší varianta pro přihlašovací stránku. */
export function BrandMark({ large = false, link = true }: { large?: boolean; link?: boolean }) {
  const brand = useBrand();
  const hasLogo = !!brand?.logo;
  const showName = !hasLogo || brand?.showName !== false;
  const body = (
    <span className={`inline-flex items-center gap-2 font-heading font-bold ${large ? 'text-3xl' : 'text-2xl'}`} style={brandVars(brand)}>
      {hasLogo && <img src={`/api/public/brand/logo?v=${brand!.logo}`} alt={showName ? '' : t('app.name')} className={large ? 'tk-brand-logo tk-brand-logo-large' : 'tk-brand-logo'} />}
      {showName && <span>{t('app.name')}</span>}
    </span>
  );
  return link ? (
    <Link to="/" aria-label={t('app.name')}>
      {body}
    </Link>
  ) : (
    body
  );
}

/** Ikona záložky prohlížeče podle loga (když je nahrané). */
export function BrandFavicon() {
  const brand = useBrand();
  useEffect(() => {
    if (!brand?.logo) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = `/api/public/brand/logo?v=${brand.logo}`;
  }, [brand?.logo]);
  return null;
}
