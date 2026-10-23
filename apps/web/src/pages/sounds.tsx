import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { onSocket } from '../net';
import { can, useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { handleSoundEvent, loadSounds, playMentionTone, playSound, previewSound, removeSound, setMute, toggleFavorite, unlockAudio, useSoundState, type SoundItem, type SoundPlayEvent } from '../sound-client';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Td, TextInput } from '../ui';

/** Přijímá zvukové emotikony ze serveru a přehrává je podle osobního nastavení; nabídne odemčení zvuku. */
export function SoundHost() {
  const settings = useSettings();
  const st = useSoundState();
  const prefs = useRef({ play: true, volume: 80, mode: 'both' as 'both' | 'table' | 'chat', mention: true, jingles: true });
  prefs.current = {
    jingles: settings.values['sounds.jingles'] !== false,
    mention: settings.values['sounds.mentionSound'] !== false,
    play: settings.values['sounds.play'] !== false,
    volume: Number(settings.values['sounds.volume'] ?? 80),
    mode: (settings.values['sounds.mode'] as 'both' | 'table' | 'chat') ?? 'both',
  };
  useEffect(() => {
    void loadSounds().catch(() => undefined);
    const offSound = onSocket<SoundPlayEvent>('sound', (e) => handleSoundEvent(e, prefs.current));
    const offMention = onSocket('chat:mention', () => {
      if (prefs.current.mention && prefs.current.play) playMentionTone(prefs.current.volume);
    });
    return () => {
      offSound();
      offMention();
    };
  }, []);
  if (!st.locked) return null;
  return (
    <button className="fixed bottom-3 left-3 z-30 rounded-md border border-line bg-surface px-3 py-1 shadow-lg" onClick={unlockAudio}>
      🔇 {t('sounds.locked')}
    </button>
  );
}

// ---------- paleta ----------

const byRecent = (a: SoundItem, b: SoundItem) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);

