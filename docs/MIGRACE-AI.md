# Předání projektu jiné AI (migrace)

Tento soubor je určený **AI asistentovi (Claude Code nebo jinému), který projekt přebírá**. Přečti ho celý jako první, potom `CLAUDE.md`, `docs/STAV.md` a podle potřeby `docs/ZADANI.md`. Majitel projektu **není programátor**: komunikace a veškeré texty pro uživatele jsou **česky**, vysvětlovat srozumitelně, krok za krokem.

Stav k 1. 11. 2026. Co přesně je hotové a proč, je v `docs/STAV.md` (chronologický deník rozhodnutí). Tady je to, co potřebuješ, abys mohl bezpečně pokračovat.

---

## 1. Co je to za projekt

**KoronaBar Poker**: self-hosted webová pokerová herna pro domácí hry přátel přes internet. Cash game i turnaje, **virtuální měna Korona (Korony, Koron) bez peněžní hodnoty**, všechno nastavitelné v GUI. Nasazení: Docker Compose za Nginx Proxy Manager, PostgreSQL.

### Nepřekročitelná pravidla (z `CLAUDE.md`, platí vždy)
1. **Server je jediná autorita.** Klient nikdy nedostane cizí karty ani stav balíčku. Každá akce a zpráva se validuje a kontroluje oprávnění na serveru.
2. **Žádné konstanty napevno.** Každá herní, časová, finanční, UI i AI hodnota je v centrálním schématu nastavení s výchozí hodnotou. Nový parametr = záznam ve schématu + texty (label a help) v překladech; formulář v GUI se vygeneruje sám.
3. **Vzhled jen přes design tokeny** (žádné barvy, fonty, velikosti v px napevno v komponentách; hlídá to test).
4. **Peníze:** celá čísla, všechny pohyby přes účetní knihu v transakci, nic nesmí vzniknout ani zmizet. Turnajové žetony nejsou měna.
5. **Virtuální měna nemá peněžní hodnotu.** Nikdy nepřidávat platby, směnu, výběry.
6. **Tajné údaje** (API klíče, hesla) jen šifrovaně v DB, nikdy do prohlížeče, logu ani exportu.
7. **Míchání karet** jen kryptografickým RNG.
8. **AI asistent** v aplikaci nikdy nemění nastavení bez potvrzení a nikdy nevidí skrytá herní data.

### Další pravidla spolupráce
- Veřejný repozitář: **žádné osobní údaje** (jen zástupné domény a e-maily, commity pod noreply). Dev heslo `vyvoj-heslo-123` je jen vývojové.
- Texty pro uživatele **nikdy přímo v kódu**, vždy přes překladové soubory (`packages/shared/src/i18n/cs*.ts`). Kód, názvy a komentáře v kódu anglicky nebo česky podle okolí (komentáře v repu jsou převážně česky).
- **Měna se píše Korona / Korony / Koron s velkým K** (výslovné přání majitele). Malé „koruna“ jen pro skutečnou korunu (chipleader).
- Commituj po menších logických celcích, česká popisná zpráva, a **až po zelených testech**. Trailer: `Co-Authored-By: <model> <noreply@anthropic.com>`. Push do `origin/main` (jediná větev).
- Po změně vzhledu vždy vykreslit a prohlédnout (build, dev server, měření DOM / snímek). Třídy nepojmenovávat `tk-…`, pokud nejde o herní prvky (kolize s kartami).

---

## 2. Technologie a struktura

Monorepo (pnpm workspaces), TypeScript všude.

