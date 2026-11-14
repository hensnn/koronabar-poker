import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { BUILTIN_THEMES, resolveTokens } from '@kb/tokens';
import { buildServer } from '../app.js';
import { PictureService } from './picture-service.js';
import { eveningSvg, svgToPng, tournamentSvg, type EveningPictureData, type PictureStyle, type TournamentPictureData } from './pictures.js';
import { IntegrationError } from './service.js';

const dark = resolveTokens(BUILTIN_THEMES[0]!, 'dark');
const style = (o: Partial<PictureStyle> = {}): PictureStyle => ({ width: 900, maxRows: 12, amounts: true, tokens: dark, currency: ['Korona', 'Korony', 'Koron'], timeZone: 'Europe/Prague', ...o });
const AT = Date.UTC(2026, 10, 13, 21, 30);

const tournament = (players = 6): TournamentPictureData => ({
  name: 'Páteční turnaj',
  finishedAt: AT,
  results: Array.from({ length: players }, (_, i) => ({ place: i + 1, name: `Hráč${i + 1}`, payout: [2500, 1500][i] ?? 0, bounty: i === 2 ? 300 : 0 })),
});
const evening: EveningPictureData = {
  name: 'Páteční večer',
  from: AT - 4 * 3600_000,
  to: AT,
  games: 3,
  players: [
    { nickname: 'Karel', net: 1850, knockouts: 3, score: 88.5 },
    { nickname: 'Jana', net: 0, knockouts: 0, score: 40 },
    { nickname: 'Petr', net: -310, knockouts: 1, score: 12 },
  ],
  mvp: { nickname: 'Karel', score: 88.5 },
  hunter: { nickname: 'Karel', count: 3 },
  banker: { nickname: 'Jana', bb: 184 },
  badBeat: { nickname: 'Petr', equity: 91.3 },
};

