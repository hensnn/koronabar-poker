# Audit aplikace (říjen 2026)

Shrnutí kontroly funkčnosti, testů, simulací her a vzhledu. Slouží i jako seznam známých nedostatků.

## Co se kontrolovalo a jak dopadlo

| Oblast | Výsledek |
|---|---|
| Kontrola typů (`pnpm -r typecheck`) | bez chyb |
| Kontrola kódu (`pnpm lint`) | bez chyb |
| Všechny testy (`pnpm test`) | **1089 prošlo, 1 přeskočeno** (zátěžový test cash šablon, spouští se jen na přání: `STRESS=1`) |
| Produkční sestavení (`pnpm build`) | projde |
| Zranitelnosti závislostí (`pnpm audit --prod`) | nenalezeny |
| Simulace cash her (400 s, 41 hand, náhodné tahy, sit out, top-up, odchody, odpojení) | bez problémů, součet účetní knihy souhlasí |
| Simulace turnajů (freezeout, rebuy + add-on, bounty, rebuy s odpojením) | všechny doběhly, peníze v knize souhlasí |
| Vzhled stránek (počítač i mobil) | prošlo se: Lobby, Stoly, Peněženka a vyúčtování, Osobní nastavení, Statistiky, Detail turnaje, Stůl, Správa (Napojení ven, Logo, Pokladna, Finance, Role, Šablony, Údržba, Obecné nastavení) |

Simulace se spouští příkazem `pnpm --filter @kb/server exec tsx scripts/simulate.ts [cash|tournament|all] [sekundy] [seed]`. Kontroluje součty účetní knihy, žetony u stolů proti knize, zaseknutí hry a chyby serveru.

## Nalezené a opravené chyby

- **Kolize vzhledu po zavedení hustoty zobrazení:** nová třída kolidovala s třídou herních karet a rozbila vzhled všech karet v aplikaci. Opraveno přejmenováním (třídy `kd-*`).
- **Posuvník u čísel v nastavení** se smrštil na tečku, protože číselné pole mělo současně šířku 24 a 100 %. Opraveno v poli pro čísla.
- **Seznamy zaškrtávátek** (události napojení ven, Discord, rozsahy tokenů) se zalamovaly rozházeně; popisek a klíč jsou teď v jednom bloku.
- **Popisky:** „poplatek“ s malým písmenem v informacích o turnaji, obecná hláška v nastavení, která už neplatila, dvojí vysvětlení u MQTT.
- **Tlačítka v tabulce rolí** se zbytečně lámala do dvou řádků.

## Opravy nedostatků z auditu

- **Velikost aplikace:** méně časté stránky a celá Správa se načítají až při otevření. Hlavní soubor se zmenšil přibližně o třetinu (z 1,4 MB na asi 0,5 MB a společnou část 0,5 MB); ostatní stránky se stáhnou, až je otevřeš.
- **Údržba:** všechna zaškrtávátka jsou ve výchozím stavu **nezaškrtnutá**, přibyly tlačítka Vybrat vše a Zrušit výběr. Mazání dál chrání napsání slova a záloha.
- **Vyúčtování:** když vyjde zisk herny záporný (období začíná uprostřed hry), ukáže se upozornění, jak zvolit období.
- **Typ zařízení:** v Nastavení → Osobní nastavení je volba „Typ tohoto zařízení“ (Automaticky / Telefon a tablet / Počítač).
- **Vizuální kontrola:** skript `scripts/screenshots.mjs` uloží snímky hlavních stránek na počítači i mobilu (`LOGIN=... PASSWORD=... node scripts/screenshots.mjs složka`; vývojový server a web musí běžet). Přibyl test, který hlídá kolizi tříd herních karet s obecnými prvky.

## Kontrola čekání a animací u stolu

Procházelo se, jestli hráč vždy ví, co se u stolu děje, kde běží odpočet. Bylo doplněno:
- odpočet **další handy** a zpráva „Čeká se na další hráče“ (dřív jen obecné „Čeká se na další handu“),
- **hlasování** a **rozhodování o ukázání karet** je vidět všem u stolu (dřív jen tomu, kdo hlasuje nebo rozhoduje),
- **turnaj:** přestávka s odpočtem, pauza ředitelem, hand-for-hand na bublině a rozhodování o rebuy,
- **7-2 bonus, bomb pot a jackpot** se ukážou nad stolem, ne jen v chatu.

Všechny akce hráčů mají animaci (fold, check, call, bet, raise, re-raise, all-in). Když hráči vyprší čas a server za něj zahraje fold nebo check, ukáže se nad stolem oznámení. Všechna hlášení jdou vypnout v osobním nastavení (Vzhled a ovládání).

## Zbývající nedostatky a doporučení

