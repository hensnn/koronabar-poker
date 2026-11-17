import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { BUILTIN_THEMES, resolveTokens } from '@kb/tokens';
import { buildServer } from '../app.js';
import { PictureService } from './picture-service.js';
import { eveningSvg, svgToPng, textWidth, tournamentSvg, type EveningPictureData, type PictureStyle, type TournamentPictureData, type TournamentRow } from './pictures.js';
import { IntegrationError } from './service.js';

const dark = resolveTokens(BUILTIN_THEMES[0]!, 'dark');
const style = (o: Partial<PictureStyle> = {}): PictureStyle => ({ width: 900, maxRows: 12, amounts: true, tokens: dark, timeZone: 'Europe/Prague', ...o });
const AT = Date.UTC(2026, 10, 13, 21, 30);
const widthOf = (svg: string) => Number(/<svg[^>]* width="(\d+)"/.exec(svg)![1]);
const heightOf = (svg: string) => Number(/<svg[^>]* height="(\d+)"/.exec(svg)![1]);

const row = (place: number, over: Partial<TournamentRow> = {}): TournamentRow => ({
  place,
  name: `Hráč${place}`,
  entries: 1,
  entryAmount: 500,
  rebuys: 0,
  rebuyAmount: 0,
  addons: 0,
  addonAmount: 0,
  spent: 500,
  payout: 0,
  bounty: 0,
  profit: -500,
  ...over,
});
const tournament = (players = 6): TournamentPictureData => ({
  name: 'Páteční turnaj',
  summary: Array.from({ length: players }, (_, i) =>
    i === 0 ? row(1, { rebuys: 1, rebuyAmount: 500, spent: 1000, payout: 2500, bounty: 300, profit: 1800 }) : i === 1 ? row(2, { payout: 1500, profit: 1000 }) : row(i + 1),
  ),
});

const evening: EveningPictureData = {
  name: 'Páteční večer',
  from: AT - 4 * 3600_000,
  to: AT,
  players: [
    { nickname: 'Petr', net: -310, cash: 0, tournament: -310, side: 0, knockouts: 1, parts: { buyIn: -500, payout: 190 } },
    { nickname: 'Karel', net: 1850, cash: 1850, tournament: 0, side: 0, knockouts: 3, parts: { cashBuyIn: -1000, cashOut: 2850 } },
    { nickname: 'Jana', net: 0, cash: 0, tournament: 0, side: 0, knockouts: 0, parts: {} },
  ],
};

