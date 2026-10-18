# Stav projektu

## Fáze
- [x] Plán schválen (docs/PLAN.md)
- [x] Fáze 0: monorepo (pnpm), TypeScript, Vitest, Docker Compose, `.env.example`
- [x] Spike enginu (viz rozhodnutí)
- [x] Fáze 1A: nastavení, tokeny, překlady (hotovo, viz níže „Co funguje v 1A“)
- [x] Fáze 1B: engine, stůl, cash game, moduly, straddle, BB ante, noví hráči (zbývá jen odložené, viz „Co z 1B zbývá“)

## Co funguje v 1A
- Registr nastavení (`packages/shared/src/settings`): ~65 parametrů (stůl, časovač, časování handy, cash, ekonomika, speciální prvky, šance, osobní), závislosti, jednotky, příznak „kdy lze měnit“, pravidla konzistence s českými chybami.
- Vrstvy global → šablona → hra → stůl → hráč → zařízení s původem hodnoty a „vrátit na zděděné“.
- Generovaný formulář (slidery, přepínače, segmentová tlačítka, hledání, záložky) v `apps/web`.
- Šablony: 3 vestavěné (Cash – Klasika, Cash – Rychlovka, Retro – Kuchyňský stůl), export/import JSON, verze schématu a rámec pro migrace.
- Design tokeny (`packages/tokens`): světlý/tmavý/automatický režim, 2 motivy (klasický zelený, vysoký kontrast), kontrola kontrastu WCAG AA, bezpečný import motivů. Tailwind má vypnutou výchozí paletu, komponenty používají jen tokeny, hlídá to test.
- České texty jen v `packages/shared/src/i18n/cs.ts`.
- Server: zatím jen `/health` a `/api/settings/schema`.
- Testy: 37 zelených (nastavení vč. náhodných kombinací, tokeny, engine spike, zákaz natvrdo psaných stylů).

## Co z 1A zbývá (přesunuto)
- Uložení vrstev nastavení do PostgreSQL a synchronizace přes Socket.IO: přijde s DB schématem a účty ve fázi 2 (nyní jen localStorage jako cache).
- Rozhraní `can()` pro oprávnění ještě není (přijde na začátku 1B jako stub, plná verze ve fázi 2).
- Migrace šablon: rámec je hotový, první migrace vznikne při první změně schématu.
- Ve vestavěných šablonách chybí zbytek katalogu (přibude s příslušnými fázemi).
- ESLint konfigurace zatím není, hlídání stylů řeší test.

## Co funguje v 1B
- **Adaptér enginu** (`packages/game-core/src/adapter.ts`) s kontrolní sadou testů; neutrální `HandState`, na enginu nezávislé pohledy (`view.ts`) stavěné whitelistem polí. Test: hráč nikdy nedostane cizí karty ani balíček (60 náhodných hand × všichni hráči + divák), výhra bez showdownu neprozradí karty ani kombinaci.
- **Účetní kniha** (`packages/ledger`): dvojí zápis, součet transakce = 0, celá čísla, idempotenční klíče, limit záporného zůstatku, atomické provedení. `CashService`: buy-in, top-up, cash-out, vydání měny. Zatím jen v paměti (viz zbývá).
- **TableActor**: izolovaný stůl, buy-in/top-up/rebuy/cash-out, sit out/in, odchod uprostřed handy, hit-and-run ochrana, max. doba sit outu, předěl mezi handami, serverový časovač tahu + time bank + prodleva pro odpojené + sit out po N vypršeních, dokládání karet po all-inu po ulicích s prodlevami z nastavení, šance na výhru (přesný výčet, po potech, ověřeno proti nezávislému vyhodnocení), české popisy kombinací, událostní log (`onEvent`), uložitelný stav (`persisted()`), zrušení stolu vrací měnu.
- **Simulace s boty** (3 stoly, tisíce akcí, náhodné odchody, top-upy, odpojení, time bank): po každém kroku platí, že součet všech účtů včetně `mint` je 0 a účet stolu = žetony hráčů. Simulace našla a pomohla opravit 4 chyby (zastaralá kopie hráčů v enginu, ztráta výsledků při předělu, krátký all-in blind, kolize idempotenčních klíčů).
- **Server**: Socket.IO brána s jednotným řetězcem (přihlášení → rate limit → validace Zod → `can()` → handler), personalizované pohledy, plný stav po připojení z dalšího zařízení, odpojení označí hráče. Vývojové přihlášení přezdívkou (`devLogin`, ve výrobě vypnuto).
- **Klient**: obrazovka stolu (ovál, karty, pot, časovač v kruhu, akční lišta s posuvníkem a rychlými sázkami z nastavení, buy-in dialog, přepínač měna/BB). Ověřeno v prohlížeči proti botovi (`apps/server/scripts/dev-bot.ts`): rozdání, sázky, all-in, showdown s českým popisem.
- Testů celkem: 103, všechny prochází.

## Dokončení 1B: moduly, straddle, BB ante, noví hráči
- **Systém modulů** (`packages/game-core/src/modules`): modul má id, prioritu, závislosti, seznam klíčů nastavení (kontroluje se proti centrálnímu schématu) a háčky `beforeDeal`, `seatOptions`, `onHandStart`, `afterAction`, `onShowdown`, `afterPotAwarded`, `onHandEnd`, `onPlayerBusted`. Háčky běží v pevném pořadí; chyba v modulu stůl nezastaví, modul se pro stůl vypne a pošle se událost `moduleError`. Vestavěné moduly: ante, big blind ante, straddle, noví hráči. Nový prvek = nový modul + parametry ve schématu (schéma zůstává centrálně v `packages/shared`, aby formuláře fungovaly i v prohlížeči).
- **Straddle** (UTG i Mississippi, povinný i dobrovolný na žádost hráče, tlačítko „Chci straddle“ u stolu). Engine ho neumí, proto je v enginu **malá záplata** (`patches/@pokertools__engine.patch`, spravuje ji `pnpm patch`): straddle v rozdání, pořadí akcí a minimální zvýšení, a oprava čekání na big blind (originál přestane „čekajícího“ hráče nikdy posadit na BB). Sada testů pokrývá pořadí akcí, opci straddlera, minimální raise, krátký stack, heads-up.
- **Big blind ante a dead blind** jsou *mrtvé peníze* v adaptéru (nezávisle na enginu): hráči se strhnou před rozdáním, leží v potu a získá je vítěz hlavního potu (nejlepší ruka z nesložených, dělí se i lichý žeton). Důvod: původní výpočet potů v enginu by BB ante vrátil big blindu jako „nevyrovnanou sázku“.
- **Pravidlo pro nové hráče**: čekání na big blind (hráč je vidět jako „čeká na handu“) nebo dead blind (výše v BB v nastavení). Čekání se zruší, pokud by zbývalo méně než dva zkušení hráči.
- Nová nastavení: `table.straddleMandatory`, `table.deadBlindBb`; `table.ante` u BB ante znamená částku (0 = velikost big blindu).
- Testů celkem: 130. Simulace s pravidly (BB ante + straddle + noví hráči, dobrovolný straddle + dead blind, vše vypnuto) prošly na 11 různých seedech se zachováním součtu žetonů. Simulace našla další 2 chyby (ztráta podílu na mrtvých penězích při předělu a vítěz bez vkladu).

