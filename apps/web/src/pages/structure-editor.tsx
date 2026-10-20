import { useEffect, useMemo, useState } from 'react';
import { computePayouts, estimateTournament, formatStructure, generateStructure, labelKey, optionKey, parseStructure, percentsFor, scaleStructure, STRUCTURE_PRESETS, t, type Level, type PayoutPreset, type SettingValue, type SettingValues } from '@kb/shared';
import { get } from '../api';
import { can, useSession } from '../session';
import { Button, Card, DataTable, NumInput, Td } from '../ui';
import { StructureDialog, type BlindStructure } from './admin/structures';

type Set = (k: string, v: SettingValue) => void;
const numCls = 'w-24';
const selectCls = 'rounded-sm border border-line bg-surface px-2 py-1 text-text';

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
    <DataTable sortable={false} head={['#', t('rules.ante'), t('rules.sb'), t('rules.bb')]}>
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

/** Číselné pole s popiskem z registru nastavení. */
function NumField({ k, values, set, min = 0, label }: { k: string; values: SettingValues; set: Set; min?: number; label?: string }) {
  return (
    <label className="flex items-center gap-1 text-sm">
      {label ?? t(labelKey(k))}
      <NumInput className={numCls} min={min} value={Number(values[k])} onChange={(n) => set(k, n)} />
    </label>
  );
}

function Toggle({ k, values, set }: { k: string; values: SettingValues; set: Set }) {
  return (
    <label className="flex items-center gap-2 font-medium">
      <input type="checkbox" checked={!!values[k]} onChange={(e) => set(k, e.target.checked)} />
      {t(labelKey(k))}
    </label>
  );
}

