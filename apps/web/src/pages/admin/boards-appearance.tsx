import { BOARD_BACKGROUNDS, BOARD_DENSITIES, BOARD_HEADERS, BOARD_MODES, BOARD_TONES, BOARD_WIDTHS, boardName, currencyFormsOf, effectiveColumns, t, type BoardAppearance, type BoardColumn, type PublicBoardConfig } from '@kb/shared';
import { useBrand } from '../../brand';
import { useSettings } from '../../settings';
import { NumInput, Select, TextInput } from '../../ui';
import { BoardView, type BoardRow, type BoardViewData } from '../public-board';

const SAMPLE: { nick: string; profit: number; cash: number; tour: number; xp: number; level: number; rating: number; games: number; wins: number; itm: number; place: number; bounty: number; hands: number; balance: number }[] = [
  { nick: 'Karel', profit: 1850, cash: 600, tour: 1250, xp: 5400, level: 12, rating: 1620, games: 18, wins: 6, itm: 11, place: 2.4, bounty: 320, hands: 940, balance: 12400 },
  { nick: 'Lenka', profit: 920, cash: 150, tour: 770, xp: 4100, level: 10, rating: 1555, games: 15, wins: 4, itm: 9, place: 3.1, bounty: 140, hands: 610, balance: 10900 },
  { nick: 'Milan', profit: 310, cash: -90, tour: 400, xp: 2900, level: 8, rating: 1510, games: 12, wins: 2, itm: 6, place: 3.9, bounty: 60, hands: 480, balance: 10100 },
  { nick: 'Jana', profit: -120, cash: 40, tour: -160, xp: 1800, level: 6, rating: 1475, games: 9, wins: 1, itm: 3, place: 4.6, bounty: 0, hands: 310, balance: 9700 },
  { nick: 'Petr', profit: -540, cash: -300, tour: -240, xp: 1200, level: 5, rating: 1440, games: 8, wins: 0, itm: 2, place: 5.2, bounty: 20, hands: 270, balance: 8800 },
  { nick: 'Eva', profit: -980, cash: -700, tour: -280, xp: 700, level: 3, rating: 1400, games: 6, wins: 0, itm: 1, place: 5.8, bounty: 0, hands: 190, balance: 8200 },
];

/** Ukázková data pro náhled vzhledu přehledu podle aktuálně zvolených sloupců a soukromí (nic ze skutečných dat). */
export function sampleBoardView(c: PublicBoardConfig, forms: ReturnType<typeof currencyFormsOf>): BoardViewData {
  const columns: BoardColumn[] = effectiveColumns(c, { xp: true, rating: true });
  const rows: BoardRow[] = SAMPLE.map((s, i) => {
    const row: BoardRow = { rank: i + 1, nickname: boardName(s.nick, c.nameMode), rankName: 'Hráč', rankIcon: '', division: 'Stříbro' };
    const values: Record<string, number> = { profit: s.profit, cashProfit: s.cash, tournamentProfit: s.tour, xp: s.xp, level: s.level, rating: s.rating, games: s.games, wins: s.wins, itm: s.itm, avgPlace: s.place, bounty: s.bounty, cashHands: s.hands, balance: s.balance };
    for (const col of columns) row[col] = values[col];
    return row;
  });
  const now = Date.now();
  const chart = c.showChart && c.showMoney ? rows.slice(0, c.chartPlayers).map((r, i) => ({ id: String(i), name: r.nickname, points: [0, 1, 2, 3, 4, 5].map((k): [number, number] => [now - (5 - k) * 7 * 86_400_000, Math.round(((SAMPLE[i]?.profit ?? 0) * k) / 5 + ((k * 37 + i * 91) % 120) - 60)]) })) : [];
  return { title: c.title || t('boards.app.sampleTitle'), subtitle: c.subtitle, columns, rows: rows.slice(0, c.limit > 0 ? Math.min(c.limit, rows.length) : rows.length), currencyForms: forms, updatedAt: now, refreshSeconds: c.refreshSeconds, chart, appearance: c.appearance };
}

/** Vzhled veřejného přehledu: ovládací prvky a živý náhled s ukázkovými daty. */
export function BoardAppearanceEditor({ config, onChange }: { config: PublicBoardConfig; onChange: (a: BoardAppearance) => void }) {
  const settings = useSettings();
  const brand = useBrand();
  const a = config.appearance;
  const set = <K extends keyof BoardAppearance>(k: K, v: BoardAppearance[K]) => onChange({ ...a, [k]: v });
  const select = <K extends 'background' | 'tone' | 'colorMode' | 'width' | 'density' | 'header'>(k: K, list: readonly string[]) => (
    <Select label={t(`boards.app.${k}`)} value={a[k]} onChange={(e) => set(k, e.target.value as BoardAppearance[K])}>
      {list.map((m) => (
        <option key={m} value={m}>
          {t(`boards.app.${k}.${m}`)}
        </option>
      ))}
    </Select>
  );
  const check = (k: 'logo' | 'zebra' | 'medals' | 'showUpdated') => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={a[k]} onChange={(e) => set(k, e.target.checked)} />
      {t(`boards.app.${k}`)}
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line pt-3">
      <legend className="font-bold">{t('boards.app.title')}</legend>
      <p className="text-sm text-muted">{t('boards.app.help')}</p>
      <div aria-label={t('boards.app.preview')}>
        <BoardView preview view={sampleBoardView(config, currencyFormsOf(settings.values))} bgImage={brand?.loginBg ?? null} />
      </div>
      <p className="text-xs text-muted">{t('boards.app.previewNote')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {select('background', BOARD_BACKGROUNDS)}
        {a.background !== 'plain' && a.background !== 'image' && select('tone', BOARD_TONES)}
        {select('colorMode', BOARD_MODES)}
        {select('width', BOARD_WIDTHS)}
        {select('density', BOARD_DENSITIES)}
        {select('header', BOARD_HEADERS)}
        <label className="flex flex-col gap-1 text-sm">
          {t('boards.app.highlightTop')}
          <NumInput value={a.highlightTop} min={0} max={10} onChange={(n) => set('highlightTop', Math.min(10, Math.max(0, n)))} />
        </label>
        {a.logo && (
          <label className="flex flex-col gap-1 text-sm">
            {t('boards.app.logoSize')}
            <NumInput value={a.logoSizePercent} min={40} max={400} onChange={(n) => set('logoSizePercent', Math.min(400, Math.max(40, n)))} />
          </label>
        )}
        {a.background === 'image' && (
          <label className="flex flex-col gap-1 text-sm">
            {t('boards.app.overlay')}
            <NumInput value={a.bgOverlayPercent} min={0} max={90} onChange={(n) => set('bgOverlayPercent', Math.min(90, Math.max(0, n)))} />
          </label>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {check('logo')}
        {check('medals')}
        {check('zebra')}
        {check('showUpdated')}
      </div>
      <TextInput label={t('boards.app.footerText')} value={a.footerText} maxLength={200} onChange={(e) => set('footerText', e.target.value)} />
    </fieldset>
  );
}