## Co z 1B zbývá (vědomě odloženo)
- **Pot-limit a fixed-limit**: engine je jen no-limit; bude v adaptéru (fáze 4, šablona Retro – Limit Hold'em).
- **Ukládání do PostgreSQL** (účetní kniha, stav stolů): rozhraní je připravené (`persist`, `restore`, `LedgerStore`), skutečné uložení je první úkol fáze 2. Do té doby restart serveru stav ztratí.
- **Plné varianty time banku** (time chips, šachové hodiny…): fáze 3. Hotový je zásobník na hru.
- **Výkon**: přesný výčet šancí před flopem blokuje server asi desetinu až půl sekundy; při více all-inech najednou bude potřeba worker vlákno.
- Klient: bez animací, zvuků, klávesových zkratek a předvoleb akcí. Fáze 12.
- `can()` je zatím kostra (plná verze ve fázi 2).

## Rozhodnutí
- **Engine: `@pokertools/engine` 2.1.0 (MIT).** Spike (`packages/game-core/src/engine-spike.test.ts`) potvrdil: maskování karet (cizí karty ani balíček nejsou v `view`), správné side poty při třech all-inech s různými stacky (nevyrovnaná část se vrací), snapshot/restore, vlastní RNG. Engine neobsahuje straddle (grep v dist prázdný); ante a rake ano. Straddle, BB ante, bomb pot, run it twice doplním v adaptéru/herní vrstvě (fork povolen majitelem, zatím nepotřeba).
- Doména: `poker.example.cz`.
- Fáze: 1 dělena na 1A/1B, 6 na 6A–6C (schváleno).
- Engine je upravený přes `pnpm patch` (viz výše). Při aktualizaci verze enginu je nutné záplatu přenést a znovu spustit kontrolní testy adaptéru.

## Otevřené otázky
- Fixed-limit a pot-limit: engine je podle README jen no-limit; ověřit ve fázi 1B.

## Fáze 2 (hotovo)
- **Persistence**: PostgreSQL (produkce, `pg`) a PGlite (vývoj/testy), migrace Drizzle `0000–0004`. Účetní kniha je v paměti autoritativní a ukládá se přes `Journal` (dávky v jedné transakci, při chybě zápisu server skončí). Stavy stolů se ukládají na předělech mezi handami, po restartu se stoly i kniha obnoví.
- **Účty a oprávnění**: argon2, cookie relace, registrace na pozvánku, katalog oprávnění, role se silou 0–100, rozsahy, platnost, limity, schvalování čtyřma očima, ochrana posledního hlavního administrátora, audit log (tajné hodnoty se v něm maskují).
- **Tajné údaje** (AES-256-GCM, rotace klíče), **e-mail** (SMTP, fronta s opakováním, denní limit, šablony, české chyby SMTP).
- **Peněženka**: dobití, strhnutí, ruční úprava, žádosti hráčů, přehled knihy, vyúčtování s minimálním počtem převodů.
- **Lobby**: zakládání stolů ze šablon s limity, úpravy podle pravidla „kdy lze měnit“ (odložené změny se použijí po handě), zrušení.
- **Chat**: kanály (veřejné, soukromé zprávy, skupiny, stoly), odpovědi, úpravy, reakce, připínání, zmínky, vyhledávání, nepřečtené, ztlumení, ignorování, moderace, přítomnost.
- **CLI** (`dist/cli.js`): `recover-admin`, `list-admins`, `rotate-key`. **Produkční bundle** přes esbuild, server umí servírovat sestavený web. **Docker**: obraz se staví a startuje (ověřeno, `/` vrací web, přihlášení běží), `docker-compose.yml` s databází a zálohami.
- **Webový klient**: přihlášení/registrace, lobby, stůl, peněženka, profil a osobní nastavení, chat, správa (uživatelé, pozvánky, role s maticí, pokladna, schvalování, e-mail, tajné údaje, globální nastavení, audit). Test `i18n-coverage` hlídá, že každý použitý text existuje v překladech.
- Ověřeno v prohlížeči proti botovi: přihlášení, usednutí s buy-inem, rozdání, sázky, all-in. Dříve hlášené chyby WebSocketu v konzoli byly jen z okamžiku startu dev serverů, po čerstvém načtení je konzole čistá.
- Testů celkem: 283 (27 souborů), `pnpm -r typecheck` čistý.
- README (česky) je v kořeni repozitáře.

## Co z fáze 2 zbývá
- (hotovo) E-mailové předvolby uživatele: vyřízení žádosti a rozhodnutí o schválení, vypnutelné v osobním nastavení; bezpečnostní e-maily jdou vždy.
- (hotovo) Správa → Stoly: přehled všech stolů, úprava nastavení a zrušení.
- (hotovo) Systémová zpráva v chatu stolu při změně nastavení (hned i od další handy).
- Revize českých textů a dokončení leštění klienta (stavy načítání/prázdné stavy).
- Odložené z dřívějška: pot-limit/fixed-limit, worker vlákno pro šance před flopem, animace/zvuky/zkratky, čekárna.

## Další krok
- Fáze 3: turnaje, výplaty, poplatky, účet herny, plné varianty time banku, další šablony.

## Fáze 3: Turnaje, výplaty a poplatky

### Hotovo (kroky 3.1 až 3.3)
- **Jednostolový turnaj** (`packages/game-core/src/tournament`): registrace a odhlášení s vrácením plateb, start (ručně, nebo sám při plném stole), náhodné rozsazení kryptografickým RNG, vypadávání s pořadím (souběžná vypadnutí podle stacku na začátku handy), vítěz a výplaty. Datový model je připravený na víc stolů (turnaj je oddělený od stolu), přesazování a balancování zatím není.
- **Turnajové žetony nejsou měna**: žijí jen u stolu (`TableActor` v turnajovém režimu), v knize nejsou. Test ověřuje, že kniha obsahuje jen peněženky, účet turnaje, dům a mint, a že součet žetonů u stolu vždy odpovídá zaplaceným vstupům, rebuy a add-onům.
- **Peníze**: účet `tournament:<id>` je prize pool (buy-in, rebuy, add-on), poplatek jde na účet domu. Typy pohybů `turnaj_buyin / rebuy / addon / vyplata / refund` (poplatek je součástí transakce vstupu). Po výplatách je pool přesně nulový. Zrušení vrátí všechny platby včetně poplatků.
- **Hodiny**: level podle času nebo počtu hand, přestávky po N levelech (rozdávání stojí, hodiny levelu také), pauza/pokračování zmrazí čas, poslední level trvá dál. Blindy se mění od další handy.
- **Struktura blindů**: vlastní zápis (`25/50, 50/100/10`) s kontrolou, nebo generátor podle cílové délky a startovního stacku (rostoucí „hezké“ blindy, ante od poloviny).
- **Rebuy, add-on, re-entry, pozdní registrace**: vše z nastavení (do kterého levelu, cena, žetony, nejvíc kolikrát, kdy je rebuy možný, čas na rozhodnutí po vypadnutí). Hráč s nulovým stackem čeká na rozhodnutí a pak je vyřazen.
- **Výplaty**: předvolby (standardní podle počtu hráčů, vítěz bere vše, první dvě/tři místa, vlastní procenta), zaokrouhlení výher na zadanou jednotku, zbytek vítězi / herně / po jednotkách od prvního místa. Součet výher a zbytku se vždy rovná poolu (2000 náhodných pokusů). Bublina se hlásí v chatu a na stránce turnaje.
- **Server**: tabulka `tournaments`, stav turnaje se ukládá v jedné dávce s účetní knihou a stavem stolu, **po restartu serveru turnaj pokračuje** (hráči, žetony, level, prize pool). API `/api/tournaments` (přehled, detail, založení, úprava nastavení, přihlášení, odhlášení, rebuy, add-on, re-entry, start, pauza, pokračování, zrušení). Oprávnění `turnaj.hrat` (nové), `turnaj.vytvorit`, `turnaj.upravit_*`, `turnaj.zrusit_*`, `zasah.pauza`. Systémové zprávy v chatu stolu (start, level, přestávka, vypadnutí, bublina, konec).
- **Aktualizace oprávnění**: nové položky katalogu se při upgradu jednorázově přidají předpřipraveným rolím (tabulka `system_meta`), aby starší instalace nepřišly o nové funkce.
- **Klient**: nabídka Turnaje (přehled, založení ze šablony, editor struktury s generátorem, posuvníky pro vlastní výplaty s dorovnáním na 100 % a zámky), stránka turnaje (hodiny s odpočtem, aktuální a další level, pořadí, náhled výplat, tlačítka podle toho, co smí hráč dělat, úprava nastavení), stůl turnaje v žetonech bez cash tlačítek.
- **Šablony**: Klasický freezeout, Domácí rebuy s add-onem, Sit & Go Turbo.
- Testů celkem: 314 (z toho turnaje: 25), `pnpm -r typecheck` čistý. Ověřeno v prohlížeči s boty: založení, přihlášení, start, hra, chat stolu.

### Hotovo (kroky 3.4 a 3.5)
- **Turnajové poplatky**: poplatek navíc (celý herně), procentní odvod herně z každého vstupu/rebuy/add-onu, příspěvek do pojmenovaného fondu. Každá platba si pamatuje své rozdělení, takže odhlášení i zrušení vrací přesně to, co se vybralo. Hráč vidí rozdělení předem na stránce turnaje.
- **Garance (overlay)**: při skončení turnaje se chybějící část prize poolu doplní nejdřív z účtu herny, zbytek se vydá jako nová měna (typ pohybu `turnaj_overlay`, viditelné v knize). Výhry se počítají z garantovaného poolu.
- **Přehled pro pokladníka** (Správa → Finance): za každý turnaj vstupy, vybráno, prize pool, poplatky, odvod, fond, doplatek garance a vyplaceno, součty, zůstatek herny a fondů.
- **Rake u cash her**: procento z potu se stropem, „no flop, no drop“, nevyrovnaná sázka se nezpoplatňuje, rake je celý násobek kurzu žetonů. Strhne se vítězům poměrně a stejnou částku hned přesune kniha ze stolu domu a (podle nastavení) do jackpotového fondu. Hráči vidí rake a stav jackpotu u stolu i v lobby.
- **Jackpoty**: royal flush (obě karty z ruky) a bad beat (prohrávající čtyřka nebo lepší s oběma kartami z ruky proti silnější ruce; dělí se poražený / vítěz / ostatní v handě). Výplata z fondu jde na stůl hráčům, v chatu stolu se objeví zpráva.
- Testů celkem: 328, `pnpm -r typecheck` čistý. Simulace s boty běží i s rake a jackpoty a kniha vždy sedí.

### Hotovo (kroky 3.7 a 3.8)
- **Režimy time banku** (`time.bankMode`): společná rezerva (dosavadní), časové žetony (počet a délka z nastavení), šachové hodiny, Fischer (přírůstek po tahu), Bronstein (vrácení nejvýš spotřebovaného), jen pevný limit tahu (shot clock). Doplňování rezervy po N handách se stropem. Odpojený hráč čeká dál jen po dobu prodlevy pro odpojené. U sedadla se ukazuje skutečná rezerva.
- **Zavolání času** (`time.callClockEnabled`): hráč v handě zkrátí tah soupeře na zadaný čas, rezerva soupeře se nepoužije, jednou za tah. Tlačítko u stolu, příkaz `table:callClock` přes oprávnění a rate limit.
- **Vyúčtování období** (Peněženka → Vyúčtování večera): cash a turnaje zvlášť i dohromady, rozpad po hrách, součty, zisk herny a minimální převody. U cash stolů, kde hráč ještě sedí, se počítají žetony u stolu. Oprávnění `mena.vyuctovani` vidí všechny, ostatní jen svůj řádek a své převody. Přibyly české názvy nových typů pohybů v historii.
- Testů celkem: 343 (časové režimy mají vlastní sadu i simulace s boty), `pnpm -r typecheck` čistý.

### Hotovo (zbytek fáze 3: 3.5 zbytek, 3.6, 3.9, 3.10)
- **Rakeback** (podíl z rake zpět těm, kdo ho zaplatili, poměrně podle vkladu do potu, jen z podílu herny), **poplatek za čas u stolu** (pevná částka každému sedícímu po intervalu) a **jackpot high hand** (na konci období dostane část jackpotu nejlepší ruka z showdownu; chybí-li hráč u stolu, jde výplata do peněženky). Nové typy pohybů `rakeback`, `time_charge`. High hand se po restartu serveru nesbírá od začátku (období se neukládá).
- **Náhled poplatků a délky při zakládání turnaje**: kolik hráč zaplatí, kam peníze jdou, prize pool a doplatek garance pro zadaný počet hráčů, a tlačítko **Odhadnout délku** (simulace s boty ve virtuálním čase, tři běhy, medián a rozptyl; orientační, boti hrají rychleji než lidé).
- **Šablony turnajů** (celkem 9): freezeout, rebuy s add-onem, Turbo, re-entry, Hyper Turbo, Deep stack, vítěz bere vše, heads-up duel, freeroll (garance 300 doplní herna) a retro kuchyňský turnaj.
- **Simulace turnajů**: matice 8 nastavení (level po handách s přestávkami, heads-up, plných 10 hráčů s vlastními procenty, freeroll, odvod+fond+garance, Fischer, časové žetony, rebuy+add-on+re-entry+pozdní registrace) plus dřívější sady; po každém kroku platí invarianty (kniha nulová, žetony u stolu = zaplacené vstupy, žádná chyba stolu), na konci pool nulový a výplaty = pool + doplatek garance.
- Testů celkem: 354, `pnpm -r typecheck` čistý. **Fáze 3 je hotová** s výjimkou odložených položek níže.

### Odložené z fáze 3
- Turnaj na více stolech (přesazování, balancování, finálový stůl), plánované turnaje (fáze 5), e-maily o turnajích.
- Rebuy/add-on/re-entry se v odhadu délky nesimulují.

## Rozhodnutí o textech
- **Tykání**: všechny texty v aplikaci, e-mailech, hláškách serveru a README tykají (rozhodl majitel). Nové texty piš v tykání.

## Fáze 4: Bounty, dealy, speciální prvky, hlasovací engine

### Hotovo: bounty, PKO, mystery (po dohodě před hlasovacím enginem)
- **Typy**: fixní bounty, progresivní (PKO: zadaná část hlavy hned, zbytek se přičte k hlavě vyřazujícího) a mystery (odměna je překvapení, ukáže se po vyřazení). Podíl z buy-inu a rebuy, který jde do bounty, je v nastavení (bounty nese vstup a rebuy, ne add-on); kontrola, že bounty + odvod herně + fond nepřesáhnou 100 % buy-inu.
- **Peníze**: samostatný účet `bounty:<turnaj>`, odměny v měně typu `bounty` hned při vyřazení, nebo vše na konci (`tournament.bountyPayout`). Zbytek na účtu bounty (hlava vítěze, nevyplacené odměny) připadne na konci vítězi. Zrušení turnaje vrací vstupy i nevyplacenou bounty; už vyplacené odměny zůstávají hráčům.
- **Kdo koho vyřadil**: stůl po handě pošle turnaji, kolik kdo vložil a vyhrál. Vyřadili ho vítězové, kteří měli vloženo aspoň tolik co on (jinak vítěz s nejvyšším vkladem). Při rozděleném potu se bounty dělí rovným dílem, nebo podle výhry; hráč, který vyřadí víc lidí najednou, dostane všechna bounty. Hráč, který po vypadnutí koupí rebuy, o svou hlavu přišel (vyplatila se) a rebuy mu založí novou.
- **Mystery**: při startu se hodnoty vylosují z žebříčku násobků a přeškálují tak, aby jejich součet přesně odpovídal vybrané bounty (nic nevznikne ani nezmizí); pozdější vstupy přidají do pytlíku základní hodnotu.
- **Klient**: u sedadel ikona ☠ s hlavou (fixní a PKO; u mystery se hlavy neukazují), na stránce turnaje popis bounty, sloupce Hlava a Bounty v pořadí, bounty u výsledků, sloupec v přehledu financí, zprávy o vyřazení v chatu, vyúčtování počítá bounty k turnajům. Šablony: bounty, PKO, mystery.
- **Opravená chyba**: odhlášení a nová přihláška stejného hráče použily stejný klíč v účetní knize, takže druhý vstup byl zdarma. Klíč má nově pořadové číslo vstupu.
- Testů celkem: 367, `pnpm -r typecheck` čistý. Simulace s boty pro všech pět variant (včetně rebuy, re-entry, pozdní registrace a zrušení) hlídá, že účet bounty sedí a po skončení je nulový.

### Hotovo: hlasovací engine a dealy
- **Hlasovací engine** (`packages/game-core/src/voting.ts`): ano/ne o návrhu s pravidly zadanými při návrhu: kdo hlasuje, váhy, práh (jednomyslně, většina, procenta), časový limit (kdo neodpoví, nesouhlasí), tajnost (do uzavření se neukazují cizí hlasy ani součty). Předčasné rozhodnutí, když už práh nejde dosáhnout. Odchod hlasujícího přepočítá hlasování. Stav je čistá data a ukládá se (turnaj ho drží ve svém stavu), po restartu serveru hlasování pokračuje s uloženými hlasy a časovačem. Použije ho deal a půjde ho použít pro run it twice a pauzu.
- **ICM** (Malmuth–Harville, dynamické programování přes podmnožiny, rychlé i pro 10 hráčů) a čisté funkce dělení (`packages/shared/src/tournament/deal.ts`): ICM, chip chop, rovným dílem a vlastní částky. Součet částek je vždy přesně dělená částka, zaokrouhlení na jednotku výher, zbytek hráči s nejvíc žetony.
- **Dohoda v turnaji**: nastavení (povolit, které metody, nejvýš při kolika hráčích, čas na hlasování, kolik smí zůstat na hru, pauza po zamítnutí). Lze navrhnout, až skončí rebuy, add-on i pozdní registrace a zbývá 2 až N hráčů; navrhne ji zbývající hráč (automaticky souhlasí) nebo organizátor. Částky počítá server z aktuálních žetonů a drží se jako snímek v návrhu. Platí jen při souhlasu všech zbývajících; vyřazení hráče během hlasování návrh zruší. Dělí se součet výher za první k míst (k = zbývající), ostatní dostanou výplatu za své místo.
- **Ponechání části na hru**: tato část se nerozdělí a dostane ji vítěz, který se dohraje, spolu se svým dohodnutým dílem. Bez ponechání dohoda turnaj hned ukončí, pořadí zbývajících je podle žetonů, zbytek bounty se dělí podle zbývajících hlav.
- **Klient**: panel dohody na stránce turnaje (srovnání metod vedle sebe, výběr metody, ponechání na hru, vlastní částky se kontrolou součtu, hlasování s odpočtem a stavem hlasujících) a stejný panel u stolu turnaje, když se hlasuje. Zprávy v chatu, API `/api/tournaments/:id/deal` (+ propose, vote, cancel). Ověřeno v prohlížeči.
- Testů celkem: 390, `pnpm -r typecheck` čistý.

### Hotovo: speciální prvky u stolu a limitové hry
- **Run it twice/třikrát**: když jsou všichni all-in a zbývá rozdat aspoň jednu kartu, stůl otevře hlasování (společný hlasovací engine, jednomyslně, limit v nastavení, kdo neodpoví, nesouhlasí). Karty hráčů se otočí, ale zbytek boardu se do rozhodnutí neukáže, takže hlasuje „naslepo“. Po souhlasu se board dokládá vícekrát ze zbytku téhož balíčku (společné karty z doby all-inu zůstanou), každý pot se dělí rovným dílem mezi běhy (lichý žeton dostane první běh) a vítěz každého běhu se určuje zvlášť, včetně vedlejších potů, mrtvých peněz a vrácené nevyrovnané sázky. Rozdíl proti výsledku enginu se promítne do žetonů při předělu; rake, jackpoty i bounty počítají už s přepočítaným výsledkem.
- **Ukázání karet** (po foldu nebo výhře bez showdownu, obě nebo jednu kartu) a **rabbit hunt** (karty, které by přišly, jednou za handu; smí hráči z handy, nebo kdokoli podle nastavení). Platí mezi koncem handy a rozdáním další.
- **7-2 bonus**: kdo vyhraje se sedmou a dvojkou různých barev, dostane od každého hráče v handě zadaný počet big blindů (nejvýš kolik hráč má); ve výchozím nastavení jen po showdownu, aby oznámení bonusu neprozradilo karty. Jen u cash her.
- **Bomb pot**: každou N-tou handu dá každý ante a preflop se dorovná automaticky, hraje se od flopu. Spustí se, jen když mají všichni dost žetonů na ante a blindy.
- **Limitové hry**: fixed-limit (small bet 1 BB před flopem a na flopu, big bet 2 BB na turnu a riveru, nejvýš N sázek na kolo, „all-in“ znamená největší povolenou sázku) a pot-limit (nejvyšší zvýšení je o velikost potu po dorovnání) jsou v adaptéru nad no-limit enginem, takže platí pro boty i klienta. Klient u fixed-limitu schová posuvník.
- **Klient**: dialog hlasování u stolu, zobrazení běhů pod sebou s výherci každého, tlačítka Ukázat karty / Rabbit hunt, karty ukázané soupeřem u jeho sedadla, štítek Bomb pot. Zprávy v chatu (7-2, bomb pot, rabbit hunt).
- **Šablony** cash: Divoký večer, Limit Hold'em a Pot-Limit (Heads-up cash už existoval).
- Testů celkem: 413 (simulace s boty běží i se všemi speciálními prvky a s oběma limity), `pnpm -r typecheck` čistý.

### Zbývá z fáze 4
- Hlasování o pauze přes společný engine (turnaj) a ruční zásahy ředitele se řeší ve fázi 5.
- Run it twice neběží, když dohrávání začne před flopem u hráče, který se právě odpojil (hlasování pak vyprší a hraje se jednou); u turnajů se hlasování bere stejně jako u cash.
- **Fáze 4 je hotová.**

### Původní plán fáze 4
Pořadí práce (podle `docs/PLAN.md`, upřesněno):
1. **Hlasovací engine** (jádro): návrh, kdo smí hlasovat (účastníci), váhy, kvórum (jednomyslně / většina), časový limit (bez odpovědi = nesouhlas), tajnost, výsledek jako událost. Postaví se jako obecná služba nad časovačem (FakeClock-friendly), uložená v paměti stolu a v DB u turnaje. Použije ji deal, run it twice a pauza.
2. **Bounty**: fixní, PKO (půlka vyplacena, půlka na hlavě), mystery (překvapení od určité fáze), dělení při split potu a vícenásobných vyřazeních; vyplácení hned, nebo na konci. Zavádí se do `Tournament` (typy pohybů `bounty`) a do účetní knihy.
3. **Dealy**: ICM, chip chop, rovným dílem, vlastní částky, srovnání vedle sebe, část ponechaná na hru; hlasují všichni zbývající, deal platí jen při jednomyslném souhlasu. Dělí se prize pool v měně, ne žetony.
4. **Speciální prvky u stolu**: run it twice/třikrát (hlasuje se při all-inu před riverem, balíček ze zbytku téhož), rabbit hunt, ukázání karet, 7-2 bonus, bomb pot, automatické otočení karet při all-inu (už částečně je).
5. **Dialogy u stolu** pro hlasování (deal, run it twice).
6. **Šablony**: bounty, PKO, mystery, Divoký večer, Heads-up cash, Limit Hold'em (fixed-limit v adaptéru).
7. **Testy**: split poty, PKO, ICM, run it twice s více poty, hlasování, simulace s boty.

Otevřené: fixed-limit a pot-limit se v enginu nedají (jen no-limit), budou se dělat v adaptéru až na konci fáze; run it twice vyžaduje úpravu rozdávání v adaptéru (druhý board z téhož balíčku).

## Fáze 5: Plánované turnaje (plán)
Cíl: turnaj jde naplánovat dopředu (i opakovaně) a pak proběhne sám od otevření registrace po výplatu.
1. **Plánovací pravidla** (čisté funkce, časové pásmo Europe/Prague): jednorázově, každý N-tý týden v zadaný den, n-tý den v měsíci („první čtvrtek“, „poslední pátek“); správně přes přechod letního času. Testy.
2. **Data**: tabulka \`schedules\` (pravidlo, šablona, nastavení, kolik minut před startem se otevře registrace, zapnuto) a nové sloupce u turnaje (plánovaný start, otevření registrace, kolikrát odloženo, odkud pochází).
3. **Plánovač** (restart-safe, vše z DB, tikání každých pár sekund s vyměnitelnými hodinami): vytváří nadcházející výskyty, ve správný čas otevírá registraci, v čase startu turnaj spustí (náhodné rozsazení), neonline hráči dostávají blindy jako sit out.
4. **Minimum a maximum hráčů**: když se nesejde minimum, podle nastavení zrušit (vrátit buy-iny), odložit o X minut (nejvýš N-krát), nebo začít i s menším počtem. Odhlášení s vrácením buy-inu do nastaveného času před startem.
5. **Pojistky bez admina**: automatická pauza, když klesne počet připojených hráčů pod hranici (a pokračování po návratu); ostatní hlasování o pauze přes společný engine.
6. **Upozornění**: připomenutí (např. 24 h, 1 h, 10 min), otevření registrace, zrušení a odložení v aplikaci a e-mailem. Web push (VAPID) a PWA je v plánu jako další krok (vyžaduje service worker).
7. **Kalendář turnajů** v lobby (odpočet, registrovaní) a export ICS.
8. **Série a ligy**: spojení turnajů do série s bodováním a žebříčkem, finálový turnaj pro nejlepších N.
9. **Testy s posunutým časem**: celý turnaj bez zásahu, zrušení při nedostatku hráčů, odložení, restart uprostřed.

Zásah admina (úprava, pozastavení, zrušení) zůstává a zapisuje se do audit logu.

### Fáze 5: výsledek
**Hotovo:** plánovací pravidla (jednorázově, denně, týdně, každý 2. týden, první/poslední den v měsíci, pásmo Europe/Prague včetně letního času), plánovač odolný proti restartu (otevření registrace, připomenutí, automatický start, odložení, zrušení s vrácením buy-inů, start i s menším počtem hráčů), automatická pauza při nedostatku připojených hráčů, upozornění v aplikaci (zvonek) i e-mailem, kalendář v lobby a export ICS, série a ligy s bodováním (tabulka nebo lineárně, nejlepších N výsledků) a finále jen pro nejlepší. Klient: tlačítko Naplánovat turnaj, záložky Přehled / Kalendář / Série, údaje o plánu v detailu turnaje. Testy: 437 prošlo, typecheck čistý.
**Odloženo:** turnaj na více stolech, hlasování o pauze přes společný engine (zatím jen automatická pauza).

### Web push a PWA (dodatek k fázi 5)
Server si při prvním použití vytvoří VAPID klíče (soukromý šifrovaně mezi tajnými údaji, veřejný v systémových údajích), odběry jsou v tabulce `push_subscriptions` (jedno zařízení = jeden odběr, mrtvé se samy mažou). Každé upozornění na turnaj jde i jako push. Klient má manifest, ikonu, service worker (jen push, nic se nekešuje) a přepínač „Posílat upozornění i mimo aplikaci“ ve zvonku. Na iPhonu push funguje až po přidání aplikace na plochu. Testy: 439 prošlo. V reálném prohlížeči s push službou zatím neověřeno (vyžaduje HTTPS na `poker.example.cz`).

## Fáze 6A: statistiky a historie hand (část 1 ze 3)
**Hotovo:** po každé handě (cash i turnaj) server uloží akce, board, výsledky a skryté karty (`hands`, `hand_players`); výsledky turnajů do `game_results`. Z toho se počítá VPIP, PFR, 3-bet, WTSD, W$SD, faktor agrese, největší pot, nejlepší vyhraná ruka a zisk z cash her i turnajů. Žebříček za sezónu i celou historii (cash a turnaje zvlášť i celkem), správa sezón (oprávnění `statistiky.sezony`), historie vlastních hand s přehráním po akcích. Cizí karty se ukážou jen když byly odkryté (showdown nebo dobrovolné ukázání), vlastní vždy; cizí handy vidí jen účastníci a správce statistik. Po době uchování (výchozí 365 dní, nastavitelné) se smažou jen akce a karty, součty zůstanou. Klient: stránka Statistiky (moje, žebříček, historie hand s přehráváním, sezóny) a graf zůstatku z pohybů v peněžence.
**Neověřeno / zbývá:** přehrávání jsem ověřil jen testem na serveru, v prohlížeči jen prázdné stránky (bez odehraných hand). Dobrovolné ukázání karet po handě se zapíše podle události `shown`. Statistiky před touto změnou nejsou (handy se dřív neukládaly).
**Další části fáze 6A:** (2) chat navíc: push na zmínky a DM, obrázky/GIFy, karty turnajů, automatické zprávy, e-mailový souhrn; (3) zvukové emotikony (ffmpeg v Dockeru).

## Fáze 6A, část 3: zvukové emotikony
**Hotovo:** knihovna zvuků (`sound_emotes`, oblíbené, ztlumení), vestavěná sada šesti zvuků syntetizovaná přímo serverem, nahrávání s kontrolou formátu podle obsahu, velikosti a délky, ořezem a normalizací hlasitosti přes `ffmpeg` do jednotného mp3, kvóta úložiště a limit zvuků na hráče, osobní zvuky a sdílení se schvalováním kurátorem (oprávnění `emotikon.*`), skrývání a mazání správcem. Odesílání do chatu (zpráva `:zkratka:` + živá událost) i ke stolu (bublina u avataru), cooldown na hráče a na zvuk a limit za minutu (po překročení se emotikon ukáže bez zvuku). Příjemce si nastaví přehrávání, hlasitost a režim (všude / jen stůl / jen chat) v osobním nastavení, může ztlumit zvuk, hráče, kanál nebo stůl. Odemknutí zvuku po prvním kliknutí s tlačítkem, když prohlížeč přehrávání zablokuje. Nastavení pro správce je v kategorii „Zvukové emotikony“. Docker obraz má ffmpeg, zvuky jsou ve volume `/data/sounds`.
**Neověřeno:** skutečné zpracování přes ffmpeg (na vývojovém počítači není, testy používají zástupný převodník) a nahrávání s ořezem v prohlížeči. Při chybějícím ffmpeg server vrátí srozumitelnou chybu. Zvuk jako vlastní upozornění na zmínku / „jsi na tahu“ a klávesové zkratky zatím nejsou.

## Fáze 6A, část 2: chat navíc
**Hotovo:** push upozornění na zmínky (@) a na soukromé / skupinové zprávy (jen tomu, kdo není připojený; osobní předvolby `push.chatMentions` a `push.chatDm`, ztlumení kanálu tlačítkem 🔔/🔕, zmínky chodí i z ztlumeného kanálu); obrázky a GIFy ve zprávách (PNG, JPG, GIF, WebP, kontrola podle obsahu, limit velikosti a formátů v nastavení, SVG záměrně ne, stahují je jen čtenáři kanálu, nepřipojené obrázky se po dni mažou); karty turnajů a stolů v chatu (`{{turnaj:id}}`, `{{stul:id}}`, tlačítka „Sdílet v chatu“ na stránce turnaje a stolu); automatické zprávy do hlavního kanálu (nový turnaj, otevření registrace, start, vítěz a první tři místa; vypínatelné); e-mailový souhrn nepřečtených zpráv (denně / týdně podle osobního nastavení, jen s novými nepřečtenými, správce ho může vypnout pro všechny). Obsluha událostí chatu se nově řetězí, nepřepisuje.
**Neověřeno:** skutečné doručení push (potřebuje HTTPS a push službu prohlížeče), nahrání obrázku přes prohlížeč (ověřeno testem na serveru), skutečné odeslání souhrnu SMTP (ověřeno zařazení do fronty).
**Fáze 6A je tím celá hotová.** Zbývá z původního zadání jen drobnost: zvuk jako vlastní upozornění na zmínku a klávesové zkratky zvuků.

## Fáze 6B, část 1: XP a hodnosti
**Hotovo:** zkušenosti (`xp_events` s jedinečným klíčem hráč+zdroj+odkaz, součet a level v `player_progress`). Zdroje: odehraná handa, výhra na showdownu, cash sezení (stůl + den, od zadaného počtu hand), odehraný turnaj, umístění (za každého předčeného soupeře), umístění v penězích, výhra turnaje, vyřazení soupeře, první hra dne a týdne, účast v sérii. Ochrana proti farmení: minimum hráčů u handy / turnaje a volitelný denní strop (odměny za úspěchy ho obcházejí). Křivka levelů `základ × level^exponent` (výchozí 60 a 1,4), hodnosti editovatelné v nastavení (tvar `název|ikona|barva|od levelu`, oddělené středníkem), náhled tabulky levelů. Postup na vyšší level: upozornění v aplikaci, pruh s animací, při změně hodnosti zpráva v hlavním kanálu (vypínatelné). Ikona hodnosti u avataru u stolu a před přezdívkou v chatu (vypínatelné), stránka Postup. Turnaj nově vždy zapisuje, kdo koho vyřadil (`tournament_eliminations`), i bez bounty: základ pro rating.
**Opraveno:** nestabilní test `server.test.ts` (hra do výhry) čekal na krátké okno s výherci; nově hledá v celé historii přijatých pohledů.
**Zbývá z 6B:** (2) úspěchy (odznaky s odměnou XP), (3) rating OpenSkill turnajový a cash, divize, provizorní rating, neaktivita, sezónní reset, (4) zobrazení ratingu, graf, žebříček, zpětný přepočet XP a ratingu s náhledem dopadu. Handy se v XP počítají jen za nové; zpětný přepočet z historie přijde ve čtvrté části.

## Fáze 6B, část 2: úspěchy
**Hotovo:** katalog úspěchů v databázi (`achievements`, `player_achievements`), 16 vestavěných (první handa, stovka a tisícovka hand, výhra na showdownu, turnaje, výhry, vyřazení, lovec série, série, týden v kuse, velký pot, čtveřice / postupka v barvě / royal flush, desátý level). Podmínky jsou z pevné nabídky 11 typů s číselnou hodnotou, správce (oprávnění `statistiky.uspechy`, předvolená role Statistik) může přidávat vlastní, upravovat odměnu a vypínat; vestavěné jdou upravit a vypnout, ne smazat. Vyhodnocení po handě, po turnaji a po postupu na level; udělení je jednorázové, odměna jde zápisem XP (neomezuje ji denní strop), hráč dostane upozornění a pruh nahoře. Nově přidaný úspěch se doplní i zpětně všem hráčům, kteří ho z historie splňují. Vitrína úspěchů a správa jsou na stránce Postup.
**Neověřeno:** udělení v prohlížeči za skutečné hry (ověřeno testem na serveru a vzhled stránky).
**Chybí z původního zadání:** úspěch „vyhraný all-in s méně než 10 % šancí“. Potřebuje uložené šance na výhru při all-inu, které přibudou s EV korekcí ratingu (část 3).
**Výkon:** vyhodnocení úspěchů se slučuje na 3 s a zápisy XP si pamatují hotové bonusy dne a týdne. Při vypnutí serveru se čekající zápisy XP a statistik zahazují (dají se odvodit z uložených hand). Při simulaci s okamžitým během her (testy) zápisy zaostávají za hrou, v reálném čase to nevadí.

## Fáze 6B, část 3: herní rating (turnaj a cash)
**Hotovo:** rating OpenSkill (Plackett-Luce, knihovna `openskill`), zobrazení `1500 + měřítko × (μ − k·σ)`, zvlášť turnajový a cash (`rating_state`, historie změn s rozpisem v `rating_events`, zpracování téže hry se nezdvojí). Turnaj: po skončení se z konečného pořadí upraví rating všech, váha podle velikosti pole (plná od 9 hráčů), délky turnaje (turbo méně), rebuye snižují zisk (ztrátu ne), opakované heads-upy téže dvojice mají klesající váhu; k tomu výměna bodů za vyřazení po vzoru Elo s nulovým součtem (výchozí váha 20 %, dělí se mezi více vyřazujících). Turnaj lze označit jako nehodnocený (`tournament.rated`), minimum hráčů je nastavitelné. Cash: sezení = stůl + den s aspoň 100 handami, výsledek v BB na 100 hand, hodnotí se vůči ostatním u stolu s váhou 30 %, počítá se po skončení dne (hodinový běh). Provizorní rating (10 turnajů / 20 cash sezení, do žebříčku až potom), růst nejistoty σ po 30 dnech bez hraní, měkký reset sezóny tlačítkem (oprávnění `statistiky.sezony`), divize s editovatelnými hranicemi, možnost skrýt přesné číslo. Klient: sekce Herní rating na stránce Postup (číslo, ±, divize, graf, rozpis změn „+x za umístění, +y za vyřazení…“, žebříček, bilance vyřazení se soupeřem).
**Zbývá:** EV korekce all-inů (vyžaduje ukládat šance na výhru při all-inu) a s ní úspěch „vyhraný all-in pod 10 %“; zpětný přepočet XP a ratingu s náhledem dopadu; označení podezření na přelévání žetonů; sezónní žebříček ratingu (zatím celkový).
**Poznámka:** Nový hráč má rating 1500 a divizi Bronz; nejistota ± je zpočátku velká (750), protože odpovídá modelu. Výchozí hodnoty jsou jen návrh, vše jde změnit v nastavení Herní rating.

## Fáze 6B: dokončení (EV, přepočet, podezření)
**Hotovo:**
- **Šance při all-inu.** U heads-up all-inu (dva hráči, zbývá dobrat board) se uloží šance obou (`hand_players.all_in_equity`). Počítá se přesně do 30 000 kombinací, jinak odhadem z 4 000 simulací (nastavení `rating.equity*`). Vícenásobné all-iny šance nemají.
- **EV korekce.** Výměna bodů za vyřazení v turnaji se násobí `1 − EV + EV × šance vyřazujícího` (výchozí EV 50 %), takže vyřazení šťastným dobráním přinese i ztratí méně, ale zůstává nulový součet. U cash ratingu se výsledek sezení v BB/100 počítá z podílu EV a skutečného výsledku.
- **Úspěch Zázrak:** vyhraný all-in s šancí pod 10 % (nový typ podmínky `longshotWin`, jde použít i ve vlastních úspěších).
- **Zpětný přepočet XP a ratingu** z historie podle aktuálního nastavení: probíhá v jedné databázové transakci, v náhledu se na konci vrátí zpět a ukáže 50 největších změn, po potvrzení se uloží. Přepočet bez změny nastavení dává totéž (testováno). Rating se přehrává chronologicky včetně resetů sezón, XP včetně denního stropu; odměny za úspěchy zůstávají.
- **Podezření na zneužití** (tabulka `rating_flags`, správa na stránce Postup): opakované heads-upy téže dvojice (od 3 v okně) a jednosměrný tok žetonů v cash hrách (od 300 BB, 90 % jedním směrem, aspoň 20 společných hand za 7 dní). Označení je jen upozornění, správce ho zamítne nebo potvrdí s poznámkou.
**Omezení:** šance chybí u hand před touto změnou (EV se u nich nepoužije). Údaje o délce turnaje a „hodnocený“ se do `game_results` ukládají až od teď, starší turnaje se v přepočtu berou jako hodnocené s výchozí délkou. Přepočet XP načítá celou historii hand do paměti, což stačí pro domácí hru.
**Fáze 6B je tím hotová.** Zbývá sezónní žebříček ratingu a automatická reakce na potvrzená podezření (zatím jen záznam).

## Fáze 6C: ankety
### Část 1: engine (hotovo)
Čisté funkce v `packages/shared/src/polls/`: typy anket (ano/ne/zdržuji se, jedna volba, více voleb s min a max, pořadí preferencí s okamžitým rozstřelem, hodnocení, výběr termínu ve stylu Doodle, volná odpověď), kontrola nastavení a odpovědí, váhy (rovné, podle role, levelu, ratingu, stacku, se stropem), kvórum (počet / procenta), potřebná většina (prostá, nadpoloviční ze všech, 2/3, 3/4, jednomyslnost, vlastní procento), počítání nehlasujících, předčasné ukončení (když hlasovali všichni nebo výsledek nejde zvrátit), řešení remízy (zakladatel, los, prodloužení, nejvýše postavená role) a skládací podmínky „kdo smí hlasovat“ (A / NEBO / kromě, 19 druhů podmínek, omezená hloubka a velikost). Herní hlasování (dohoda, run it twice) zatím používá původní engine v `game-core`; převod na společný engine je zapsán jako navazující krok.

### Části 2 a 4: server a klient anket (hotovo)
**Server:** tabulky `polls`, `poll_votes`, `poll_secret_ballots`, `poll_templates`; oprávnění `anketa.vytvorit` (hráč, moderátor), `anketa.spravovat` (moderátor, admin), `anketa.akce` (admin); nastavení v kategorii „Ankety a hlasování“ (výchozí délka, většina, tajnost, tie-break, připomenutí, upozornění). Okruh hlasujících se při založení zafixuje s vahami, nebo se vyhodnocuje průběžně (živě); podmínky se počítají z profilů hráčů (online, stůl, turnaj, kanál, role, level, hodnost, divize, rating, aktivita, série, žebříček, výhry, zůstatek). Tajná anketa ukládá jen, že hráč hlasoval, a anonymní lístky bez vazby na něj (hlas nejde změnit). Pravidla jde měnit jen do prvního hlasu, prodloužit lze vždy; předčasné ukončení při hlasování všech nebo nezvratném výsledku; remíza podle nastavení (zakladatel, los, prodloužení, nejvýše postavená role). Plánovač (30 s) ukončuje po termínu a připomíná nehlasujícím. Upozornění v aplikaci i push, karta ankety v chatu (`{{anketa:id}}`), zprávy o výsledku, audit všech změn, export do CSV, šablony anket.
**Klient:** stránka Ankety (otevřené, moje, archiv), detail s hlasováním pro všechny typy (ano/ne, jedna volba, více voleb, pořadí, hodnocení, termíny, text, vlastní možnost), výsledky s grafy a „kdo jak hlasoval“ u veřejných, správa (ukončit, prodloužit, zrušit, připnout, rozhodnout remízu), editor s pravidly, váhami a skládacím editorem podmínek (A / NEBO / kromě) se živým počtem oprávněných, panel v lobby, upozornění u stolu pro ankety založené na stůl.
**Zbývá z 6C:** (3) akce po výsledku (naplánovat turnaj na vítězný termín, použít šablonu hry, změnit nastavení stolu, pozastavit / ukončit hru, přidělit roli) s potvrzením a v rozsahu oprávnění zakladatele; převod herních hlasování (dohoda, run it twice) na tento engine; anketa přímo z dialogu u stolu.

### Část 3: akce po výsledku ankety (hotovo)
Anketa může mít navázanou akci (jen s oprávněním `anketa.akce`): naplánovat turnaj na vítězný termín (výběr termínu, možnosti nesou datum a čas), založit stůl z vítězné šablony, změnit nastavení stolu nebo turnaje (pevné hodnoty u ano / ne, nebo hodnota z vítězné možnosti), pozastavit turnaj, ukončit stůl či turnaj, přidělit roli (konkrétnímu hráči, nebo vítěznému kandidátovi). Akce se provede jen když anketa projde, **jménem zakladatele a v rozsahu jeho oprávnění** (každá služba si oprávnění kontroluje sama, při nedostatku práv akce selže a důvod se uloží). Volitelně ji ještě musí potvrdit oprávněná osoba (výchozí ano; upozornění dostane zakladatel a držitelé `anketa.akce`), potvrzení i zamítnutí i výsledek jdou do audit logu a stav je vidět v detailu ankety. Neprošlá anketa akci přeskočí. Editor ankety umí akci nastavit včetně termínů a hodnot u možností.
**Zbývá z 6C:** převod herních hlasování (dohoda v turnaji, run it twice) na společný engine, anketa přímo z dialogu u stolu. Herní hlasování zatím běží na původním engine beze změny.

### Herní hlasování na společném enginu (hotovo)
Třída `Voting` v `game-core` (dohoda v turnaji, run it twice) teď rozhoduje přes stejnou funkci `tally` z `@kb/shared` jako ankety: pravidla se převádějí funkcí `pollConfigOf` (jednomyslně → „jednomyslně“, většina → nadpoloviční ze všech vah, procento → procento ze všech vah, nehlasující jako „ne“, předčasné ukončení zapnuté). Chování zůstalo stejné: všech 186 testů game-core prošlo beze změny a nový test porovnává 400 náhodných průběhů se starým vzorcem. `Voting` si ponechává herní část (časovač, obnova po restartu, tajné zobrazení hlasů, obsluha po rozhodnutí). Hlasování o pauze přes anketu a anketa přímo z dialogu u stolu zůstávají jako možné rozšíření.

## Fáze 7: editor vzhledu (hotovo)
- Tokeny motivu (~85): stůl, karty, žetony, hráči, tlačítka, tvary, hustota, písmo, animace; schéma verze 2 s migrací starších motivů.
- Vestavěné motivy: výchozí, Kasino, Noční, Minimalistický, Retro (světlá i tmavá varianta).
- Editor `/vzhled`: kategorie, hledání, barevná paleta, kontrast WCAG s opravou, zámky prvků, undo/redo, porovnání, druhá varianta, export/import, simulace barvosleposti, živý náhled v celé aplikaci.
- Server: vlastní motivy (soukromé / čeká na schválení / sdílené / skryté), schvalování, výchozí motiv, limity v nastavení.
- Galerie sdílených motivů (použít, upravit kopii, skrýt, fronta ke schválení).
- Obrázky motivů (plsť, pozadí, rub karet, logo): nahrání na disk, obsah se kontroluje (PNG/JPG/WebP/GIF, SVG ne), limity velikosti, formátů a počtu v nastavení; složka `THEME_ASSETS_DIR`.
- Dodaná písma: Inter, Merriweather, Roboto Mono (balíčky `@fontsource`, bez externích služeb).
- Odloženo: vlastní nahrání písma, motiv zakladatele u stolu.
- Testy: 63 souborů, 568 testů prochází.

## Fáze 8, část 1: režim živé hry (hotovo)
- **Živý turnaj:** stejný turnaj jako online (hodiny, blindy, přestávky, rebuy, add-on, re-entry, bounty, deal, výplaty přes účetní knihu), jen nastavení `tournament.live` místo stolu s kartami připojí jednoduchý „stůl“ s evidencí míst (`LiveTable`). Ředitel (oprávnění `zivahra.rizeni`, nebo vlastník/správce turnaje) přihlašuje hráče, zapisuje rebuy, add-on, re-entry a vyřazení (kdo koho vyřadil, kvůli bounty a ratingu). Platí se z peněženky hráče, každý zápis jde do auditu.
- **Živý cash:** samostatná služba `LiveCashService`, tabulka `live_cash_games`. Buy-iny a top-upy leží na účtu stolu v knize, poplatek za čas jde domu, cash-out vyplácí ze stolu. Hru jde uzavřít, jen když nikdo nesedí a na stole je přesně nula (nic nevznikne ani nezmizí).
- **Statistiky a rating:** výsledky se ukládají do `game_results` s příznakem `live`. Do ratingu jdou s váhou `live.ratingWeightPercent` (0 = vůbec); živý cash má vlastní druh `live_cash` a do stávajících statistik, XP a ratingu zatím nejde (odloženo).
- **Nastavení:** modul `live.enabled`, váha v ratingu, předvyplněný poplatek za čas. UI: ovládání ředitele na stránce turnaje, nová stránka `/zivy-cash`, zaškrtávátko „Živá hra“ při zakládání turnaje.
- **Odloženo:** ovládání offline s pozdější synchronizací, zápis stacků jednotlivých hráčů, losování více stolů, XP a statistiky živého cashe.
- Testy: 64 souborů, 572 testů prochází.

## Fáze 8, část 2: TV režim (hotovo)
- **Párování:** správce (oprávnění `tv.spravovat`) v Správa → TV založí zařízení a dostane osmimístný jednorázový kód (platí `tv.pairCodeMinutes`). Televize na `/tv` kód zadá a dostane dlouhý token; v databázi je jen otisk kódu i tokenu. Token jde odvolat, nový kód starý token zneplatní. Po 10 chybných kódech se adresa na 10 minut zablokuje. Vše jde do auditu.
- **Snapshot** (`GET /api/tv/snapshot`, Bearer token, jen čtení): hodiny turnaje (level, blindy, odpočet, přestávka, pauza, bublina), prize pool a výplaty, zbývající hráči a průměrný stack, žebříčky (sezóna, rating, dnešní večer), nadcházející turnaje, běžící ankety, pruh zpráv z hlavního chatu. Žádná ID hráčů, e-maily ani soukromá data.
- **Přenos stolu se zpožděním:** server si ukládá veřejný pohled na stůl a televizi dává stav starý o `tv.tableDelaySeconds`. Karty podle `tv.cardsMode`: nikdy, až po skončené handě (výchozí), nebo jako divák. Akce, hlasování a šance se do pohledu nedostanou (whitelist).
- **Rozvržení:** uložená v `system_meta`, každé zařízení má vlastní; pořadí a doba obrazovek, velikost písma, pruh, motiv. Obrazovky bez dat se přeskočí, televize se střídá podle času serveru, takže víc televizí běží synchronně.
- **Odloženo:** výběr hráčových „motivů“ mimo vestavěné pro TV, přepínání obrazovek ručně, TV varianta pro živý turnaj s vlastním časovačem hlasatele (část 3).
- Testy: 65 souborů, 579 testů prochází.

## Fáze 8, část 3: hlasatel (hotovo)
- **Události a šablony:** katalog (all-in, start turnaje, nový level, odpočet do konce levelu a přestávky, přestávka, vyřazení, odměna za vyřazení, bublina, pauza, vítěz). Výchozí hlášky jsou v překladech, správce je v GUI přepisuje vlastními variantami (více na událost, server nevybere dvakrát za sebou stejnou, proměnné se kontrolují). Vypnutí po událostech, uložení do `system_meta`.
- **Zdroje hlasu:** hlas prohlížeče (výchozí, server posílá jen text), Piper přes protokol Wyoming (vlastní kontejner `docker compose --profile piper up -d`, nebo Piper v Home Assistantu: adresa a port v GUI, „Otestovat spojení“ vrací seznam hlasů) a Google Cloud TTS (klíč `tts.google.apiKey` šifrovaně, upozornění v GUI). U každého zdroje „Přehrát ukázku“, TV má vlastní zdroj (`announcer.tvSource`).
- **Mezipaměť:** soubory v `ANNOUNCER_DIR` pod otiskem (zdroj, hlas, text), limit `announcer.cacheMaxMb`, předgenerování pevných hlášek, vyprázdnění. Stejná hláška se generuje jednou i při souběhu.
- **Selhání:** chyba zdroje se zapíše (v administraci varování), klient při nedostupném audiu přečte hlášku hlasem zařízení. Zařízení bez českého hlasu hlasatele tiše vypne a jednou upozorní.
- **Doručení:** Socket.IO místnosti `table:<id>` a `announce:<id>` (stránka turnaje/živé hry se přihlásí), televize je dostane v TV snapshotu; hlášky stolu (all-in) se zpožděním přenosu. Odpočet řídí časovač serveru.
- **Hráč:** tlačítko ztlumení v záhlaví, hlasitost, volba „hlas mého prohlížeče“ a název hlasu v osobním nastavení; správce může volbu hráčům zakázat (`announcer.allowUserChoice`).
- **Ověřeno jen testy s falešnými službami:** Piper (falešný server Wyoming) a Google (falešný fetch). Skutečný Piper a Google zatím nezkoušeny.
- **Odloženo:** hlášky živého cashe, přepis rychlosti řeči přímo v Piperu (rychlost se řeší přehráváním), mluvené hlášky se SSML.
- Testy: 67 souborů, 594 testů prochází.

## Fáze 8, část 4: herní večer (hotovo) – tím je fáze 8 hotová
- **Večer** (`evenings`, `evening_games`) seskupuje turnaje, živý cash a cash stoly (ty jen v časovém okně večera). Hra se při startu sama přiřadí k otevřenému večeru s aktivitou v posledních `evening.gapHours`, jinak vznikne nový; správce (`vecer.spravovat`) večer zakládá, přejmenovává, přidává a odebírá hry (jedna hra jen v jednom večeru), uzavírá, přepočítává a maže. Automaticky založený večer se po mezeře sám uzavře, ručně založený nikdy.
- **Souhrn** (počítá se z účetní knihy, uložených hand a vyřazení): výsledek hráče cash i turnaje, minimální převody (nic nevznikne ani nezmizí, zbytek jde domu), MVP z vážených bodů (zisk, umístění, vyřazení, XP; váhy v nastavení `evening.mvp*`), ocenění Lovec (nejvíc vyřazení), Bankér (největší pot v BB) a Smolař (nejvyšší šance na výhru při prohraném all-inu, od `evening.badBeatMinPercent`), statistiky. Handa večera má v souhrnu připravené místo (fáze 9).
- **Doručení:** po uzavření souhrn do hlavního chatu, volitelně e-mailem účastníkům (`evening.emailEnabled` a osobní `email.notifyEvening`), na TV nová obrazovka „Herní večer“. Stránky `/vecery` (archiv) a `/vecery/:id` (detail, správa, export CSV).
- **Viditelnost:** otevřený večer vidí účastník a správce, uzavřený každý přihlášený (souhrn stejně jde do chatu).
- **Odloženo:** živý cash zatím nejde do statistik, XP a ratingu (jen do večera), „Handa večera“ s hlasováním (fáze 9), pořadí večera na TV nahrazuje pouze obrazovku „Herní večer“ (žebříček „Dnešní večer“ dál počítá podle dne).
- Testy: 68 souborů, 599 testů prochází.

## Fáze 8 celkem
Živá hra (turnaj i cash), TV režim, hlasatel a herní večer jsou hotové. Co zbývá ověřit ve skutečném prostředí: Piper a Google TTS (jen falešné služby v testech), televize na skutečné TV, web push na HTTPS.

## Dávka dodělávek z fází 6 a 8 (hotovo)
- **Sezónní žebříček ratingu:** `GET /api/rating/season` (hráči s hrou v sezóně podle ratingu po poslední hře, posun od začátku sezóny, počet her; provizorní se nezobrazují). V ratingu záložky „Celkově / Sezóna“ s výběrem sezóny.
- **Potvrzené podezření v ratingu:** po potvrzení dostanou upozornění ostatní správci ratingu (`rating.flagNotifyAdmins`) a volitelně oba hráči (`rating.flagNotifyPlayers`). O ratingu dál rozhoduje člověk, automat do něj nesahá.
- **Anketa u stolu:** tlačítko „Založit anketu u stolu“ (stejný editor, hlasují hráči u stolu).
- **Živý cash:** výsledek jde do statistik a žebříčků (součást cash výsledku), hráči dostanou XP za sezení (`xp.cashSession`, i při zpětném přepočtu XP) a hlasatel hlásí buy-in a cash-out. Do ratingu cash nepatří (rating cashe se počítá z hand).
- **Hlasování o pauze turnaje:** hráč, který ještě hraje, navrhne pauzu (`POST /api/tournaments/:id/pause-vote`); vznikne krátká ano/ne anketa jen pro hráče turnaje a při souhlasu se turnaj sám pozastaví. Zapnutí, délka, práh a pauza mezi návrhy jsou v nastavení (`poll.pauseVote*`). Akce se provádí s pravomocí hlasujících, ne zakladatele; z veřejného rozhraní ji nejde vytvořit (parametr `byVote` server odmítne).
- **TV:** žebříček „Dnešní večer“ se počítá podle běžícího herního večera, bez večera podle dne.
- **Zvuky:** tón při zmínce v chatu (`sounds.mentionSound`) a klávesy Alt + 1 až 9 pro oblíbené zvuky (`sounds.hotkeys`).
- Testy: 69 souborů, 605 testů prochází.
- **Zbývá z odložených:** turnaj na více stolech (další krok), ověření ve skutečném prostředí (Piper, Google TTS, TV, web push na HTTPS).

## Turnaj na více stolech (hotovo)
- **Nastavení** (`tournament.maxTables` 1 až 10, výchozí 1; `tournament.balanceMaxDiff`; `tournament.handForHand`). S výchozí hodnotou 1 se turnaj chová jako dřív.
- **Jádro** (`TournamentTableSet` v `packages/game-core/src/tournament/table-set.ts`): turnaj s ním mluví jako s jedním stolem. Při startu rozsadí hráče vyváženě (kryptografický generátor), po každé handě (`onBoundary` ve `TableActor`) vyrovná počty (přesadí hráče, který by byl příště velkou blindou), nejmenší stůl zruší, když na zbylé hráče stačí méně stolů, a skončí finálovým stolem. Přesazuje se jen mezi handami, stoly se zbývajícím rebuy rozhodováním se neruší. Pozdní registrace usadí hráče k nejmenšímu stolu, případně přidá stůl.
- **Hand-for-hand** na bublině (`alive − placených míst ≤ počet stolů`): stoly po handě čekají na ostatní, pak se rozdává společně. Najdená a opravená chyba: uvolnění stolu uprostřed předělu spustilo předěl dvakrát a rozehraná handa přišla o žetony.
- **Level po handách** se u více stolů počítá podle prvního stolu. Hand-for-hand, vyvažování i rušení stolů mají testy (simulace s boty, součet žetonů, nikdo nesedí u dvou stolů, ledger sedí).
- **Server:** stoly `id`, `id~2`, `id~3`; `tournaments.state.tableIds` přežije restart (test obnovy po restartu), statistiky hand po stolech k jednomu turnaji, chat, dohoda a ankety patří celému turnaji, hlasatel a chat hlásí přesazení, zrušení stolu, finálový stůl a hand-for-hand. Pohled turnaje (`tables`, `me.tableId`).
- **Klient:** stránka turnaje ukazuje stoly s hráči, „K mému stolu“ a „Sledovat“; stránka stolu hráče po přesazení sama přesměruje k novému stolu; TV si vybere největší (finálový) stůl a ukáže „Turnaj · stůl N“.
- **Živý turnaj na více stolech:** stoly jsou jen evidence (`LiveTable`), server navrhuje přesazení (vyvážení nebo rušení stolu) a ředitel je potvrdí tlačítkem; hráč dostane upozornění a zpráva jde do chatu. Návrhy jsou jen v pohledu ředitele.
- **Odhad délky turnaje** (`estimate`) počítá dál s jedním stolem. Zadání pro víc stolů tedy nezpřesňuje.
- Testy: 71 souborů, 615 testů.

## Fáze 9, část 1: sázky a odměny na hlavu (hotovo)
- **Sázky** (turnaje, online i živé): bank (pari-mutuel, ano/ne) a přímá sázka dvou hráčů (stejná částka, opačná strana, jen jeden protihráč). Na co: vítěz, první vyřazený, souboj dvou hráčů, konkrétní umístění, vlastní tvrzení. Čistá logika v `packages/shared/src/bets.ts` (vyhodnocení, ochrana „nikdy proti sobě“, dělení banku s poplatkem), služba `BetService` v `apps/server/src/bets.ts`.
- **Peníze:** vklad se hned zamkne na účtu `escrow:bet:<id>` (kniha `bet_stake`), vypořádání je jedna transakce (`bet_payout` nebo `bet_refund`, poplatek domu `bet_fee` volitelně). Součet výplat + poplatek = součet vkladů, escrow je po vypořádání nula. Zrušený turnaj, hráč mimo turnaj nebo sázka bez protistrany: vklady se vrací.
- **Uzavírání** (`bets.defaultClose` nebo volba zakladatele): při startu, na konci rebuy období, ručně. „První vyřazený“ se vyhodnotí hned po prvním vyřazení, ostatní po konci turnaje.
- **Vlastní tvrzení:** zakladatel navrhne výsledek, strana, které škodí, ho potvrdí (hned) nebo zpochybní; bez sporu se potvrdí sám po `bets.disputeHours`. Spor rozhodne rozhodčí (oprávnění `sazky.rozhodnout`, ve výchozím nastavení ředitel a správce), který do sázky nesmí sám vkládat.
- **Ochrany:** na sebe jde jen „pro sebe“ (a vůbec ne při `bets.allowSelfBet` vypnutém), obě strany jedné sázky nejdou, limity vkladu a počtu otevřených sázek, vše přes nastavení. Operace s penězi běží v sériové frontě (žádné dvojí vyplacení).
- **Odměna na hlavu** (`HeadBountyService`): hráč zablokuje odměnu za vyřazení hráče v turnaji (`escrow:hb:<id>`), vyplatí se tomu, kdo ho vyřadí (víc vyřazujících podle váhy), víc odměn se sčítá. Když vyřazení nikdo nezpůsobil nebo hráč přežil, rozhoduje nastavení (vrátit, propadne domu, připadne vítězi); při zrušení turnaje se vždy vrací. U avataru „hledaného“ je štítek ⚑ se součtem.
- **Klient:** karty „Sázky“ a „Odměny na hlavu“ na stránce turnaje (vypsání, vsazení, přijetí nabídky, uzavření, zrušení, navržení výsledku, potvrzení/spor, rozhodnutí rozhodčího), upozornění hráčům při vypořádání.
- **Odloženo:** sázky a odměny u cash stolů (na showdown pot), sázky s pevnými kurzy navržené zakladatelem, sázkové upozornění e-mailem.
- Testy: 73 souborů, 641 testů prochází.

## Fáze 9, část 2: osobní limity a poznámky o hráčích (hotovo)
- **Osobní limity** (`packages/shared/src/limits.ts`, `LimitsService`): největší prohra a nejvíc buy-inů za den, týden, měsíc a večer, nejdelší hra v kuse a připomínání pauzy po X minutách. Zpřísnění platí hned, uvolnění až po `limits.loosenDelayHours` (výchozí 24 h, každé pole zvlášť, opakované žádosti čekání nezkracují). Správce nastavuje společné limity (`limits.global.*`), platí přísnější z osobního a společného.
- **Hlídá je účetní kniha:** `Ledger.setGuard` odmítne transakci, která by vzala hráči peníze do hry přes limit (cash buy-in a top-up, vstup do turnaje, rebuy, add-on, vklad do sázky, odměna na hlavu, živá hra), a to před zápisem, takže se nic nestrhne. Chyba `LIMIT_REACHED` nese, který limit a kdy se uvolní, klient ukáže srozumitelnou hlášku. Spotřeba se počítá z čistého výsledku peněženky (výběr prohru snižuje); sázky a odměny se počítají do prohry, ne do počtu buy-inů.
- **Pauza od hry:** jde jen prodloužit (nejvýš `limits.maxBreakDays`), zkrátit ani zrušit se nedá; po dobu pauzy kniha nepustí žádný vklad do hry.
- **Sezení:** podle toho, kdo sedí u stolů (přestávka delší než `limits.sessionGapMinutes` ukončí sezení); připomínka pauzy upozorněním a po dosažení limitu doby hry další vklady nejdou.
- **Poznámky a štítky o hráčích** (`NotesService`): soukromá poznámka (do 1000 znaků) a štítek (název do 20 znaků, barva je klíč designového tokenu, do 12 štítků) k jinému hráči, vidí je jen autor, synchronizují se přes server, jdou exportovat do JSON. U avataru u stolu je barevná tečka a po kliknutí dialog poznámky; v profilu přehled, správa štítků a export.
- **Opravená chyba:** klient u chyb s klíčem `error` (živá hra, TV, hlasatel, večery, sázky) ukazoval obecnou hlášku, protože četl jen `code`. Teď čte oba.
- **Odloženo:** zobrazení štítku v historii hand a v profilu cizího hráče, nucené odsazení hráče od stolu při dosažení limitu doby hry (zatím jen zákaz dalších vkladů), pauza od hry zrušitelná správcem.
- Testy: 75 souborů, 664 testů.

## Fáze 9, část 3: sdílení hand, handa večera a znělky (hotovo)
- **Sdílení hand** (`SharedHandService`): u přehrané handy tlačítko „Sdílet v chatu“ pošle do hlavního kanálu kartu `{{ruka:id}}`. Autor může dobrovolně odkrýt své karty (a zase skrýt), volitelně se založí anketa „Jak bys hrál?“ (Fold/Call/Raise). Cizí karty se nikdy neukážou, jen ty z showdownu. Pod handou je vlákno komentářů (limit `hands.commentMax`, mazání autorem a moderátorem) a reakce (👍 🔥 😮 😂 🤔 💀), autor sdílení dostane upozornění na komentář. Přehrávač je společná komponenta (`hand-replay.tsx`), sdílí ho statistiky i karta v chatu.
- **Handa večera:** po uzavření večera (volitelně automaticky, `evening.handVoteAuto`) nebo ručně tlačítkem server vybere kandidáty z uložených hand (největší pot, bad beat, ukázaný bluff, nejnepravděpodobnější výhra) a hráči večera hlasují v anketě. Po skončení ankety (kontroluje se minutovým časovačem) se vítězná handa uloží do souhrnu večera, sdílí do chatu a ukáže se v detailu večera. Bez remízového hlasu platí první kandidát. Pod dva kandidáty se hlasování nespustí.
- **Znělky:** každý hráč si zvolí nástupovou (při přisednutí ke stolu) a vítěznou (výhra turnaje nebo velký pot od `sounds.jingleBigPotBb` BB) znělku z knihovny zvuků. Odstup `sounds.jingleCooldownSeconds`, globální vypnutí, hráč si může znělky ostatních vypnout (`sounds.jingles`). Znělky zní i na TV se zpožděním přenosu stolu (TV smí stáhnout jen zvuk, který právě zazněl jako znělka).
- Migrace `0028_sdilene_handy`. Testy: 76 souborů, 668 testů prochází.
- **Zbývalo z fáze 9:** část 4 (kosmetika a obchod), viz níže.

## Fáze 9, část 4: kosmetika a obchod (hotovo)
- **Katalog** (`CosmeticService`, tabulky `cosmetic_items` a `player_cosmetics`, migrace `0029_kosmetika`): rámečky avatarů, efekty, rub karet, plsť stolu, barva jména, tituly, trofeje a sloty pro zvuky. Vzhled je jen klíč barevného tokenu a pevný styl (`packages/shared/src/cosmetics.ts`), takže v komponentách nejsou žádné barvy. Vestavěná sada má 26 předmětů (názvy v překladech), kurátor je může upravovat, stáhnout z prodeje a přidávat vlastní.
- **Získání:** kterákoli ze splněných podmínek: level, hodnost, úspěch, umístění v uzavřené sezóně (do N. místa), koupě v obchodě, nebo přidělení správcem. Server uděluje sám (po postupu na level, po úspěchu, při otevření obchodu a hodinovým časovačem kvůli sezónám). Každý předmět má volitelné časové okno prodeje, cenu a možnost stažení.
- **Obchod:** koupě je jedna transakce knihy peněženka → dům (`shop_purchase`), idempotentní klíč `shop:<hráč>:<předmět>`, sériová fronta, takže dvojklik nestrhne dvakrát. Nedostatek peněz nic nestrhne. Nastavení `cosmetics.enabled`, `cosmetics.shopEnabled`, `cosmetics.discountPercent` (společná sleva) a `cosmetics.maxTrophies`.
- **Nošení:** z každého druhu jeden předmět, trofejí do limitu; jen vlastněné. Ostatní u hráče vidí rámeček, efekt, barvu jména, titul (v chatu) a trofeje (v profilu). Rub karet a plsť stolu vidí jen majitel (data atributy na kořeni stolu a CSS v `styles.css`). Slot navíc zvedá limit nahraných zvuků (`sounds.maxPerUser` + součet slotů).
- **Oprávnění:** `obchod.nakupovat` (hráč), `obchod.spravovat` (role Kurátor obsahu a správce).
- **Klient:** stránka Obchod (obchod, moje předměty s vitrínou, správa katalogu s formulářem a přidělováním), zobrazení u stolu a v chatu, upozornění o získání předmětu.
- **Odloženo:** předměty se nedají vracet ani posílat mezi hráči (záměrně, kvůli obchodování s měnou), titul se u stolu nezobrazuje (jen v chatu a v profilu), ceny se nezobrazují v jiných měnách.
- Testy: 77 souborů, 675 testů prochází.
- **Fáze 9 je tím hotová.** Další: fáze 10 (Home Assistant, webhooky, REST API, Discord).

## Fáze 10: napojení ven (Home Assistant, webhooky, Discord) a REST API (hotovo)
- **Katalog událostí** (`packages/shared/src/integrations.ts`): registrace do turnaje, start, nový level, přestávka a její konec, konec turnaje s výhercem, vyřazení, all-in, velký pot, bad beat, nová zpráva v hlavním chatu, nová anketa, uzavření večera. Tělo `{ version, event, at, data }` nikdy neobsahuje skrytá herní data (cizí karty, balíček). Události vznikají na jednom místě (`IntegrationService.emit`), zdroje jsou napojené v `app.ts`.
- **Webhooky:** seznam adres s vlastním výběrem událostí (prázdný = všechny kromě chatu a all-inů). Zprávy jsou podepsané HMAC-SHA256 z `<čas>.<tělo>` (hlavičky `X-KB-Signature`, `X-KB-Timestamp`, `X-KB-Event`, `X-KB-Delivery`), podpisový klíč `webhook.signingSecret` vznikne sám a je šifrovaný. Opakování s odstupem, který se zdvojnásobuje (`integrations.webhookRetrySeconds`, `webhookMaxAttempts`), log doručení s ručním zopakováním, mazání starého logu. Adresa se v seznamu ukazuje jen jako hostitel.
- **Discord:** adresa webhooku je tajný údaj (`discord.webhookUrl`), zprávy jsou přeložené texty bez pingů (`allowed_mentions` prázdné), výchozí výběr: registrace, konec turnaje, souhrn večera. Tlačítko zkušební zprávy.
- **MQTT pro Home Assistant:** vlastní malý klient MQTT 3.1.1 bez nové závislosti (jméno, heslo z tajných údajů, TLS, retain, keepalive), událostí do témat `<předpona>/event/<událost>`, retained stav `<předpona>/state` (turnaj a poslední událost, obnova po minutě), `<předpona>/status`, **MQTT Discovery** šesti entit. Tlačítko „Otestovat spojení“ vrací srozumitelnou chybu (např. špatné přihlášení).
- **Osobní tokeny a REST API** (`/api/v1`): token `kbp_…` se ukládá jako otisk a ukáže se jednou. Rozsah je z pevné nabídky a každý scope má oprávnění, které majitel musí mít při každém volání (token nikdy nemá víc než majitel; ztracené oprávnění, blokace, vypršení i zrušení ho okamžitě zneplatní). Rate limit na token (`api.rateLimitPerMinute`, 429 s `Retry-After`), vypínač `api.enabled`, nejvíc tokenů na hráče a nejdelší platnost. API se přihlašuje jen tokenem, cookie se tam ignoruje. Trasy: me, turnaje (seznam, detail, přihlášení), sezóny, žebříček, vlastní statistiky, zůstatek, večery, zpráva do chatu. **OpenAPI** na `/api/v1/openapi.json` se staví z téže tabulky tras.
- **Klient:** administrace „Napojení ven“ (výběr událostí pro MQTT a Discord, webhooky, log s opakováním), v profilu „Přístupové tokeny“. README má návod pro Home Assistant (včetně ukázkových automatizací), webhooky, Discord a API.
- Migrace `0030_napojeni_ven` a `0031_api_tokeny`. Testy: 79 souborů, 693 testů prochází (podpis, opakování, výběr událostí, falešný MQTT broker s Discovery, rozsah a limity tokenů, OpenAPI).
- **Odloženo:** administrátorská tabulka cizích tokenů v GUI (služba a API existují), webhooky ze stolů jednotlivých cash her mimo událostí v katalogu, příjem příkazů z Home Assistantu (zatím jen posílání ven), skutečný test s Home Assistantem a Discordem je na tobě (návod v README).
- **Další:** fáze 11 (AI asistent nastavení a MCP server).

## Fáze 11: AI asistent nastavení a MCP server (hotovo)
- **Asistent** (`apps/server/src/assistant/service.ts`): okno ve stylu chatu (tlačítko vpravo dole, kontext podle stránky: lobby, stůl, administrace, vzhled, plánování, vysvětlování). Pracuje přes volání nástrojů: `search_settings`, `get_settings`, `explain_setting`, `list_games`, `list_templates` a navrhující `propose_settings_change`, `propose_create_tournament`, `propose_poll`. Nástroje a jejich popisy jsou definované jednou (`packages/shared/src/assistant.ts`), parametry se berou z centrálního schématu nastavení (hledání v českých názvech a nápovědě s vahami podle vzácnosti slova a kmenem kvůli skloňování), takže každý nový parametr je dostupný bez další práce.
- **Nikdy nemění sám:** vzniká návrh s přehledem před → po a časováním (hned / od další handy / nelze), uživatel ho potvrdí, upraví hodnoty, nebo zamítne. Při potvrzení se oprávnění a stav hry ověří znovu a změnu provede stejná služba jako ruční změna (`SettingsStore.set`, `TableManager.updateSettings`, `TournamentManager.updateSettings`, plánování turnaje, anketa) se značkou `assistant` a původním textem v audit logu. Návrh patří jen tomu, kdo ho vyvolal, vyprší po `assistant.proposalMinutes`. Seznam `assistant.autoKeys` povoluje drobné změny bez potvrzení (nikdy ne globální). Parametry `assistant.*` a tajné údaje asistent měnit ani číst nesmí.
- **Poskytovatelé** (`providers.ts`): Google Gemini (výchozí), Anthropic Claude, OpenAI a obecné rozhraní kompatibilní s OpenAI (lokální modely). Klíče jen šifrované v tajných údajích; model zvlášť pro vysvětlování a plánování, teplota, nejdelší odpověď, časový limit, opakování, velikost historie, nejvíc kroků s nástroji. Bez klíče je asistent skrytý a aplikace jede dál.
- **Limity a spotřeba:** denní strop na hráče i celkem, přehled spotřeby (požadavky, tokeny) v administraci, tlačítko „Otestovat spojení“.
- **Prompty v GUI:** systémový pokyn, pokyny podle kontextu, šablony textů (shrnutí, potvrzení, zamítnutí, odmítnutí, po startu, chyba, nabídka hlasování) i popisy nástrojů jsou upravitelné, s proměnnými `{prezdivka}`, `{role}`, `{opravneni}`, `{stul}`, `{stav_hry}` a dalšími (seznam podle kontextu, kontrola neznámé proměnné, náhled), s verzemi (autor, čas, návrat ke starší verzi, reset jednoho promptu i všech). **Pískoviště** ukáže odeslaný prompt, odpověď a návrh změn bez provedení a bez zápisu.
- **MCP server** (`POST /api/mcp`, JSON-RPC přes HTTP, `initialize`, `ping`, `tools/list`, `tools/call`, dávky): stejné nástroje plus `confirm_proposal`, `reject_proposal`, `list_proposals` (potvrzení druhým voláním). Přístup jen osobním tokenem s rozsahem `mcp` (oprávnění `asistent.mcp`, ve výchozím stavu správce), vypínač `mcp.enabled`, nástroje jdou vypínat jednotlivě, log volání v administraci.
- **Oprávnění:** `asistent.pouzivat` (hráč), `asistent.spravovat` a `asistent.mcp` (správce). Voice: diktování přes rozpoznání řeči v prohlížeči a odpověď hlasem prohlížeče jsou volitelné v nastavení.
- Migrace `0032_asistent`. Testy: 81 souborů, 718 testů prochází (návrh a potvrzení, oprávnění, neplatné hodnoty, úpravy před potvrzením, vypršení, limity, prompty a verze, pískoviště, adaptéry všech poskytovatelů, MCP).
- **Odloženo:** návrhy z vlastní iniciativy (`assistant.suggestEnabled` je zatím jen příznak), vysvětlení „proč mi klesl rating“ (potřebuje nástroj nad ratingem), úprava vzhledu a rolí přes asistenta (zatím nástroje jen pro nastavení, hru a ankety), hlasová odpověď přes serverového hlasatele (zatím hlas prohlížeče). Zkoušku s opravdovým klíčem Gemini a MCP klientem je třeba udělat ve skutečném prostředí.
- **Další:** fáze 12 (doladění: PWA, zvuky, animace).

## Fáze 12: doladění, PWA, zvuky, animace (hotovo)
- **Zvuky hry u stolu** (`apps/web/src/table/sfx.ts`): rozdání nové handy, otočení karet na stole, žeton při sázce, check, fold, all-in, „jsi na tahu“, tikání před koncem času (hranice `ui.warnSeconds` a její polovina), začátek time banku, výhra (delší fanfára, když vyhraju já). Syntetizované přes WebAudio, takže bez souborů; čistá funkce `detectSfx` určuje zvuky z přechodu mezi dvěma pohledy na stůl (nikdy nepoužívá cizí karty). Osobní nastavení: vypínač, hlasitost, každý zvuk zvlášť (`ui.sfx*`), vibrace (`ui.vibrate`). Odemykání zvuku po první interakci řeší prohlížeč (resume na dotyk a klávesu).
- **Animace u stolu:** rozdávání karet se zpožděním (flop po jedné), pop sázky, záře vítěze a plovoucí „+částka“. Řídí je tokeny `anim.enabled` a `anim.speed`, vypínají se i „omezit pohyb“.
- **PWA:** PNG ikony (192, 512, maskable, Apple touch) generované skriptem `scripts/make-icons.mjs`; dynamický manifest `/manifest.webmanifest` s barvami motivu z nastavení `pwa.themeId`, zkratky (lobby, turnaje, chat), `id`, kategorie; service worker s obalem aplikace a offline stránkou, který nikdy nekešuje `/api` ani `/socket.io` (hashované soubory zůstávají v keši i po aktualizaci); registrace i bez podpory push; `theme-color` sleduje pozadí aktuálního motivu a režimu; karta „Nainstalovat aplikaci“ (tlačítko, návod pro iOS) v profilu; pruh „jsi offline“.
- Testy: 83 souborů, 730 testů prochází (zvukové události, manifest, barvy z motivu, ikony, service worker nesmí kešovat živá data).
- **Odloženo:** rozdělení balíku (je přes 1 MB; vyžaduje oddělit `isAdmin` od administračních stránek a líně je načítat), animace přesunu žetonů do potu a k výherci (zatím jen pop a záře), zvukové sady jako součást motivu (zvuky hry jsou zatím jedna vestavěná sada), skutečné ověření instalace a offline režimu na telefonu a v Chrome.

## Stav projektu po fázi 12
Všech 12 fází ze zadání je implementováno a pokryto testy (83 souborů, 730 testů, typecheck čistý). Co zbývá, je **ověření ve skutečném prostředí** a drobná odložená rozšíření uvedená u jednotlivých fází:
- nasazení na server s Dockerem a Nginx Proxy Managerem (README, krok za krokem), reálný e-mail přes Gmail, web push na HTTPS;
- Piper nebo Google TTS pro hlasatele, TV režim na skutečné televizi, turnaj na více stolech s opravdovými hráči;
- Home Assistant (MQTT), Discord, webhooky, API tokeny a MCP s opravdovým klíčem Gemini nebo klientem;
- instalace PWA na telefonu a zvuky u stolu s opravdovou hrou.

## Ověření v prohlížeči před nasazením (17. 10. 2026)
Projito ve vývojovém prostředí (server + Vite) s účtem majitele: lobby, stůl, turnaje, večery, živý cash, chat, peněženka, statistiky, postup, vzhled, ankety, nastavení, obchod, profil, TV a všechny části administrace. Nalezené a opravené chyby:
- **Stránka stolu padala** (bílá obrazovka): `tournamentId` se v `pages/table.tsx` používalo dřív, než bylo definované (chyba z úprav pro turnaj na více stolech), a hook pro rub karet a plsť byl v `TableScreen` za předčasným `return` (porušení pravidel hooků).
- **Server se složkou webu nenastartoval:** dynamický `/manifest.webmanifest` kolidoval se statickým souborem ve `dist`. Statický soubor odstraněn, ve vývoji ho Vite proxuje na server; přidán test, který start se statickými soubory hlídá.
- **Okno asistenta po odpovědi shodilo celou aplikaci:** efekt pro odscrollování vracel hodnotu (`scrollIntoView`), opraveno.
- Chyběl popisek tajného údaje `ai.compatible.apiKey`; test pokrytí překladů teď hlídá i katalogy (tajné údaje, události, nástroje asistenta, rozsahy tokenů, druhy kosmetiky).

Ověřeno, že funguje: nákup a nošení kosmetiky až po zobrazení u stolu (rámeček, plsť, rub), vytvoření API tokenu v profilu a volání `/api/v1` s ním (rozsah se respektuje), celý průchod asistentem (návrh → úprava hodnoty → potvrzení → změna nastavení, audit) proti falešnému poskytovateli `scripts/fake-ai.mjs`, produkční build servírovaný serverem (index, SPA fallback, manifest s barvami motivu, offline stránka, service worker, ikony, OpenAPI).
Přidán `pnpm lint` (oxlint s pravidlem React hooků, které by obě chyby s hooky zachytilo; našel ještě jednu v paletě zvuků, opravena).
Neověřeno: skuteční poskytovatelé AI, MQTT/Discord/webhooky proti skutečným službám, push a instalace PWA na telefonu, zvuky u stolu (jde jen o WebAudio, logika je otestovaná jednotkově).

## Ověření v Dockeru s PostgreSQL (17. 10. 2026)
Sestaven obraz z `docker/Dockerfile` a spuštěn `docker compose` (služby `db` a `app`) se zkušebním `.env` (není v repozitáři). Výsledek: aplikace nastartuje, na opravdovém PostgreSQL 16 proběhne všech 33 migrací (77 tabulek, vestavěná kosmetika nasazená), `/health`, index, SPA fallback, manifest, offline stránka, service worker, ikony i OpenAPI odpovídají správně, kontejner je zdravý.
Nalezeno a opraveno: `PUBLIC_URL` z `.env` server nečetl (nastavení `system.publicUrl` mělo jen výchozí hodnotu ze schématu). Teď platí jako výchozí veřejná adresa a povolený původ, dokud správce nenastaví jinou v GUI (test v `pwa.test.ts`). Pro ostrý provoz na `poker.example.cz` to nic nemění, pro zkoušení na jiné adrese ano.

## Mobilní kontrola a příprava nasazení (17. 10. 2026)
Projito na šířce telefonu (375 px): lobby, stůl, chat, obchod, turnaje, administrace. Nic nepřetékalo; opraveno: hlavní nabídka zabírala třetinu obrazovky (teď sbalená pod tlačítkem „Nabídka“ do šířky md), u stolu byla jména zkrácená na pár písmen (na telefonu menší avatar v poměru k tokenu, jméno pod avatarem, užší sedadlo) a tlačítko asistenta je na telefonu jen ikona. README: aktuální stav projektu, kontrolní seznam před prvním spuštěním, sjednocené tykání. Repozitář je připravený pro `git clone` na serveru.

## Zveřejnění repozitáře (17. 10. 2026)
Repozitář na GitHubu je veřejný. Z obsahu i z historie commitů byly odstraněny osobní údaje: e-maily (odesílatel aplikace je teď zástupný `poker@example.cz`, skutečný se zadává v GUI), doména (v dokumentaci zástupná `poker.example.cz`, skutečná jen v `.env` jako `PUBLIC_URL`) a e-mail autora commitů (commity jdou pod GitHub adresou `noreply`). Instalační skript se na veřejnou adresu ptá. Historie commitů byla kvůli tomu sloučena do jednoho; původní historie zůstává jen lokálně ve větvi `historie-soukroma` (nepushovat).

## Produkce (17. 10. 2026)
Aplikace je nasazená v LXC kontejneru v Proxmoxu instalačním skriptem, běží za Nginx Proxy Managerem s HTTPS na vlastní doméně majitele. Kontejnery `app`, `db` i `backup` jsou zdravé. Aktualizace: v kontejneru `cd /opt/koronabar && git pull && docker compose up -d --build`. Další krok: ladění vzhledu podle poznámek majitele z telefonu a televize.

## Nový vzhled stolu podle předlohy majitele (17. 10. 2026)
- **Sedadla jako na klasických desktopových hernách:** karty (vlastní velké, cizí menší), pod nimi jméno a stack jako text přímo na plátně (token `color.feltText`), dealer button „D“ u karet, sázky jako žetony uvnitř oválu mezi hráčem a středem, záře kolem karet hráče na tahu, bubliny s akcí („Call 10 KČ“, „Raise 20 KČ“, „Fold“, „All-in“, „Check“) odvozené z rozdílu pohledů na stůl (`table/actions-feed.ts`, testy), výrazný pruh „Jsi na tahu“ s odpočtem.
- **Desktop:** levý panel s widgety (hodiny turnaje, můj stůl, moje handa, šance na výhru, hráči, zvukové emotikony), každý sbalitelný a skrytelný, stav uložený v osobním nastavení `ui.tablePanel` (synchronizuje se); stůl se vejde nad akční lištu i na nižší monitor; chat dole (nebo vpravo podle motivu).
- **Mobil:** stůl na celou šířku s vyšším oválem, menší karty soupeřů, prázdná sedadla jen jako tečky, chat a panel v celoobrazovkových panelech pod tlačítky „Chat“ (s počtem nepřečtených) a „Panel“.
- **Motiv „Červený salon“** (vestavěný): červené plátno s tmavým okrajem, šedé okolí, karty s velkými indexy, bílý text na plátně.
- Doladění podle majitele: částky u stolu bez symbolu měny (volba `ui.showSymbolAtTable`), sázky posunuté do středu nad karty, dialog buy-inu/dokoupení jako modální okno (tlačítko Potvrdit bylo bílé na bílém kvůli pořadí tříd, opraveno), tlačítko **Celá obrazovka** (schová nabídku a patičku, přepne prohlížeč do fullscreen), ozubené kolečko panelu (výběr a pořadí widgetů, zobrazení v BB, symbol měny, hodnost u stolu), widget **Plánovaný tah** (Fold, Check/Fold, Check, Call; provede se sám na tahu, s novou handou se ruší; na mobilu pod stolem). Widget šancí na výhru z panelu odstraněn (majitel ho nepovažuje za fér).
- Druhé kolo připomínek: sázky blíž k hráči (nad kartami, mimo board), chat u stolu menší a hustší s přepínači „Hra“ a „Hráči“ (osobní nastavení `chat.showSystemAtTable`, `chat.showPlayersAtTable`), nastavení panelu se otevírá uvnitř panelu (nezakrývá stůl), paleta zvukových emotikonů se otevírá doprava a nevyjíždí z obrazovky, okno stolu má stálé rozložení: stavový řádek i akční lišta mají pevnou výšku, čtyři tlačítka jsou vždy na stejných místech a mimo tah je na jejich místě plánovaný tah.
- Třetí kolo: volba „Moje místo vždy dole uprostřed“ (`ui.rotateToMe`, výchozí zapnuto; vypnuto = pevná místa podle čísel), výška sázky kolečkem myši nad posuvníkem (po big blindech), **Historie** u stolu (okno s přehrávačem předchozích hand tohoto stolu, šipky pro listování, sdílení do chatu; API `/api/stats/hands?tableId=`), celá obrazovka bez posuvníků (stránka má výšku okna, panel a chat rolují uvnitř sebe, chat vpravo, stůl se zmenší podle výšky okna).
- Ukládání v nastavení: změny v Globálním nastavení a E-mailu se jen připraví a uloží až tlačítkem **Uložit**. Nově je to vidět: u změněného řádku štítek „Neuloženo“, dole přilepená lišta „Neuložené změny: N“ s Uložit/Zahodit a prohlížeč varuje při odchodu ze stránky s neuloženými změnami.
- Šablony Turbo a Hyper: minimální počet hráčů pro start turnaje snížen ze 3 na 2 (na přání majitele; šablona má přednost před globálním nastavením). Už vytvořené turnaje si nesou starou hodnotu, dá se změnit v jejich nastavení.
- Připomínky majitele: vypnutý obchod (`cosmetics.enabled`) zmizí i z hlavní nabídky; hledání v nastavení je fulltextové (název, nápověda, klíč, kategorie i názvy možností, více slov, bez ohledu na diakritiku, výsledky s nadpisy kategorií); přepínač v osobním nastavení na telefonu „probliknul“ zpět – pomalá odpověď načtení nastavení přepsala čerstvou změnu, nově se místní změny od začátku načtení zachovají (test `apps/web/src/settings.test.ts`).
- Oprava pádu při startu: po zavření výchozího „Stůl 1“ server při dalším startu stůl zakládal znovu se stejným id a padal na duplicitě (`game_tables_pkey`). Výchozí stůl se teď zakládá jen při úplně prvním startu (v databázi ještě žádný stůl nebyl); test v `server.test.ts`.
- Další kolo připomínek: ikona 🔊 v záhlaví je nabídka **Zvuk** s přepínači (zvuky hry, zvukové emotikony, znělky, zmínka v chatu, hlasatel) a tlačítky Vypnout/Zapnout vše; nabídky zvonku a zvuku se na telefonu roztáhnou pod tlačítkem přes šířku okna (nevyjíždí ven); po startu turnaje aplikace přihlášeného hráče sama přepne na jeho stůl (`ui.autoJoinTournament`); **mobilní rozložení stolu** (`ui.mobileLayout`: auto/vždy/nikdy, přepínač i v nabídce ⋯ u stolu): schová nabídku a patičku, stránka má výšku okna bez posuvníků, ovál se zmenší podle místa, nástroje stolu jsou pod „⋯“, sázky leží blíž ke středu (nezakrývají je karty). Návod doplněn o kapitolu Čas na tah a time bank a o šablony. Otevřené: telefon na šířku (landscape) má běžné rozložení a posouvá se.
- Vlastní šablony nastavení: tabulka `settings_templates` (migrace 0033), služba `TemplateService` (vestavěné + vlastní, CRUD jen pro správce s `nastaveni.globalni`, validace klíčů vrstvy „šablona“, mazání blokované u šablony v užívání), hry založené z vlastní šablony si ukládají snímek hodnot (`template_values`), takže pozdější úprava šablony běžící hru nemění; REST `/api/admin/templates`, stránka Správa → Šablony (kopie vestavěné, editor s formulářem nastavení); asistent vidí i vlastní šablony. Test `templates.test.ts`.
- Odhad délky turnaje přepsán: místo simulace s náhodnými boty analytický výpočet podle struktury blindů a žetonů ve hře (konec kolem BB ≈ 1/20 žetonů, rozmezí 1/30–1/12, přestávky, odhad rebuy/add-on), test v `tournament.test.ts`.
- Přehled **Pravidla** u stolu (lobby) a turnaje: záložky podle kategorií nastavení + tabulka levelů a blindů; dialogy se při obnově dat už neodrolují nahoru (Modal zaměřuje jen při otevření).
- Zakládání a úprava turnaje (i šablony): hlavní věci jsou vidět hned ve třech kartách – **Peníze a výplaty** (buy-in, poplatek, výplatní struktura, kolik hráč zaplatí, kam peníze jdou, prize pool a rozpis výplat po místech pro zadaný počet hráčů), **Rebuy, add-on a re-entry** (zapnutí a hlavní čísla) a **Struktura blindů** (cílová délka, délka levelu, stack, počet hráčů → tlačítko *Vygenerovat blindy podle cílové délky*, náhled levelů a živý odhad délky). Odhad délky přesunut do `@kb/shared` (počítá se i v prohlížeči). Generátor míří na konec turnaje (BB ≈ 1/20 žetonů) a engine za posledním zadaným levelem blindy dál zdvojnásobuje (jako „Double blinds after last level“), takže se turnaj vždy dohraje.
- Ukládání nastavení: dialogy (úprava stolu/turnaje, šablony, zakládání) se s neuloženými změnami nezavřou bez potvrzení (klik vedle okna, Escape i tlačítko Zavřít/Zrušit); úprava stolu/turnaje má štítky „Neuloženo“ a přilepenou lištu Uložit/Zahodit jako globální nastavení. Ukládání samo ověřeno (PUT/PATCH 200, hodnoty po znovuotevření sedí).
- Turnaj podle majitele: karta **Hlavní nastavení** hned nahoře (buy-in, poplatek, stack, rebuy cena a počet, add-on cena, dělení výhry, délka levelu, přestávky) v zakládání, úpravě i šabloně; **struktura blindů** je u vestavěných turnajových šablon hotová (vygenerovaná pro 9 hráčů) a v editoru jsou předvolby Pomalá/Standardní/Turbo/Hyper, vlastní zápis, nebo až na přání „automaticky při startu“ s tlačítkem Vygenerovat; číselná pole (`NumInput`) při mazání nevnucují nulu; **vestavěné šablony jde upravit** (název, popis, hodnoty – uloží se jako přepsání pod stejným id, tlačítko *Obnovit původní*), vedle toho kopie jako vlastní.
- Další kolo: globální nastavení se ukládá optimisticky (`saveGlobalSetting`), takže se po Uložit hodnoty na pomalém spojení nevracejí ke starým; přestávka v turnaji může být jen jednou (`tournament.breakRepeat`); nový turnaj dostane navržený název (šablona + čas), dokud ho hráč nepřepíše; pořadí šablon v nabídce (šipky ve Správa → Šablony, uloženo v `templates.order`); volitelné označení žetonů u stolu (`table.showChipLabel`, `table.chipLabel`) pro cash i turnaj. Hlasatel: úprava hlášek už existuje (Správa → Hlasatel → Šablony hlášek).
- U stolu: návrat ze sit outu se řídí příznakem `sitOut` z registru stolu (dřív se během rozehrané handy po automatickém sit outu tlačítko nepřepnulo), tlačítko **Ke stolu** v hlavní nabídce (`/api/me/seat`), volba **Zakrýt moje karty** (ukážou se přejetím myší / klepnutím), tlačítko **Pauza / Pokračovat** u stolu (cash: zakladatel nebo `zasah.pauza`, turnaj přes turnaj), pohled stolu nese `paused`, nabídka **Zvuk** je i u stolu (na mobilu vedle ⋯).
- Oprava „šedivé Uložit“: textová hodnota, která vypadá jako JSON (např. `templates.order`), se z jsonb vracela rozparsovaná a validace pak odmítla celé globální nastavení – při načtení se hodnoty srovnají podle typu parametru (`coerce` v settings-store) a tlačítko Uložit blokují jen chyby změněných polí; důvod se vypisuje přímo v liště. Chat u stolu: seznam zpráv jde tažením zvětšit a tlačítko ⛶ ho otevře na celou obrazovku (i na PC). Karty: nové líce (tučné indexy, obrysové) a ruby (mřížka, šachovnice, paprsky, rámeček), nové motivy Modrý klub, Zlatý večer, Pastelový.
- Správa → **Údržba** (`MaintenanceService`, jen hlavní správce s `nastaveni.globalni`): vynulování po testování po oblastech – zavření stolů a zrušení turnajů, XP a úrovně, úspěchy, rating (včetně historie a podezření), statistiky a historie hand, peněženky na startovní zůstatek (rozdíl přes účet mint); potvrzení slovem VYNULOVAT, zápis do audit logu. U uživatele tlačítko **Vynulovat XP a rating** (jen jeho). Test `maintenance.test.ts`.
- Mobil na šířku: nízké okno (telefon landscape) je také mobilní rozložení s atributem `data-landscape` – stůl vlevo podle výšky okna, stav tahu, akční lišta a tlačítka vpravo (grid na `.tk-screen`), bez přetékání. Tvar oválu na mobilu je osobní volba `ui.mobileTableAspect` (100 % kruh … 150 % jako na PC). Klávesové zkratky u stolu (`ui.hotkeysEnabled`, F/C/B/R/A, šipky ↑/↓ mění výšku sázky; nastavitelné). Návrat ze sit outu je hned od další handy (čekání na big blind jen s `cash.sitInWaitsForBb`); přepínač Sit out je v levém panelu.
- Telefon: menší karty (vlastní 0,62×, soupeři 0,45×, board 0,58× šířky karty), moje sedadlo posunuté níž k okraji oválu, menší pot.
- Správa → **Turnaje**: přehled turnajů (filtr jen ukončené/zrušené) a nevratné **Smazat z historie** (`TournamentManager.deleteFromHistory`, jen `nastaveni.globalni`): smaže záznam turnaje, výsledky, vyřazení, handy jeho stolů, sázky, odměny na hlavu, zařazení do večera a chat stolu; XP a rating zůstávají. REST `DELETE /api/tournaments/:id`, test v `maintenance.test.ts`.
- Správa → **Historie** (`HistoryService`, nové oprávnění `historie.spravovat`, u role Administrátor výchozí): přehled skončených turnajů, zavřených cash stolů, živých cash her, uzavřených anket, zavřených večerů a sdílených hand s nevratným mazáním včetně souvisejících záznamů; hromadné mazání hand starších než N dní. Samostatná stránka Turnaje sloučena sem. Bubliny akcí mizí po skončení sázkového kola a při živé hře se už časovač nerušil překreslením (dřív bubliny „visely“). Symbol měny u stolu je ve výchozím stavu zapnutý (volba zůstává), v záhlaví je zůstatek se symbolem. Vestavěné turnajové šablony mají strukturu „automaticky“ (dopočítá se ze stacku a délky), aby seděla i po změně stacku; předvolby Pomalá/Standardní/Turbo/Hyper zůstávají.
- **Uložené struktury blindů**: tabulka `blind_structures` (migrace 0034), `BlindStructureService` (správce zakládá/upravuje/maže, kdokoli čte), Správa → Struktury blindů s editorem a náhledem levelů; v kartě Struktura blindů při zakládání/úpravě turnaje a v šabloně jsou uložené struktury v nabídce (přepočítají se na stack turnaje přes `scaleStructure`, převezmou délku levelu) a tlačítko „Uložit jako strukturu“. Test `structures.test.ts`, přepočet v `estimate.test.ts`.
- Údržba: **Nový start účetní knihy** (`MaintenanceService.resetLedger`, `Ledger.reset`): po zavření všech her smaže celou historii transakcí a zůstatků a každému hráči připíše počáteční zůstatek otevírací transakcí z účtu mint (kniha zůstane vyrovnaná, číslování od 1); samostatné potvrzení slovem VYNULOVAT, audit log, test.
- Statistiky → Moje statistiky: sekce **Jak se mi daří** (`/api/stats/timeline`, `TimelineService`, jen vlastní data): souhrnné karty (zůstatek, změna, výsledek turnajů a cash, nejlepší turnaj, XP, handy) a grafy – zůstatek v peněžence po každém pohybu, turnaje (kumulativní zisk + sloupce po turnajích), cash (kumulativní výsledek v žetonech + po dnech), XP, rating (turnaje/cash, jen když je zobrazení čísel povolené) a aktivita po dnech; období 30 dní / 90 dní / rok / vše; najetí myší nebo klepnutí ukáže hodnotu. SVG bez knihovny (`charts.tsx`), šířka se měří, barvy z tokenů.
- Statistiky → **Přehled hráčů** (`OverviewService`, `/api/stats/overview` a `/api/stats/compare`): tabulka všech aktivních hráčů (zůstatek, celkový výsledek, zisk z turnajů a cash, úroveň a hodnost, rating turnaje/cash, handy, turnaje; řazení klepnutím na sloupec, vlastní řádek zvýrazněn) a srovnání vývoje až 8 vybraných hráčů v jednom grafu (zůstatek / zisk / XP, období 30 dní až vše, legenda se zvýrazněním a hodnotami při najetí). Viditelnost řídí globální nastavení `stats.publicOverview` (výchozí zapnuto; vypnuto = čísla ostatních se nevydávají). `DataTable` umí v hlavičce i tlačítka. Test `overview.test.ts`.
- Statistiky: primární ukazatel je **výdělek ze všech her** (turnaje + cash + živý cash, vše v měně, bez dobití a výplat od pokladníka): výchozí metrika srovnání hráčů, první sloupec tabulky Přehled hráčů a první graf/karta v „Jak se mi daří“; zůstatek zůstává jako podružný údaj s poznámkou, že zahrnuje dobití. Cash se v grafech počítá v měně (ne v žetonech), živý cash je započten.

## Testování simulací (apps/server/scripts/simulate.ts)
- Spuštění: `cd apps/server && pnpm exec tsx scripts/simulate.ts [cash|tournament|all] [sekundy] [seed]`.
- 6 botů přes Socket.IO hraje cash (chaos: sit out, doplnění, odchody, odpojení, call clock, pauzy) a turnaje (freezeout, rebuy + add-on, bounty, 2 stoly). Hlídá nulový součet knihy, shodu žetonů u stolu s knihou, zaseknutí a chyby serveru.
- Výsledek (cash seedy 13, 31, 32, 33; turnaje seedy 1–3): žádné chyby serveru. Nalezena jediná vada: chyběly české texty pro chybové kódy pokerového enginu (doplněno + test).

## Hlavní menu
- Horní menu má 4 barevné rozbalovací skupiny: Hrát (zelená), Komunita (modrá), Moje (žlutá), Účet a správa (červená/akcent). Barvy jsou design tokeny (success, info, warning, accent). Na telefonu jsou skupiny pod tlačítkem Nabídka a rozbalují se po jedné. Komponenta `apps/web/src/main-menu.tsx`.

## Velikost oken u stolu (počítač)
- Levý panel jde tahat za pravý a spodní okraj (šířka, výška), chat za pravý/levý a spodní okraj (šířka, výška seznamu zpráv); dvojklik na úchyt vrátí výchozí velikost.
- Chat jde sbalit do miniatury (pruh s počtem nepřečtených a poslední zprávou). Vše se ukládá jako osobní nastavení (`ui.tablePanelWidth/Height`, `ui.tableChatWidth/Height`, `ui.tableChatMinimized`), komponenta `apps/web/src/table/resizable.tsx`.

## Lobby jako přehled a stránka Cash stoly
- `/` je nově přehled (`apps/web/src/pages/dashboard.tsx`): moje konto (zůstatek, výdělek ze všech her, místo v žebříčku), kde právě hraju, otevřené cash stoly, plánované turnaje (se startem) a žebříček hráčů podle výdělku. Žebříček se řídí nastavením `stats.publicOverview`.
- Dosavadní seznam cash stolů (zakládání, úprava, zavření) je na `/cash`, v menu Hrát → Cash stoly. Živý cash zůstává samostatný (zápis hry u skutečného stolu), s online stoly se nemíchá.
- Server: přehled turnajů vrací i `startAt` (plánovaný start).
- Živý cash je schovaný z nabídky (globální nastavení `liveCash.enabled`, výchozí vypnuto). Stránka a uložené hry zůstávají, zapnout jde v Nastavení.
- Mobilní rozložení se z tlačítka u stolu ukládá jen pro dané zařízení (vrstva zařízení přebíjí nastavení účtu); tlačítko je vidět i na počítači.
- Stránka stolu využije celou šířku okna a po sbalení chatu do miniatury se stůl zvětší (`--tk-table-vh`). Úchyty velikosti panelu a chatu jsou viditelné čárky na okraji.
- Chat u stolu je na širokém displeji dole v levém panelu (widgety nad ním se posouvají, chat je pevně vidět); místo pod stolem zmizelo. Šířku chatu určuje šířka panelu, výšku seznamu zpráv jde tahat (`ui.tableChatHeight`), sbalit jde do miniatury. Nastavení šířky chatu bylo zrušeno.