1. **Plné prohlížečové testy** (klikání ve vykreslené aplikaci) zatím chybí; snímky stránek se kontrolují ručně skriptem výše.
2. **Vývojové přihlášení v repozitáři.** V `.claude/launch.json` je vývojové heslo majitele (`vyvoj-heslo-123`) pro lokální běh s prázdnou databází. Na ostrém serveru ho nikdy nepoužívej.
3. **Vyúčtování za období uprostřed hry** zahrne jen pohyby v období; upozornění je v aplikaci, volba celého období je na uživateli.
4. **Rebuy s držením hry** může hru zastavit až o desítky sekund (v simulaci asi 40 s). U stolu je teď vidět pruh „Hráč X se rozhoduje o rebuy, zbývá N s“ (u odpojeného hráče „hra na něj čeká“). Délku čekání ovládají nastavení Čas na rozhodnutí, Hra čeká a Nejdéle čekat na odpojeného.
5. **Ověřeno jen proti náhradním službám:** MQTT/Home Assistant, Discord, webhooky, skuteční poskytovatelé AI (Gemini), push upozornění a instalace aplikace na telefon. Po nasazení vyzkoušej jednou ručně (postupy jsou v README a `docs/HOME-ASSISTANT.md`).
6. **Nasazení přes Docker nebylo v tomto auditu spuštěno.** Postup je v README a `docs/NASAZENI.md`; po prvním nasazení projdi Kontrolní seznam před prvním spuštěním.
7. **Odložené funkce** (viz `docs/STAV.md`): sázky a odměny na hlavu u cash stolů, sázky s pevnými kurzy, e-mail o sázkách, štítek hráče v historii hand.

## Co dělat po každé změně vzhledu

Spustit `pnpm typecheck`, `pnpm lint`, `pnpm test`, potom `scripts/screenshots.mjs` a snímky prohlédnout. Nové obecné CSS třídy pojmenovat s vlastní předponou a před tím prohledat `apps/web/src/styles.css`.

## Audit 1. 11. 2026 (nastavení, statistiky, účetní kniha)

| Oblast | Výsledek |
|---|---|
| Testy balíčků (ledger 14, game-core 383, tokens 61, shared 188) a webu (138) | vše prošlo |
| Serverové testy (501) | 496 prošlo v jednom velkém běhu s `--maxWorkers=4`; 4 zátěžová selhání (restart serveru, šablony, převody, roční statistika) při samostatném běhu všechna prošla |
| Registr nastavení | 615 nastavení, žádné výchozí mimo rozsah, žádný neplatný výběr, žádná neexistující závislost |
| Účetní kniha na vývojových datech (288 pohybů) | každý pohyb má nulový součet, součet všech účtů 0, žádný záporný účet, zůstatky z pohybů = uložené = paměť, dluhy kontokorentu sedí, vydáno = peněženky + dům + fondy + stoly + turnaje + ven |
| Statistiky vs. kniha | **nalezeno:** skončený turnaj bez výsledků ve statistikách (Žebříček a osobní statistiky ho nezapočítaly); doplněno nástrojem `repair-results` |
| Přehled hráčů vs. vyúčtování | po sjednocení zdroje (kniha) 0 rozdílů z 25 hráčů (dřív 7) |
| Simulace turnajů (120 s na scénář) | freezeout, rebuy+add-on a bounty doběhly a součty peněženek souhlasí; dva nejtěžší scénáře (kolize časů automatických odpovědí, rebuy s držením hry a odpojením) se na pomalém stroji v limitu nedohrály (stejné chování jako známý nedostatek č. 4 výše, nejde o ztrátu peněz); bez dalšího šetření to nepovažujeme za potvrzenou chybu |

### Nalezené a opravené v tomto auditu
1. Přehled hráčů počítal peníze ze součtu výsledků hand a turnajů, ne z knihy: sjednoceno na knihu (`gameNets`).
2. Vyúčtování v peněžence nezahrnovalo sázky a odměny na hlavu a nepočítalo turnaj celý, když začal před oknem: opraveno.
3. Účet herny: příjmy a výdaje nenavazovaly na zůstatek (chyběly vrácené poplatky, doplatky a storna): opraveno, tabulka teď sedí.
4. Po restartu serveru byly vydaná měna a dluh z úvěru nulové (paměť knihy nemá historii): čte se z DB.
5. Skončený turnaj uvolněný z paměti ukazoval ve widgetu Informace výchozí hodnoty bez šablony: opraveno.
6. Dluhy z kontokorentu se nesplácely z příjmů: nyní automaticky jako první.

Nový nástroj: **Kontrola konzistence dat** (Pokladna), viz `docs/NAVOD-HRA.md`.


---

# Závěrečný audit 2. 11. 2026 (celý kód, testy, simulace)

Hloubková kontrola celé aplikace: automatické testy, simulace her na skutečném serveru a ruční průchod kódu v pěti oblastech (peníze, herní engine, bezpečnost serveru, webový klient, nastavení a datová vrstva). Nálezy byly následně opraveny, viz sekce „Opravy po auditu (3. 11. 2026)“ na konci. Nálezy označené „ověřeno testem“ byly reprodukovány dočasným testem, ostatní byly ověřeny čtením kódu.

## Souhrn kontrol

| Kontrola | Výsledek |
|---|---|
| Kontrola typů (`pnpm typecheck`) | bez chyb |
| Kontrola kódu (`pnpm lint`) | bez chyb, ale lint je nastavený velmi mírně (povoluje vše kromě 4 pravidel), viz doporučení |
| Všechny testy (`pnpm test`, 152 souborů) | **1300 prošlo, 1 přeskočen** (zátěžový `STRESS=1`), 668 s |
| Zranitelnosti závislostí (`pnpm audit --prod`) | 13 nálezů (9 středních, 4 nízké), žádný kritický: `nodemailer` < 10.1.4 (parsování adres), `fast-uri` (přes Fastify), `minimatch`, `glob`. Opravit aktualizací. |
| Míchání karet | kryptografický generátor (`crypto.randomBytes`) + Fisher-Yates v enginu, produkční kód nikam nepodstrkuje vlastní náhodu, tajná data se klientům neposílají (ověřeno v `view.ts`, TV i historii) |
| Simulace her (`scripts/simulate.ts all 240 4242`) | cash (60 s, 6 hand) a turnaje freezeout, rebuy+add-on, bounty (po 60 s) doběhly, součty peněženek a knihy sedí, žádná chyba serveru. Dva nejtěžší scénáře (kolize časů automatických odpovědí; rebuy s držením hry a odpojením) se v 60 s nedohrály, ale **při samostatném běhu s limitem 420 s oba doběhly bez problémů** (5 vyřazených, 12 a 18 rebuy, 3 add-ony, součet změn peněženek 600 = poplatky, účet turnaje 0). Jde tedy o pomalý průběh daný nastavením (rebuy drží hru, čeká se na odpojené), ne o zaseknutí; viz známý nedostatek č. 4 výše. |