| Složka | Obsah |
|---|---|
| `apps/server` | Node 20+, Fastify (REST), Socket.IO, Drizzle ORM. V testech a vývoji **PGlite** (vestavěný Postgres), v produkci PostgreSQL. |
| `apps/web` | React + Vite + Tailwind v4 (jen přes tokeny). Klient je „hloupý“: jen vykresluje to, co pošle server. |
| `packages/game-core` | Pokerová logika: adaptér na hotový engine (`@pokertools/engine`, patch v `patches/`), `TableActor` (stůl), `Tournament` (turnaj, hodiny, rebuy, add-on, bounty…), bot pro testy. |
| `packages/ledger` | Účetní kniha: `Ledger` (transakce, zůstatky, idempotence), účty (`accounts.*`), `EntryKind` (druhy pohybů), hlídač limitů, overdraft hook (kontokorent). |
| `packages/shared` | Registr nastavení (`settings/definitions/index.ts`), překlady `i18n/cs*.ts`, oprávnění (`permissions.ts`, `roles-preset.ts`), čisté funkce sdílené serverem a klientem. |
| `packages/tokens` | Design tokeny, motivy, kontrola kontrastu WCAG. |
| `docs/` | `ZADANI.md` (celé zadání), `PLAN.md`, `STAV.md` (deník), `NAVOD-HRA.md` (návod pro majitele), `NASAZENI.md`, `AUDIT.md`, `HOME-ASSISTANT.md`, tento soubor. |

### Klíčové moduly serveru (`apps/server/src`)
- `app.ts`: skládá celou aplikaci (`buildServer`), vrací objekt se všemi službami (používají ho testy).
- `http/routes.ts`: všechny REST cesty. `gateway.ts`: Socket.IO brána (stoly, chat).
- `wallet/service.ts`: peněženka, dobití/strhnutí, žádosti, **kontokorent**, vyúčtování (`settlementForPeriod`).
- `tournaments.ts`, `tables.ts`, `live-cash.ts`, `bets.ts` (sázky a odměny na hlavu), `evenings.ts` (herní večery).
- `stats.ts`, `overview.ts`, `timeline.ts`, `year-stats.ts`, `public-boards.ts`: statistiky.
- `side-results.ts`: **jediný zdroj peněz pro přehledy** (`gameNets`, `gameEvents`, `sideNets`).
- `consistency.ts`: kontrola konzistence dat (viz níže).
- `db/schema.ts` + `drizzle/` (migrace), `db/journal.ts` (asynchronní zápis knihy do DB).

---

## 3. Příkazy

```bash
pnpm install
pnpm -r typecheck           # kontrola typů
pnpm lint                   # oxlint
pnpm test                   # všechny testy (vitest)
# jen jeden balíček / soubor:
cd apps/server && npx vitest run src/wallet
# bez zátěžových časových limitů při velkém běhu serverových testů:
cd apps/server && npx vitest run --maxWorkers=4
# nová migrace po změně schématu:
cd apps/server && npx drizzle-kit generate --name=popis
# simulace her (kontroluje součty knihy):
pnpm --filter @kb/server exec tsx scripts/simulate.ts all 60 1
```

### Vývojový běh (Claude Code / ruční)
`.claude/launch.json` má konfigurace `server` (port 3000, PGlite v `.data/pglite`, přihlášení `Majitel` / `vyvoj-heslo-123`) a `web` (Vite, port 5173, proxy na server). **Po změně serverového kódu se server musí restartovat** (nemá hot reload). Změna `styles.css` se občas neprojeví: `touch apps/web/src/styles.css` a obnovit stránku.

Boti pro zkoušení stolů: `pnpm --filter @kb/server exec tsx scripts/dev-bot.ts <přezdívka> <místo> <stůl|t-idTurnaje>`.

### Poznámky k testům
- Při souběžném běhu celé serverové sady se objevují **zátěžová selhání** (5s časové limity, testy s restartem serveru). Samostatně nebo s `--maxWorkers=2` procházejí. Nejsou to chyby, ale po každém selhání ověř soubor zvlášť.
- Testy kontrolují: každé nastavení má label a help, každé uživatelské nastavení patří do právě jedné sady (`settings/sets.ts`), žádná pevná velikost `px` ani barva v komponentách (`apps/web/src/no-hardcoded-styles.test.ts`: pozor na třídy typu `gap-2 px-3`, regulár `\d\s*px` je chytne, přeřaď je), úplnost překladů.
- Chybné commity: **nikdy neřetěz příkazy středníkem před commitem**; použij `set -e` nebo `&&`, aby selhání testu zastavilo commit.

---

## 4. Účetní kniha a peníze (nejdůležitější část)

