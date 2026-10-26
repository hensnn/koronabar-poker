import { useState } from 'react';
import { t } from '@kb/shared';
import { ApiError, del, get, put } from './api';
import { useNet } from './net';
import { deviceId } from './settings';
import { Button, Card } from './ui';

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}

const describe = (e: unknown): string => (e instanceof ApiError ? `${e.status} ${e.code}${e.params ? ' ' + JSON.stringify(e.params).slice(0, 120) : ''}` : String(e));

/** Zkouška, proč u konkrétního účtu nereagují nastavení: spojení, uložení a smazání zkušební hodnoty, vrstva nad stránkou. Výsledek jde zkopírovat. */
export function Diagnostics() {
  const net = useNet();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setBusy(true);
    setCopied(false);
    const out: Row[] = [];
    let previous: unknown;
    const step = async (name: string, fn: () => Promise<string>) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        out.push({ name, ok: true, detail: `${detail} (${Math.round(performance.now() - t0)} ms)` });
      } catch (e) {
        out.push({ name, ok: false, detail: describe(e) });
      }
    };
    await step(t('diag.me'), async () => {
      const me = await get<{ user: { nickname: string; emailVerified: boolean; status: string }; permissions: string[] }>('/api/auth/me');
      return `${me.user.nickname}, stav ${me.user.status}, e-mail ${me.user.emailVerified ? 'ověřen' : 'neověřen'}, oprávnění ${me.permissions.length}`;
    });
    await step(t('diag.load'), async () => {
      const s = await get<{ user: Record<string, unknown>; device: Record<string, unknown> }>(`/api/me/settings?device=${deviceId()}`);
      previous = s.user['ui.betChips'];
      return `hodnot v účtu ${Object.keys(s.user).length}, v zařízení ${Object.keys(s.device).length}`;
    });
    await step(t('diag.save'), async () => {
      await put('/api/me/settings', { key: 'ui.betChips', value: previous === false });
      // Zkušební změna se hned vrátí na původní hodnotu.
      if (previous === undefined) await del(`/api/me/settings/${encodeURIComponent('ui.betChips')}`);
      else await put('/api/me/settings', { key: 'ui.betChips', value: previous as boolean });
      return 'zápis a vrácení hodnoty prošly';
    });
    await step(t('diag.saveDevice'), async () => {
      await put('/api/me/settings', { key: 'ui.tablePanelWidth', value: 272, device: deviceId() });
      await del(`/api/me/settings/${encodeURIComponent('ui.tablePanelWidth')}?device=${deviceId()}`);
      return 'zápis a smazání pro zařízení prošly';
    });
    out.push({ name: t('diag.socket'), ok: net.status === 'online', detail: `stav ${net.status}` });
    // Vrstva nad stránkou: co leží uprostřed okna a nad první hlavičkou widgetu.
    const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    // První viditelné tlačítko s rozbalováním (widget, nabídka); skrytá tlačítka mají nulovou velikost.
    const header = [...document.querySelectorAll('button[aria-expanded]')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
    });
    let overlay = 'na této stránce není viditelné rozbalovací tlačítko (zkus na stránce se stolem)';
    if (header) {
      const r = header.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      overlay = top === header || header.contains(top) ? `klikatelné: ${(header.textContent ?? '').trim().slice(0, 20)}` : `ZAKRYTO: ${top?.tagName}.${String(top?.className).slice(0, 80)}`;
    }
    out.push({ name: t('diag.overlay'), ok: !overlay.startsWith('ZAKRYTO'), detail: `${overlay}; střed okna: ${centre?.tagName}` });
    out.push({
      name: t('diag.env'),
      ok: true,
      detail: `okno ${window.innerWidth}x${window.innerHeight}, zvětšení ${window.devicePixelRatio}, zařízení ${deviceId()}, adresa ${location.origin}, mobilní rozložení ${document.documentElement.hasAttribute('data-mobile') ? 'ano' : 'ne'}`,
    });
    setRows(out);
    setBusy(false);
  };

  const text = rows.map((r) => `${r.ok ? 'OK ' : 'CHYBA '} ${r.name}: ${r.detail}`).join('\n');
  return (
    <Card title={t('diag.title')}>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">{t('diag.intro')}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void run()} disabled={busy}>
            {t('diag.run')}
          </Button>
          {rows.length > 0 && (
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? t('share.copied') : t('diag.copy')}
            </Button>
          )}
        </div>
        {rows.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((r) => (
              <li key={r.name} className={r.ok ? '' : 'font-semibold text-danger'}>
                {r.ok ? '✔' : '✖'} <span className="font-medium">{r.name}:</span> {r.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