## Nálezy podle závažnosti

### Vysoká závažnost

1. **Rake jde obejít odchodem hned po showdownu** (ověřeno testem). `packages/game-core/src/table-actor.ts:274` (`leave`), `:1470`, `:1777`. Po skončení handy se stůl přepne do fáze „pauza“ a rake, 7-2 bonus a jackpoty se účtují až po animaci showdownu (`time.showdownMs` + `time.potToWinnerMs`, výchozí asi 3 s). Odchod v tomto okně vyplatí celý stack včetně výhry; při následném účtování už hráč u stolu není a rake se **vůbec neodvede** (v testu: dům 0 místo 3 Koron, událost `rake` chybí). Kniha zůstane vyrovnaná, jde o obejití pravidla a ztrátu příjmu herny; totéž platí pro časovač maximálního sit outu a odstranění hráče turnajem (`removeTournamentPlayer`). Oprava: dobu od konce handy do zaúčtování považovat za „uprostřed handy“ (příznak `settling`, odchod jen označí `leaving`), nebo rake a bonusy účtovat hned při konci handy před animací. Doplnit test.
2. **Dvojí dobití při souběžném schválení žádosti.** `apps/server/src/wallet/service.ts:445–475`. Stav žádosti se přečte, pak se čeká na dobití (klíč idempotence je náhodné UUID) a teprve potom se žádost označí jako vyřízená. Dva rychlé kliky na „Schválit“ nebo dva správci současně = dvě dobití. U převodu ven (`transfer:${id}`) je klíč deterministický, tam to nehrozí. Oprava: nejdřív podmíněný `UPDATE … WHERE status='pending' RETURNING` (jako ve `auth/approvals.ts:378`), klíč `request:${id}`.
3. **Pozdní registrace a re-entry do turnaje: platba před usazením, bez vratky při selhání.** `packages/game-core/src/tournament/tournament.ts:447–463`, `:1105–1133`, `table-set.ts:148–176`. Nejprve se odepíše buy-in, potom se hledá místo. Výběr stolu nepočítá hráče ve stavu `leaving`, ale výběr sedadla ano, takže může vyjít `null` a usazení skončí výjimkou `INVALID_SEAT`. Peníze zůstanou na účtu turnaje, hráč není ve hře ani ve výsledcích a jeho buy-in se na konci rozdělí ostatním. Oprava: nejdřív ověřit a rezervovat místo, `seat()` obalit `try/catch` s `refund`, sjednotit počítání `leaving` sedadel.
4. **Snímky migrací 0043 a 0044 chybí.** `apps/server/drizzle/meta/` končí `0042_snapshot.json`, deník má 45 položek. Příští `drizzle-kit generate` vytvoří migraci s duplicitním `ADD COLUMN users.chart_color`, a server na ostrém provozu při startu spadne. Provoz dnes funguje (startovní migrátor čte jen deník a SQL). Oprava: dogenerovat snímky a přidat test, který spustí `drizzle-kit generate` do dočasné složky a selže, když vznikne nový SQL soubor.
5. **Webu chybí záchytná vrstva (ErrorBoundary).** `apps/web/src/App.tsx:37–52, 215`, `lazy.ts:3`, `router.tsx:336`. Po nasazení nové verze má hráč se starou záložkou při otevření líně načítané stránky (Chat, Peněženka) chybu 404 na starý soubor, a celá aplikace včetně rozehraného stolu zbělá bez hlášky. Totéž udělá neplatná adresa (`/stul/%E0` vyhodí `URIError` při dekódování). Oprava: ErrorBoundary kolem `Suspense` i nad celou aplikací s tlačítkem „Načíst znovu“, při selhání importu jednou `location.reload()`, `decodeURIComponent` v `try/catch`.

### Střední závažnost: peníze a hra

