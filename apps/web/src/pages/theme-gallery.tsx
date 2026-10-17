import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { post, put, errorText, get } from '../api';
import { can, useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { loadThemes, useThemeStore, type CustomTheme } from '../theme/themes-client';
import { Badge, Button, Card, Notice } from '../ui';

/** Galerie sdílených motivů, fronta ke schválení (kurátor) a výchozí motiv pro nové hráče (správce). */
export function ThemeGallery({ onEdit }: { onEdit: (th: CustomTheme) => void }) {
  const { me } = useSession();
  const settings = useSettings();
  const store = useThemeStore();
  const [pending, setPending] = useState<CustomTheme[]>([]);
  const [msg, setMsg] = useState('');
  const review = can(me, 'motiv.schvalit');
  const admin = can(me, 'nastaveni.globalni');
  const current = String(settings.values['ui.themeId']);
  const loadPending = useCallback(() => {
    if (review) get<{ themes: CustomTheme[] }>('/api/themes/pending').then((d) => setPending(d.themes)).catch(() => setPending([]));
  }, [review]);
  useEffect(loadPending, [loadPending]);
  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try {
      await fn();
      await loadThemes();
      loadPending();
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  const shared = store.themes.filter((x) => !x.mine && x.status === 'shared');
  return (
    <Card title={t('gallery.title')}>
      <div className="flex flex-col gap-4">
        {msg && <Notice kind="error">{msg}</Notice>}
        {shared.length === 0 ? (
          <p className="text-sm text-muted">{t('gallery.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shared.map((th) => (
              <li key={th.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
                <strong className="flex-1">{th.name}</strong>
                <span className="text-sm text-muted">{t('gallery.by', { nick: th.ownerNickname ?? '?' })}</span>
                {current === th.id && <Badge tone="primary">{t('gallery.inUse')}</Badge>}
                <Button onClick={() => void saveUserSetting('ui.themeId', th.id).catch((e) => setMsg(errorText(e)))}>{t('gallery.use')}</Button>
                <Button onClick={() => onEdit(th)}>{t('gallery.copy')}</Button>
                {review && (
                  <Button variant="danger" onClick={() => void run(() => post(`/api/themes/${th.id}/hide`, { hidden: true }))}>
                    {t('gallery.hide')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {review && (
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('gallery.pending')}</h3>
            {pending.length === 0 ? (
              <p className="text-sm text-muted">{t('gallery.pendingEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((th) => (
                  <li key={th.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
                    <strong className="flex-1">{th.name}</strong>
                    <span className="text-sm text-muted">{t('gallery.by', { nick: th.ownerNickname ?? '?' })}</span>
                    <Button onClick={() => onEdit(th)}>{t('gallery.preview')}</Button>
                    <Button variant="primary" onClick={() => void run(() => post(`/api/themes/${th.id}/review`, { approve: true }))}>
                      {t('gallery.approve')}
                    </Button>
                    <Button variant="danger" onClick={() => void run(() => post(`/api/themes/${th.id}/review`, { approve: false }))}>
                      {t('gallery.reject')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {admin && (
          <section className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{t('gallery.defaultNow', { id: store.defaultId })}</span>
            <Button onClick={() => void run(() => put('/api/settings/global', { key: 'theme.defaultId', value: current }))}>{t('gallery.makeDefault')}</Button>
          </section>
        )}
      </div>
    </Card>
  );
}