describe('summary pictures: drawing', () => {
  it('tournament: winner, places, payouts and prize pool in the colours of the theme', () => {
    const svg = tournamentSvg(tournament(), style());
    expect(svg).toContain('width="900"');
    expect(svg).toContain(`fill="${dark['color.bg']}"`);
    expect(svg).toContain('Páteční turnaj');
    expect(svg).toContain('prize pool 4 000 Koron');
    expect(svg).toContain('>2 500 Koron<');
    expect(svg).toContain('>1 500 Koron<');
    expect(svg).toContain('>300 Koron<'); // bounty column appears because somebody earned one
    expect(svg).toContain('BOUNTY');
    expect(svg).toContain('>Hráč6<');
    expect(svg).toContain('13. 11. 2026');
  });

  it('player names cannot break the picture or smuggle markup into it', () => {
    const d = tournament(2);
    d.results[0]!.name = '<b>Karel</b> & "spol"';
    d.name = "O'Brien <script>";
    const svg = tournamentSvg(d, style());
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;b&gt;Karel&lt;/b&gt; &amp; &quot;spol&quot;');
    expect(svg).toContain('O&apos;Brien &lt;script&gt;');
  });

  it('without amounts the picture shows places only: no payouts, prize pool or bounty', () => {
    const svg = tournamentSvg(tournament(), style({ amounts: false }));
    expect(svg).not.toMatch(/\d Koron/);
    expect(svg).not.toContain('VÝHRA');
    expect(svg).not.toContain('BOUNTY');
    expect(svg).toContain('>Hráč1<');
    const ev = eveningSvg(evening, style({ amounts: false }));
    expect(ev).not.toMatch(/\d Koron/);
    expect(ev).not.toContain('PROFIT');
    expect(ev).toContain('BODY');
  });

  it('a long field is cut to the row limit and the rest is counted in one line', () => {
    const svg = tournamentSvg(tournament(20), style({ maxRows: 5 }));
    expect(svg).toContain('>Hráč5<');
    expect(svg).not.toContain('>Hráč6<');
    expect(svg).toContain('… a dalších hráčů: 15');
    expect(tournamentSvg(tournament(5), style({ maxRows: 5 }))).not.toContain('a dalších hráčů');
  });

  it('players who share the first place are both named as winners and their payouts are added up', () => {
    const d = tournament(3);
    d.results = [
      { place: 1, name: 'Karel', payout: 2000, bounty: 0 },
      { place: 1, name: 'Jana', payout: 2000, bounty: 0 },
      { place: 3, name: 'Petr', payout: 0, bounty: 0 },
    ];
    const svg = tournamentSvg(d, style());
    expect(svg).toContain('>Karel, Jana<');
    expect(svg).toContain('>4 000 Koron<');
  });

  it('evening: MVP, awards and the ranking with signed profit in the success and danger colours', () => {
    const svg = eveningSvg(evening, style());
    expect(svg).toContain('Páteční večer');
    expect(svg).toContain('her: 3');
    expect(svg).toContain('hráčů: 3');
    expect(svg).toContain('vyřazených: 3');
    expect(svg).toContain('pot 184 BB');
    expect(svg).toContain('prohra se šancí 91,3 %');
    expect(svg).toMatch(new RegExp(`fill="${dark['color.success']}"[^>]*>\\+1 850 Koron<`));
    expect(svg).toMatch(new RegExp(`fill="${dark['color.danger']}"[^>]*>−310 Koron<`));
    expect(svg).toContain('>0 Koron<');
  });

  it('an evening without awards still draws the ranking; the light mode uses the light colours', () => {
    const light = resolveTokens(BUILTIN_THEMES[0]!, 'light');
    const svg = eveningSvg({ ...evening, mvp: null, hunter: null, banker: null, badBeat: null }, style({ tokens: light }));
    expect(svg).toContain(`fill="${light['color.bg']}"`);
    expect(svg).not.toContain('MVP');
    expect(svg).toContain('>Karel<');
  });

  it('the size follows the width setting', () => {
    const narrow = tournamentSvg(tournament(), style({ width: 600 }));
    const wide = tournamentSvg(tournament(), style({ width: 1200 }));
    const height = (svg: string) => Number(/height="(\d+)"/.exec(svg)![1]);
    expect(narrow).toContain('width="600"');
    expect(height(wide)).toBeGreaterThan(height(narrow) * 1.9);
  });

  it('renders a real PNG of the requested width', async () => {
    const png = await svgToPng(tournamentSvg(tournament(), style()), 'DejaVu Sans');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Buffer.from(png).readUInt32BE(16)).toBe(900);
    expect(png.length).toBeGreaterThan(5000);
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
    const [d] = await c.server.integrations.deliveries(c.admin);
    expect(d).toMatchObject({ target: 'discord', event: 'evening.closed', status: 'ok' });
  });

  it('a finished tournament goes out as a picture with the real results', async () => {
    const c = await start({ ...TOUR, 'integrations.discordEvents': 'tournament.finished' });
    await playTournament(c);
    expect(c.calls).toHaveLength(1);
    const p = await parts(c.calls[0]!.body);
    expect(p.json.content).toContain('Čtvrteční');
    expect(p.json.content).toMatch(/http:\/\/localhost\/turnaj\/\S+/); // link to the full results
    expect(p.json.attachments).toEqual([{ id: 0, filename: 'turnaj.png' }]);
    const svg = c.drawn[0]!;
    expect(svg).toContain('Čtvrteční');
    expect(svg).toContain('>P1x<'); // the winner
    expect(svg).toContain('>P2x<');
    expect(svg).toContain('>200 Koron<');
    expect(svg).not.toMatch(/hole|deck/);
  });

  it('after a restart the results are read from the database, so a retried delivery still gets its picture', async () => {
    const c = await start({ ...TOUR, 'integrations.discordEvents': '' });
    const { id } = await playTournament(c);
    await c.server.journal.flush();
    await c.server.stats.idle();
    const drawn: string[] = [];
    const fresh = new PictureService({
      db: c.server.db,
      perms: c.server.perms,
      settings: () => c.server.settings.resolve(),
      now: () => 0,
      tournament: () => null, // nothing in memory
      render: async (svg) => {
        drawn.push(svg);
        return FAKE_PNG;
      },
    });
    const pic = await fresh.forEvent({ version: 1, event: 'tournament.finished', at: 0, data: { id } });
    expect(pic?.filename).toBe('turnaj.png');
    expect(drawn[0]).toContain('Čtvrteční');
    expect(drawn[0]).toContain('>P1x<');
    expect(drawn[0]).toContain('>200 Koron<');
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
    expect(c.drawn[0]).toContain('Ukázkový turnaj');
    expect((await c.server.integrations.overview(c.admin)).discord.map((d) => d.pictures)).toEqual([true, false, false, false]);

    expect([...(await c.server.pictures.preview(c.admin, 'evening'))]).toEqual([...FAKE_PNG]);
    expect(c.drawn[1]).toContain('Ukázkový večer');
    const player = await c.user();
    await expect(c.server.pictures.preview(player, 'tournament')).rejects.toBeInstanceOf(IntegrationError);
  });

  it('picture settings change the look: light mode, width, hidden amounts', async () => {
    const c = await start({ 'integrations.pictureMode': 'light', 'integrations.pictureWidth': 1200, 'integrations.pictureAmounts': false });
    await c.server.pictures.preview(c.admin, 'tournament');
    const light = resolveTokens(BUILTIN_THEMES.find((x) => x.id === 'classic-green')!, 'light');
    expect(c.drawn[0]).toContain('width="1200"');
    expect(c.drawn[0]).toContain(`fill="${light['color.bg']}"`);
    expect(c.drawn[0]).not.toMatch(/\d Koron/);
  });
});