6. **Časovač tahu se při odpojení resetuje a odpouští spotřebovaný time bank.** `table-actor.ts:483–492`, `:1096–1133`. Odpojení (stačí F5) nastaví nový základní čas a po připojení znovu celý time bank, zavolaný čas (`clockCalled`) zmizí. Zneužitelné zdržování na bublině. Oprava: při odpojení deadline jen zkracovat, nikdy neprodlužovat, nejprve `settleBank`.
7. **Opožděná nebo zdvojená zpráva `table:act` se provede jako akce v další ulici.** `gateway.ts:233`, `table-actor.ts:494–501`. Zpráva nenese `handId` ani ulici; BB může dvojklikem „Check“ uzavřít preflop i flop. Oprava: do schématu akce přidat `handId` + `street` (nebo `seq`), neshodu odmítnout kódem `STALE_ACTION`. Souvisí s nálezem 15 (klient nebrání dvojímu odeslání).
8. **Živý cash: dva souběžné zápisy sdílí stejný klíč.** `apps/server/src/live-cash.ts:113–178`. `seq` se čte z DB, mezi čtením a zápisem se čeká; dva požadavky naráz skončí chybou `KEY_REUSED` (500) nebo přepsanou evidencí (kniha správná, výsledky hry ne). Oprava: fronta na jednu živou hru (jako `Serial` v `bets.ts`) nebo optimistický zámek.
9. **Evidenční tabulky se zapisují mimo Journal.** `wallet/service.ts:227, 464`, `live-cash.ts:78`, `bets.ts` (sázky, odměny na hlavu), `permissions.ts:261`. Kniha jde do DB dávkově v transakci, tyto tabulky hned a zvlášť; pád mezi nimi nechá např. sázku bez vkladu v knize nebo schválenou žádost bez dobití. Kontrola konzistence hlídá jen escrow vypořádaných sázek. Oprava: zápisy poslat jako operace do `Journal`, nebo rozšířit kontrolu konzistence o otevřené sázky a `house_expenses.tx_id`.
10. **Výplaty turnaje ve `finish()` nejsou atomické.** `tournament.ts:1207–1267`. Desítky samostatných pohybů; výjimka uprostřed nechá turnaj napůl vyplacený ve stavu `running`. Klíče jsou deterministické (dvojí výplata nehrozí), ale overlay a zbytek se při opakování spočítají špatně. Souvisí: ruční úprava knihy (`wallet/service.ts:215`) smí sáhnout i na účty běžících her. Oprava: nejdřív vše spočítat a ověřit součet, pak postovat; při chybě zřetelný chybový stav; v `adjust` povolit jen peněženky, dům, fondy a účty uzavřených her.
11. **Zavření stolu zevnitř vlastního předělu.** `tournament/table-set.ts:282–299` → `table-actor.ts:925–945`. `breakTable` zavře stůl synchronně, řízení se vrátí do předělu, který přepíše fázi `stopped` na `idle` a vyvolá změnu na už odstraněném stole. Oprava: po `onBoundary` ověřit `phase === 'stopped'`, nebo zavírat přes `queueMicrotask` (jako `Tournament.finish`).
12. **Souběžná vyřazení se stejným stackem se nedělí.** `tournament.ts:798`. Dva hráči vypadlí v téže handě se stejným startovním stackem dostanou různá místa podle pořadí v poli. Podle pravidel TDA mají místo i výplatu dělit. Oprava: při shodě sloučit místa a rozdělit součet výplat přes `distribute`.
13. **Automatický úvěr a záporný limit peněženky se sčítají.** `packages/ledger/src/ledger.ts:269–279, 319–321`. Při zapnutém `economy.negativeBalanceLimit` i `economy.creditEnabled` jde hráč do mínusu o limit a navíc čerpá úvěr. Druhé `postCore` po `credit_draw` není chráněné (při selhání dluh zůstane bez služby). Oprava: kombinaci zakázat ve validaci nastavení, při selhání kompenzační `credit_repay`.
14. **Zbytek žetonů při kurzu > 1 zůstává navždy na účtu stolu.** `packages/ledger/src/cash.ts:48–65`. Při výchozím kurzu 1 se neprojeví. Oprava: při zavření stolu zbytek převést domu a přidat kontrolu „zavřený stůl má 0“.

### Střední závažnost: webový klient

15. **Akce u stolu bez ochrany proti dvojímu odeslání.** `apps/web/src/table/TableScreen.tsx:209–213`, `ActionBar.tsx:56–85, 113–130`. Dvojklik nebo držení klávesy pošle akci vícekrát, hráč dostane chybu „nejsi na tahu“ u legitimní akce. Oprava: stav `pending` do příchodu potvrzení, `disabled` na tlačítkách, v klávesových zkratkách `if (e.repeat) return`.
16. **Částka sázky a buy-inu není hlídaná.** `ActionBar.tsx:108–126`, `TableScreen.tsx:806–816`. Prázdné pole = `NaN` („Raise NaN“), dialog částky dovolí hodnotu pod minimem i nad maximem; chyba přijde až ze serveru. Oprava: použít `NumInput` z `ui.tsx`, při opuštění pole ořezat, Potvrdit vypnout mimo rozsah.
17. **Odpojení: stará view zůstávají „živá“, odběr stolu se nikdy neruší.** `net.ts:66–70`, `TableScreen.tsx:160–162`. Při výpadku jsou tlačítka aktivní (vrátí jen „NETWORK“), po návratu do lobby server dál posílá view všech dříve otevřených stolů. `TableView.seq` klient ignoruje a offset hodin se počítá z každé zprávy, takže odpočet na mobilu poskakuje. Oprava: `table:unsubscribe` při odchodu ze stránky, view přijímat jen s rostoucím `seq`, offset vyhlazovat; tlačítka vypnout při `status !== 'online'`.
18. **Plánovaný tah je globální a nezruší se mezi handami.** `table/plan.ts:376–435`. „Fold“ kliknutý o přestávce složí příští handu; při přechodu na jiný stůl se provede tam; „Call“ dorovná jakoukoli částku i po velkém re-raise. Oprava: plán vázat na `{tableId, handId}`, u Call uložit částku.
19. **Token písma umožňuje CSS komentář.** `packages/tokens/src/theme.ts:52–80`. `isSafeValue` nezakazuje `/*`; hodnota `font.body = "x /*"` ve sdíleném motivu zakomentuje zbytek bloku a rozbije tmavý režim všem. Oprava: pro písma whitelist znaků, obecně zakázat `/*`, `*/`, `var(`.
20. **Časovač tahu po otevření stolu uprostřed tahu.** `TimerRing.tsx:4–19`. Kruh začíná na 100 % a ubývá dvakrát rychleji; interval 100 ms běží i bez deadline. Oprava: server posílat délku tahu, interval jen při aktivním deadline.
21. **Drobnější UX:** `theme-editor.tsx:189–193` komponenta definovaná uvnitř renderu ztrácí fokus po každém znaku; `chat.tsx:133, 252` skok na konec při načtení starších zpráv a nativní `prompt()`; `ui.tsx:173–290` Modal bez focus trapu, sedadla jako `div` bez klávesnice; 66× nativní `confirm()`/`prompt()` (nepřeložitelné, špatné na mobilu).

