import { useCallback, useEffect, useState } from 'react';
import { COSMETIC_COLORS, COSMETIC_KINDS, COSMETIC_STYLES, t, type CosmeticKind } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { avatarClasses, BG, TEXT, type PublicLook } from '../cosmetics-client';
import { onSocket } from '../net';
import { Badge, Button, Card, Modal, Notice, Select, Spinner, Tabs, TextInput } from '../ui';

interface Item {
  key: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  look: { color?: string; style?: string; icon?: string; extra?: number };
  acquire: { level?: number; rank?: string; achievement?: string; season?: { place: number; seasonId?: string } };
  price: number | null;
  basePrice: number | null;
  buyable: boolean;
  availableUntil: number | null;
  enabled: boolean;
  builtin: boolean;
  owned: boolean;
  equipped: boolean;
  source: string | null;
}
interface Catalog {
  items: Item[];
  canManage: boolean;
  maxTrophies: number;
  extraSlots: number;
}

/** Náhled předmětu podle druhu. */
function Preview({ item }: { item: Item }) {
  const c = item.look.color ?? 'primary';
  const s = item.look.style ?? 'solid';
  if (item.kind === 'frame' || item.kind === 'effect') {
    const look: PublicLook = {
      userId: '',
      frame: item.kind === 'frame' ? { color: c, style: s } : null,
      effect: item.kind === 'effect' ? { color: c, style: s } : null,
      nameColor: null,
      title: null,
      trophies: [],
    };
    const a = avatarClasses(look, 'border-2 border-line');
    return (
      <span className={`relative inline-flex h-12 w-12 items-center justify-center rounded-md bg-surface ${a.cls}`} aria-label={t('cosmetic.preview')}>
        {a.sparkle && <span aria-hidden>✨</span>}
      </span>
    );
  }
  if (item.kind === 'cardBack') {
    return (
      <span
        aria-label={t('cosmetic.preview')}
        data-my-back-color={c}
        data-my-back-style={s}
        className="inline-block"
      >
        <span className="tk-card tk-card-back inline-block border border-line [--card-scale:0.6]" />
      </span>
    );
  }
  if (item.kind === 'felt') return <span className={`inline-block h-10 w-16 rounded-md border border-line ${BG[c] ?? ''}`} aria-label={t('cosmetic.preview')} />;
  if (item.kind === 'nameColor' || item.kind === 'title') return <strong className={TEXT[c] ?? ''}>{item.name}</strong>;
  if (item.kind === 'trophy') return <span className="text-3xl">{item.look.icon}</span>;
  return <span className="font-mono text-xl">+{item.look.extra}</span>;
}

function how(item: Item): string[] {
  const a = item.acquire;
  const out: string[] = [];
  if (a.level) out.push(t('cosmetic.how.level', { n: a.level }));
  if (a.rank) out.push(t('cosmetic.how.rank', { name: a.rank }));
  if (a.achievement) out.push(t('cosmetic.how.achievement', { name: a.achievement }));
  if (a.season) out.push(t('cosmetic.how.season', { n: a.season.place }));
  if (item.basePrice !== null) out.push(t('cosmetic.how.shop'));
  if (out.length === 0) out.push(t('cosmetic.how.grant'));
  return out;
}

