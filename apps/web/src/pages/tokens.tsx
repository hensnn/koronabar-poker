import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, post } from '../api';
import { can, useSession } from '../session';
import { Badge, Button, Card, Modal, Notice, TextInput } from '../ui';

interface Token {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  expiresAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  expired: boolean;
}

const fmt = (ms: number) => new Date(ms).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });

/** Osobní přístupové tokeny pro REST API (v profilu). */
export function TokensSection() {
  const { me } = useSession();
  const [data, setData] = useState<{ tokens: Token[]; allowed: string[] } | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<string[]>([]);
  const [fresh, setFresh] = useState('');
  const load = useCallback(() => {
    get<{ tokens: Token[]; allowed: string[] }>('/api/tokens')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => load(), [load]);
  if (!me || !can(me, 'api.tokeny')) return null;
  return (
    <Card
      title={t('tokens.title')}
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('tokens.new')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('tokens.help')}</p>
        <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          {t('tokens.docs')}
        </a>
        {error && <Notice kind="error">{error}</Notice>}
        {fresh && (
          <Notice kind="success">
            {t('tokens.created')} <code className="break-all font-mono">{fresh}</code>
          </Notice>
        )}
        {data && data.tokens.length === 0 && <p className="text-muted">{t('tokens.none')}</p>}
        {data?.tokens.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
            <strong>{k.name}</strong>
            <span className="font-mono text-sm text-muted">{k.hint}…</span>
            {k.revoked && <Badge tone="danger">{t('tokens.revoked')}</Badge>}
            {!k.revoked && k.expired && <Badge tone="warning">{t('tokens.expired')}</Badge>}
            <span className="text-xs text-muted">{k.scopes.map((s) => t(`api.scope.${s}`)).join(', ')}</span>
            <span className="text-xs text-muted">{t('tokens.expires', { time: fmt(k.expiresAt) })}</span>
            <span className="text-xs text-muted">{k.lastUsedAt ? t('tokens.lastUsed', { time: fmt(k.lastUsedAt) }) : t('tokens.neverUsed')}</span>
            {!k.revoked && (
              <Button
                className="ml-auto"
                variant="danger"
                onClick={() => {
                  if (confirm(t('tokens.confirmRevoke'))) void del(`/api/tokens/${k.id}`).then(load, (e) => setError(errorText(e)));
                }}
              >
                {t('tokens.revoke')}
              </Button>
            )}
          </div>
        ))}
      </div>
      {creating && data && (
        <Modal title={t('tokens.new')} onClose={() => setCreating(false)}>
          <div className="flex flex-col gap-3">
            <TextInput label={t('tokens.name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <TextInput label={t('tokens.expiry')} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm text-muted">{t('tokens.scopes')}</legend>
              {data.allowed.map((s) => (
                <label key={s} className="flex items-center gap-2">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {t(`api.scope.${s}`)}
                  <span className="font-mono text-xs text-muted">{s}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={name.trim().length < 2 || scopes.length === 0}
                onClick={async () => {
                  try {
                    const r = await post<{ token: string }>('/api/tokens', { name, scopes, expiresInDays: Number(days) });
                    setFresh(r.token);
                    setCreating(false);
                    setName('');
                    setScopes([]);
                    load();
                  } catch (e) {
                    setError(errorText(e));
                    setCreating(false);
                  }
                }}
              >
                {t('tokens.create')}
              </Button>
              <Button onClick={() => setCreating(false)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