### Střední závažnost: server a nasazení

22. **`trustProxy: true` věří jakékoli hlavičce `X-Forwarded-For`.** `apps/server/src/app.ts:272`, `docker-compose.yml` publikuje port na všech rozhraních. Všechny limity podle IP (zámek přihlášení, registrace, reset hesla, párování TV, veřejné přehledy) jdou obejít podvrženou hlavičkou a IP v auditu je falešná. Oprava: `trustProxy: 1` nebo adresa proxy; port publikovat jen na `127.0.0.1` nebo dát NPM do stejné docker sítě.
23. **`GET /api/settings/global` vrací celou globální vrstvu každému přihlášenému.** `http/routes.ts:363–366`; totéž nástroj asistenta `get_settings` (`assistant/service.ts:517–545`) a kontext pro poskytovatele AI (`:407`). Hesla tam nejsou, ale ano adresy SMTP, MQTT, Piper, uživatelské jméno k SMTP. Oprava: omezit na `nastaveni.globalni`, nebo zavést příznak „provozní“ u definic a filtrovat.
24. **Neošetřené promise → pád celého procesu.** `bets.ts:280, 480, 491, 542, 603`, `app.ts:594` (`void notify(...)` bez `.catch`), `index.ts` nemá `process.on('unhandledRejection')`. Chyba DB při zápisu oznámení ukončí server a vrátí běžící handy na poslední předěl. Oprava: `.catch` všude + globální obsluha s logem; `setErrorHandler` ve Fastify (dnes 500 vrací text výjimky).
25. **Nahrávání souborů bez omezení souběhu, ffmpeg bez časového limitu.** `routes.ts:1542, 1769, 1808` (16–32 MB base64 v JSON), `audio.ts:31–39`. Oprava: `bodyLimit` z nastavení, počítadlo souběžných nahrávek na uživatele, `AbortSignal.timeout` pro ffmpeg.
26. **Provoz předpokládá jedinou instanci, nic to nehlídá.** Kniha a stav stolů v paměti, plánovač tiká v každé instanci. Dvě repliky = duplicitní turnaje a rozjetá kniha. Oprava: `pg_advisory_lock` při startu a odmítnutí druhé instance, zdokumentovat „1 replika“.
27. **Kaskádní mazání uživatele rozbije historii ostatních.** `db/schema.ts` (`hand_players`, `game_results`, `rating_events`, `xp_events` s `onDelete: 'cascade'`), `maintenance.ts:522`. Po smazání hráče přestane sedět součet v detailu handy a přepočet ratingu už není reprodukovatelný. Kniha je chráněná správně. Oprava: anonymizovat místo mazat, nebo `restrict`.
28. **Globální vrstva pro herní parametry je bez účinku.** `packages/shared/src/settings/templates.ts:54–66` doplní do každé šablony všechny klíče, takže globální hodnota např. `time.turnSeconds` se u žádné hry neprojeví, přestože ji formulář nabídne a uloží. Validace globální vrstvy navíc běží proti výchozím, ne efektivním hodnotám (`settings-store.ts:106–109`). Vrstva `game` není nikde použita. Oprava: herní klíče v globálním formuláři skrýt, nebo šablony ukládat řídce.
29. **Časová zóna je konstanta.** `packages/shared/src/schedule.ts:7` `DEFAULT_TZ`, používá roční statistika, výdaje, rating, ankety, kalendář, asistent; proměnná `TZ` z Docker Compose se v kódu ignoruje. Porušuje pravidlo 2. Oprava: `system.timezone` v registru nastavení.
30. **`liveCash.enabled` server nevynucuje** (`live-cash.ts:68` kontroluje `live.enabled`); `announcer.allowUserChoice=false` nebrání uložit vlastní hlas přes `PUT /api/me/settings`.

### Nízká závažnost (výběr)