- Účty (`accounts.*`): `wallet:<userId>`, `table:<id>`, `house`, `mint` (vydání měny, smí být záporný), `fund:<id>`, `escrow:<id>`, `tournament:<id>`, `bounty:<id>`, `external:<cíl>`. **Součet všech účtů je vždy 0.**
- `EntryKind` (druhy pohybů): `mint`, `cash_*`, `turnaj_*`, `bounty`, `bet_*`, `head_bounty_*` (vč. `head_bounty_cancel` = storno), `rake`, `time_charge`, `jackpot_payout`, `credit_draw` / `credit_repay` (kontokorent), `manual_adjustment`, `shop_purchase`, `transfer_out`.
- Peněženka nikdy nejde pod nulu (záporný limit neexistuje; chybějící Korony kryje jen kontokorent, viz níže). Kniha je v paměti autoritativní a do DB se zapisuje asynchronně přes `Journal`; **paměť po startu drží jen zůstatky, ne historii**. Cokoli, co potřebuje historii (dluhy, přehledy vydané měny), se čte z DB po `journal.flush()`.
- **Nic se z knihy nemaže.** Oprava = protipohyb (storno). Smazání historie hry nemění knihu.

### Kontokorent (dřív „úvěr“)
- Když hráči při platbě za hru (`cash_buyin/topup`, `turnaj_buyin/rebuy/addon`, `bet_stake`, `head_bounty_post`) chybí Korony, `Ledger.setOverdraft` si vyžádá `credit_draw` z `mint` na chybějící částku (do limitu hráče) a platba proběhne. Klíč `credit:auto:<klíč platby>` zajišťuje idempotenci.
- **Z každého příjmu na peněženku** (dobití, výhra, vrácení vkladu, výběr od stolu…) se **nejdřív splácí dluh** (`credit_repay` zpět na `mint`, klíč `credit:autorepay:<tx>:<user>`). Hráč to nemění; správce smí vypnout `economy.creditAutoRepay`.
- Limit: výchozí `economy.creditLimit`, osobní v tabulce `credit_lines` (Pokladna → Kontokorent hráčů, oprávnění `mena.dobit`). Dluhy a limity drží `WalletService` v paměti, po startu `loadCredit()`.
- Splátka je **samostatný pohyb**: výhra ve hře ve statistikách zůstává celá.

### Statistiky = kniha (rozhodnutí, nerozbíjet)
- Peníze v přehledech (Přehled hráčů, vyúčtování v peněžence, večery, roční statistika, grafy) se **vždy počítají z knihy** a **vždy zahrnují všechno, co se u hry stalo**: výhry, bounty, **odměny na hlavu a sázky bokem** (`SIDE_KINDS`), a to ke hře (`gameId`). Společný kód: `side-results.ts`.
- Turnaj se do období vyúčtování počítá **celý**, jakmile má v okně jakýkoli pohyb.
- Žebříček (`stats.leaderboard`) má vlastní pravidla (nejmenší počet hand pro cash, sezóny) a čerpá z `game_results`; rozdíl proti Přehledu je záměrný. Rozpracované turnaje se v knize počítají jako zaplacený vstup.

### Kontrola konzistence
`GET /api/admin/consistency` (Pokladna → Kontrola konzistence dat) ověří: nulový součet každého pohybu a celé knihy, shodu zůstatků v paměti, v DB a z pohybů, žádný záporný účet (mimo `mint`), prázdné pooly skončených her, dluhy z kontokorentu a shodu `game_results` s knihou i přítomnost výsledků každého skončeného turnaje. `POST /api/admin/consistency/repair-results` doplní chybějící výsledky skončených turnajů do statistik (XP a rating pak přepočítá Údržba). **Po větších změnách peněz tuto kontrolu spusť** a při psaní testů ji lze volat jako `server.consistency.run(adminId)`.

---

## 5. Nastavení, oprávnění, překlady

