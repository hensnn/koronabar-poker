import { buildServer } from './app.js';

/** Neošetřená chyba na pozadí (zapomenutý `.catch`) se jen zaloguje; proces běží dál a handy se nevracejí na předěl. */
process.on('unhandledRejection', (reason) => {
  console.error('Neošetřené odmítnutí promise:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
/** Výjimka mimo obsluhu požadavku znamená neznámý stav: zapíše se do logu a proces se ukončí; Docker ho restartuje. */
process.on('uncaughtException', (e) => {
  console.error('Neočekávaná výjimka, server se ukončuje:', e instanceof Error ? (e.stack ?? e.message) : e);
  // Zápis do logu (stderr) doběhne dřív, než proces skončí.
  process.stderr.write('', () => process.exit(1));
});

/**
 * `TRUST_PROXY`: komu věřit hlavičku X-Forwarded-For. Prázdné = proxy z vnitřní sítě (NPM na stejném stroji
 * nebo v Dockeru), číslo = počet proxy za sebou, jinak adresy/CIDR oddělené čárkou, nebo true/false.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const adminNick = process.env.ADMIN_NICKNAME ?? 'admin';
let server: Awaited<ReturnType<typeof buildServer>>;
try {
  server = await buildServer({
    logger: true,
    databaseUrl: process.env.DATABASE_URL,
    dataDir: process.env.PGLITE_DIR ?? '.data/pglite',
    bootstrapAdmin: { nickname: adminNick, password: process.env.ADMIN_PASSWORD },
    publicUrlDefault: process.env.PUBLIC_URL?.trim() || undefined,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    extraOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
} catch (e) {
  console.error('Start serveru selhal:', e instanceof Error ? e.message : e);
  process.exit(1);
}
if (server.bootstrap?.created) {
  console.log('==============================================================');
  console.log(`Vytvořen hlavní administrátor "${adminNick}".`);
  if (server.bootstrap.password) console.log(`Vygenerované heslo (po přihlášení ho změň): ${server.bootstrap.password}`);
  console.log('==============================================================');
}
const port = await server.listen();
console.log(`KoronaBar Poker server poslouchá na portu ${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