- `auth/accounts.ts` změna e-mailu bez limitu pokusů (e-mail bombing); zámek přihlášení podle identifikátoru umožňuje zablokovat oběť; `authenticate` nekontroluje `status` účtu u existující relace.
- `gateway.ts:170–176` `announce:join` bez omezení počtu místností; žádný strop spojení na uživatele.
- `routes.ts:1577` `polls.create` bez zod schématu → `TypeError` → 500 při chybějícím `config`.
- `auth/approvals.ts:76–79` schválení se provede s oprávněními z doby žádosti.
- `assistant.autoKeys` dovoluje správci vyjmenovat klíče aplikované bez potvrzení (jde proti pravidlu 8, je to opt-in, aspoň zdokumentovat).
- `integrations/service.ts:351` URL webhooků bez zákazu privátních rozsahů (jen správce).
- `app.ts:284` cookie `secure` se určuje jen při startu; změna `system.publicUrl` v GUI se projeví až po restartu.
- `auth/crypto.ts:11` pozvánkový kód `b % alphabet.length` (mírné zkreslení, entropie dostatečná).
- `odds.ts:81` Monte Carlo šance používají `Math.random` (karty neovlivní, jen jednotnost).
- `voting.ts:91` uzavřená hlasování se nikdy nemažou; `readyTimer` se neruší ve `stop()`; odpojený hlasující zůstává v hlasování run-it.
- `view.ts`/`tables.ts` změna levelu uprostřed handy: UI ukazuje nové blindy, hraje se za staré (`handSettings` se ukládá, ale nečte).
- Skryté karty všech hráčů (i složené) se ukládají do DB (`stats.ts saveHand`); klientům se maskují správně, jen vědět kvůli zálohám.
- `apps/web/src/no-hardcoded-styles.test.ts` hlídá jen 11 barev a část prefixů, `.css` je z kontroly px vyjmuté, libovolné hodnoty `w-[70%]` projdou; `i18n-coverage.test.ts` nehlídá české literály v JSX (nalezeny v `diagnostics.tsx`, `ThemePreview.tsx`, `boards-appearance.tsx`, `aria-label` v `SettingsForm.tsx` a `CardView.tsx`, 50× `'cs-CZ'` natvrdo).
- Natvrdo zapsané ladicí hodnoty (pravidlo 2): intervaly úloh v `app.ts:857–1056` (1 s až 6 h), `scheduler.ts:70, 190` (tik 5 s, horizont 7 dní), `achievements.ts:214` (3 s), `email/service.ts:253–265`, `integrations/service.ts:201`, `mqtt.ts:65, 95`, `assistant/service.ts:876` (70 s), délky názvů a stránkování. Strukturální konstanty (3 pokusy journalu, pojistka 40 iterací) jsou v pořádku.
- `table.variant` má jedinou volbu a nikde se nečte; `table.straddleMultiplier` nemá `appliesTo: 'cash'`.
- `tables.ts:244–249` pro vyřazený klíč uloží `undefined` do nastavení stolu.
- Testy: `templates-matrix.test.ts:55` má `retry: 2`; asi 18 souborů čeká skutečným `setTimeout` (na pomalém stroji nestabilní); uložený `hands.rake` není nikde ověřen.

## Doporučené optimalizace výkonu

1. **`resolveSettings` stojí asi 300 µs a volá se 10–20× na jednu akci u stolu**, na každou událost statistik i na každou zprávu v rate-limiteru (`resolve.ts:24–27`, `table-actor.ts`, `stats.ts:93`, `gateway.ts:142`). Cache `defaults()` v registru a memoizace na verzi vrstev; `TableActor` může použít snímek `handSettings`.
2. **`useSettings()` na webu přepočítává celý registr při každém volání** (`apps/web/src/settings.ts:172–181`), `TableScreen` ho volá asi 8×, každé sedadlo znovu. `useNet()` překresluje celý stůl i při změně přítomnosti (`net.ts:104–112`). `TableScreen.tsx:102–120` effect bez závislostí měří DOM a registruje posluchače při každém renderu. Memoizovat podle identity stavu, selektor nad store, `ResizeObserver`.
3. **Žebříček a statistiky bez cache a bez indexů** (`stats.ts:299–368`): plný průchod `hand_players` při každém zobrazení; chybí indexy `hand_players(kind, played_at)`, `game_results(kind, finished_at)`, `hands(tournament_id)`.
4. **Plánovač čte všechny turnaje z DB každých 5 s** (`scheduler.ts:186`), tabulka roste navždy. `WHERE sched IS NOT NULL` + částečný index.
5. **Kniha v paměti kopíruje celé pole transakcí při každém zápisu** (`ledger.ts:162–182`) a roste bez omezení za běhu. Držet jen poslední dávku (historie je v DB).
6. **Broadcast stolu** volá `viewFor` pro každý socket a iteruje přes všechny sockety při každé změně (`gateway.ts:44–96`): pro domácí hernu v pořádku, při stovkách spojení zpomalí vysílání všem.
7. **Lint** je prakticky vypnutý (`-A all`); zapnout aspoň `react-hooks/exhaustive-deps` (hlásí 9 míst), `no-floating-promises`, `eqeqeq`, `no-unused-vars`.

## Doporučené pořadí oprav

1. Rake po odchodu (1), dvojí dobití (2), platba před usazením (3). Všechny tři se týkají peněz a mají jednoznačnou opravu.
2. Snímky migrací + test driftu (4), aby další změna schématu nerozbila nasazení.
3. ErrorBoundary (5), dvojité odeslání a částky u stolu (15, 16), reset časovače při odpojení (6), stará akce (7).
4. `trustProxy` a vazba portu (22), omezení `GET /api/settings/global` (23), `.catch` + globální obsluha chyb (24).
5. Živý cash (8), Journal pro evidenci (9), atomické výplaty (10), zbytek (11 až 14).
6. Výkon: cache `resolveSettings` a `useSettings` (největší efekt za nejmenší práci), indexy.
7. Aktualizace závislostí (`nodemailer`, Fastify kvůli `fast-uri`).

## Co bylo ověřeno jako správné

