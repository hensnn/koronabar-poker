import { useMemo, useState } from 'react';
import { computePayouts, estimateTournament, formatStructure, generateStructure, labelKey, optionKey, parseStructure, percentsFor, t, type Level, type PayoutPreset, type SettingValue, type SettingValues } from '@kb/shared';
import { Button, Card, DataTable, Td } from '../ui';

const num = 'w-20 rounded-sm border border-line bg-surface px-2 py-1 font-mono';

/** Levely ze zadané struktury, nebo vygenerované podle cílové délky (jako to udělá server při startu). */
export function levelsFor(values: SettingValues, players: number): { levels: Level[]; generated: boolean; error: string } {
  const text = String(values['tournament.structure'] ?? '').trim();
  const byHands = values['tournament.levelMode'] === 'hands';
  const minutes = byHands ? Math.max(1, Number(values['tournament.levelHands'])) : Number(values['tournament.levelMinutes']);
  if (!text) return { levels: generateStructure({ startingStack: Number(values['tournament.startingStack']), targetMinutes: Number(values['tournament.targetMinutes']), levelMinutes: minutes, players }), generated: true, error: '' };
  try {
    return { levels: parseStructure(text), generated: false, error: '' };
  } catch {
    return { levels: [], generated: false, error: t('tournament.structureInvalid') };
  }
}

/** Tabulka levelů (ante, SB, BB) s oddělením přestávek. */
export function LevelsTable({ levels, breakEvery }: { levels: Level[]; breakEvery: number }) {
  return (
    <DataTable head={['#', t('rules.ante'), t('rules.sb'), t('rules.bb')]}>
      {levels.map((l, i) => (
        <tr key={i} className={breakEvery > 0 && (i + 1) % breakEvery === 0 ? 'border-b-2 border-line' : ''}>
          <Td>{i + 1}</Td>
          <Td className="font-mono">{l.ante || '–'}</Td>
          <Td className="font-mono">{l.smallBlind}</Td>
          <Td className="font-mono">{l.bigBlind}</Td>
        </tr>
      ))}
    </DataTable>
  );
}

/** Věta s odhadem délky turnaje pro daný počet hráčů. */
export function EstimateLine({ values, players }: { values: SettingValues; players: number }) {
  const e = useMemo(() => estimateTournament(values, { players }), [values, players]);
  if (e.minutes === null) return <span className="text-danger">{t('tournament.estimateNone')}</span>;
  return <span className="text-sm">{t('tournament.estimateResult', { minutes: e.minutes, from: e.range![0], to: e.range![1], levels: e.levels ?? 0 })}</span>;
}

/**
 * Struktura blindů: cílová délka, délka levelu, startovní stack a počet hráčů přímo u tlačítka Vygenerovat,
 * náhled levelů (zadaných, nebo těch, které by vznikly automaticky) a živý odhad délky turnaje.
 */