function ItemCard({ item, children }: { item: Item; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-16 shrink-0 items-center justify-center">
          <Preview item={item} />
        </div>
        <div className="min-w-0 flex-1">
          <strong className="block truncate">{item.name}</strong>
          <span className="text-xs text-muted">{t(`cosmetic.kind.${item.kind}`)}</span>
        </div>
      </div>
      {item.description && <p className="text-sm text-muted">{item.description}</p>}
      <p className="text-xs text-muted">{how(item).join(' · ')}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function ShopPage() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<'shop' | 'mine' | 'manage'>('shop');
  const load = useCallback(() => {
    get<Catalog>('/api/cosmetics')
      .then((d) => {
        setCat(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    return onSocket('wallet', () => undefined);
  }, [load]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      setError('');
      setMsg(ok ?? '');
      load();
    } catch (e) {
      setMsg('');
      setError(errorText(e));
    }
  };
  if (!cat) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const tabs = [
    { id: 'shop' as const, label: t('cosmetic.shop') },
    { id: 'mine' as const, label: t('cosmetic.mine') },
    ...(cat.canManage ? [{ id: 'manage' as const, label: t('cosmetic.manage') }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('cosmetic.title')}</h1>
      <p className="text-sm text-muted">{t('cosmetic.intro')}</p>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {error && <Notice kind="error">{error}</Notice>}
      {msg && <Notice kind="success">{msg}</Notice>}
      {tab === 'shop' && <ShopTab cat={cat} run={run} />}
      {tab === 'mine' && <MineTab cat={cat} run={run} />}
      {tab === 'manage' && cat.canManage && <ManageTab cat={cat} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function ShopTab({ cat, run }: { cat: Catalog; run: Run }) {
  const items = cat.items.filter((i) => i.buyable && !i.owned);
  const kinds = COSMETIC_KINDS.filter((k) => items.some((i) => i.kind === k));
  if (items.length === 0) return <Notice>{t('cosmetic.empty')}</Notice>;
  return (
    <div className="flex flex-col gap-4">
      {kinds.map((k) => (
        <section key={k} className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-bold">{t(`cosmetic.kind.${k}`)}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items
              .filter((i) => i.kind === k)
              .map((i) => (
                <ItemCard key={i.key} item={i}>
                  <span className="font-mono">{t('cosmetic.price', { n: i.price ?? 0 })}</span>
                  {i.price !== i.basePrice && <Badge tone="success">{t('cosmetic.discount', { n: Math.round((1 - (i.price ?? 0) / (i.basePrice || 1)) * 100) })}</Badge>}
                  {i.availableUntil && <Badge tone="warning">{t('cosmetic.until', { time: new Date(i.availableUntil).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }) })}</Badge>}
                  <Button
                    variant="primary"
                    className="ml-auto"
                    onClick={() => {
                      if (confirm(t('cosmetic.confirmBuy', { name: i.name, price: i.price ?? 0 }))) void run(() => post(`/api/cosmetics/${i.key}/buy`), t('cosmetic.bought'));
                    }}
                  >
                    {t('cosmetic.buy')}
                  </Button>
                </ItemCard>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MineTab({ cat, run }: { cat: Catalog; run: Run }) {
  const mine = cat.items.filter((i) => i.owned);
  if (mine.length === 0) return <Notice>{t('cosmetic.empty')}</Notice>;
  return (
    <div className="flex flex-col gap-4">
      {cat.extraSlots > 0 && <p className="text-sm">{t('cosmetic.extraSlots', { n: cat.extraSlots })}</p>}
      <p className="text-sm text-muted">{t('cosmetic.trophyLimit', { n: cat.maxTrophies })}</p>
      {COSMETIC_KINDS.filter((k) => mine.some((i) => i.kind === k)).map((k) => (
        <section key={k} className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-bold">{k === 'trophy' ? t('cosmetic.vitrine') : t(`cosmetic.kind.${k}`)}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mine
              .filter((i) => i.kind === k)
              .map((i) => (
                <ItemCard key={i.key} item={i}>
                  {i.source && <Badge>{t(`cosmetic.source.${i.source}`)}</Badge>}
                  {!i.enabled && <Badge tone="warning">{t('cosmetic.hidden')}</Badge>}
                  {i.kind === 'soundSlots' ? (
                    <Badge tone="success">{t('cosmetic.owned')}</Badge>
                  ) : (
                    <Button variant={i.equipped ? 'secondary' : 'primary'} className="ml-auto" onClick={() => void run(() => post(`/api/cosmetics/${i.key}/equip`, { on: !i.equipped }))}>
                      {i.equipped ? t('cosmetic.unequip') : t('cosmetic.equip')}
                    </Button>
                  )}
                </ItemCard>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------- správa katalogu ----------

interface Form {
  key: string | null;
  kind: CosmeticKind;
  name: string;
  description: string;
  color: string;
  style: string;
  icon: string;
  extra: string;
  price: string;
  level: string;
  rank: string;
  achievement: string;
  seasonPlace: string;
  from: string;
  until: string;
  enabled: boolean;
}

const dt = (ms: number | null) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const toMs = (v: string) => (v ? new Date(v).getTime() : null);

function toForm(i: Item | null): Form {
  return {
    key: i?.key ?? null,
    kind: i?.kind ?? 'frame',
    name: i?.name ?? '',
    description: i?.description ?? '',
    color: i?.look.color ?? 'primary',
    style: i?.look.style ?? COSMETIC_STYLES[i?.kind ?? 'frame']?.[0] ?? '',
    icon: i?.look.icon ?? '',
    extra: String(i?.look.extra ?? 5),
    price: i?.basePrice != null ? String(i.basePrice) : '',
    level: i?.acquire.level ? String(i.acquire.level) : '',
    rank: i?.acquire.rank ?? '',
    achievement: i?.acquire.achievement ?? '',
    seasonPlace: i?.acquire.season ? String(i.acquire.season.place) : '',
    from: '',
    until: dt(i?.availableUntil ?? null),
    enabled: i?.enabled ?? true,
  };
}

function ManageTab({ cat, run }: { cat: Catalog; run: Run }) {
  const [form, setForm] = useState<Form | null>(null);
  const [grant, setGrant] = useState<Item | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="primary" onClick={() => setForm(toForm(null))}>
          {t('cosmetic.edit.new')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cat.items.map((i) => (
          <ItemCard key={i.key} item={i}>
            {!i.enabled && <Badge tone="warning">{t('cosmetic.hidden')}</Badge>}
            {i.basePrice !== null && <span className="font-mono text-sm">{t('cosmetic.price', { n: i.basePrice })}</span>}
            <Button className="ml-auto" onClick={() => setForm(toForm(i))}>
              {t('cosmetic.edit.save')}
            </Button>
            <Button onClick={() => setGrant(i)}>{t('cosmetic.edit.grant')}</Button>
          </ItemCard>
        ))}
      </div>
      {form && <EditDialog form={form} onClose={() => setForm(null)} run={run} />}
      {grant && <GrantDialog item={grant} onClose={() => setGrant(null)} run={run} />}
    </div>
  );
}

function EditDialog({ form: initial, onClose, run }: { form: Form; onClose: () => void; run: Run }) {
  const [f, setF] = useState(initial);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const styles = COSMETIC_STYLES[f.kind];
  const body = () => ({
    kind: f.kind,
    name: f.name,
    description: f.description,
    look: f.kind === 'soundSlots' ? { extra: Number(f.extra) } : f.kind === 'trophy' ? { icon: f.icon } : { color: f.color, ...(styles ? { style: f.style } : {}) },
    acquire: {
      ...(f.level ? { level: Number(f.level) } : {}),
      ...(f.rank ? { rank: f.rank } : {}),
      ...(f.achievement ? { achievement: f.achievement } : {}),
      ...(f.seasonPlace ? { season: { place: Number(f.seasonPlace) } } : {}),
    },
    price: f.price === '' ? null : Number(f.price),
    availableFrom: toMs(f.from),
    availableUntil: toMs(f.until),
    enabled: f.enabled,
  });
  return (
    <Modal title={f.key ? f.name || t('cosmetic.edit.new') : t('cosmetic.edit.new')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Select label={t('cosmetic.edit.kind')} value={f.kind} disabled={!!f.key} onChange={(e) => setF({ ...f, kind: e.target.value as CosmeticKind, style: COSMETIC_STYLES[e.target.value as CosmeticKind]?.[0] ?? '' })}>
          {COSMETIC_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`cosmetic.kind.${k}`)}
            </option>
          ))}
        </Select>
        <TextInput label={t('cosmetic.edit.name')} value={f.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
        <TextInput label={t('cosmetic.edit.description')} value={f.description} maxLength={200} onChange={(e) => set('description', e.target.value)} />
        {f.kind !== 'soundSlots' && f.kind !== 'trophy' && (
          <Select label={t('cosmetic.edit.color')} value={f.color} onChange={(e) => set('color', e.target.value)}>
            {COSMETIC_COLORS.map((c) => (
              <option key={c} value={c}>
                {t(`cosmetic.color.${c}`)}
              </option>
            ))}
          </Select>
        )}
        {styles && (
          <Select label={t('cosmetic.edit.style')} value={f.style} onChange={(e) => set('style', e.target.value)}>
            {styles.map((s) => (
              <option key={s} value={s}>
                {t(`cosmetic.style.${s}`)}
              </option>
            ))}
          </Select>
        )}
        {f.kind === 'trophy' && <TextInput label={t('cosmetic.edit.icon')} value={f.icon} maxLength={8} onChange={(e) => set('icon', e.target.value)} />}
        {f.kind === 'soundSlots' && <TextInput label={t('cosmetic.edit.extra')} type="number" min={1} value={f.extra} onChange={(e) => set('extra', e.target.value)} />}
        <TextInput label={t('cosmetic.edit.price')} type="number" min={0} value={f.price} onChange={(e) => set('price', e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label={t('cosmetic.edit.level')} type="number" min={1} value={f.level} onChange={(e) => set('level', e.target.value)} />
          <TextInput label={t('cosmetic.edit.rank')} value={f.rank} maxLength={30} onChange={(e) => set('rank', e.target.value)} />
          <TextInput label={t('cosmetic.edit.achievement')} value={f.achievement} maxLength={60} onChange={(e) => set('achievement', e.target.value)} />
          <TextInput label={t('cosmetic.edit.seasonPlace')} type="number" min={1} value={f.seasonPlace} onChange={(e) => set('seasonPlace', e.target.value)} />
          <TextInput label={t('cosmetic.edit.from')} type="datetime-local" value={f.from} onChange={(e) => set('from', e.target.value)} />
          <TextInput label={t('cosmetic.edit.until')} type="datetime-local" value={f.until} onChange={(e) => set('until', e.target.value)} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> {t('cosmetic.edit.enabled')}
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              await run(() => (f.key ? patch(`/api/cosmetics/${f.key}`, body()) : post('/api/cosmetics', body())), t('cosmetic.edit.saved'));
              onClose();
            }}
          >
            {t('cosmetic.edit.save')}
          </Button>
          {f.key && (
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(t('cosmetic.edit.confirmRemove'))) return;
                await run(() => del(`/api/cosmetics/${f.key}`));
                onClose();
              }}
            >
              {t('cosmetic.edit.remove')}
            </Button>
          )}
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function GrantDialog({ item, onClose, run }: { item: Item; onClose: () => void; run: Run }) {
  const [users, setUsers] = useState<{ id: string; nickname: string }[]>([]);
  const [who, setWho] = useState('');
  useEffect(() => {
    void get<{ id: string; nickname: string }[]>('/api/directory').then(setUsers).catch(() => setUsers([]));
  }, []);
  return (
    <Modal title={`${t('cosmetic.edit.grant')}: ${item.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Select label={t('cosmetic.edit.grantPlayer')} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="" />
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nickname}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!who}
            onClick={async () => {
              await run(() => post(`/api/cosmetics/${item.key}/grant`, { userId: who }), t('cosmetic.edit.saved'));
              onClose();
            }}
          >
            {t('cosmetic.edit.grant')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}