- **Účetní kniha:** synchronní, jediný zapisovatel, součet každé transakce 0, `Number.isSafeInteger`, idempotence s detekcí `KEY_REUSED`, dům/fondy/escrow/turnaj nikdy pod nulu, Journal dává pohyb knihy a stav stolu do jedné DB transakce. Zaokrouhlení výplat, dealů, bounty, rake, rakebacku a jackpotů vždy dorovnává součet. Refund při zrušení turnaje vrací přesně původní rozdělení platby. Sázky mají frontu `Serial` a jeden pohyb na vypořádání.
- **Skrytá data:** `buildView` pracuje whitelistem, cizí karty jen vlastní nebo odkryté, při hlasování run-it se hlasuje naslepo, `legalActions` jen hráči na tahu, TV a historie dál ořezávají. Žádné `dangerouslySetInnerHTML` na webu.
- **Oprávnění:** každá mutující služba kontroluje `perms.can` nebo vlastnictví; hierarchie rolí důsledná; Socket.IO řetězec autentizace → token bucket → zod → oprávnění → handler; CSRF přes `Origin` + `sameSite: lax`; argon2, tokeny 256 bitů jen jako otisk v DB; tajné údaje AES-256-GCM, nikdy v odpovědích ani exportech; Drizzle parametrizované dotazy, `spawn` s poli argumentů, nahrávky podle magických bajtů (SVG odmítnuto).
- **Engine:** pravidlo znovuotevření sázek, lichý žeton podle TDA, heads-up pořadí, straddle a BB ante přes záplatu, side poty, run it twice, odchod a příchod uprostřed handy, timeouty s grace; `guard()` zastaví jen daný stůl.
- **Turnaj:** přesazování jen mezi handami, hand-for-hand, přestávky s pojistným časovačem, pozdní registrace kontroluje `FULL` před platbou (až na nález 3), dohoda zablokovaná při otevřených oknech.
- **Nastavení:** 616 parametrů, výchozí hodnoty v rozsahu, výčty platné, závislosti existují, `scopeAllowed` brání hráči přepsat stolní parametr, mutabilita „mezi handami“ vynucena na serveru.
- **Nasazení:** obraz běží pod uživatelem `node`, healthcheck, DB jen v interní síti, hlavní klíč mimo DB.

## Opravy po auditu (3. 11. 2026)

Čísla odkazují na nálezy výše. Každá oprava má test; nové parametry jsou v registru nastavení s výchozí hodnotou.

### Vysoké nálezy

1. **Rake při odchodu:** doba od konce handy do zaúčtování (animace showdownu) se bere jako „uprostřed handy“ (`settling` v `table-actor.ts`). Odchod, maximální sit out i odstranění hráče turnajem se v ní odloží na předěl, rake, 7-2 bonus i jackpoty se vždy zaúčtují. Test `settling-and-disconnect.test.ts`.
2. **Dvojí dobití:** vyřízení žádosti si žádost nejdřív zabere podmíněnou změnou stavu (`pending` → `deciding`), dobití má pevný klíč `request:<id>`, při chybě se žádost vrátí do `pending`. Test `audit-money.test.ts`.
3. **Pozdní registrace a re-entry:** místo se ověří před platbou (`canSeat` u sady stolů podle fyzicky volných míst); když usazení přesto selže, platba se vrátí a stav hráče obnoví. Test v `tournament.test.ts`.
4. **Snímky migrací:** dogenerované `0043` a `0044`, nový test `db-migrations.test.ts` hlídá drift (`drizzle-kit generate` nesmí vyrobit nový soubor).
5. **ErrorBoundary:** kolem celé aplikace i líně načítaných stránek, jedno automatické obnovení při selhání importu po nasazení nové verze, bezpečné dekódování adresy.

### Střední nálezy