export function StructureEditor({ values, set }: { values: SettingValues; set: (k: string, v: SettingValue) => void }) {
  const seats = Number(values['table.seats']);
  const [players, setPlayers] = useState(Math.max(2, Math.min(seats, Number(values['tournament.minPlayers']) + 3)));
  const n = Math.max(2, Math.min(seats, players || 2));
  const text = String(values['tournament.structure'] ?? '');
  const byHands = values['tournament.levelMode'] === 'hands';
  const preview = useMemo(() => levelsFor(values, n), [values, n]);
  const [showPreview, setShowPreview] = useState(false);
  const generate = () => set('tournament.structure', formatStructure(levelsFor({ ...values, 'tournament.structure': '' }, n).levels));
  const field = (key: string, label: string, min: number, max: number) => (
    <label className="flex items-center gap-1 text-sm">
      {label}
      <input type="number" className={num} min={min} max={max} value={Number(values[key])} onChange={(e) => set(key, Number(e.target.value))} />
    </label>
  );
  return (
    <Card title={t('tournament.structure')}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          {field('tournament.targetMinutes', t('structure.targetMinutes'), 10, 1440)}
          {byHands ? field('tournament.levelHands', t('structure.levelHands'), 1, 500) : field('tournament.levelMinutes', t('structure.levelMinutes'), 1, 240)}
          {field('tournament.startingStack', t('tournament.startingStack'), 1, 1_000_000_000)}
          <label className="flex items-center gap-1 text-sm">
            {t('structure.players')}
            <input type="number" className={num} min={2} max={seats} value={players} onChange={(e) => setPlayers(Number(e.target.value))} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={generate}>
            {t('tournament.generate')}
          </Button>
          <Button onClick={() => set('tournament.structure', '')} disabled={!text}>
            {t('tournament.structureAuto')}
          </Button>
          <Button onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview}>
            {showPreview ? t('structure.hidePreview') : t('structure.showPreview', { n: preview.levels.length })}
          </Button>
        </div>
        <textarea className="min-h-20 w-full rounded-sm border border-line bg-surface px-2 py-1 font-mono text-text" aria-label={t('tournament.structure')} value={text} placeholder={t('tournament.structurePlaceholder')} onChange={(e) => set('tournament.structure', e.target.value)} />
        {preview.error && <span className="text-danger">{preview.error}</span>}
        {!text && <span className="text-sm text-muted">{t('tournament.structureAutoHint')}</span>}
        {!preview.error && (
          <p>
            <EstimateLine values={values} players={n} />
          </p>
        )}
        {showPreview && !preview.error && (
          <>
            {preview.generated && <span className="text-sm text-muted">{t('structure.generatedNote', { n })}</span>}
            <LevelsTable levels={preview.levels} breakEvery={Number(values['tournament.breakEveryLevels'] ?? 0)} />
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * Peníze a výplaty (jako „Players / Money & Prizes“): buy-in a poplatek jdou upravit přímo tady,
 * pro zadaný počet hráčů se ukáže, kolik každý zaplatí, kam peníze jdou, celkový prize pool a rozpis výplat po místech.
 */
export function MoneyPreview({ values, set }: { values: SettingValues; set: (k: string, v: SettingValue) => void }) {
  const seats = Number(values['table.seats']);
  const [players, setPlayers] = useState(Math.max(2, Math.min(seats, Number(values['tournament.minPlayers']) + 3)));
  const n = Math.max(2, Math.min(seats, players || 2));
  const buyIn = Number(values['tournament.buyIn']);
  const fee = Number(values['tournament.fee']);
  const housePct = Number(values['tournament.houseCutPercent']);
  const fundPct = Number(values['tournament.fundPercent']);
  const house = Math.floor((buyIn * housePct) / 100);
  const fund = Math.floor((buyIn * fundPct) / 100);
  const perPlayer = buyIn - house - fund;
  const pool = perPlayer * n;
  const guarantee = Number(values['tournament.guarantee']);
  const overlay = Math.max(0, guarantee - pool);
  const total = Math.max(pool, guarantee);
  const payouts = useMemo(() => {
    try {
      const pct = percentsFor(values['tournament.payoutPreset'] as PayoutPreset, String(values['tournament.payoutCustom'] ?? ''), n);
      return computePayouts(total, pct, { roundTo: Number(values['tournament.payoutRoundTo']), remainder: values['tournament.payoutRemainder'] as 'first' | 'house' | 'spread' });
    } catch {
      return null;
    }
  }, [values, n, total]);
  const num = 'w-24 rounded-sm border border-line bg-surface px-2 py-1 font-mono';
  return (
    <Card title={t('money.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-sm">
            {t('tournament.buyIn')}
            <input type="number" className={num} min={0} value={buyIn} onChange={(e) => set('tournament.buyIn', Number(e.target.value))} />
          </label>
          <label className="flex items-center gap-1 text-sm">
            {t('money.fee')}
            <input type="number" className={num} min={0} value={fee} onChange={(e) => set('tournament.fee', Number(e.target.value))} />
          </label>
          <label className="flex items-center gap-1 text-sm">
            {t('structure.players')}
            <input type="number" className="w-20 rounded-sm border border-line bg-surface px-2 py-1 font-mono" min={2} max={seats} value={players} onChange={(e) => setPlayers(Number(e.target.value))} />
          </label>
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          {t(labelKey('tournament.payoutPreset'))}
          <select className="rounded-sm border border-line bg-surface px-2 py-1" value={String(values['tournament.payoutPreset'])} onChange={(e) => set('tournament.payoutPreset', e.target.value)}>
            {['standard', 'wta', 'top2', 'top3', 'custom'].map((o) => (
              <option key={o} value={o}>
                {t(optionKey('tournament.payoutPreset', o))}
              </option>
            ))}
          </select>
        </label>
        <ul className="flex flex-col gap-1 text-sm">
          <li>{t('money.playerPays', { total: buyIn + fee, buyIn, fee })}</li>
          <li>{t('money.toPool', { amount: perPlayer, house, housePct, fund, fundPct })}</li>
          <li>
            <strong>{t('money.pool', { n, each: perPlayer, pool })}</strong>
            {guarantee > 0 && ' ' + (overlay > 0 ? t('money.guaranteeOverlay', { guarantee, overlay }) : t('money.guaranteeOk', { guarantee }))}
          </li>
          {(house > 0 || fee > 0) && <li className="text-muted">{t('money.houseTotal', { amount: (house + fee) * n })}</li>}
          {fund > 0 && <li className="text-muted">{t('money.fundTotal', { amount: fund * n })}</li>}
        </ul>
        {payouts && (
          <div>
            <h3 className="mb-1 font-medium">{t('money.payouts', { n })}</h3>
            <DataTable head={[t('tournament.placeShort'), t('money.amount'), '%']}>
              {payouts.amounts.map((amt, i) => (
                <tr key={i}>
                  <Td>{i + 1}.</Td>
                  <Td className="font-mono">{amt}</Td>
                  <Td className="font-mono text-muted">{total > 0 ? Math.round((amt / total) * 1000) / 10 : 0}</Td>
                </tr>
              ))}
            </DataTable>
            {payouts.toHouse > 0 && <p className="text-sm text-muted">{t('money.remainderHouse', { amount: payouts.toHouse })}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}


const numCls = 'w-24 rounded-sm border border-line bg-surface px-2 py-1 font-mono';

/** Číselné pole s popiskem z registru nastavení. */
function NumField({ k, values, set, min = 0 }: { k: string; values: SettingValues; set: (k: string, v: SettingValue) => void; min?: number }) {
  return (
    <label className="flex items-center gap-1 text-sm">
      {t(labelKey(k))}
      <input type="number" className={numCls} min={min} value={Number(values[k])} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  );
}

/** Rebuy, add-on a re-entry na jednom místě: zapnutí a hlavní čísla (cena, žetony, do kterého levelu, kolikrát). */
export function RebuyCard({ values, set }: { values: SettingValues; set: (k: string, v: SettingValue) => void }) {
  const toggle = (k: string) => (
    <label className="flex items-center gap-2 font-medium">
      <input type="checkbox" checked={!!values[k]} onChange={(e) => set(k, e.target.checked)} />
      {t(labelKey(k))}
    </label>
  );
  return (
    <Card title={t('rebuy.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {toggle('tournament.rebuyEnabled')}
          {values['tournament.rebuyEnabled'] && (
            <div className="flex flex-wrap items-center gap-3 pl-6">
              <NumField k="tournament.rebuyCost" values={values} set={set} min={1} />
              <NumField k="tournament.rebuyChips" values={values} set={set} min={1} />
              <NumField k="tournament.rebuyUntilLevel" values={values} set={set} min={1} />
              <NumField k="tournament.rebuyMax" values={values} set={set} min={1} />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {toggle('tournament.addonEnabled')}
          {values['tournament.addonEnabled'] && (
            <div className="flex flex-wrap items-center gap-3 pl-6">
              <NumField k="tournament.addonCost" values={values} set={set} min={1} />
              <NumField k="tournament.addonChips" values={values} set={set} min={1} />
              <NumField k="tournament.addonFromLevel" values={values} set={set} min={1} />
              <NumField k="tournament.addonUntilLevel" values={values} set={set} min={1} />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {toggle('tournament.reentryEnabled')}
          {values['tournament.reentryEnabled'] && (
            <div className="flex flex-wrap items-center gap-3 pl-6">
              <NumField k="tournament.reentryMax" values={values} set={set} min={1} />
            </div>
          )}
        </div>
        <p className="text-sm text-muted">{t('rebuy.hint')}</p>
      </div>
    </Card>
  );
}
