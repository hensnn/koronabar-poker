import { buildServer } from './app.js';

const adminNick = process.env.ADMIN_NICKNAME ?? 'admin';
const server = await buildServer({
  logger: true,
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.PGLITE_DIR ?? '.data/pglite',
  bootstrapAdmin: { nickname: adminNick, password: process.env.ADMIN_PASSWORD },
  publicUrlDefault: process.env.PUBLIC_URL?.trim() || undefined,
  extraOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
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