describe('summary pictures: the tournament window as a picture', () => {
  it('same title, columns and figures as the "tournament finished" window, in the colours of the theme', () => {
    const svg = tournamentSvg(tournament(), style());
    expect(svg).toContain(`fill="${dark['color.bg']}"`);
    expect(svg).toContain('Turnaj Páteční turnaj skončil');
    for (const head of ['Místo', 'Hráč', 'Buy-in', 'Rebuy', 'Add-on', 'Zaplaceno', 'Výhra (umístění)', 'Bounty', 'Profit']) expect(svg).toContain(`>${head}<`);
    expect(svg).not.toContain('Odměny na hlavu</text>'); // columns of head bounties and bets only when somebody has them
    expect(svg).toContain('>1× 500<'); // buy-in: count and amount
    expect(svg).toContain('>-1 000<'); // paid in total (buy-in + rebuy)
    expect(svg).toContain('>2 500<');
    expect(svg).toContain('>300<'); // bounty
    expect(svg).toMatch(new RegExp(`fill="${dark['color.success']}"[^>]*>\\+1 800<`));
    expect(svg).toMatch(new RegExp(`fill="${dark['color.danger']}"[^>]*>-500<`));
    expect(svg).toContain('včetně poplatků'); // the note under the table
  });

  it('head bounties and side bets get their columns when somebody has them, with the colours of the app', () => {
    const d = tournament(3);
    d.summary[0] = { ...d.summary[0]!, headEarned: 100, headLost: 40, betNet: 250 };
    const svg = tournamentSvg(d, style());
    expect(svg).toContain('>Odměny na hlavu<');
    expect(svg).toContain('>Sázky bokem<');
    expect(svg).toContain('>+100 -40<');
    expect(svg).toMatch(new RegExp(`fill="${dark['color.success']}"[^>]*>\\+250<`));
  });

  it('the picture is as wide as the table needs, never narrower than the width setting', () => {
    const wide = widthOf(tournamentSvg(tournament(), style({ width: 600 })));
    expect(wide).toBeGreaterThan(600); // the table needs more
    expect(widthOf(tournamentSvg(tournament(), style({ width: 1600 })))).toBeGreaterThanOrEqual(1600);
    const long = tournament(2);
    long.summary[0]!.name = 'Velmi dlouhé jméno hráče, které se nevejde';
    expect(widthOf(tournamentSvg(long, style()))).toBeGreaterThanOrEqual(900);
  });

  it('player names cannot break the picture or smuggle markup into it', () => {
    const d = tournament(2);
    d.summary[0]!.name = '<b>Karel</b> & "spol"';
    d.name = "O'Brien <script>";
    const svg = tournamentSvg(d, style());
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;b&gt;Karel&lt;/b&gt; &amp; &quot;spol&quot;');
    expect(svg).toContain('O&apos;Brien &lt;script&gt;');
  });

  it('without amounts the picture shows places and counts only: no money columns, no profit', () => {
    const svg = tournamentSvg(tournament(), style({ amounts: false }));
    for (const head of ['Zaplaceno', 'Výhra (umístění)', 'Bounty', 'Profit']) expect(svg).not.toContain(`>${head}<`);
    expect(svg).not.toContain('2 500');
    expect(svg).toContain('>1×<');
    expect(svg).toContain('>Hráč1<');
    const ev = eveningSvg(evening, style({ amounts: false }));
    expect(ev).not.toContain('>Profit<');
    expect(ev).not.toContain('>Cash vklady<');
    expect(ev).toContain('>Vyřazení<');
  });

  it('a long field is cut to the row limit and the rest is counted in one line', () => {
    const svg = tournamentSvg(tournament(20), style({ maxRows: 5 }));
    expect(svg).toContain('>Hráč5<');
    expect(svg).not.toContain('>Hráč6<');
    expect(svg).toContain('… a dalších hráčů: 15');
    expect(tournamentSvg(tournament(5), style({ maxRows: 5 }))).not.toContain('a dalších hráčů');
  });

  it('light mode uses the light colours', () => {
    const light = resolveTokens(BUILTIN_THEMES[0]!, 'light');
    expect(tournamentSvg(tournament(), style({ tokens: light }))).toContain(`fill="${light['color.bg']}"`);
  });
});

describe('summary pictures: the evening page as a picture', () => {
  it('heading with the status and the time span, then the ranking sorted by result with the columns the evening used', () => {
    const svg = eveningSvg(evening, style());
    expect(svg).toContain('>Páteční večer<');
    expect(svg).toContain('>Uzavřený<');
    expect(svg).toContain('od ');
    expect(svg).toContain('Pořadí a výsledek v penězích');
    for (const head of ['#', 'Hráč', 'Cash vklady', 'Cash výběry', 'Buy-in', 'Výhra', 'Vyřazení', 'Profit']) expect(svg).toContain(`>${head}<`);
    expect(svg).not.toContain('>Rebuy<'); // columns nobody used are left out, like in the app
    expect(svg).not.toContain('>Bounty<');
    // sorted by result: Karel, Jana, Petr
    expect(svg.indexOf('>Karel<')).toBeLessThan(svg.indexOf('>Jana<'));
    expect(svg.indexOf('>Jana<')).toBeLessThan(svg.indexOf('>Petr<'));
    expect(svg).toMatch(new RegExp(`fill="${dark['color.success']}"[^>]*>\\+1850<`));
    expect(svg).toMatch(new RegExp(`fill="${dark['color.danger']}"[^>]*>-310<`));
    expect(svg).toContain('>0<');
  });

  it('only the first table of the evening page: no awards, hands, statistics or list of games', () => {
    const svg = eveningSvg(evening, style());
    for (const gone of ['Ocenění', 'MVP', 'Lovec', 'Bankér', 'Smolař', 'Společné karty', 'Handa večera', 'Statistiky večera', 'Obrat', 'Hry večera']) expect(svg).not.toContain(gone);
    expect(svg).not.toContain(dark['color.cardFace']); // no cards are drawn
  });

  it('a player who still sat at a cash table carries the badge and the notice; the light mode uses the light colours', () => {
    const light = resolveTokens(BUILTIN_THEMES[0]!, 'light');
    const bare: EveningPictureData = { ...evening, players: [{ ...evening.players[1]!, seated: 700 }] };
    const svg = eveningSvg(bare, style({ tokens: light }));
    expect(svg).toContain(`fill="${light['color.bg']}"`);
    expect(svg).toContain('>u stolu<');
    expect(svg).toContain('Karel (žetony v hodnotě 700)');
  });

  it('an evening without players says so; names are escaped', () => {
    const empty = eveningSvg({ ...evening, players: [], name: '<i>Večer</i>' }, style());
    expect(empty).toContain('Zatím se nikdo nepřihlásil.');
    expect(empty).not.toContain('<i>');
    expect(empty).toContain('&lt;i&gt;Večer&lt;/i&gt;');
  });

  it('a long ranking is cut to the row limit', () => {
    const many: EveningPictureData = { ...evening, players: Array.from({ length: 20 }, (_, i) => ({ nickname: `H${i}`, net: 100 - i, cash: 0, tournament: 0, side: 0, knockouts: 0, parts: { buyIn: -1 } })) };
    const svg = eveningSvg(many, style({ maxRows: 4 }));
    expect(svg).toContain('… a dalších hráčů: 16');
  });
});