- **Registr nastavení**: `packages/shared/src/settings/definitions/index.ts` (typy `bool/int/choice/text`, kategorie, `mutability` ADM/A/H/S, `scopes` GLOBAL/USER, `dependsOn`, křížová pravidla). Vrstvy: global → šablona → hra → stůl → hráč → zařízení.
- Nové nastavení vyžaduje: záznam v registru, `settings.<klíč>.label` a `.help` v i18n, u uživatelských zařazení do sady v `settings/sets.ts`, u speciálních prvků podskupinu v `settings/groups.ts`. Testy to vynutí.
- **Oprávnění** (`permissions.ts`, předvolby rolí `roles-preset.ts`, texty `i18n/cs-permissions.ts`). Předvolby platí jen při prvním startu; **do už založených rolí se nová oprávnění nedoplňují**, přidělují se v GUI (Lidé → Role). Hlavní administrátor má vše vždy.
- Překlady: jen čeština (`cs*.ts`), struktura připravená na další jazyky.

---

## 6. Znalosti a pasti z práce na projektu

- **Konce řádků:** soubory v repozitáři mají v pracovní kopii CRLF (Windows), git je normalizuje na LF. Při skriptových úpravách textu ošetři `\r\n` (načíst, nahradit na `\n`, zapsat zpět se stejným zakončením).
- **Skripty s `heredoc` a zpětným lomítkem** v Bashi se občas poškodí (`\n`, `\r`, `\u…` v regulárech). Pro složitější úpravy napiš skript do souboru; v testech používej `String.fromCharCode(10)` místo `\n` v regulárech.
- Dev server po restartu nějakou dobu nereaguje (načítání); skripty volají API s opakováním.
- `data-mobile` / `data-fit` / `data-focus` na `<html>` řídí rozložení stolu (mobil, přizpůsobení oknu, celá obrazovka). Aplikace nainstalovaná jako PWA (`display-mode: standalone`) přepíná do kompaktního rozložení pod 64 rem.
- Karty v přehledech zobrazuj přes `CardView` s `still`; animace `win` (zvedá kartu) je jen pro stůl, pro statické zvýraznění je `mark`.
- Vestavěné šablony a nastavení se u archivovaných (z paměti uvolněných) turnajů musí řešit stejnými vrstvami jako u běžících (`resolveArchived`).
- Škálování a sdílení více serverů se nepředpokládá: jedna instance, stav stolů v paměti, perzistence do DB.

---

## 7. Co je hotové a co zbývá

Hotovo (výběr, detaily v `docs/STAV.md`): pokerové jádro (cash, turnaje, bounty/PKO/mystery, rebuy/add-on, dohoda), role a oprávnění, nastavení v GUI se šablonami a profily, účetní kniha, peněženka, kontokorent, sázky bokem a odměny na hlavu (se stornem), večery, statistiky, žebříčky, rating, XP, zvukové emotikony (editovatelná společná knihovna), chat, ankety, TV režim, hlasatel, napojení (webhooky, MQTT/Home Assistant, Discord, REST API, MCP), AI asistent nastavení, PWA, kompaktní a mobilní rozložení.

Otevřené / nápady (nejsou rozpracované):
- Obecné storno libovolného pohybu v knize (zatím jen odměna na hlavu; oprávnění `mena.stornovat` už existuje). Storno pohybů, jejichž výsledky se ukládají zvlášť (turnajové vstupy), by chtělo přepočet hry.
- Snapshot nastavení turnaje při startu (dnes se startovní stack bere z šablony; pozdější úprava vestavěné šablony ho u starého turnaje změní).
- Automatické doplnění chybějících výsledků turnajů při startu (zatím ručně v kontrole konzistence).
- Sjednocení Žebříčku a Přehledu (záměrně se liší pravidly).

## 8. Jak pracovat (doporučený postup pro další úkol)

1. Přečti `CLAUDE.md`, tento soubor a posledních ~20 záznamů v `docs/STAV.md`.
2. U nové funkce nejdřív shrň, co uděláš (česky, stručně). U velké změny počkej na souhlas majitele.
3. Piš testy ke každé funkci; pro peníze vždy ověř, že součet knihy zůstává 0 (`ledger.totalIsZero`, `consistency.run`).
4. Po změně serveru restartuj dev server, po změně vzhledu ověř na vykreslené stránce (počítač i mobil).
5. Doplň `docs/NAVOD-HRA.md` (co a jak pro majitele) a `docs/STAV.md` (rozhodnutí a proč), commit po logickém celku.
6. Na konci práce stručně česky shrň: co funguje, co je neověřené, co zbývá.