/** Tlačítko se zvukovou paletou (oblíbené a naposledy použité nahoře, pak vše podle kategorií). */
export function SoundPalette({ target }: { target: { kind: 'table' | 'channel'; id: string } }) {
  const st = useSoundState();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  // Nabídka je ve vlastní vrstvě nad stránkou (nesmí ji oříznout panel ani chat) a vejde se do okna: nahoru nebo dolů podle volného místa, jinak se posouvá.
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const toggle = () => {
    if (open) return setOpen(false);
    const r = box.current?.getBoundingClientRect();
    if (r) {
      const margin = 8;
      const above = r.top - margin;
      const below = window.innerHeight - r.bottom - margin;
      const up = above >= below;
      const width = Math.min(320, window.innerWidth - 2 * margin);
      const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
      setPlace(up ? { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(160, above - 4) } : { left, top: r.bottom + 4, maxHeight: Math.max(160, below - 4) });
    }
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const n = e.target as Node;
      if (box.current && !box.current.contains(n) && !(popup.current && popup.current.contains(n))) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const usable = st.sounds.filter((s) => s.status === 'shared' || s.mine);
  const query = q.trim().toLowerCase();
  const match = (s: SoundItem) => !query || s.name.toLowerCase().includes(query) || s.shortcut.includes(query);
  const favorites = usable.filter((s) => s.favorite && match(s));
  const recent = usable.filter((s) => s.lastUsedAt && match(s)).sort(byRecent).slice(0, 6);
  const categories = [...new Set(usable.filter(match).map((s) => s.category))].sort();
  const send = async (s: SoundItem) => {
    setMsg('');
    try {
      const r = await playSound(s.id, target);
      if (r.silent) setMsg(t('sounds.silent'));
      else setOpen(false);
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  const hotkeys = settings.values['sounds.hotkeys'] !== false;
  const hotkeyList = usable.filter((s) => s.favorite).slice(0, 9);
  const hotkeyRef = useRef({ list: hotkeyList, send });
  hotkeyRef.current = { list: hotkeyList, send };
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
      const s = hotkeyRef.current.list[Number(e.key) - 1];
      if (!s) return;
      e.preventDefault();
      void hotkeyRef.current.send(s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys]);
  // Předčasný návrat až za všemi hooky (pravidla hooků).
  if (settings.values['sounds.enabled'] === false) return null;
  const chip = (s: SoundItem) => {
    const n = hotkeys ? hotkeyList.findIndex((h) => h.id === s.id) : -1;
    return (
      <button key={s.id} className="rounded-sm border border-line bg-surface px-2 py-1 text-sm" title={`:${s.shortcut}:${n >= 0 ? ` · ${t('sounds.hotkeyHint', { n: n + 1 })}` : ''}`} onClick={() => void send(s)}>
        {s.emoji} {s.name}
        {n >= 0 && <span className="ml-1 text-xs text-muted">{n + 1}</span>}
      </button>
    );
  };
  return (
    <div className="relative" ref={box}>
      <Button aria-expanded={open} aria-label={t('sounds.palette')} onClick={toggle}>
        🔊
      </Button>
      {open && place && createPortal(
        <div ref={popup} role="dialog" aria-label={t('sounds.palette')} style={{ position: 'fixed', left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }} className="z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-md border border-line bg-surface p-2 shadow-lg">
          <input className="rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('sounds.search')} placeholder={t('sounds.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          {msg && <p className="text-sm text-danger">{msg}</p>}
          {usable.length === 0 && <p className="text-sm text-muted">{t('sounds.none')}</p>}
          {favorites.length > 0 && (
            <section>
              <h3 className="text-xs text-muted">{t('sounds.favorites')}</h3>
              <div className="flex flex-wrap gap-1">{favorites.map(chip)}</div>
            </section>
          )}
          {recent.length > 0 && (
            <section>
              <h3 className="text-xs text-muted">{t('sounds.recent')}</h3>
              <div className="flex flex-wrap gap-1">{recent.map(chip)}</div>
            </section>
          )}
          {categories.map((c) => (
            <section key={c}>
              <h3 className="text-xs text-muted">{c}</h3>
              <div className="flex flex-wrap gap-1">{usable.filter((s) => s.category === c && match(s)).map(chip)}</div>
            </section>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------- nahrávání ----------

const MAX_PEAKS = 240;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function peaksOf(buf: AudioBuffer): number[] {
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / MAX_PEAKS));
  const out: number[] = [];
  for (let i = 0; i < ch.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(ch.length, i + step); j++) m = Math.max(m, Math.abs(ch[j]!));
    out.push(m);
  }
  return out;
}

function UploadDialog({ maxSeconds, onClose, onDone }: { maxSeconds: number; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; ext: string; data: ArrayBuffer } | null>(null);
  const [decoded, setDecoded] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [name, setName] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [emoji, setEmoji] = useState('🔊');
  const [category, setCategory] = useState('ostatni');
  const [share, setShare] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const src = useRef<AudioBufferSourceNode | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const total = decoded ? Math.round(decoded.duration * 1000) : 0;
  const maxMs = maxSeconds * 1000;

  const pick = async (f: File | undefined) => {
    setError('');
    if (!f) return;
    const data = await f.arrayBuffer();
    ctx.current ??= new AudioContext();
    try {
      const buf = await ctx.current.decodeAudioData(data.slice(0));
      setFile({ name: f.name, ext: f.name.split('.').pop() ?? '', data });
      setDecoded(buf);
      setPeaks(peaksOf(buf));
      const ms = Math.round(buf.duration * 1000);
      setRange([0, Math.min(ms, maxMs)]);
      if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 40));
      if (!shortcut) setShortcut(f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20));
    } catch {
      setError(t('sounds.cannotDecode'));
    }
  };
  const stop = () => {
    try {
      src.current?.stop();
    } catch {
      /* už dohrál */
    }
    src.current = null;
  };
  const preview = () => {
    if (!decoded || !ctx.current) return;
    stop();
    const s = ctx.current.createBufferSource();
    s.buffer = decoded;
    s.connect(ctx.current.destination);
    s.start(0, range[0] / 1000, (range[1] - range[0]) / 1000);
    src.current = s;
  };
  useEffect(() => () => stop(), []);
  const length = range[1] - range[0];
  const tooLong = length > maxMs;
  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/sounds', { name, shortcut, emoji, category, ext: file.ext, data: toBase64(file.data), startMs: range[0], endMs: range[1], share });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('sounds.upload')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t('sounds.file')}</span>
          <input type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {decoded && (
          <>
            <svg viewBox={`0 0 ${peaks.length} 40`} preserveAspectRatio="none" className="h-16 w-full rounded-sm border border-line text-primary" role="img" aria-label={t('sounds.waveform')}>
              {peaks.map((p, i) => {
                const x0 = (range[0] / total) * peaks.length;
                const x1 = (range[1] / total) * peaks.length;
                const inside = i >= x0 && i <= x1;
                return <rect key={i} x={i} y={20 - p * 20} width={0.7} height={Math.max(0.5, p * 40)} fill="currentColor" opacity={inside ? 1 : 0.25} />;
              })}
            </svg>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                {t('sounds.start')}: {(range[0] / 1000).toFixed(2)} s
                <input type="range" min={0} max={total} step={10} value={range[0]} onChange={(e) => setRange([Math.min(Number(e.target.value), range[1] - 100), range[1]])} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('sounds.end')}: {(range[1] / 1000).toFixed(2)} s
                <input type="range" min={0} max={total} step={10} value={range[1]} onChange={(e) => setRange([range[0], Math.max(Number(e.target.value), range[0] + 100)])} />
              </label>
            </div>
            <p className={`text-sm ${tooLong ? 'text-danger' : 'text-muted'}`}>{tooLong ? t('sounds.tooLongTrim', { max: maxSeconds }) : t('sounds.length', { s: (length / 1000).toFixed(2) })}</p>
            <div className="flex gap-2">
              <Button onClick={preview}>{t('sounds.previewPlay')}</Button>
              <Button onClick={stop}>{t('sounds.previewStop')}</Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextInput label={t('sounds.name')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <TextInput label={t('sounds.shortcut')} hint={t('sounds.shortcutHint')} value={shortcut} maxLength={20} onChange={(e) => setShortcut(e.target.value.toLowerCase())} />
              <TextInput label={t('sounds.emoji')} value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />
              <TextInput label={t('sounds.category')} value={category} maxLength={30} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
              {t('sounds.shareOnUpload')}
            </label>
          </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('table.cancel')}</Button>
          <Button variant="primary" disabled={!decoded || tooLong || busy || !name.trim() || shortcut.length < 2} onClick={() => void save()}>
            {t('sounds.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- knihovna v nastavení ----------

const STATUS_TONE: Record<string, 'muted' | 'warning' | 'success' | 'danger'> = { private: 'muted', pending: 'warning', shared: 'success', hidden: 'danger' };

function RenameDialog({ sound, onClose, onDone }: { sound: SoundItem; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState(sound.emoji);
  const [category, setCategory] = useState(sound.category);
  const [error, setError] = useState('');
  return (
    <Modal title={t('sounds.edit')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('sounds.name')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <TextInput label={t('sounds.emoji')} value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />
        <TextInput label={t('sounds.category')} value={category} maxLength={30} onChange={(e) => setCategory(e.target.value)} />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('table.cancel')}</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await patch(`/api/sounds/${sound.id}`, { name, emoji, category });
                onDone();
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('sounds.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Správa vlastních zvuků, procházení společné knihovny a (pro kurátory) schvalování a skrývání. */
/** Výběr nástupové a vítězné znělky ze zvukových emotikonů. */
function JinglePicker() {
  const st = useSoundState();
  const settings = useSettings();
  const volume = Number(settings.values['sounds.volume'] ?? 80);
  const usable = st.sounds.filter((s) => s.status === 'shared' || s.mine);
  if (settings.values['sounds.jingleEnabled'] === false) return null;
  const one = (key: 'sounds.joinJingle' | 'sounds.winJingle', label: string) => {
    const value = String(settings.values[key] ?? '');
    return (
      <div className="flex flex-wrap items-end gap-2">
        <Select label={label} value={value} onChange={(e) => void saveUserSetting(key, e.target.value).catch(() => undefined)}>
          <option value="">{t('jingles.none')}</option>
          {usable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.emoji} {s.name}
            </option>
          ))}
        </Select>
        <Button disabled={!value} onClick={() => previewSound(value, volume)}>
          {t('jingles.preview')}
        </Button>
      </div>
    );
  };
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line p-3">
      <h3 className="font-bold">{t('jingles.title')}</h3>
      <p className="text-sm text-muted">{t('jingles.help')}</p>
      {one('sounds.joinJingle', t('jingles.join'))}
      {one('sounds.winJingle', t('jingles.win'))}
    </section>
  );
}

export function SoundLibrary() {
  const { me } = useSession();
  const st = useSoundState();
  const settings = useSettings();
  const [error, setError] = useState('');
  const [upload, setUpload] = useState(false);
  const [edit, setEdit] = useState<SoundItem | null>(null);
  const [pending, setPending] = useState<SoundItem[]>([]);
  const [all, setAll] = useState<SoundItem[]>([]);
  const review = can(me, 'emotikon.schvalit');
  const manage = can(me, 'emotikon.spravovat');
  const volume = Number(settings.values['sounds.volume'] ?? 80);
  const loadAdmin = useCallback(() => {
    if (review) get<{ sounds: SoundItem[] }>('/api/sounds/pending').then((d) => setPending(d.sounds)).catch(() => undefined);
    if (manage) get<{ sounds: SoundItem[] }>('/api/sounds/all').then((d) => setAll(d.sounds)).catch(() => undefined);
  }, [review, manage]);
  useEffect(() => {
    void loadSounds().catch((e) => setError(errorText(e)));
    loadAdmin();
  }, [loadAdmin]);
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await loadSounds();
      loadAdmin();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const mine = st.sounds.filter((s) => s.mine && !s.builtin);
  const library = st.sounds.filter((s) => !s.mine);
  const muteOf = (kind: string, target: string) => st.mutes.some((m) => m.kind === kind && m.target === target);
  const maxSeconds = Number(settings.values['sounds.maxSeconds'] ?? 5);
  const usagePct = useMemo(() => (st.usage && st.usage.quotaBytes > 0 ? Math.min(100, Math.round((st.usage.bytes / st.usage.quotaBytes) * 100)) : 0), [st.usage]);
  if (settings.values['sounds.enabled'] === false) return <Notice>{t('sounds.disabled')}</Notice>;
  return (
    <Card
      title={t('sounds.title')}
      actions={
        can(me, 'emotikon.nahrat') ? (
          <Button variant="primary" onClick={() => setUpload(true)}>
            {t('sounds.upload')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <JinglePicker />
        <p className="text-sm text-muted">{t('sounds.intro')}</p>
        {error && <Notice kind="error">{error}</Notice>}

        <section className="flex flex-col gap-2">
          <h3 className="font-bold">{t('sounds.mine')}</h3>
          {mine.length === 0 ? (
            <p className="text-sm text-muted">{t('sounds.mineEmpty')}</p>
          ) : (
            <DataTable head={[t('sounds.name'), t('sounds.shortcut'), t('sounds.status'), '']}>
              {mine.map((s) => (
                <tr key={s.id}>
                  <Td>
                    {s.emoji} {s.name}
                  </Td>
                  <Td className="font-mono">:{s.shortcut}:</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[s.status] ?? 'muted'}>{t(`sounds.state.${s.status}`)}</Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Button onClick={() => previewSound(s.id, volume)}>▶</Button>
                      <Button onClick={() => setEdit(s)}>{t('sounds.edit')}</Button>
                      {s.status === 'private' && <Button onClick={() => run(() => post(`/api/sounds/${s.id}/share`, { on: true }))}>{t('sounds.share')}</Button>}
                      {(s.status === 'shared' || s.status === 'pending') && <Button onClick={() => run(() => post(`/api/sounds/${s.id}/share`, { on: false }))}>{t('sounds.unshare')}</Button>}
                      <Button variant="danger" onClick={() => confirm(t('sounds.deleteConfirm', { name: s.name })) && void run(() => removeSound(s.id))}>
                        {t('sounds.delete')}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-bold">{t('sounds.library')}</h3>
          <DataTable head={[t('sounds.name'), t('sounds.shortcut'), t('sounds.author'), '']}>
            {library.map((s) => (
              <tr key={s.id}>
                <Td>
                  {s.emoji} {s.name}
                </Td>
                <Td className="font-mono">:{s.shortcut}:</Td>
                <Td>{s.builtin ? t('sounds.builtin') : (s.ownerNickname ?? '–')}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button onClick={() => previewSound(s.id, volume)}>▶</Button>
                    <Button aria-pressed={s.favorite} onClick={() => run(() => toggleFavorite(s.id, !s.favorite))}>
                      {s.favorite ? '★' : '☆'}
                    </Button>
                    <Button aria-pressed={muteOf('sound', s.shortcut)} onClick={() => run(() => setMute('sound', s.shortcut, !muteOf('sound', s.shortcut)))}>
                      {muteOf('sound', s.shortcut) ? t('sounds.unmute') : t('sounds.mute')}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </DataTable>
        </section>

        {st.mutes.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('sounds.mutes')}</h3>
            <ul className="flex flex-wrap gap-2">
              {st.mutes.map((m) => (
                <li key={`${m.kind}:${m.target}`}>
                  <Button onClick={() => run(() => setMute(m.kind as 'sound', m.target, false))}>
                    {t(`sounds.muteKind.${m.kind}`)}: {m.target} ✕
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {review && (
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('sounds.pending')}</h3>
            {pending.length === 0 ? (
              <p className="text-sm text-muted">{t('sounds.pendingEmpty')}</p>
            ) : (
              <DataTable head={[t('sounds.name'), t('sounds.author'), '']}>
                {pending.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      {s.emoji} {s.name} <span className="font-mono">:{s.shortcut}:</span>
                    </Td>
                    <Td>{s.ownerNickname}</Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button onClick={() => previewSound(s.id, volume)}>▶</Button>
                        <Button variant="primary" onClick={() => run(() => post(`/api/sounds/${s.id}/review`, { approve: true }))}>
                          {t('sounds.approve')}
                        </Button>
                        <Button variant="danger" onClick={() => run(() => post(`/api/sounds/${s.id}/review`, { approve: false }))}>
                          {t('sounds.reject')}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
        )}

        {manage && (
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('sounds.admin')}</h3>
            {st.usage && (
              <div>
                <progress className="w-full" max={100} value={usagePct} aria-label={t('sounds.quota')} />
                <p className="text-sm text-muted">{t('sounds.usage', { used: mb(st.usage.bytes), quota: mb(st.usage.quotaBytes), count: st.usage.count })}</p>
              </div>
            )}
            <DataTable head={[t('sounds.name'), t('sounds.author'), t('sounds.status'), '']}>
              {all.map((s) => (
                <tr key={s.id}>
                  <Td>
                    {s.emoji} {s.name} <span className="font-mono">:{s.shortcut}:</span>
                  </Td>
                  <Td>{s.builtin ? t('sounds.builtin') : (s.ownerNickname ?? '–')}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[s.status] ?? 'muted'}>{t(`sounds.state.${s.status}`)}</Badge>
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button onClick={() => previewSound(s.id, volume)}>▶</Button>
                      <Button onClick={() => run(() => post(`/api/sounds/${s.id}/hide`, { hidden: s.status !== 'hidden' }))}>{s.status === 'hidden' ? t('sounds.unhide') : t('sounds.hide')}</Button>
                      {!s.builtin && (
                        <Button variant="danger" onClick={() => confirm(t('sounds.deleteConfirm', { name: s.name })) && void run(() => del(`/api/sounds/${s.id}`))}>
                          {t('sounds.delete')}
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </section>
        )}
      </div>
      {upload && <UploadDialog maxSeconds={maxSeconds} onClose={() => setUpload(false)} onDone={() => void run(async () => undefined)} />}
      {edit && <RenameDialog sound={edit} onClose={() => setEdit(null)} onDone={() => void run(async () => undefined)} />}
    </Card>
  );
}

/** Řádek ikon oblíbených zvukových emotikonů (jedno klepnutí zvuk pošle) a tlačítko s celou paletou; pro telefon. */
export function SoundStrip({ target }: { target: { kind: 'table' | 'channel'; id: string } }) {
  const st = useSoundState();
  const settings = useSettings();
  if (settings.values['sounds.enabled'] === false) return null;
  const usable = st.sounds.filter((s) => s.status === 'shared' || s.mine);
  const quick = [...usable.filter((s) => s.favorite), ...usable.filter((s) => !s.favorite && s.lastUsedAt).sort(byRecent)].slice(0, 6);
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('sounds.palette')}>
      {quick.map((s) => (
        <button key={s.id} className="rounded-md border border-line bg-surface px-2 py-1 text-lg" title={s.name} aria-label={s.name} onClick={() => void playSound(s.id, target).catch(() => undefined)}>
          {s.emoji}
        </button>
      ))}
      <SoundPalette target={target} />
    </div>
  );
}