function PayoutSelect({ values, set }: { values: SettingValues; set: Set }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      {t('basics.payoutPlaces')}
      <select className={selectCls} value={String(values['tournament.payoutPreset'])} onChange={(e) => set('tournament.payoutPreset', e.target.value)}>
        {['standard', 'wta', 'top2', 'top3', 'custom'].map((o) => (
          <option key={o} value={o}>
            {t(optionKey('tournament.payoutPreset', o))}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Hlavní nastavení turnaje na jednom místě nahoře: buy-in, rebuy (cena a počet), add-on, dělení výhry,
 * délka levelu a přestávky. Podrobnosti jsou v kartách níž a v podrobném nastavení.
 */
export function TournamentBasics({ values, set }: { values: SettingValues; set: Set }) {
  const byHands = values['tournament.levelMode'] === 'hands';
  return (
    <Card title={t('basics.title')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <NumField k="tournament.buyIn" values={values} set={set} label={t('basics.buyIn')} />
          <NumField k="tournament.fee" values={values} set={set} label={t('money.fee')} />
          <NumField k="tournament.startingStack" values={values} set={set} min={1} />
        </div>
        <div className="flex flex-col gap-2">
          <Toggle k="tournament.rebuyEnabled" values={values} set={set} />
          {values['tournament.rebuyEnabled'] && (
            <div className="flex flex-wrap gap-3 pl-6">
              <NumField k="tournament.rebuyCost" values={values} set={set} min={1} label={t('basics.price')} />
              <NumField k="tournament.rebuyMax" values={values} set={set} min={1} label={t('basics.maxCount')} />
            </div>
          )}
          <Toggle k="tournament.addonEnabled" values={values} set={set} />
          {values['tournament.addonEnabled'] && (
            <div className="flex flex-wrap gap-3 pl-6">
              <NumField k="tournament.addonCost" values={values} set={set} min={1} label={t('basics.price')} />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <PayoutSelect values={values} set={set} />
        </div>
        <div className="flex flex-col gap-2">
          {byHands ? <NumField k="tournament.levelHands" values={values} set={set} min={1} label={t('structure.levelHands')} /> : <NumField k="tournament.levelMinutes" values={values} set={set} min={1} label={t('structure.levelMinutes')} />}
          <div className="flex flex-wrap gap-3">
            <NumField k="tournament.breakEveryLevels" values={values} set={set} label={t('basics.breakEvery')} />
            {Number(values['tournament.breakEveryLevels']) > 0 && <NumField k="tournament.breakMinutes" values={values} set={set} min={1} label={t('basics.breakMinutes')} />}
          </div>
          {Number(values['tournament.breakEveryLevels']) > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={values['tournament.breakRepeat'] !== false} onChange={(e) => set('tournament.breakRepeat', e.target.checked)} />
              {t('basics.breakRepeat')}
            </label>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Struktura blindů: předvolby (pomalá, standardní, turbo, hyper) podle stacku a počtu hráčů, vlastní zápis,
 * nebo – jen na přání – automatické vygenerování při startu. Náhled levelů a živý odhad délky turnaje.
 */
export function StructureEditor({ values, set }: { values: SettingValues; set: Set }) {
  const seats = Number(values['table.seats']);
  const [players, setPlayers] = useState(Math.max(2, Math.min(seats, Number(values['tournament.minPlayers']) + 3)));
  const n = Math.max(2, Math.min(seats, players || 2));
  const text = String(values['tournament.structure'] ?? '');
  const preview = useMemo(() => levelsFor(values, n), [values, n]);
  const [showPreview, setShowPreview] = useState(true);
  const mode = text.trim() ? 'custom' : 'auto';
  // Uložené struktury (Správa → Struktury blindů): při výběru se přepočítají na aktuální stack.
  const { me } = useSession();
  const [saved, setSaved] = useState<BlindStructure[]>([]);
  const [saveAs, setSaveAs] = useState(false);
  useEffect(() => {
    get<{ structures: BlindStructure[] }>('/api/structures')
      .then((d) => setSaved(d.structures))
      .catch(() => undefined);
  }, []);
  const applyPreset = (id: string) => {
    if (id === 'auto') return set('tournament.structure', '');
    if (id === 'custom') return;
    if (id.startsWith('saved:')) {
      const s = saved.find((x) => x.id === id.slice(6));
      if (!s) return;
      try {
        const stack = Number(values['tournament.startingStack']);
        const levels = scaleStructure(parseStructure(s.levels), stack > 0 && s.startingStack > 0 ? stack / s.startingStack : 1);
        set('tournament.levelMinutes', s.levelMinutes);
        set('tournament.structure', formatStructure(levels));
      } catch {
        /* neplatný zápis uložené struktury se přeskočí */
      }
      return;
    }
    const p = STRUCTURE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    set('tournament.levelMinutes', p.levelMinutes);
    set('tournament.targetMinutes', p.targetMinutes);
    set('tournament.structure', formatStructure(generateStructure({ startingStack: Number(values['tournament.startingStack']), targetMinutes: p.targetMinutes, levelMinutes: p.levelMinutes, players: n })));
  };
  const generate = () => set('tournament.structure', formatStructure(levelsFor({ ...values, 'tournament.structure': '' }, n).levels));
  return (
    <Card title={t('tournament.structure')}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            {t('structure.preset')}
            <select className={selectCls} value={mode} onChange={(e) => applyPreset(e.target.value)}>
              <option value="custom">{t('structure.mode.custom')}</option>
              {STRUCTURE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(`structure.preset.${p.id}`, { level: p.levelMinutes, minutes: p.targetMinutes })}
                </option>
              ))}
              <option value="auto">{t('structure.mode.auto')}</option>
              {saved.length > 0 && (
                <optgroup label={t('structures.savedGroup')}>
                  {saved.map((s) => (
                    <option key={s.id} value={`saved:${s.id}`}>
                      {s.name} ({s.startingStack} / {s.levelMinutes} min)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {can(me, 'nastaveni.globalni') && text.trim() && !preview.error && (
            <Button onClick={() => setSaveAs(true)}>{t('structures.saveAs')}</Button>
          )}
          {saveAs && (
            <StructureDialog
              base={null}
              initial={{ levels: formatStructure(preview.levels), startingStack: Number(values['tournament.startingStack']), levelMinutes: Number(values['tournament.levelMinutes']) }}
              onClose={() => setSaveAs(false)}
              onSaved={() => {
                setSaveAs(false);
                get<{ structures: BlindStructure[] }>('/api/structures')
                  .then((d) => setSaved(d.structures))
                  .catch(() => undefined);
              }}
            />
          )}
          <label className="flex items-center gap-1 text-sm">
            {t('structure.players')}
            <NumInput className="w-20" min={2} max={seats} value={players} onChange={setPlayers} />
          </label>
        </div>
        <textarea className="min-h-20 w-full rounded-sm border border-line bg-surface px-2 py-1 font-mono text-text" aria-label={t('tournament.structure')} value={text} placeholder={t('tournament.structurePlaceholder')} onChange={(e) => set('tournament.structure', e.target.value)} />
        {preview.error && <span className="text-danger">{preview.error}</span>}
        {mode === 'auto' && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-raised p-2">
            <span className="text-sm text-muted">{t('tournament.structureAutoHint')}</span>
            <NumField k="tournament.targetMinutes" values={values} set={set} min={10} label={t('structure.targetMinutes')} />
            <Button onClick={generate}>{t('tournament.generate')}</Button>
          </div>
        )}
        {!preview.error && (
          <p>
            <EstimateLine values={values} players={n} />
          </p>
        )}
        <div>
          <Button onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview}>
            {showPreview ? t('structure.hidePreview') : t('structure.showPreview', { n: preview.levels.length })}
          </Button>
        </div>
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
 * Kam jdou peníze a rozpis výplat (jako „Players / Money & Prizes“): pro zadaný počet hráčů se ukáže,
 * kolik každý zaplatí, kolik jde do poolu, herně a do fondu, celkový prize pool a výhra po místech.
 */
export function MoneyPreview({ values }: { values: SettingValues; set?: Set }) {
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
  return (
    <Card title={t('money.title')}>
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-1 text-sm">
          {t('structure.players')}
          <NumInput className="w-20" min={2} max={seats} value={players} onChange={setPlayers} />
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
            <DataTable sortable={false} head={[t('tournament.placeShort'), t('money.amount'), '%']}>
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

/** Rebuy, add-on a re-entry podrobně: žetony, do kterého levelu, kolikrát. */
export function RebuyCard({ values, set }: { values: SettingValues; set: Set }) {
  return (
    <Card title={t('rebuy.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Toggle k="tournament.rebuyEnabled" values={values} set={set} />
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
          <Toggle k="tournament.addonEnabled" values={values} set={set} />
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
          <Toggle k="tournament.reentryEnabled" values={values} set={set} />
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