- **6** Odpojení hráče na tahu čas jen zkracuje na toleranci odpojení, nikdy neprodlužuje; běžící rezerva se o spotřebovaný čas zkrátí, zavolaný čas zůstává.
- **7** Zpráva `table:act` nese `handId`; server starou nebo zdvojenou akci odmítne kódem `STALE_ACTION`, klient ji tiše zahodí.
- **8** Operace jedné živé cash hry běží za sebou (zámek na hru).
- **9** Kontrola konzistence má nové kontroly: úschova otevřených sázek = držené vklady, výdaje domu odkazují na existující pohyb, žádosti zaseklé ve stavu „vyřizuje se“. (Evidence se dál zapisuje mimo dávku knihy; kontrola ji odhalí.)
- **10** Výplaty turnaje běží v `try/catch`: při chybě turnaj zůstane běžící s `finishError`, událost `finishFailed` jde do chatu, `retryFinish()` dokončení zopakuje (klíče pohybů jsou pevné, nic se nevyplatí dvakrát). Ruční úprava knihy nesmí na účty běžících her ani na úschovy.
- **11** Předěl po zrušení stolu turnajem nic nepřepíše (`phase === 'stopped'` se kontroluje po `onBoundary`).
- **12** Hráči vyřazení v téže handě se stejným stackem dělí výplatu za svá místa rovným dílem (pořadí míst zůstává podle sedadel).
- **13** Kontokorent a záporný limit se nesčítají: se zapnutým kontokorentem je dolní mez peněženky nula a čerpá se celý chybějící rozdíl. Když původní pohyb selže i po čerpání, čerpání se vrátí (`credit_repay`). Rozhodnutí majitele (3. 11. 2026): nastavení `economy.negativeBalanceLimit` je odstraněno (vyřazený klíč, uložená hodnota se tiše vypustí); peněženka nikdy nejde pod nulu a chybějící Korony kryje jen kontokorent, který navíc platí jen pro platby za hru a má limit na hráče.
- **14** Při zavření cash stolu připadne zbytek žetonů (kurz > 1) domu, účet stolu končí na nule.
- **15 až 21** Web: ochrana proti dvojímu odeslání akce, částky přes `NumInput` s ořezem na rozsah, view jen s rostoucím `seq`, vyhlazený posun hodin, odhlášení odběru stolu, pruh „Obnovuji spojení“, plánovaný tah vázaný na stůl a handu (Call s částkou), tokeny písma bez CSS komentářů, kruh časovače podle nastavení, editor vzhledu bez ztráty fokusu, chat drží dole jen když byl dole, dialog ztlumení místo `prompt()`, Modal s focus trapem a `inert`, sedadla a karty z klávesnice, service worker čeká na potvrzení nové verze.
- **22** `TRUST_PROXY` (výchozí jen vnitřní síť) a `BIND_ADDRESS` v `.env`; viz `docs/NASAZENI.md`.
- **23** `GET /api/settings/global` vrací hráčům vrstvu bez provozních klíčů (`omitInternalSettings`), asistent je nevidí ani neposílá poskytovateli AI.
- **24** Globální obsluha chyb Fastify (`UNKNOWN` bez textu výjimky), `unhandledRejection` a `uncaughtException` v `index.ts`, `.catch` u všech oznámení.
- **25** Limit těla a souběhu nahrávání z nastavení (`system.uploadMaxConcurrentPerUser`), ffmpeg s časovým limitem (`sounds.ffmpegTimeoutSeconds`).
- **26** Zámek jediné instance (`pg_try_advisory_lock`) při startu na PostgreSQL; druhá instance skončí s českou hláškou.
- **27** Smazání hráče v Údržbě ho anonymizuje („Smazaný hráč 1a2b3c4d“): kniha, handy, výsledky, rating a XP zůstávají; relace, tokeny, role a osobní nastavení se smažou; cizí klíče statistik mají `restrict` místo `cascade` (migrace `0045`).
- **28** Herní klíče nejdou uložit do globální vrstvy (`globalHidden`, `SCOPE_NOT_ALLOWED`); vyhodnocení vrstev se nemění. Konzistence nastavení se kontroluje proti efektivním hodnotám, hodnoty mimo rozsah se při načtení oříznou (s varováním v logu).
- **29** `system.timezone` (výchozí Europe/Prague) používají roční statistika, výdaje, rating, ankety, kalendář, plánovač, asistent i XP.
- **30** `liveCash.enabled` server vynucuje; osobní volba hlasu respektuje zákaz správce (`userChoiceDependsOn`).

### Nízké nálezy (opravené)

Limit pokusů o změnu e-mailu, blokovaný účet bez platné relace, strop spojení na hráče (`system.maxSocketsPerUser`) a místností announce (`system.announceRoomsPerSocket`), zod pro ankety, opětovná kontrola práv při schválení, pozvánkový kód bez zkreslení, `nosniff` u zvuků, webhooky bez vnitřních adres (`integrations.allowPrivateUrls`), varování u `assistant.autoKeys`, cookie `secure` při každém nastavení, šance na výhru s kryptografickou náhodou, `readyTimer` se ruší při zastavení stolu, vyřazené klíče nastavení se tiše vypouštějí, `table.variant` odstraněn, `table.straddleMultiplier` jen pro cash, lint zapíná další pravidla (`exhaustive-deps`, `no-unused-vars`, `no-fallthrough`, …).

### Výkon

`defaults()` a `resolveSettings` s cache (95 µs → 0,1 µs, resolve tří vrstev 227 µs → 22 µs), `useSettings()` memoizované, selektor nad síťovým storem, `ResizeObserver` místo intervalu, mezipaměť žebříčku (`stats.cacheSeconds`), indexy `hands(tournament_id)`, `hand_players(kind, played_at)`, `game_results(kind, finished_at)`, plánovač čte jen plány, paměťová kniha nekopíruje historii při zápisu.

### Co zůstává (vědomě)

- Evidence sázek, výdajů a žádostí se zapisuje mimo dávku knihy (nález 9): kontrola konzistence to odhalí, přesun do Journalu je větší zásah.
- Uzavřená hlasování run-it se z paměti stolu nemažou (drobné, do zavření stolu).
- Změna levelu uprostřed handy: UI ukazuje nové blindy, hraje se za staré (jen zobrazení).
- Nové serverové hlášky a pruhy na webu nebyly prohlédnuty v prohlížeči (změny vzhledu jsou malé), doporučeno projít `scripts/screenshots.mjs`.
- Závislosti: aktualizovány `nodemailer` (10.3.1), `@fastify/cookie`, `@fastify/static`, `fast-uri` (3.1.9); zbývají 2 střední nálezy v `glob`/`minimatch`, které přináší `@fastify/static` a nejdou opravit bez nové verze této knihovny (dopad: teoretické zpomalení při servírování statických souborů, ne únik dat).

### Kontrola po opravách

Typy a lint (včetně nových pravidel) bez chyb; testy: 1372 prošlo, 1 přeskočen (zátěžový). Prohlédnuto v prohlížeči: lobby, přehled stolů, stránka stolu, pruh o nové verzi aplikace s tlačítkem Obnovit; bez chyb v konzoli.