describe('summary pictures: drawing basics', () => {
  it('the size follows the width setting', () => {
    const small = eveningSvg(evening, style({ width: 600 }));
    const big = eveningSvg(evening, style({ width: 1200 }));
    expect(widthOf(big)).toBeGreaterThanOrEqual(1200);
    expect(heightOf(big)).toBeGreaterThan(heightOf(small) * 1.5);
  });

  it('text width estimates grow with the text and the size, and wide letters take more room', () => {
    expect(textWidth('', 20)).toBe(0);
    expect(textWidth('Karel Novák', 20)).toBeGreaterThan(textWidth('Karel', 20));
    expect(textWidth('Karel', 40)).toBeCloseTo(textWidth('Karel', 20) * 2, 5);
    expect(textWidth('WWWW', 20)).toBeGreaterThan(textWidth('iiii', 20) * 2);
  });

  it('renders a real PNG as wide as the drawing, for both pictures', async () => {
    for (const svg of [tournamentSvg(tournament(), style()), eveningSvg(evening, style())]) {
      const png = await svgToPng(svg, 'DejaVu Sans');
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(Buffer.from(png).readUInt32BE(16)).toBe(widthOf(svg));
      expect(png.length).toBeGreaterThan(5000);
    }
  });
});

// ---------- Discord ----------

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string | FormData;
}
const HOOK = 'https://discord.example/api/webhooks/1/abc';
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function start(settings: Record<string, unknown> = {}, render?: (svg: string) => Promise<Uint8Array>) {
  const calls: Call[] = [];
  const drawn: string[] = [];
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 31), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'integrations.enabled': true, 'integrations.discordEnabled': true, 'integrations.discordPictures': true, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    integrationFetch: (async (url: string, init: { headers: Record<string, string>; body: string | FormData }) => {
      calls.push({ url, headers: { ...init.headers }, body: init.body });
      return { status: 200 } as Response;
    }) as unknown as typeof fetch,
    pictureRender:
      render ??
      (async (svg) => {
        drawn.push(svg);
        return FAKE_PNG;
      }),
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  await server.secrets.set(admin!, 'discord.webhookUrl', HOOK);
  let n = 0;
  const user = async (role?: string) => {
    const nick = `P${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, admin: admin!, user, calls, drawn };
}

/** The parts of a multipart Discord message. */
async function parts(body: string | FormData) {
  if (typeof body === 'string') throw new Error('expected a picture, got text');
  const file = body.get('files[0]') as File;
  return { json: JSON.parse(String(body.get('payload_json'))), file, bytes: new Uint8Array(await file.arrayBuffer()) };
}

const TOUR = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' };
async function playTournament(c: Awaited<ReturnType<typeof start>>) {
  const org = await c.user('organizator');
  const [a, b] = [await c.user(), await c.user()];
  const { id } = await c.server.tournaments.create(org, { name: 'Čtvrteční', templateId: 'tour-turbo', settings: TOUR });
  for (const p of [a, b]) await c.server.tournaments.liveRegister(org, id, p);
  await c.server.tournaments.start(org, id);
  await c.server.tournaments.liveEliminate(org, id, b, [a]);
  await c.server.integrations.idle();
  return { id };
}

describe('summary pictures: Discord', { timeout: 60_000 }, () => {
  it('a closed evening goes out as a picture with a short caption and the link', async () => {
    const c = await start();
    const { id } = await c.server.evenings.create(c.admin, 'Páteční večer');
    await c.server.evenings.close(c.admin, id);
    await c.server.integrations.idle();
    expect(c.calls).toHaveLength(1);
    const call = c.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.headers['content-type']).toBeUndefined(); // the form sets its own boundary
    const p = await parts(call.body);
    expect(p.json.content).toContain('Páteční večer');
    expect(p.json.content).toContain(`http://localhost/vecery/${id}`);
    expect(p.json.allowed_mentions).toEqual({ parse: [] });
    expect(p.json.attachments).toEqual([{ id: 0, filename: 'vecer.png' }]);
    expect(p.file.type).toBe('image/png');
    expect(p.file.name).toBe('vecer.png');
    expect([...p.bytes]).toEqual([...FAKE_PNG]);
    expect(c.drawn).toHaveLength(1);
    expect(c.drawn[0]).toContain('Páteční večer');
    expect(c.drawn[0]).toContain('Pořadí a výsledek v penězích'); // the first table of the evening page
    expect(c.drawn[0]).not.toContain('Statistiky večera'); // and nothing more
    const [d] = await c.server.integrations.deliveries(c.admin);
    expect(d).toMatchObject({ target: 'discord', event: 'evening.closed', status: 'ok' });
  });

  it('a finished tournament goes out as the same table the players get, with the real figures', async () => {
    const c = await start({ ...TOUR, 'integrations.discordEvents': 'tournament.finished' });
    const { id } = await playTournament(c);
    expect(c.calls).toHaveLength(1);
    const p = await parts(c.calls[0]!.body);
    expect(p.json.content).toContain('Čtvrteční');
    expect(p.json.content).toMatch(/http:\/\/localhost\/turnaj\/\S+/); // link to the full results
    expect(p.json.attachments).toEqual([{ id: 0, filename: 'turnaj.png' }]);
    const svg = c.drawn[0]!;
    expect(svg).toContain('Turnaj Čtvrteční skončil');
    expect(svg).toContain('>P1x<'); // the winner
    expect(svg).toContain('>P2x<');
    expect(svg).toContain('>1× 100<'); // each paid one buy-in
    expect(svg).toContain('>-100<'); // paid
    expect(svg).toContain('>200<'); // the winner takes the pool
    expect(svg).toMatch(new RegExp(`fill="${dark['color.success']}"[^>]*>\\+100<`)); // profit of the winner
    // every figure is the one of the summary the players receive
    const summary = (await c.server.tournaments.summaryOf(id))!.summary;
    expect(summary.map((r) => r.profit).sort()).toEqual([-100, 100]);
    expect(svg).not.toMatch(/hole|deck/);
  });

  it('the tournament table is read from the tournament service, so a retried delivery still gets its picture', async () => {
    const c = await start({ ...TOUR, 'integrations.discordEvents': '' });
    const { id } = await playTournament(c);
    await c.server.journal.flush();
    const drawn: string[] = [];
    const fresh = new PictureService({
      db: c.server.db,
      perms: c.server.perms,
      settings: () => c.server.settings.resolve(),
      now: () => 0,
      tournament: (tid) => c.server.tournaments.summaryOf(tid),
      render: async (svg) => {
        drawn.push(svg);
        return FAKE_PNG;
      },
    });
    const pic = await fresh.forEvent({ version: 1, event: 'tournament.finished', at: 0, data: { id } });
    expect(pic?.filename).toBe('turnaj.png');
    expect(drawn[0]).toContain('Čtvrteční');
    expect(drawn[0]).toContain('>P1x<');
    expect(drawn[0]).toContain('>200<');
    expect(await c.server.tournaments.summaryOf('neexistuje')).toBeNull();
  });

  it('only summaries become pictures; other events and channels with the switch off keep the text', async () => {
    const c = await start({ 'integrations.discordEvents': 'tournament.registration,evening.closed', 'integrations.discord2Enabled': true, 'integrations.discord2Events': 'evening.closed' });
    await c.server.secrets.set(c.admin, 'discord.webhookUrl2', 'https://discord.example/api/webhooks/2/def');
    c.server.integrations.emit('tournament.registration', { name: 'Sobotní' });
    await c.server.integrations.idle();
    expect(typeof c.calls[0]!.body).toBe('string');
    expect(JSON.parse(c.calls[0]!.body as string).content).toContain('Sobotní');

    const { id } = await c.server.evenings.create(c.admin, 'Sobota');
    await c.server.evenings.close(c.admin, id);
    await c.server.integrations.idle();
    const byUrl = new Map(c.calls.slice(1).map((x) => [x.url, x.body]));
    expect(typeof byUrl.get(HOOK)).toBe('object'); // channel 1: picture
    const text = byUrl.get('https://discord.example/api/webhooks/2/def'); // channel 2: switch off
    expect(typeof text).toBe('string');
    expect(JSON.parse(text as string).content).toContain('MVP');
  });

  it('when the picture cannot be made the full text goes out instead and nothing is lost', async () => {
    const c = await start({}, async () => {
      throw new Error('no renderer');
    });
    const { id } = await c.server.evenings.create(c.admin, 'Bez obrázku');
    await c.server.evenings.close(c.admin, id);
    // a summary whose data is gone (unknown tournament) falls back the same way
    c.server.integrations.emit('tournament.finished', { id: 'neexistuje', name: 'Ztracený', winner: 'Karel', players: 4 });
    await c.server.integrations.idle();
    expect(c.calls).toHaveLength(2);
    const texts = c.calls.map((x) => JSON.parse(x.body as string).content as string);
    expect(texts[0]).toContain('Bez obrázku');
    expect(texts[0]).toContain(`http://localhost/vecery/${id}`);
    expect(texts[1]).toContain('Ztracený');
    expect(texts[1]).toContain('Karel');
    expect((await c.server.integrations.deliveries(c.admin)).every((d) => d.status === 'ok')).toBe(true);
  });

  it('the test message of a picture channel is a sample picture; the admin preview needs the permission', async () => {
    const c = await start();
    expect(await c.server.integrations.testDiscord(c.admin)).toEqual({ ok: true });
    const p = await parts(c.calls[0]!.body);
    expect(p.json.attachments).toEqual([{ id: 0, filename: 'turnaj.png' }]);
    expect(c.drawn[0]).toContain('Turnaj Ukázkový turnaj skončil');
    expect((await c.server.integrations.overview(c.admin)).discord.map((d) => d.pictures)).toEqual([true, false, false, false]);

    expect([...(await c.server.pictures.preview(c.admin, 'evening'))]).toEqual([...FAKE_PNG]);
    expect(c.drawn[1]).toContain('Ukázkový večer');
    expect(c.drawn[1]).toContain('Pořadí a výsledek v penězích');
    const player = await c.user();
    await expect(c.server.pictures.preview(player, 'tournament')).rejects.toBeInstanceOf(IntegrationError);
  });

  it('picture settings change the look: light mode, width, hidden amounts', async () => {
    const c = await start({ 'integrations.pictureMode': 'light', 'integrations.pictureWidth': 1200, 'integrations.pictureAmounts': false });
    await c.server.pictures.preview(c.admin, 'tournament');
    const light = resolveTokens(BUILTIN_THEMES.find((x) => x.id === 'classic-green')!, 'light');
    expect(widthOf(c.drawn[0]!)).toBeGreaterThanOrEqual(1200);
    expect(c.drawn[0]).toContain(`fill="${light['color.bg']}"`);
    expect(c.drawn[0]).not.toContain('>Zaplaceno<');
    expect(c.drawn[0]).not.toContain('>Profit<');
  });
});
