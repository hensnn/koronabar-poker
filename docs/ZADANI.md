# KoronaBar Poker: specifikace projektu

> Tento dokument je kompletní zadání. Stálá pravidla práce jsou v `CLAUDE.md` v kořeni repozitáře.

## Kontext
Stavíme webovou aplikaci pro domácí poker přátel přes internet. Každý hraje ze svého domova v prohlížeči (mobil i počítač). Skupina má typicky 4–9 hráčů. Dnes hrajeme přes DDPoker a chceme něco modernějšího, přívětivějšího a s mnohem bohatším nastavením.

Hraje se o **virtuální měnu**, která se chová jako peníze (peněženky, buy-iny, výhry, vyúčtování). Měna je **čistě virtuální a nemá žádnou peněžní hodnotu**: nejde ji koupit ani směnit za skutečné peníze a aplikace nikdy nepracuje se skutečnými penězi ani platbami. To musí být **výslovně uvedeno** v podmínkách použití, které hráč odsouhlasí při registraci, v patičce aplikace a u vyúčtování (převody ve vyúčtování jsou vždy jen ve virtuální měně). Texty jsou upravitelné v nastavení.

Celé UI je **v češtině**. Pokerové výrazy (Fold, Check, Call, Raise, All-in, Straddle…) mohou zůstat anglicky.

Doména: **poker.example.cz**

## Hlavní princip: nepiš pokerová pravidla od nuly
Základní herní logiku (pořadí tahů, sázková kola, blindy, all-in, **side poty**, vyhodnocení rukou, showdown) převezmi z hotové open-source knihovny. Nepiš ji sám.

1. Nejdřív porovnej kandidáty a doporuč jeden. Kritéria: správnost side potů a all-in, maska pohledu pro jednotlivého hráče, možnost rozšíření (run it twice, straddle, ante/BB ante), serializace stavu, testy, údržba, licence.
   - `@pokertools/engine` (TypeScript, `engine.view(playerId)`, turnajový modul)
   - `poker-ts` (TypeScript, stavový automat stolu)
   - případně jiný, pokud najdeš lepší
2. Engine obal vlastním **adaptérem** (`PokerEngineAdapter`), aby šel vyměnit. Funkce, které engine neumí (např. run it twice), implementuj v adaptéru nebo v herní vrstvě nad ním.
3. Herní formáty (cash, turnaje, bounty, dealy) jsou vlastní vrstva nad enginem.
4. Architekturu připrav tak, aby šlo později přidat **Pot-Limit Omaha** a další varianty. Na začátku stačí No-Limit Texas Hold'em.

**Než začneš psát kód, předlož mi plán**: volbu enginu se zdůvodněním, architekturu, datový model a fáze. Počkej na moje schválení.

## Klíčový požadavek: maximální konfigurovatelnost a škálovatelnost
Cílem je co nejvíc škálovatelná hra. **Každá proměnná musí jít změnit v nastavení.** V kódu nesmí být napevno žádná herní, časová, finanční ani UI konstanta. Všechna čísla v tomto zadání (počty hráčů, časy, procenta, limity…) jsou jen **výchozí hodnoty**.

### Architektura nastavení
- **Jedno centrální schéma nastavení** (např. Zod), ze kterého se odvozuje všechno: typy v TypeScriptu, validace na serveru, výchozí hodnoty a **automaticky generovaný formulář v UI**. Nový parametr = přidání do schématu, bez psaní formuláře ručně.
- Každý parametr má ve schématu: klíč, český název, popis/nápovědu, typ, výchozí hodnotu, min/max/krok nebo výčet možností, jednotku, kategorii (pro záložky v UI), závislosti (např. „zobrazit jen když je zapnuté bounty“) a příznak **kdy ho lze měnit**:
  - `kdykoli` (změna platí okamžitě nebo od další handy),
  - `jen mezi handami`,
  - `jen před startem hry`,
  - `jen admin`.
- **Vrstvy s dědičností** (nižší přepisuje vyšší): globální výchozí hodnoty (admin) → šablona → konkrétní hra/stůl → osobní nastavení hráče (jen to, co se týká jeho zobrazení a ovládání). V UI je vidět, odkud hodnota pochází, a jde ji vrátit na zděděnou.
- **Kde se ukládá nastavení hráče:** všechno osobní nastavení (motiv a režim, zvuky a hlasitosti, ztlumení, notifikace, rychlé sázky, klávesové zkratky, oblíbené emotikony, vlastní šablony) se ukládá **na serveru v databázi u účtu hráče**. Po přihlášení na jiném zařízení má hráč vše stejně a nastavení je součástí zálohy databáze. **Synchronizace napříč zařízeními je výchozí a hlavní požadavek.** Změna na jednom zařízení se okamžitě (přes Socket.IO) projeví i na ostatních právě otevřených zařízeních téhož hráče, bez obnovení stránky.
  - Volitelně **přepsání pro konkrétní zařízení** (např. na mobilu jiné rozložení nebo tišší zvuk): hráč u vybraných položek zaškrtne „jen na tomto zařízení“. Ty se uloží také na serveru, ale s identifikátorem zařízení.
  - V prohlížeči (localStorage) je jen **mezipaměť** pro rychlé načtení a to, co nesmí opustit zařízení (identifikátor zařízení). Server je vždy zdroj pravdy.
  - Hráč může své nastavení **exportovat a importovat jako JSON** a vrátit na výchozí hodnoty (celé nebo po kategoriích). Admin může nastavení hráče resetovat.
- Kontrola **vzájemné konzistence** (např. min. buy-in ≤ max. buy-in, součet procent výplat = 100 %, bounty ≤ buy-in) se srozumitelnou chybou česky.
- **Šablony**: ukládání, kopírování, sdílení mezi hráči, **export/import jako JSON**. Přednastavené šablony pro běžné formáty.
- Změny nastavení běžící hry se zapisují do **historie (audit log)**: kdo, kdy, co, z jaké hodnoty na jakou. Hráči u stolu dostanou systémovou zprávu.
- Nastavení je verzované (číslo verze schématu) a při upgradu aplikace se staré šablony automaticky migrují.
- Herní pravidla a speciální prvky piš jako **samostatné moduly (pluginy) s háčky** do průběhu handy (začátek handy, po akci, před showdownem, po rozdělení potu, vyřazení hráče…). Každý modul si do schématu registruje vlastní nastavení. Nový prvek jde přidat bez zásahu do jádra.

### Co všechno musí být nastavitelné (minimální katalog, rozšiř ho)
- **Stůl:** počet míst (2–10, s rezervou v kódu pro víc), varianta hry, sázkový limit (no-limit / pot-limit / fixed-limit), blindy, ante, BB ante, straddle (typy, výše, povinnost), pravidla pro dealer button a nové hráče (čekat na BB / zaplatit dead blind), heads-up pravidla.
- **Čas:** časovač tahu a všechny varianty time banku (viz sekce Časovač tahu a time bank), prodleva mezi handami, rychlost animací, timeout pro odpojeného hráče, počet hand do sit out, délka levelů a přestávek.
- **Cash:** min. a max. buy-in (v měně i v BB), top-up, rebuy, cash-out, hit-and-run ochrana (doba, pravidla), čekací listina, max. doba sit out.
- **Turnaj:** buy-in, fee, startovní stack, struktura blindů (editor levelů, automatický generátor podle cílové délky turnaje), late reg, rebuy (období, podmínky, cena, počet žetonů, max. počet), addon (kdy, cena, žetony), re-entry (počet, období), výplatní struktura (tabulky podle počtu hráčů, vlastní procenta, zaokrouhlení), pravidla pro přestávky.
- **Výplaty a poplatky:** viz samostatná sekce Výplaty, poplatky a podíl domu (house cut, rake, time charge, rakeback, fondy, jackpoty, garance, počet placených míst, rozdělení, zaokrouhlení).
- **Bounty:** typ (fixní/PKO/mystery), podíl z buy-inu, podíl vyplacený vs. přičtený k hlavě, pravidla dělení při split potu.
- **Dealy:** povolené metody, kdy lze navrhnout, minimální počet hráčů, částka ponechaná „na hru“, časový limit hlasování.
- **Časování průběhu handy (každá prodleva zvlášť, v milisekundách nebo sekundách):** rozdání jedné karty hráči, prodleva mezi kartami při rozdávání, odhalení flopu (prodleva mezi třemi kartami), prodleva před turnem a před riverem při běžné hře, **prodlevy mezi ulicemi při dokládání karet po all-inu** (zvlášť před flopem, turnem a riverem, volitelně „dramatické zpomalení“ riveru), otočení karet hráčů při all-inu, zobrazení výherce a výherní kombinace, přesun žetonů do potu a k výherci, prodleva mezi běhy při run it twice, zobrazení rabbit huntu, pauza po showdownu před další handou, prodleva před automatickou akcí odpojeného hráče. Možnost globálního zrychlení nebo zpomalení všech animací jedním násobitelem.
- **Pravděpodobnost výhry při dokládání karet:** zap/vyp, zvlášť pro hráče a přihlížející, zobrazení outů a síly ruky, počet desetinných míst, styl ukazatele, metoda výpočtu a počet simulací (Monte Carlo).
- **Speciální prvky:** každý zap/vyp a s vlastními parametry (run it 2×/3×, kdo musí souhlasit, rabbit hunt, ukazování karet, 7-2 bonus a jeho výše, bomb pot a frekvence/výše, automatické ukázání karet při all-inu…).
- **Měna a ekonomika:** název, symbol, počet desetinných míst, počáteční vklad, limit záporného zůstatku, kdo smí dobíjet, zaokrouhlování výplat.
- **Akční lišta a UX:** tlačítka rychlých sázek (počet, hodnoty jako násobky potu nebo BB, zvlášť preflop a postflop), krok posuvníku, klávesové zkratky (přemapovatelné), zobrazení v měně/BB, zvuky (každý zvlášť), notifikace. Vzhled řeší samostatný systém motivů (viz sekce Vzhled).
- **Chat a reakce:** zap/vyp, seznam emoji, limity zpráv, chat pro přihlížející, zpoždění pro přihlížející.
- **Systém:** registrace a pozvánky, délka session, rate limity, délka sezóny, co se počítá do žebříčku, uchovávání historie hand (počet dní/neomezeně).

### Škálovatelnost
- Server musí zvládat **libovolný počet souběžných stolů a her**. Každý stůl je izolovaná instance s vlastním stavem. Pád nebo chyba na jednom stole neovlivní ostatní.
- Herní stav drž v paměti, ukládej průběžně do DB a komunikaci přes Socket.IO dělej po místnostech, aby šlo později přidat Redis adapter a provozovat víc instancí serveru.
- Datový model připrav na **turnaje přes více stolů** (přesazování, balancování, finálový stůl), i když v první verzi budou jednostolové.
- Žádné limity napevno v datovém modelu (počet míst, počet levelů, počet rebuyů, počet běhů run it…).

## Technologie (návrh, můžeš oponovat se zdůvodněním)
- **Server:** Node.js 20+ a TypeScript, Fastify nebo Express, **Socket.IO** pro real-time komunikaci
- **Klient:** React a Vite a TypeScript, Tailwind. Mobile-first, responzivní.
- **Databáze:** **PostgreSQL** (rozhodnuto) jako samostatný kontejner v Docker Compose s daty ve volume. ORM Drizzle nebo Prisma s migracemi. Peněžní operace v transakcích (s odpovídající úrovní izolace nebo zámky řádků), částky jako celá čísla v nejmenších jednotkách, nikdy desetinná čísla s plovoucí čárkou. Automatická denní záloha databáze (`pg_dump`) do volume s nastavitelnou retencí.
- **Nasazení:** Docker Compose, za Nginx Proxy Manager (HTTPS, WebSocket) na `poker.example.cz`. Aplikace sama poslouchá jen HTTP na jednom portu. **Cílový server zatím není rozhodnutý** (bude to LXC s Debianem a Dockerem na některém Proxmoxu), proto nic nesmí záviset na konkrétní IP adrese, síti ani hostiteli: vše přes proměnné v `.env`. Orientační požadavky: 2–4 jádra, 4 GB RAM, 30 GB disk.

## Bezpečnost a férovost (povinné)
- **Server je jediná autorita.** Klient jen posílá akce, server je validuje.
- Míchání: Fisher–Yates s kryptografickým RNG (`crypto.randomInt`), nikdy `Math.random`. Při run it twice se druhý board rozdává ze zbytku téhož balíčku.
- Každý klient dostává **jen své vlastní karty**. Cizí karty se posílají až při showdownu, a jen ty, které se ukazují. Tohle ověř testem.
- Rate limiting akcí a chatu, validace všech vstupů.

### Správa tajných údajů (API klíče a hesla)
Platí pro **všechny** tajné údaje zadávané v GUI: Gemini a další AI klíče, Google Cloud TTS klíč, heslo k SMTP (Gmail heslo aplikace), heslo k MQTT, tajemství pro podpis webhooků, Discord webhook adresy, klíče k VAPID push notifikacím.
- **Šifrování v databázi:** AES-256-GCM, pro každý údaj náhodný nonce, k tomu uložená **verze klíče**. Hlavní šifrovací klíč (32 bajtů) je **jen mimo databázi**: v proměnné prostředí z `.env`, nebo lépe v Docker secret. Při prvním startu, pokud klíč chybí, aplikace ho vygeneruje a vypíše návod, kam ho uložit a zazálohovat.
- **Klíč nikdy neopustí server:** všechna volání Gemini a dalších služeb dělá server, prohlížeč klíč nikdy nedostane. API vrací jen informaci „nastaveno“ a **poslední 4 znaky** (`••••••••abcd`). Celý klíč nejde v GUI znovu zobrazit, jen **nahradit** nebo **smazat**.
- **Nikdy v logu ani v exportu:** tajné údaje se maskují v logech, chybových hláškách, audit logu (zapíše se jen „klíč změněn“, kdo a kdy) i v exportu nastavení do JSON (exportují se bez tajných údajů).
- **Zálohy:** záloha databáze obsahuje jen zašifrované hodnoty. README upozorní, že **hlavní klíč se musí zálohovat zvlášť** (bez něj jdou tajné údaje jen znovu zadat, ostatní data zůstanou v pořádku).
- **Rotace klíče:** příkaz v kontejneru (a tlačítko pro hlavního administrátora), který vygeneruje nový hlavní klíč a přešifruje všechny údaje. Starý klíč jde po rotaci zahodit.
- **Ochrana změn:** zadání, změna nebo smazání tajného údaje vyžaduje příslušné oprávnění a **znovuzadání hesla**. Tlačítko „Otestovat“ volá službu ze serveru a vrací jen výsledek.
- V GUI u Gemini klíče krátké doporučení: v Google AI Studio / Google Cloud **omezit klíč jen na Gemini API** a nastavit kvótu, aby případný únik neměl velké následky.

## Účty, role a virtuální měna
- Účty: přezdívka a heslo (argon2 nebo bcrypt), session v httpOnly cookie. Registrace jen přes **pozvánkový kód** od admina.
- Oprávnění řeší **systém rolí** (viz níže). Kde se v tomto zadání píše „admin“, myslí se tím **kdokoli s příslušným oprávněním**.

### Role a oprávnění
Řízení přístupu je postavené na **granulárních oprávněních seskupených do rolí**. Role nastavuje a přiděluje **Hlavní administrátor** v GUI. Mysli na co nejvíc reálných situací a v plánu mi navrhni i ty, které tu chybí.

**Základní principy**
- **Oprávnění** je nejmenší jednotka (např. `turnaj.vytvorit`, `mena.dobit`, `chat.mazat_zpravy`). Celý katalog oprávnění je definovaný v jednom místě (stejný přístup jako u schématu nastavení), každé má český název, popis a kategorii. Nová funkce si do katalogu registruje vlastní oprávnění.
- **Role** je pojmenovaná sada oprávnění s **úrovní síly** (číslo, např. 0–100), barvou a ikonou (zobrazí se u přezdívky v chatu a u stolu, volitelně).
- **Hierarchie podle síly:** hráč smí přidělovat, odebírat a upravovat jen role a uživatele s **nižší silou**, než je jeho nejvyšší role, a nemůže nikomu dát oprávnění, které sám nemá. Nikdo nemůže zvýšit sílu vlastní role.
- Hráč může mít **více rolí najednou**. Výsledná oprávnění jsou jejich sjednocení, výslovné zákazy mají přednost.
- **Rozsah (scope) přidělení:** role může platit globálně, nebo jen pro konkrétní sérii, turnaj, stůl nebo kanál chatu (např. „Turnajový ředitel jen pro Páteční ligu“, „Moderátor jen kanálu Hospoda“).
- **Časově omezené role:** přidělení s datem platnosti „od–do“ (např. zástup pokladníka na dovolenou), po vypršení se samo odebere.
- **Limity u oprávnění:** oprávnění může mít parametry, např. pokladník smí dobít max. X za jednu operaci a Y za den, organizátor smí zakládat hry s buy-inem max. Z a mít nejvýš N her současně, moderátor smí ztlumit max. na 24 h.
- **Vlastní vs. cizí:** u akcí nad hrami rozlišuj „své“ (které hráč založil) a „všechny“ (např. `turnaj.upravit_vlastni` vs. `turnaj.upravit_vse`).
- **Princip čtyř očí (schvalování):** vybrané akce lze nastavit tak, že je musí **schválit druhá osoba** s oprávněním (např. dobití nad limit, ruční úprava účetní knihy, smazání účtu, změna rolí s vysokou silou). Nikdo nesmí schválit vlastní požadavek.
- **Žádosti od hráčů:** hráč může požádat o dobití měny, o roli nebo o schválení zvuku či motivu. Žádosti mají frontu, notifikaci příslušným osobám a historii vyřízení.

**Hlavní administrátor**
- Vzniká při prvním startu. Má vždy všechna oprávnění a nejvyšší sílu, roli nejde upravit ani smazat.
- Aplikace nedovolí odebrat **posledního** hlavního administrátora. Hlavních administrátorů může být víc, volitelně se přidání dalšího potvrzuje e-mailem.
- **Nouzová obnova:** když se hlavní administrátor zamkne, jde přístup obnovit příkazem v kontejneru (CLI), popsaným v README.

**Předpřipravené role** (jde je upravit, duplikovat, smazat a přidat vlastní):
- **Hlavní administrátor:** vše, včetně správy rolí a systému.
- **Administrátor:** správa uživatelů, pozvánek a většiny nastavení, bez správy rolí s vyšší silou a bez systémových věcí (SMTP, zálohy, šifrovací klíče).
- **Pokladník (bankéř):** dobíjení a strhávání měny v rámci limitů, vyřizování žádostí o dobití, přehled účetní knihy a vyúčtování, uzavření sezóny po stránce měny.
- **Organizátor her (zhotovitel her):** zakládání a plánování turnajů a cash stolů, opakované turnaje a série, úprava a zrušení vlastních her, správa šablon her.
- **Turnajový ředitel (floor):** zásahy do běžící hry: pauza, prodloužení přestávky, úprava nastavení za běhu (jen u položek, které to dovolují), vyřazení neaktivního hráče, rozhodnutí sporu, ruční oprava stacku se zápisem důvodu.
- **Moderátor chatu:** mazání zpráv, ztlumení a dočasná blokace v chatu, připínání zpráv, správa kanálů.
- **Kurátor obsahu:** schvalování sdílených zvukových emotikonů, motivů a obrázků, správa vestavěné knihovny.
- **Statistik:** správa sezón a žebříčků, bodování sérií, export statistik.
- **Hráč:** běžné hraní, chat, vlastní nastavení, žádosti.
- **Nováček:** omezený hráč do ověření e-mailu nebo schválení (např. jen chat a přihlížení, bez nahrávání souborů).
- **Host / přihlížející:** jen sledování her a čtení vybraných kanálů.
- **Zablokovaný:** žádný přístup kromě přihlášení s informací o blokaci a jejím důvodu a délce.

**Katalog oprávnění (minimálně tyto oblasti, rozepiš do detailu):** uživatelé a pozvánky, role a oprávnění, měna a účetní kniha, cash hry, turnaje, plánované turnaje a série, zásahy do běžící hry, přihlížení (např. vidět karty se zpožděním pro ředitele), chat a kanály, zvukové emotikony, motivy a vzhled, statistiky a sezóny, e-mail a šablony e-mailů, systémová nastavení, zálohy a údržba, audit log.

**GUI pro správu rolí**
- Seznam rolí seřazený podle síly, editor role se zaškrtávacími oprávněními po kategoriích, nastavení limitů a rozsahu.
- **Matice oprávnění** (role × oprávnění) pro rychlý přehled a porovnání rolí.
- U uživatele přehled jeho rolí, odkud které oprávnění má, a tlačítko **„Zobrazit aplikaci jako tento uživatel“** (náhled bez možnosti provádět akce).
- Hromadné přidělení role více hráčům.
- Export a import definic rolí jako JSON.

**Bezpečnost**
- Oprávnění se kontrolují **vždy na serveru** u každé akce i každé zprávy přes Socket.IO. UI skryje, co hráč nesmí, ale na to se nespoléhá.
- Změna rolí se projeví okamžitě, i u právě přihlášených hráčů.
- Každé přidělení či odebrání role, změna role a každá akce vyžadující zvýšené oprávnění se zapíše do **audit logu** (kdo, komu, co, kdy, odkud a důvod). Hráč dostane upozornění, když získá nebo ztratí roli.
- Volitelně vyžadovat **znovuzadání hesla** před citlivými akcemi (změna rolí, úpravy měny nad limit).
- Profil: přezdívka, avatar (emoji nebo obrázek), změna hesla, e-mail.

### E-mail: ověření účtu a obnova hesla
Aplikace odesílá e-maily přes **SMTP**. Vše se nastavuje v GUI v administraci, nic natvrdo v kódu ani v `.env` (kromě šifrovacího klíče).
- **Nastavení SMTP v GUI:** server, port, zabezpečení (žádné / STARTTLS / SSL/TLS), přihlašovací jméno a heslo, jméno a adresa odesílatele, adresa pro odpovědi. Tlačítko **„Odeslat testovací e-mail“** se srozumitelným výpisem chyby česky. Heslo k SMTP se v DB ukládá **zašifrované** (klíč v `.env`) a v GUI se už nikdy nezobrazí celé.
- Přednastavení pro běžné poskytovatele (Gmail s heslem aplikace, Seznam, Brevo, vlastní server), které vyplní server, port a zabezpečení.
- **Odesílací účet aplikace: `poker@example.cz`** (předvyplněný jako přihlašovací jméno i adresa odesílatele, jméno odesílatele „KoronaBar Poker“; heslo aplikace zadá admin v GUI, nikdy v kódu ani v repozitáři).
- **Výchozí volba je Gmail** (`smtp.gmail.com`, port 587, STARTTLS, přihlášení celou Gmail adresou a **heslem aplikace**, ne běžným heslem k účtu). V GUI u této volby zobraz krátký návod česky: zapnout dvoufázové ověření na Google účtu, vytvořit heslo aplikace a vložit ho do pole bez mezer. Odesílatel musí být stejná Gmail adresa (nebo alias ověřený v Gmailu). Zohledni denní limit odesílání Gmailu: fronta e-mailů má mít nastavitelný denní strop a při jeho dosažení odkládá nepovinné e-maily (připomínky, výsledky) na další den, bezpečnostní e-maily mají přednost. Přihlašovací chyby Gmailu (např. špatné heslo aplikace) převeď na srozumitelnou českou hlášku.
- **Ověření e-mailu při registraci:** po zadání pozvánkového kódu, přezdívky, e-mailu a hesla přijde e-mail s odkazem. Do ověření je účet neaktivní (nebo omezený, podle nastavení). Možnost poslat ověření znovu.
- **Zapomenuté heslo:** zadání e-mailu nebo přezdívky → e-mail s jednorázovým odkazem. Na stránce se vždy zobrazí stejná odpověď, ať účet existuje, nebo ne. Po změně hesla se odhlásí všechny ostatní relace a přijde potvrzovací e-mail.
- **Změna e-mailu** vyžaduje ověření nové adresy a upozornění na starou.
- Tokeny v odkazech jsou náhodné, jednorázové a v DB uložené jen jako hash.
- **Nastavitelné v GUI:** platnost ověřovacího odkazu a odkazu pro obnovu hesla, zda je ověření e-mailu povinné, limity odesílání (počet žádostí na účet a IP za hodinu), veřejná adresa aplikace použitá v odkazech (`https://poker.example.cz`).
- **Šablony e-mailů upravitelné v GUI** (předmět a text, HTML i prostý text, proměnné jako `{prezdivka}`, `{odkaz}`, `{platnost}`, náhled před uložením). Výchozí šablony česky: ověření účtu, obnova hesla, potvrzení změny hesla, změna e-mailu, pozvánka, připomínky turnajů (registrace otevřena, start za X, zrušení či odložení), výsledky turnaje a vyúčtování.
- **Uživatel si v profilu vybírá**, jaké e-maily chce dostávat (bezpečnostní e-maily vypnout nejde).
- Admin může poslat **pozvánku e-mailem** přímo z administrace (s pozvánkovým kódem v odkazu) a v případě potřeby ručně ověřit účet nebo vynutit změnu hesla.
- **Fronta e-mailů** s opakováním při selhání a přehledem v administraci (odeslané, čekající, chyby). Když SMTP není nastavený, aplikace funguje dál a admin může heslo resetovat ručně.
- **Peněženka:** každý hráč má zůstatek ve virtuální měně. Název a symbol měny jsou nastavitelné (např. „Korona“, „KČ“).
  - Admin přiděluje počáteční vklad a dobíjí (s poznámkou).
  - Každý pohyb je záznam v **účetní knize** (ledger): buy-in, rebuy, addon, cash-out, výhra, bounty, deal, ruční úprava admina. Zůstatek se vždy dá spočítat z knihy.
  - Nastavení, zda je povolen záporný zůstatek (hra „na dluh“) a do jakého limitu.
- **Vyúčtování:** po každé hře i za celý večer nebo sezónu přehled, kdo kolik vyhrál nebo prohrál. K tomu **minimální seznam převodů** („Petr dá Pavlovi 350“), aby se to dalo jednoduše vyrovnat.

## Lobby
- Seznam stolů a turnajů (formát, stav, počet hráčů, blindy nebo buy-in). Filtry.
- Vytvoření hry přes podrobné nastavení (níže), **ukládání vlastních šablon** a přednastavené šablony.
- Odkaz pro pozvání do konkrétní hry, čekárna, start spouští zakladatel.
- **Přihlížení** (spectator) bez vidění karet, volitelně se zpožděním.

## Herní formáty
### Jedna měna, dva různé druhy žetonů (povinné rozlišení)
Cash game i turnaje používají **stejnou virtuální měnu a stejnou peněženku**, ale žetony u stolu mají v každém formátu úplně jiný význam. Systém to musí rozlišovat v datovém modelu, v účetní knize, v UI i ve statistikách. Nikdy se nesmí smíchat.

| | **Cash game** | **Turnaj** |
|---|---|---|
| Co jsou žetony | **Přímo měna.** Žetony u stolu = peníze z peněženky (výchozí kurz 1 : 1, kurz nastavitelný). | **Turnajové žetony bez peněžní hodnoty.** Slouží jen ke hře v daném turnaji. |
| Vstup | Buy-in: převod měny z peněženky na žetony u stolu (min./max.), top-up a rebuy kdykoli mezi handami. | Buy-in, rebuy, addon, re-entry a fee se strhnou z peněženky. Hráč za ně dostane **pevný počet turnajových žetonů** podle nastavení. |
| Výhra v handě | Okamžitě mění hráčův majetek. | Mění jen turnajový stack, peněženku neovlivní. |
| Odchod | **Cash-out:** žetony od stolu se převedou zpět do peněženky, kdykoli. | Žetony propadnou. Peníze se vyplácejí až podle **konečného umístění** z prize poolu. |
| Bounty | Neexistuje (kromě volitelných bonusů jako 7-2, ty jdou v měně). | Bounty se vyplácí **v měně** okamžitě při vyřazení (nebo na konci, podle nastavení). |
| Deal | Neexistuje. | Dělí se **prize pool v měně**, ne žetony (ICM a chip chop jen přepočítávají žetony na podíl z poolu). |
| Čistý výsledek hráče | výběry (cash-out) − vklady (buy-in, top-up, rebuy) | výplata za umístění + bounty + podíl z dealu − (buy-in + rebuy + addon + re-entry + fee) |

**Důsledky pro implementaci:**
- **Účetní kniha** má oddělené typy pohybů pro cash (`cash_buyin`, `cash_topup`, `cash_cashout`) a pro turnaje (`turnaj_buyin`, `turnaj_rebuy`, `turnaj_addon`, `turnaj_fee`, `turnaj_vyplata`, `bounty`, `deal`). Každý pohyb je navázaný na konkrétní hru.
- **Peníze ležící u cash stolu** jsou v knize vidět jako „na stole“ (hráč je nemá v peněžence, ale nepatří nikomu jinému). Při pádu serveru nebo zrušení stolu se automaticky vrátí do peněženek podle posledního uloženého stavu.
- **Prize pool** turnaje je v knize vedený jako samostatný účet turnaje. Po výplatách musí být nulový (zbytek ze zaokrouhlení podle nastaveného pravidla: vítězi, do banku, nebo rozpočítat).
- **UI:** v cash game se částky zobrazují se symbolem měny. V turnaji jako **žetony** (jiná ikona, bez symbolu měny), aby nikoho nemátlo, že má „10 000“ a v peněžence 500. Přepínač zobrazení v BB funguje v obou.
- **Vyúčtování** večera nebo sezóny sčítá oba formáty dohromady, ale vždy ukazuje i rozpad: kolik cash, kolik turnaje.
- **Statistiky, žebříčky, XP a rating** rozlišují formát. Turnajový a cash rating jsou oddělené (viz Postup hráče), žebříček zisku se ukazuje celkem i zvlášť.
- **Nastavení:** každý formát má vlastní sadu parametrů ve schématu, parametry, které ve formátu nedávají smysl, se v GUI nezobrazí.

### Vestavěné šablony her
Protože nastavení je hodně, aplikace má **připravené šablony nejhranějších a nejčastějších her**, ze kterých se hra založí jedním klikem. Každá šablona obsahuje **kompletní nastavení** (všechny parametry vyplněné, ne jen rozdíly). Vestavěné šablony jsou jen pro čtení, jdou duplikovat a upravit (viz Šablony v Architektuře nastavení).

**Pravidla pro šablony**
- **Intuitivní český název** ve tvaru `Kategorie – Název (upřesnění)`, aby i nováček poznal, co hraje. Pod názvem **jednovětý popis** pro laika.
- **Štítky** s ikonou: délka hry (odhad v minutách podle počtu hráčů), doporučený počet hráčů, obtížnost, a co je zapnuté (🔁 Rebuy, 🎯 Bounty, ⚡ Turbo, 🎲 Zábavné prvky, 🕰 Retro, 🍺 Živá hra).
- **Shrnutí klíčových parametrů** na kartě šablony (buy-in, startovní stack v BB, délka levelu, výplaty), detail po rozkliknutí.
- Výběr šablon s **filtrem** (cash / turnaj / živá hra, délka, počet hráčů, štítky) a vyhledáváním. Nahoře doporučené a naposledy použité.
- **Průvodce rychlým založením:** tři otázky tlačítky (Cash nebo turnaj? Jak dlouho? Klasika, nebo se zábavnými prvky?) a aplikace nabídne nejvhodnější šablony.
- Konkrétní hodnoty (struktury blindů, výplatní tabulky) navrhni podle běžných standardů, odhad délky vypočítej simulací, a předlož je ke schválení v plánu.
- Při přidání nového parametru v budoucnu dostanou vestavěné šablony rozumnou hodnotu. „Retro“ šablony mají každou novou funkci **vypnutou**.

**Minimální katalog vestavěných šablon (doplň, pokud něco běžného chybí)**

| Název | Popis pro hráče |
|---|---|
| **Cash – Klasika** | Běžný cash game, buy-in 40–100 BB, bez straddle a bez extra funkcí, bez rake. |
| **Cash – Hluboké stacky** | Buy-in 100–250 BB, delší časovač, pro pomalejší a promyšlenou hru. |
| **Cash – Krátké stacky** | Buy-in 20–50 BB, víc all-inů a rychlejší akce. |
| **Cash – Rychlovka (Turbo)** | Krátký časovač a shot clock, rychlé tempo. |
| **Cash – Divoký večer** | Straddle, run it twice, 7-2 bonus a bomb pot jednou za kolo. |
| **Cash – Heads-up 1 na 1** | Cash pro dva hráče. |
| **Cash – Jako v herně (s rake)** | Klasika s rake, stropem a „no flop no drop“, peníze jdou domu nebo do jackpotu. |
| **Turnaj – Klasický freezeout** | Jeden vstup bez rebuy, levely 15 min, cca 2–2,5 h. |
| **Turnaj – Domácí rebuy s addonem** | Rebuy první hodinu, na konci addon. Nejčastější domácí formát. |
| **Turnaj – Re-entry** | Po vypadnutí jde znovu vstoupit do konce pozdní registrace. |
| **Turnaj – Sit & Go Turbo** | Rychlý turnaj, levely 6 min, cca 45–60 min. |
| **Turnaj – Hyper Turbo** | Krátké stacky, levely 3 min, do 20–30 min. |
| **Turnaj – Deep stack (dlouhý)** | Velký startovní stack, levely 20–30 min, 3–4 h. |
| **Turnaj – Bounty (odměna za vyřazení)** | Část buy-inu je odměna za každé vyřazení. |
| **Turnaj – Progresivní bounty (PKO)** | Polovina bounty se vyplatí, polovina roste na hlavě vítěze. |
| **Turnaj – Mystery bounty** | Odměny za vyřazení jsou překvapení až od určité fáze. |
| **Turnaj – Vítěz bere vše** | Celý prize pool pro vítěze. |
| **Turnaj – Heads-up souboj** | Turnaj pro dva hráče. |
| **Turnaj – Freeroll (zdarma)** | Bez buy-inu, prize pool platí dům. |
| **Liga – Turnaj série** | Turnaj s body do série a příspěvkem do fondu finále. |
| **Liga – Finále sezóny** | Turnaj pro nejlepší hráče sezóny, prize pool z fondu. |
| **Retro – Jako DDPoker** | Čistý No-Limit Hold'em turnaj, jak jsme ho hráli dřív: jednoduchý časovač, bez time banku, bez šancí na výhru, bez zvukových emotikonů a bez dalších novinek. |
| **Retro – Kuchyňský stůl** | Jednoduchá domácí hra bez rake, poplatků a speciálních pravidel. |
| **Retro – Limit Hold'em** | Klasický Fixed-Limit Hold'em se stropem sázek. |
| **Živě – Turnaj v hospodě** | Režim živé hry: skutečné karty, aplikace dělá hodiny, buy-iny a výplaty. |
| **Živě – Cash u stolu** | Režim živé hry: evidence buy-inů a cash-outů, vyúčtování. |

### Výplaty, poplatky a podíl domu (detailní nastavení u každé hry)
Každá hra i turnaj má **vlastní detailní nastavení výplat a poplatků**. Výchozí hodnoty pochází ze šablony a jdou u konkrétní hry přepsat.

**Ovládání v GUI**
- Číselné hodnoty se nastavují **slidery** s polem pro přesné zadání vedle (a jednotkou: %, měna, BB, minuty).
- Volby a předvolby jsou **tlačítka** (segmentové přepínače), zapnutí funkcí přepínače.
- Procenta výplat podle míst: slidery, které se **automaticky dorovnávají na 100 %**. Jednotlivé místo jde **zamknout** (zámek), aby se při dorovnání neměnilo.
- **Živý náhled** vedle nastavení: tabulka výplat v měně pro zadaný počet hráčů (posuvník „simulovat pro X hráčů“ s počtem rebuyů a addonů), kolik jde do prize poolu, kolik do bounty, kolik domu a dalších fondů, a co dostane které místo. U cash game náhled rake z typického potu.
- Předvolby s tlačítky („Vítěz bere vše“, „Top heavy“, „Standardní“, „Ploché“, „Vlastní“) a uložení vlastní předvolby.

**Podíl domu (house cut) a poplatky — turnaje**
- **House cut z buy-inu:** procento nebo pevná částka, zvlášť pro buy-in, rebuy, addon, re-entry a late reg (např. buy-in 100 + 10).
- **Bounty podíl** z buy-inu (pro bounty a PKO turnaje).
- **Příspěvky do fondů** (každý zap/vyp, procento nebo pevná částka): fond série/ligy (výplata na konci série), fond finálového turnaje sezóny, jackpot (viz níže), vlastní pojmenovaný fond.
- **Garantovaný prize pool (garance):** když vybrané buy-iny nestačí, rozdíl doplní dům (overlay), s limitem a s volbou, zda se hra spustí jen při dosažení minima hráčů.
- Volitelně **příplatek za pozdní registraci** a **poplatek za odhlášení** po určitém čase.

**Rozdělení prize poolu — turnaje**
- **Počet placených míst:** pevný, procento pole, nebo automaticky podle tabulky (počet hráčů → počet míst), tabulka editovatelná.
- **Rozdělení:** procenta podle míst (slidery), nebo vzorec (např. geometrická řada s nastavitelným strmostí), nebo předvolba.
- **Bublina:** volitelná výplata „bubble“ (vrácení buy-inu prvnímu neplacenému místu) a minimální výplata = buy-in pro poslední placené místo.
- **Zaokrouhlování výplat:** na kolik (1, 5, 10…) a kam jde zbytek (vítězi, domu, rozpočítat shora).
- **Okamžik výplaty:** bounty okamžitě, nebo vše až na konci. Výplata za umístění při vyřazení (průběžně), nebo na konci.
- Pravidla pro **dealy** (viz výše) pracují s tímto nastavením.

**Podíl domu a poplatky — cash game**
- **Rake z potu:** procento, **strop** (cap) na handu (zvlášť podle počtu hráčů u stolu), minimální pot pro rake, **„no flop, no drop“** (bez flopu bez rake), zaokrouhlování.
- Alternativně nebo navíc **poplatek za čas** (time charge): částka za hráče za 30 nebo 60 minut u stolu.
- Volitelně **poplatek za sezení** při usednutí ke stolu.
- **Rakeback:** procento vybraného rake vrácené hráčům (podle podílu na rake nebo podle odehraných hand), s frekvencí výplaty (po sezení, denně, týdně).
- **Jackpoty z rake** (každý zap/vyp s vlastním podílem): **bad beat jackpot** (podmínka nastavitelná, např. prohra s čtveřicí osmiček a lepší, rozdělení mezi poraženého, vítěze a ostatní u stolu v procentech), **high hand** (nejlepší ruka za období), jackpot na royal flush.

**Kam jdou peníze domu**
- V účetní knize existuje **účet Domu (banku)** a samostatné účty jednotlivých fondů a jackpotů. Každý poplatek, rake a příspěvek se zapíše jako převod na příslušný účet.
- Zůstatky domu a fondů jsou vidět v administraci (podle oprávnění, viz role Pokladník), s historií.
- Využití peněz domu: doplnění garancí, výplata fondů a jackpotů, odměny (např. turnaj zdarma, freeroll), ruční převod se zápisem důvodu (s principem čtyř očí nad limit).
- Volitelně **průhlednost pro hráče:** hráči vidí stav fondů a jackpotů (nastavitelné, zda i stav domu).

**Validace:** součet procent = 100 %, poplatek nepřesáhne buy-in, bounty + house cut + fondy nepřesáhnou buy-in, strop rake ≥ 0, upozornění na nesmyslné hodnoty (např. rake 50 %). Chyby česky přímo u slideru.

### Cash game
- Blindy (volitelně ante, BB ante, **straddle**: UTG, volitelně mississippi), min. a max. buy-in.
- Kdykoli rebuy nebo top-up až do max. buy-inu (mezi handami), odchod od stolu s **cash-outem** do peněženky.
- Sit out a návrat, ochrana proti „hit and run“ (volitelně minimální doba hry nebo zákaz vrátit se s menším stackem během X minut).
- Volitelně čekací listina, když je stůl plný.

### Turnaje
- **Freezeout**, **rebuy/addon** (rebuy období N levelů, podmínky rebuye: po vypadnutí nebo stack ≤ počáteční, max. počet, addon na konci rebuy období) a **re-entry**.
- Struktura blindů podle **času** (minuty) nebo podle **počtu hand**, ante nebo BB ante, přestávky. Editor levelů.
- Buy-in a případný poplatek (fee, volitelně, jde do „banku“ nebo se nepoužije).
- Pozdní registrace (late reg) do levelu X.
- Rozdělení prize poolu podle umístění: přednastavené tabulky i vlastní procenta, automaticky podle počtu hráčů.
- Jeden stůl (max 9–10 hráčů). Balancování více stolů zatím neřešit, ale datový model na to připrav.

### Plánované turnaje (automatický provoz bez admina)
Turnaj jde **naplánovat dopředu** se všemi pravidly. Pak celý proběhne sám od registrace po výplatu, bez nutnosti, aby byl kdokoli přítomen jako správce.
- **Plánování:** datum a čas startu (časové pásmo Europe/Prague), jednorázově nebo **opakovaně** (např. každý pátek ve 20:00, každý první čtvrtek v měsíci). Vychází z uložené šablony nebo vlastního nastavení. Kdo smí plánovat, je nastavitelné (jen admin / vybraní hráči / všichni).
- **Registrace:** otevře se v nastavený čas před startem. Buy-in se strhne z peněženky při registraci (nebo až při startu, podle nastavení). Odhlášení s vrácením buy-inu do nastaveného času. Late registrace a re-entry podle pravidel turnaje.
- **Automatický start:** v plánovaný čas se hráči usadí (náhodné rozsazení, losování buttonu) a turnaj začne. Registrovaný hráč, který není online, je usazen a dostává blindy jako v sit out.
- **Minimální a maximální počet hráčů:** když se do startu nesejde minimum, turnaj se podle nastavení **zruší** (všem se vrátí buy-iny), **odloží** o X minut (nejvýš N krát), nebo začne i s menším počtem.
- **Celý průběh je automatický:** nárůst blindů, přestávky, konec rebuy období a addon, vyřazování, bounty, hlasování o dealu (s časovým limitem, bez odpovědi = nesouhlas), závěrečná výplata do peněženek a vyúčtování. Nic z toho nesmí čekat na ruční zásah.
- **Pojistky bez admina:** automatická pauza, když klesne počet připojených hráčů pod nastavenou hranici. Volitelné hlasování hráčů o pauze, prodloužení přestávky nebo ukončení. Při restartu serveru plánovač i běžící turnaj pokračují (plánované události jsou uložené v DB, ne jen v paměti).
- **Upozornění:** připomenutí registrovaným hráčům (nastavitelné časy, např. 24 h, 1 h a 10 min před startem) v aplikaci a přes **web push notifikace** (PWA). Volitelně e-mail, pokud bude nastavený SMTP. Upozornění i na otevření registrace a na zrušení nebo odložení.
- **Kalendář turnajů** v lobby: nadcházející turnaje, kdo je registrovaný, pravidla, odpočet do startu. Export do kalendáře (ICS odkaz, který jde přidat do Google Kalendáře).
- **Série a ligy:** volitelně spojení více plánovaných turnajů do série s **bodováním** (vzorec bodů nastavitelný) a vlastním žebříčkem série. Volitelně finálový turnaj série pro nejlepších N hráčů.
- Admin může plánovaný nebo běžící turnaj kdykoli upravit, pozastavit nebo zrušit. Každý zásah se zapíše do audit logu.

### Bounty (volitelné u turnaje)
- **Fixní bounty:** část buy-inu je odměna za vyřazení hráče.
- **Progressive knockout (PKO):** část bounty jde vyřazujícímu, zbytek se přičte k jeho vlastní hlavě.
- (Volitelně) **mystery bounty** od určité fáze.
- Správně řeš dělené poty: víc vyřazujících při split potu a vyřazení více hráčů v jedné handě.

### Dohody a dělení (deal)
- Kdykoli v turnaji (typicky na finále) může kdokoli navrhnout **deal**. Hlasují všichni zbývající hráči a deal platí jen při souhlasu všech.
- Metody: **ICM**, **chip chop** (poměr žetonů), **rovným dílem**, vlastní částky. Volitelně se nechá část poolu „na hru“ a hraje se dál o zbytek.
- Aplikace ukáže návrh rozdělení pro každou metodu vedle sebe.

### Časovač tahu a time bank (víc variant)
Časování rozhodnutí je samostatný modul s více **režimy, které jde kombinovat**. Každý stůl nebo turnaj si vybere režim tlačítky a parametry nastaví slidery. Přednastavené předvolby: **Pohodový**, **Normální**, **Turbo**, **Hyper**, **Šachové hodiny**, **Živý turnaj**.

**Základní časovač tahu**
- Čas na rozhodnutí, volitelně **zvlášť podle ulice** (preflop, flop, turn, river) a podle situace: první akce preflop (kratší, rychlé foldy), rozhodnutí proti all-inu nebo velké sázce (delší), heads-up, bomb pot.
- Akce po vypršení: check, jinak fold (výchozí), volitelně jen fold. Po N vypršeních za sebou automatický sit out.

**Varianty time banku**
1. **Klasický time bank (zásobník):** hráč má zásobu sekund pro celou hru. Když vyprší základní čas, začne se čerpat zásoba.
   - **Doplňování:** +X sekund každých N hand, +X za každý nový level, +X o přestávce, nebo vůbec.
   - **Strop** maximální zásoby, počáteční velikost, volitelně **reset** zásoby na začátku každého levelu.
2. **Time bank na handu:** v každé handě má hráč navíc pevný čas, který se do další handy nepřenáší („use it or lose it“).
3. **Prodlužovací žetony (time chips):** hráč dostane N žetonů po X sekundách (např. 3 × 30 s). Každý použije **ručně tlačítkem**. Další žetony za level nebo přestávku, strop počtu. Volitelně kombinace s klasickým zásobníkem.
4. **Šachové hodiny:** každý hráč má **celkový čas na celou hru** (nebo na level) a k němu:
   - **Fischerův přírůstek:** po každé akci se přičte X sekund.
   - **Bronsteinova prodleva:** prvních X sekund každého rozhodnutí se z hodin neodečítá.
   - Při vypršení celkového času: automatické akce, nebo jen minimální čas na tah.
5. **Shot clock:** pevný čas na každé rozhodnutí bez jakékoli zásoby (rychlé hry).

**Spouštění a ovládání**
- Time bank se spustí **automaticky** po vypršení základního času, nebo **ručně** tlačítkem „Čas navíc“ (volitelné, kvůli zamezení náhodného čerpání).
- **„Call the clock“ (vyvolání hodin):** když hráč přemýšlí příliš dlouho, kdokoli u stolu (nebo jen ředitel, nebo hlasováním přes modul anket) může vyvolat hodiny. Hráč pak má jen kratší pevný čas a time bank se nečerpá. Nastavitelné: kdo smí, po kolika sekundách přemýšlení, kolikrát za hru, délka odpočtu.
- **Ochrana při odpojení:** samostatná zásoba času pro odpojené hráče (disconnect time bank), aby výpadek Wi-Fi nesnědl běžný time bank. Velikost a doplňování nastavitelné.

**Zobrazení**
- Kruhový časovač kolem avataru se **změnou barvy** při přechodu do time banku, číselný odpočet, zvukové a vibrační upozornění (např. 10 a 5 s před koncem).
- U avataru zbývající zásoba time banku nebo počet prodlužovacích žetonů. Nastavení, zda zásobu ostatních hráčů vidí soupeři.
- Šachové hodiny zobrazené u každého hráče jako u šachu.

**V režimu živé hry** slouží časovač pro ředitele (vyvolání hodin s velkým odpočtem na mobilu a v TV režimu).

**Statistiky:** průměrná doba rozhodnutí, spotřebovaný time bank, počet vyvolání hodin (vůči komu a kým), počet vypršení.

### Speciální prvky (každý zapínatelný v nastavení hry)
- **Run it twice** (případně třikrát): nabídne se při all-in před riverem, musí souhlasit všichni zapojení hráči. Každý pot se dělí po polovinách nebo třetinách.
- **Rabbit hunt:** po skončení handy ukázat, co by přišlo.
- **Ukázat kartu** (jednu nebo obě) po foldu nebo vyhrané handě bez showdownu.
- **7-2 bonus:** kdo vyhraje s 7-2, dostane od každého hráče nastavenou částku.
- **Bomb pot:** občasná handa, kde všichni dají ante a hraje se rovnou od flopu (frekvence nastavitelná).
- Volitelné nastavení „all-in ukázat karty“ (při all-inu bez další akce se karty otočí).

Návrh dalších vylepšení vítán. Předlož je v plánu jako volitelné.

## Herní stůl (UX, na tom hodně záleží)
- Oválný stůl, vlastní místo vždy dole. Animace rozdání, žetonů, otočení karet. Zvýraznění hráče na tahu.
- **Časovač tahu** (kruh kolem avataru) a time bank. Po vypršení automaticky check, jinak fold.
- Akční lišta: Fold / Check / Call X / Raise, posuvník, rychlé sázky (½, ¾, pot, all-in, v cashi i 2,5×/3× BB preflop), zadání částky.
- **Předvolby akcí** (check/fold, check, call any).
- Zobrazení potu a side potů, levelu a času do dalšího, bounty u avatarů, počtu zbývajících hráčů, tlačítek rebuy/addon/top-up ve správnou chvíli.
- Dialogy pro run it twice a deal (hlasování) přímo u stolu.
- **Pravděpodobnost výhry při dokládání karet:** jakmile už nikdo nemůže hru ovlivnit (všichni zbývající hráči jsou all-in, nebo zbývá jediný hráč se žetony a ostatní jsou all-in), karty zapojených hráčů se otočí a u každého se zobrazí **procentuální šance na výhru** (a zvlášť na dělbu potu). Procenta se přepočítají po flopu, turnu i riveru.
  - Výpočet dělá server. Před riverem je počet zbývajících kombinací malý, proto použij **přesný výčet všech kombinací**. Monte Carlo jen jako záloha pro varianty s větším počtem karet (např. Omaha) s nastavitelným počtem simulací.
  - U více potů (side poty) zobraz šance zvlášť pro každý pot. Při run it twice zvlášť pro každý běh.
  - Volitelně zobrazit i **počet outů**, aktuální sílu ruky („Dvojice esa“, „Barva na flopu“) a karty, které by obrátily výsledek.
  - Procenta se zapisují do historie handy a vstupují do statistik (např. „smůla/štěstí“: očekávaná vs. skutečná výhra při all-inech).
  - **Nastavitelné:** zapnutí, zobrazení pro hráče a pro přihlížející zvlášť, zobrazení outů a síly ruky, počet desetinných míst, styl ukazatele (číslo, proužek, obojí).
- Zobrazení částek v měně i v **big blindech** (přepínač).
- Showdown s popisem kombinace česky („Postupka do dámy“).
- Historie hand (čitelně, s přehráním).
- Zvuky (vypínatelné), notifikace nebo blikající titulek, když jsem na tahu. Klávesové zkratky na desktopu.
- Čitelné karty i na mobilu, vzhled podle zvoleného motivu (viz sekce Vzhled).
- Instalovatelné jako PWA.

## Vzhled: motivy a editor vzhledu
Vzhled celé aplikace (lobby, chat, administrace i herní stůl) musí jít **kompletně upravit v GUI**. Nic vizuálního nesmí být napevno v CSS ani v komponentách.

### Architektura
- Celé UI stojí na **design tokenech** (CSS proměnné), které se generují z motivu. Komponenty používají jen tokeny, nikdy přímé barvy, velikosti nebo fonty. Tokeny jsou definované ve stejném centrálním schématu jako ostatní nastavení (typ, výchozí hodnota, rozsah, kategorie, český popis).
- Motiv je JSON s verzí schématu. Starší motivy se při upgradu automaticky migrují a chybějící hodnoty doplní výchozí.
- Grafické prvky (karty, žetony, stůl, dealer button) jsou vykreslené přes SVG nebo CSS a parametrizované tokeny, aby šly měnit barvy a tvary bez nových obrázků. Volitelně jde nahrát vlastní obrázky (rubová strana karet, textura stolu, pozadí, logo).

### Co jde nastavit (minimální katalog, rozšiř ho)
- **Barvy:** primární, sekundární a zvýrazňující barva, pozadí a plochy (několik úrovní), text (hlavní, vedlejší, ztlumený), okraje, stavové barvy (úspěch, varování, chyba, info), odkazy, výběr a focus.
- **Herní stůl:** tvar (ovál, obdélník se zaoblením, kruh), barva a textura plsti, okraj stolu (barva, šířka, materiál), logo nebo text uprostřed, osvětlení či vinětace, pozadí místnosti.
- **Karty:** styl líce (klasický, minimalistický, velké indexy), 2barevný nebo **4barevný balíček** a barvy jednotlivých barev, rubová strana (barva, vzor, vlastní obrázek), velikost, zaoblení rohů, stín, animace otočení.
- **Žetony a pot:** barvy hodnot, styl žetonů, zobrazení stacku (žetony / jen číslo / obojí).
- **Hráči u stolu:** tvar avataru (kruh, čtverec, zaoblený), rámeček, zvýraznění hráče na tahu (barva, záře, pulzování), styl časovače, štítky akcí (Fold, Call…) a jejich barvy, dealer button a blind žetony.
- **Akční tlačítka:** barvy pro Fold / Check / Call / Raise / All-in, tvar, velikost, styl (plné, obrysové, lesklé).
- **Typografie:** písmo pro nadpisy, text a čísla zvlášť (výběr z balíčku písem dodaných s aplikací, volitelně Google Fonts nebo nahrání vlastního), základní velikost a měřítko, tloušťka, řádkování, tabulková čísla pro částky.
- **Tvary a rozvržení:** zaoblení rohů (globálně i po prvcích), stíny, tloušťka okrajů, hustota (kompaktní / normální / vzdušná), mezery, šířka panelů, umístění chatu a historie u stolu.
- **Animace:** zapnutí, rychlost, typ přechodů, respektování systémového nastavení „omezit pohyb“.
- **Zvuky** jako součást motivu (sada zvuků a hlasitost jednotlivých).

### Světlý a tmavý režim
- Každý motiv má **světlou i tmavou variantu**. Editor umí upravovat obě a jedním klikem vygenerovat druhou variantu z první jako návrh k doladění.
- Hráč volí režim: světlý, tmavý, nebo **automaticky podle systému** (`prefers-color-scheme`). Volitelně automatické přepnutí podle času.
- Přepnutí režimu i motivu proběhne okamžitě bez obnovení stránky.

### Přednastavené styly a vlastní motivy
- Několik **vestavěných motivů**, např. Klasický zelený stůl, Kasino (červená a zlatá), Noční (tmavě modrá), Minimalistický, Retro, **Vysoký kontrast**. Barvy PWA (`theme-color`) a ikony se přizpůsobí.
- Vestavěné motivy jsou jen pro čtení, ale jdou **duplikovat a uložit jako nový**. Vlastní motivy jde **editovat, přejmenovat, duplikovat, smazat**.
- **Export a import motivu jako JSON**, sdílení motivu s ostatními hráči (galerie motivů v aplikaci), volitelně schválení adminem.
- Admin nastaví **výchozí motiv** pro nové hráče a může vybrané prvky zamknout (např. aby karty zůstaly čitelné).
- Hráč si vybírá vlastní motiv. Volitelně přepínač „u stolu používat motiv zakladatele hry“.

### Editor vzhledu
- Prvky rozdělené do záložek podle kategorií, s vyhledáváním parametru.
- **Živý náhled** vedle editoru: ukázkový herní stůl s rozdanou handou, lobby a chat, přepínatelný mezi mobilem a desktopem a mezi světlým a tmavým režimem.
- Výběr barvy (paleta, HEX/RGB/HSL, průhlednost, kapátko), návrh harmonických palet z jedné základní barvy.
- **Kontrola kontrastu** (WCAG): varování, když je text nebo karta špatně čitelná, a režim simulace barvosleposti.
- Vrácení změn (undo/redo), reset jednotlivého prvku nebo celé kategorie na hodnotu vzoru, porovnání s původním motivem.

## Odolnost proti výpadkům
- Po odpojení zůstává hráč usazený. Při reconnectu (i z jiného zařízení) dostane kompletní aktuální stav.
- Odpojený hráč na tahu: čeká se do vypršení časovače, pak automatická akce. Po X handách bez reakce přechází do „sit out“ (v turnaji se mu blindy dál strhávají).
- Stav běžících her se průběžně ukládá. **Restart serveru hru neztratí** (obnoví se z poslední dokončené handy, rozehraná handa se vrátí).

## Chat a reakce
Chat je **samostatná komunitní část aplikace**, která funguje i když se nehraje (místo pro domlouvání her a běžné povídání). Nezávisí na žádném stole ani turnaji.
- **Kanály:** hlavní společný kanál (výchozí „Hospoda“), další kanály vytváří admin (případně hráči, podle nastavení), např. „Domlouvání her“, „Výsledky“. Každý plánovaný turnaj má volitelně vlastní kanál, který vznikne s registrací a zůstane jako archiv.
- **Soukromé zprávy** mezi hráči (1:1), volitelně malé skupinové konverzace.
- **Chat u stolu** dál zvlášť pro konkrétní hru, s volitelným oddělením chatu přihlížejících.
- **Trvalá historie** uložená v DB, načítání starších zpráv při posunu nahoru, vyhledávání ve zprávách.
- **Kdo je online** (stav: online, u stolu, nepřítomen), indikátor „píše…“, počet nepřečtených zpráv u kanálů a soukromých konverzací.
- Zmínky **@přezdívka** (zvýraznění a upozornění), odpověď na konkrétní zprávu, úprava a smazání vlastní zprávy, emoji reakce na zprávy, odkazy klikací, volitelně obrázky a GIFy (velikost a povolení nastavitelné).
- **Upozornění:** push notifikace (PWA) na soukromé zprávy a zmínky, i když aplikace není otevřená. Volitelně e-mailový souhrn nepřečtených zpráv (frekvence nastavitelná). Každý hráč si nastaví, co chce dostávat, a může ztlumit kanál.
- **Propojení s hrou:** z chatu jde jedním klikem pozvat do hry nebo sdílet odkaz na turnaj (zobrazí se jako karta s tlačítkem „Připojit se“ / „Registrovat“). Do hlavního kanálu volitelně automatické zprávy: nový naplánovaný turnaj, otevření registrace, start, vítěz a výsledky.
- **Moderování:** admin může mazat zprávy, ztlumit nebo zablokovat hráče v chatu na dobu určitou, připnout zprávu. Hráč si může jiného hráče skrýt (ignorovat).
- Emoji reakce létající u avataru u stolu a systémové zprávy u stolu („Petr dokoupil rebuy“, „Blindy stoupají na 100/200“, „Pavel vyřadil Petra a získal bounty 50“).
### Zvukové emotikony (vlastní zvuková upozornění)
Hráči můžou poslat **emotikon se zvukem** (výkřik, hláška, fanfára…), který se ostatním přehraje. Funguje v chatu (kanály i soukromé zprávy) i **u herního stolu**, kde se zobrazí jako animovaná bublina u avataru a zazní všem u stolu.
- **Knihovna zvukových emotikonů:** každá položka má emoji nebo vlastní obrázek/ikonu, název, textovou zkratku (např. `:vykrik:`), zvukový soubor a kategorii. Část je **vestavěná**, další přidávají hráči.
- **Nahrání vlastního MP3** (volitelně i OGG, WAV, M4A): kontrola formátu a velikosti na serveru, **ořez** na začátek a konec v jednoduchém editoru s průběhem zvuku, **normalizace hlasitosti** (aby jeden výkřik nebyl řádově hlasitější než jiné), náhled před uložením. Server soubor převede do jednotného formátu a uloží do Docker volume.
- **Osobní a sdílené:** hráč má vlastní sadu a může ji nabídnout do společné knihovny. Volitelně se sdílené položky schvalují adminem. Admin může cokoli skrýt nebo smazat.
- **Odeslání:** tlačítko se zvukovou paletou v chatu a u stolu, oblíbené a naposledy použité nahoře, textová zkratka v chatu, volitelně klávesové zkratky na desktopu.
- **Ochrana proti otravování:** cooldown na hráče i na konkrétní zvuk, limit zvuků za minutu na kanál nebo stůl, maximální délka zvuku, při překročení se emotikon zobrazí bez zvuku.
- **Příjemce má plnou kontrolu:** hlasitost zvukových emotikonů zvlášť od herních zvuků, vypnutí úplně, pro konkrétní kanál, konkrétní zvuk nebo konkrétního hráče, a režim „jen u stolu“ nebo „jen v chatu“.
- **Volitelně jako upozornění:** hráč si může vybrat zvuk z knihovny jako vlastní zvuk pro zmínku @, soukromou zprávu nebo „jsi na tahu“.
- Prohlížeče blokují automatické přehrávání, dokud uživatel na stránce neklikne. Řeš to odemčením zvuku po první interakci a jasnou ikonou „zvuk ztlumen, klikni pro zapnutí“.

**Vlastní sekce v nastavení „Zvukové emotikony“:**
- *Pro hráče:* správa vlastních zvuků (nahrát, ořezat, přejmenovat, změnit ikonu, smazat), procházení společné knihovny a přidávání do oblíbených, nastavení hlasitosti a ztlumení.
- *Pro admina:* zapnutí funkce, kdo smí nahrávat, povolené formáty, max. velikost a délka souboru, max. počet zvuků na hráče, cooldowny a limity, schvalování sdílených zvuků, celková kvóta úložiště a přehled jejího zaplnění.

- **Vše nastavitelné v GUI:** zapnutí jednotlivých funkcí, kdo smí zakládat kanály, délka uchovávání historie, limity délky a frekvence zpráv, povolení obrázků a jejich max. velikost, seznam emoji, filtr slov.

## Ankety a hlasování
Samostatný modul pro **ankety a hlasování s podmínkami, kdo smí hlasovat**. Použij **jeden společný hlasovací engine** i pro herní hlasování, která už v zadání jsou (deal, run it twice, pauza turnaje, ukončení hry), aby vše fungovalo stejně a bylo stejně nastavitelné.

**Typy anket**
- Ano / ne (případně „zdržuji se“), jedna volba, více voleb (s min. a max. počtem), **pořadí preferencí** (ranked choice), bodové hodnocení (např. 1–5 hvězd), **výběr termínu** (jako Doodle: více dat a časů, u každého „můžu / nemůžu / když musím“), volitelně volná textová odpověď.
- Možnosti můžou mít obrázek nebo emoji. Volitelně smí hlasující přidat vlastní možnost.

**Podmínky, kdo smí hlasovat (skládací editor pravidel)**
Pravidla se skládají tlačítky do skupin s **A ZÁROVEŇ / NEBO** a volitelnou negací („kromě“). Dostupné podmínky (rozšiř je):
- **Přítomnost:** právě online, sedí u konkrétního stolu, hraje v konkrétním turnaji (včetně jen dosud nevyřazených), je v konkrétním kanálu chatu, je registrovaný na plánovaný turnaj.
- **Role** (konkrétní role nebo minimální síla role).
- **Hodnost a level** (od–do), **divize**.
- **Rating** (od–do, turnajový nebo cash), včetně podmínky „rating není provizorní“.
- **Aktivita:** počet odehraných her nebo hand (celkem, za sezónu, za posledních X dní), stáří účtu, poslední aktivita.
- **Výsledky:** účast v sérii, umístění v žebříčku (např. top 10), počet výher.
- **Konkrétní hráči** (ručně vybraný seznam), vyloučení konkrétních hráčů.
- Volitelně zůstatek v peněžence (od–do).

Editor ukazuje **živě, kolik a kteří hráči podmínky aktuálně splňují**. Nastavení, zda se okruh hlasujících **zafixuje při spuštění** ankety, nebo se **průběžně vyhodnocuje** (např. kdo přijde online, může hlasovat).

**Váha hlasů**
- Rovná (1 hráč = 1 hlas), nebo **vážená** podle role, hodnosti, ratingu, stacku (u herních hlasování) či vlastní tabulky. Volitelně strop váhy jednoho hráče.

**Pravidla vyhodnocení**
- **Kvórum** (min. počet nebo procento oprávněných, kteří musí hlasovat), **potřebná většina** (prostá, nadpoloviční ze všech oprávněných, 2/3, 3/4, jednomyslnost, vlastní procento).
- Délka hlasování nebo pevný konec, **předčasné ukončení**, když hlasovali všichni nebo výsledek už nejde zvrátit.
- Co se počítá při nehlasování (nezapočítat / jako ne / jako ano), řešení remízy (zakladatel rozhoduje, los, prodloužení, nejvýše postavená role).
- Změna hlasu povolena do konce, nebo ne.

**Tajnost a zobrazení**
- **Veřejné** (vidět, kdo jak hlasoval), **anonymní** (jen výsledky), nebo **tajné** (ani admin nevidí jednotlivé hlasy, ukládá se jen, že hráč hlasoval, a výsledek).
- Průběžné výsledky viditelné hned, až po vlastním hlasu, nebo až po skončení.

**Kde se ankety objevují**
- Jako **karta v chatu** (kanál nebo soukromá konverzace), u herního stolu jako vyskakovací dialog, v lobby v sekci „Ankety“, na hlavní stránce připnuté.
- **Upozornění** oprávněným hráčům (v aplikaci, push, volitelně e-mail), připomenutí před koncem těm, kdo ještě nehlasovali.

**Akce po výsledku (volitelné)**
- Anketa může mít navázanou **automatickou akci**, která se provede při schválení: např. naplánovat turnaj na vítězný termín, použít vítěznou šablonu hry, změnit nastavení stolu, pozastavit nebo ukončit hru, přidělit roli. Akce proběhne jen v rozsahu oprávnění **zakladatele ankety** a volitelně ji ještě potvrdí oprávněná osoba.

**Správa**
- Kdo smí zakládat ankety a s jakými podmínkami a akcemi, řídí **oprávnění** (viz Role).
- **Šablony anket** (uložení, opakované použití), archiv ukončených anket s výsledky, export výsledků (CSV).
- Každá anketa a změna pravidel během hlasování se zapisuje do audit logu. Pravidla nejde po prvním hlasu změnit (jen prodloužit termín, pokud to nastavení dovolí).
- **Výchozí hodnoty** pro všechno výše jsou v nastavení.

## Rozšiřující moduly
Každý modul jde v nastavení celý zapnout a vypnout a všechny jeho parametry mají výchozí hodnoty. Přístup k funkcím modulů řídí oprávnění (viz Role).

### Režim živé hry (skutečné karty u stolu v hospodě)
Aplikace řídí hru, která se hraje **fyzicky se skutečnými kartami a žetony**. Karty se v aplikaci nerozdávají.
- **Turnaj:** registrace a buy-iny z peněženky, losování míst, **turnajové hodiny** (blindy, přestávky, odpočet, zvukové a hlasové upozornění), rebuy, addon a re-entry, zápis vyřazení (kdo koho vyřadil, kvůli bounty a ratingu), výplaty, deal, vyúčtování.
- **Cash game:** zápis buy-inů, top-upů a cash-outů jednotlivých hráčů, rake nebo poplatek za čas, vyúčtování na konci.
- Ovládání pro **turnajového ředitele** na mobilu nebo tabletu (velká tlačítka, i offline s pozdější synchronizací volitelně). Hráči vidí stav na svém mobilu.
- Výsledky se započítávají do peněženek, statistik, XP a ratingu stejně jako online hry, ale jako **samostatný typ hry**. Nastavení určuje, zda a s jakou vahou jdou do ratingu. Statistiky z hand (VPIP apod.) u živé hry nejsou.

### TV režim (velká obrazovka)
- Speciální adresa pro televizi nebo projektor (přihlášení **jednorázovým kódem nebo tokenem** bez hráčského účtu, jen pro čtení), funguje v jakémkoli prohlížeči, chytré TV nebo přes Chromecast.
- **Obrazovky:** turnajové hodiny (level, blindy, odpočet, další level, přestávka), prize pool a výplaty, zbývající hráči a průměrný stack, žebříček (sezóna, rating, večer), **přenos online stolu se zpožděním** (zpoždění nastavitelné, karty hráčů skryté, nebo odkryté až po handě), běžící ankety, nadcházející turnaje, pruh se zprávami z chatu a systémovými zprávami.
- Rozvržení obrazovky a střídání obrazovek (pořadí, doba zobrazení) nastavitelné, víc uložených rozvržení. Motiv a velikost písma pro čitelnost na dálku.

### Napojení na Home Assistant
- Aplikace posílá **události** (start a konec turnaje, nový level, přestávka, all-in, vyřazení, výherce, velký pot, bad beat, nová zpráva nebo anketa) přes **MQTT** (s **MQTT Discovery**, aby se v Home Assistantu automaticky objevily entity: stav turnaje, level, počet hráčů, prize pool, poslední událost) a přes **webhooky**.
- V GUI výběr, které události se posílají, nastavení MQTT brokeru (adresa, port, jméno, heslo, prefix témat, TLS) s tlačítkem „Otestovat spojení“, a seznam webhook adres. Ukázkové automatizace pro Home Assistant v README (např. při all-inu bliknout světlem).

### Hlasatel (český hlas)
- Mluvené hlášky u stolu, v TV režimu a v režimu živé hry: „All-in!“, „Blindy stoupají na 200/400“, „Přestávka 10 minut“, „Petr vyřazen, odměna 50 pro Pavla“, „Vítězem turnaje je…“, odpočet do konce levelu.
- **Zdroj hlasu je přepínatelný v nastavení** (tlačítka), s tlačítkem „Přehrát ukázku“ u každé volby:
  1. **Hlas prohlížeče (Web Speech API), výchozí.** Server nezatěžuje, funguje hned bez instalace. Aplikace vybere český hlas zařízení, pokud existuje. Když zařízení češtinu nemá, hlasatel se na něm tiše vypne a hráč dostane jednorázové upozornění. Hráč si může vybrat konkrétní hlas ze seznamu hlasů svého zařízení.
  2. **Piper (self-hosted, volitelný).** Jednotný hlas pro všechny a pro TV režim, bez internetu. Dvě možnosti připojení: **vlastní kontejner Piper** (volitelná služba v `docker-compose.yml`, ve výchozím stavu vypnutá, s českým hlasem), nebo **připojení k existujícímu Piperu v Home Assistantu přes protokol Wyoming** (adresa a port v GUI, tlačítko „Otestovat spojení“, výběr hlasu ze seznamu, který server nabídne). Server hlášky generuje a **ukládá do mezipaměti**, každá stejná hláška se generuje jen jednou. Pevné hlášky jde předgenerovat dopředu.
  3. **Google Cloud TTS (volitelný).** API klíč zadaný v GUI (uložený šifrovaně), výběr hlasu, upozornění, že se texty hlášek posílají Googlu. Také s mezipamětí.
- Když serverový zdroj selže, aplikace automaticky přejde na hlas prohlížeče a v administraci zobrazí varování.
- Nastavení, zda hráči smí používat vlastní volbu (např. prohlížeč), nebo je zdroj jednotný pro všechny. TV režim může mít vlastní zdroj (doporučeně Piper).
- **Šablony hlášek** upravitelné v GUI (text s proměnnými, víc variant pro jednu událost, aby se neopakovalo stále totéž), výběr událostí, hlasitost, rychlost řeči, volba hlasu. Každý hráč si hlasatele může ztlumit zvlášť.

### Sázky vedle hry
- Hráči si vsadí **virtuální měnu** na výsledky: kdo vyhraje turnaj, kdo vypadne první, kdo z dvojice skončí výš (souboj dvou hráčů), konkrétní umístění, vlastní tvrzení („Petr dnes vyhraje s 7-2“).
- Druhy sázek: **přímá sázka mezi dvěma hráči** (nabídka a přijetí) a **sázkový bank** (pari-mutuel, výhra se dělí poměrně podle vkladů), volitelně kurzy navržené zakladatelem.
- Vklady se při uzavření sázky **zablokují v účetní knize** (escrow) a po vyhodnocení se vyplatí. Sázky na herní výsledky vyhodnocuje systém automaticky, vlastní tvrzení vyhodnotí zakladatel s potvrzením protistrany nebo rozhodčím (role).
- Nastavitelné: kdy se sázky uzavírají (start hry, konec rebuy období, konkrétní fáze), zda smí hráč sázet na sebe a nikdy proti sobě (ochrana proti přelévání), limity sázek, poplatek domu z výher (volitelně), co se stane při zrušení hry (vrácení vkladů).

### Odměna na hlavu
- Hráč vypíše **ze svých peněz** odměnu za vyřazení konkrétního hráče v konkrétním turnaji (nebo za vyhraný pot proti němu na showdownu v cash game). Odměna se zablokuje v účetní knize.
- Vyplatí se tomu, kdo hráče vyřadí. Pokud ho nikdo nevyřadí (vyhraje nebo se hra zruší), vrátí se zadavateli (nebo podle nastavení propadne domu či vítězi).
- Odměny jsou vidět u avataru „hledaného“ hráče. Víc odměn na jednu hlavu se sčítá. Limity a zapnutí v nastavení.

### Sdílení a rozbor hand
- Každou handu jde jedním klikem **sdílet do chatu** jako kartu s přehrávačem (krok po kroku, rychlost přehrávání, pohled kteréhokoli hráče jen s kartami, které byly ukázány). Vlastník může dobrovolně odkrýt své karty.
- Pod sdílenou handou **vlákno komentářů** a reakce, volitelně anketa „Jak bys hrál?“.
- **Handa večera:** automatický výběr kandidátů (největší pot, nejhorší bad beat, nejvyšší ukázaný bluff, nejnepravděpodobnější výhra podle šance na výhru) a hlasování pomocí modulu anket.

### Herní večer
- Víc her (cash i turnaje, online i živé) jde seskupit pod jeden **herní večer** (vznikne automaticky podle plánu nebo ručně).
- Souhrn večera: celkové vyúčtování a minimální převody, **MVP večera** (vzorec nastavitelný: zisk, umístění, vyřazení, XP), ocenění (Lovec – nejvíc vyřazení, Smolař – nejhorší bad beat, Bankéř – největší pot…), Handa večera, statistiky.
- Souhrn se automaticky pošle do chatu, volitelně e-mailem a do TV režimu. Archiv večerů.

### Nástupová znělka
- Každý hráč si zvolí **znělku** (ze své sady zvukových emotikonů nebo nahráním), která zazní, když si přisedne ke stolu nebo se objeví v TV režimu, a volitelně **vítěznou znělku** při výhře turnaje nebo velkého potu.
- Limity délky, kdy se přehrává, ztlumení příjemcem a admin nastavení jsou společné se zvukovými emotikony.

### Kosmetické odměny a obchod
- **Kosmetické předměty:** rámečky avatarů, efekty u avataru (např. při výhře), rubové strany karet, plsti stolu pro vlastní motiv, barva jména v chatu, tituly pod přezdívkou, trofeje do vitríny v profilu, víc slotů pro zvukové emotikony a znělky.
- Získávají se **hodností, levelem, úspěchy, umístěním v sezóně** nebo se **kupují za virtuální měnu v obchodě** (peníze jdou na účet domu). U každého předmětu nastavitelný způsob získání a cena, časově omezené nabídky, sezónní předměty.
- Katalog předmětů spravuje kurátor obsahu (role). Předměty jsou čistě kosmetické a nesmí ovlivnit hru.

### Poznámky o hráčích
- Soukromé **poznámky a barevné štítky** k ostatním hráčům (barvy a názvy štítků si hráč nastaví sám). Vidí je jen autor.
- Zobrazení u avataru u stolu (ikona štítku, poznámka po kliknutí), v profilu hráče a v historii hand. Synchronizace napříč zařízeními jako ostatní nastavení. Export.

### Osobní limity
- Hráč si nastaví **limity**: max. počet buy-inů nebo max. prohra za večer, den, týden, měsíc, max. doba hry za sezení, připomínku pauzy po X minutách, volitelně **pauzu od hry** na zvolenou dobu.
- Zpřísnění limitu platí **okamžitě**, uvolnění až po nastavené čekací době (výchozí např. 24 h). Admin může nastavit globální limity pro všechny.
- Při dosažení limitu aplikace nedovolí další buy-in a slušně to oznámí.

### API a webhooky
- **REST API** s dokumentací (OpenAPI) pro čtení výsledků, statistik, žebříčků, plánovaných turnajů a pro vybrané akce.
- **Osobní přístupové tokeny** s rozsahem oprávnění (token nikdy nemá víc oprávnění než jeho vlastník), platností a možností zrušení. Rate limity.
- **Odchozí webhooky** pro stejný katalog událostí jako Home Assistant, podepsané (HMAC), s opakováním při chybě a logem doručení. Předvolba pro **Discord** (zprávy do kanálu: nový turnaj, výsledky, souhrn večera).

### AI asistent nastavení
Protože nastavení je velmi rozsáhlé, aplikace má **asistenta**, který nastavení ovládá podle běžné řeči. Funguje i **během hry**.

**Co umí**
- Převést požadavek na konkrétní změny: „zrychli blindy o polovinu“, „zapni run it twice a 7-2 bonus“, „dej přestávku 10 minut“, „vypni zvukové emotikony u tohoto stolu“.
- Založit nebo naplánovat hru: „naplánuj na pátek ve 20:00 turnaj jako minule, ale s bounty“ (najde podobnou hru v historii nebo šablonu a upraví ji).
- Vytvořit nebo upravit šablonu, motiv („udělej tmavší stůl s červenými kartami“), anketu, roli.
- **Vysvětlovat** nastavení a pravidla („co dělá Bronsteinova prodleva?“, „proč mi klesl rating?“) s odkazem přímo na příslušné místo v nastavení.
- Navrhovat: „turnaj se protahuje, chceš zkrátit levely?“ (jen jako nabídka, nikdy sám nic nemění).

**Jak to funguje technicky**
- Asistent pracuje přes **volání nástrojů (function calling)**. Nástroje se **generují automaticky z centrálního schématu nastavení a z katalogu oprávnění**: čtení nastavení, návrh změny, založení hry, anketa atd. Každý nový parametr nebo modul je tak asistentovi dostupný bez další práce.
- **Asistent nikdy neprovádí změny přímo.** Vždy vrátí **návrh změn**, který se zobrazí jako přehled „před → po“ s vyznačením, kdy změna začne platit (hned, od další handy, od dalšího levelu). Uživatel návrh **potvrdí, upraví nebo zamítne**. Volitelně v nastavení: drobné změny bez potvrzení (seznam povolených parametrů).
- Změnu provádí stejná serverová logika jako ruční změnu v GUI: **oprávnění uživatele, pravidla „kdy lze měnit“, validace konzistence, audit log** (se značkou „přes asistenta“ a původním textem požadavku). Co by vyžadovalo hlasování hráčů, asistent spustí jako anketu.
- **Asistent nikdy nedostane** karty hráčů, stav balíčku, obsah soukromých zpráv ani tajné hlasy. Do kontextu jde jen nastavení, veřejný stav hry a data, ke kterým má uživatel přístup.

**Ovládání**
- Ikona asistenta v nastavení, v administraci, v lobby a u stolu (jen pro uživatele s oprávněním měnit nastavení stolu). Okno ve stylu chatu s historií.
- Volitelně **hlasový vstup** (rozpoznání řeči v prohlížeči) a odpověď hlasem přes hlasatele.

**Poskytovatel AI (nastavení v GUI)**
- **Výchozí: Google Gemini API.** Další na výběr: Anthropic Claude, OpenAI a obecné rozhraní kompatibilní s OpenAI (pro lokální modely do budoucna). Přepínání tlačítky.
- API klíč zadaný v GUI (uložený šifrovaně), výběr modelu, tlačítko „Otestovat“, teplota a max. délka odpovědi.
- **Limity:** počet požadavků na uživatele za den, kdo smí asistenta používat (oprávnění), denní strop pro celou aplikaci, přehled spotřeby v administraci.
- Když AI není nastavená nebo nedostupná, aplikace funguje dál normálně, asistent je jen skrytý.

**Všechna nastavení a prompty asistenta jsou v GUI** (sekce „AI asistent“), nic není napevno v kódu. Platí pro ně stejná architektura nastavení jako pro zbytek aplikace (schéma, výchozí hodnoty, vrstvy, audit log, export a import).

- **Prompty jako upravitelné šablony:**
  - **systémový pokyn** asistenta (role, tón, jazyk, zásady, co smí navrhovat);
  - **pokyny podle kontextu**: lobby, herní stůl během hry, administrace, editor vzhledu, plánování turnajů, vysvětlování pravidel, MCP;
  - **šablony textů**, které asistent používá: shrnutí návrhu změn, potvrzení, odmítnutí (nedostatečné oprávnění, nelze měnit během hry), chybové hlášky, nabídka hlasování;
  - **popisy nástrojů** (výchozí se generují ze schématu, ale každý jde v GUI přepsat nebo doplnit o příklady).
- **Proměnné v promptech** s nápovědou a doplňováním při psaní, např. `{prezdivka}`, `{role}`, `{opravneni}`, `{kontext}`, `{stul}`, `{stav_hry}` (jen veřejný stav), `{aktualni_nastaveni}`, `{sablona}`, `{datum}`, `{cas}`, `{jazyk}`, `{nazev_aplikace}`, `{mena}`. Seznam dostupných proměnných se generuje automaticky podle kontextu. Editor **upozorní na neznámou proměnnou** a ukáže, jak bude prompt vypadat po dosazení.
- **Varianty podle role:** jiný pokyn a jiná sada povolených nástrojů pro hlavního administrátora, organizátora, ředitele, hráče.
- **Parametry modelu:** poskytovatel a model (zvlášť pro každý kontext, např. levnější model pro vysvětlování, silnější pro plánování), teplota, max. délka odpovědi, časový limit, počet opakování, velikost historie konverzace v kontextu.
- **Chování:** které nástroje jsou povolené v jakém kontextu, seznam parametrů, které jde měnit **bez potvrzení**, zda smí asistent sám **navrhovat** změny (a jak často), zda je zapnutý hlasový vstup a hlasová odpověď, limity požadavků (na uživatele, na roli, celkem za den).
- **Testovací pískoviště:** v GUI jde napsat zkušební požadavek a vidět, jaký prompt se pošle (po dosazení proměnných), co model odpověděl a jaký návrh změn by vznikl, **bez provedení změn**.
- **Verze promptů:** každá úprava se uloží jako nová verze s autorem a časem, porovnání verzí, návrat ke starší verzi, **reset na výchozí** (celé nebo jednotlivý prompt).
- Úpravy promptů a nastavení asistenta řídí oprávnění (výchozí jen hlavní administrátor).

### MCP server
- Aplikace vystaví **MCP server** (Model Context Protocol) se stejnými nástroji jako asistent, aby šla ovládat z externích AI (Claude, další MCP klienti) a z hlasového asistenta **Home Assistantu**.
- Přístup přes **osobní přístupový token** (viz API a webhooky) s rozsahem oprávnění. Stejné zásady jako u asistenta: návrh změn a potvrzení (u externího klienta lze potvrzovat druhým voláním), oprávnění, pravidla „kdy lze měnit“, audit log, žádná skrytá herní data.
- V administraci zapnutí MCP serveru, seznam vystavených nástrojů (jdou jednotlivě vypnout) a log volání. V README návod na připojení z Claude a z Home Assistantu.

## Statistiky a žebříček
Ukládej každou hru a každou handu. Zobrazuj:
- Žebříček za **sezónu** i za celou historii: **čistý zisk v měně**, odděleně cash a turnaje, počet her, výhry, ITM, průměrné umístění, rebuye, získané bounty.
- Osobní statistiky: VPIP, PFR, 3-bet, % vyhraných showdownů, největší pot, nejlepší ruka, graf vývoje zůstatku v čase.
- Detail každé hry: výsledky, vyúčtování, historie hand.

## Postup hráče: zkušenosti, hodnosti a herní rating
Dva oddělené systémy, aby se nemíchala **aktivita** a **dovednost**:
1. **Zkušenosti (XP) a hodnosti:** odměna za hraní. XP jen přibývají, nikdy se neztrácejí.
2. **Herní rating (alternativa k šachovému Elo):** měří sílu hráče. Může stoupat i klesat a body se při vyřazení a umístění **vyměňují** mezi hráči.

Všechny parametry obou systémů jsou v nastavení s rozumnými výchozími hodnotami. Po změně parametrů jde rating i XP **přepočítat zpětně z historie** (uložené výsledky všech her), s náhledem dopadu před potvrzením.

### 1. Zkušenosti a hodnosti
- **Zdroje XP (každý s nastavitelnou hodnotou):** odehraná handa, odehraná hra (cash sezení nad X minut, turnaj), umístění v turnaji (podle pořadí a velikosti pole), umístění v penězích, výhra turnaje, vyřazení soupeře, výhra handy na showdownu, splněný úspěch (achievement), bonus za první hru dne nebo týdne, účast v sérii.
- **Křivka levelů:** XP potřebné na další level podle vzorce (např. `základ × level^exponent`), oba parametry nastavitelné, plus náhled tabulky levelů v GUI.
- **Hodnosti:** pojmenované stupně podle levelu (výchozí návrh např. Nováček, Štamgast, Karbaník, Hráč od stolu, Žralok, Hospodský, Legenda), každá s ikonou a barvou. Názvy, ikony, počet hodností a hranice jsou editovatelné.
- **Úspěchy (odznaky):** katalog úspěchů s podmínkou, ikonou a odměnou XP (např. první výhra turnaje, royal flush, 10 vyřazení v jedné sérii, vyhraný all-in s méně než 10 % šancí). Admin může přidávat vlastní z nabídky podmínek.
- **Ochrana proti farmení:** XP jen ze hry s minimálním počtem lidských hráčů, denní strop XP (volitelně), hry s boty se nepočítají (nastavitelné).
- Hodnost a level se zobrazují v profilu, u avataru u stolu a v chatu (zapínatelné). Při postupu animace a systémová zpráva.

### 2. Herní rating
Klasické Elo je určené pro souboj dvou hráčů a v pokeru s více hráči a velkým vlivem náhody funguje špatně. Navrhuji tento systém (oponuj, pokud máš lepší, a zdůvodni to):

**Základ: OpenSkill (Weng-Lin, model Plackett-Luce)**, open-source alternativa k TrueSkill pro hry s více hráči (knihovna `openskill`, MIT).
- Každý hráč má **odhad síly μ** a **nejistotu σ**. Nový hráč začíná s vysokou nejistotou, takže se jeho rating zpočátku mění rychle a pak se ustálí.
- Po turnaji se rating upraví podle **konečného pořadí všech hráčů najednou**. Porazit (skončit nad) silnějšího soupeře přinese víc bodů než porazit slabšího. Prohra se slabším stojí víc.
- **Zobrazovaný rating** = konzervativní odhad `μ − k·σ` převedený na stupnici podobnou Elo (výchozí start 1500), aby hodnoty byly hráčům srozumitelné. Volitelně se zobrazí i „±“ nejistota.

**Výměna bodů při vyřazení (bounty složka):**
- Při vyřazení proběhne **přímá výměna bodů** mezi vyřazujícím a vyřazeným, počítaná po vzoru Elo: očekávaný výsledek podle rozdílu ratingů, výměna = `K × (1 − očekávání)`. Vyřazení silnějšího hráče přinese hodně, vyřazení výrazně slabšího skoro nic. Výměna je **nulový součet** (co jeden získá, druhý ztratí).
- Při dělené výhře potu nebo vyřazení více hráčů najednou se výměna dělí poměrně.
- **Váha** této složky vůči umístění je nastavitelná (výchozí návrh 20 % celkové změny), aby rating stále určovalo hlavně celkové umístění a ne jedna šťastná handa.

**Férovost a ochrana proti náhodě i zneužití:**
- **Zmírnění štěstí:** u all-in situací, kde je známá pravděpodobnost (viz funkce pravděpodobnosti výhry), lze výměnu bodů při vyřazení počítat podle **očekávané hodnoty** místo skutečného výsledku (volitelné, výchozí částečně, např. 50 % EV a 50 % výsledek). Kdo zaplatil all-in jako velký favorit a prohrál, ztratí méně.
- **Váha podle velikosti pole a délky hry:** turnaj se 3 hráči ovlivní rating méně než turnaj s 9 hráči. Turbo méně než dlouhý turnaj (koeficienty nastavitelné).
- **Rebuy a re-entry:** rating se počítá z konečného umístění. Počet rebuyů volitelně mírně snižuje zisk (nastavitelné).
- **Provizorní rating:** prvních N her se rating zobrazuje jako provizorní a hráč není v žebříčku ratingu.
- **Neaktivita:** při dlouhé pauze roste nejistota σ (ne klesá síla μ), takže se rating po návratu rychleji přizpůsobí a v konzervativním zobrazení mírně klesne, dokud hráč znovu nehraje.
- **Hodnocené a nehodnocené hry:** u každé hry lze nastavit, zda se počítá do ratingu (např. jen turnaje s min. X lidskými hráči). Hry s boty se nepočítají.
- **Proti farmení ve dvojici:** opakované heads-upy stejné dvojice mají klesající váhu, volitelně podezření na přelévání žetonů (chip dumping) označit pro kontrolu.
- **Sezóny:** na začátku sezóny volitelný měkký reset (μ se přiblíží k průměru o nastavitelné procento, σ se zvýší). Historický rating zůstává v archivu.

**Cash game:** turnajový rating a cash rating jsou **oddělené** (výchozí). Cash rating se počítá ze sezení: výsledek v big blindech na 100 hand, s korekcí na očekávanou hodnotu all-inů a s minimálním počtem hand pro započítání. Výchozí stav: cash rating zapnutý, ale s nižší váhou a delší provizorní dobou kvůli vysokému rozptylu.

**Divize:** podle ratingu se hráči řadí do divizí (výchozí návrh Bronz, Stříbro, Zlato, Platina, Diamant, Mistr, hranice a názvy editovatelné). Divize je ukazatel dovednosti, hodnost ukazatel zkušeností.

**Zobrazení:**
- Po každé hře přehled změny: „+18 za umístění, +6 za vyřazení Petra (byl silnější), −3 za vyřazení Pavlem“, aby každý viděl, proč se rating změnil.
- Graf vývoje ratingu, nejvyšší dosažený rating, žebříček ratingu (celkový, za sezónu, cash a turnaj zvlášť), vzájemná bilance dvou hráčů (kdo koho kolikrát vyřadil).
- Volitelně skrýt přesné číslo ratingu a ukazovat jen divizi.

**Nastavitelné v GUI (s výchozími hodnotami):** startovní μ a σ, měřítko převodu na zobrazovaný rating, konstanta k, K pro výměnu při vyřazení, váha umístění vs. vyřazení, podíl EV korekce, koeficienty velikosti pole a délky hry, vliv rebuyů, počet provizorních her, růst σ za neaktivitu, měkký reset sezóny, pravidla pro hodnocené hry, hranice divizí, oddělení či sloučení cash a turnajového ratingu.

## Kvalita a testy
- Unit testy adaptéru a herních vrstev: side poty s více all-in, run it twice s více poty, straddle, rebuy/addon/re-entry pravidla, bounty a PKO (včetně split potů), ICM a chip chop výpočty, nárůst blindů, heads-up pravidla.
- **Simulační test:** tisíce náhodných hand s boty. Invariant: součet žetonů a měny v systému sedí s účetní knihou. Nic nevznikne ani nezmizí. Zvlášť pro cash (měna v peněženkách + měna na stolech = konstanta) a pro turnaje (turnajové žetony = vydané stacky za buy-iny, rebuye a addony; prize pool po výplatě = 0).
- Testy hlasování: vyhodnocení podmínek oprávnění (kombinace A/NEBO/kromě), fixní vs. průběžný okruh, kvórum a většiny, vážené hlasy, remízy, tajné hlasování (jednotlivé hlasy nejdou zpětně zjistit ani z DB), automatická akce neproběhne nad rámec oprávnění zakladatele, herní hlasování (deal, run it twice) běží na stejném enginu.
- Testy rozšiřujících modulů: sázky a odměny na hlavu jsou v účetní knize vždy zablokované a buď vyplacené, nebo vrácené (nikdy nezmizí), nelze sázet proti sobě, osobní limity nejde obejít, API token nesmí víc než jeho vlastník, webhooky mají platný podpis, TV režim nikdy nedostane karty hráčů dříve, než dovoluje zpoždění.
- Testy výplat a poplatků: součet výplat + house cut + fondy + bounty = všechny vklady, zaokrouhlení nikdy nevytvoří ani neztratí měnu, rake respektuje strop a „no flop no drop“, garance doplní přesně overlay z účtu domu, bad beat jackpot se rozdělí podle nastavení, rakeback odpovídá podílu.
- Test, že turnajové žetony nikdy neprojdou do peněženky a cash žetony nikdy nezmizí (pád serveru, zrušení stolu, odpojení hráče).
- Test, že klient nikdy nedostane cizí hole cards před showdownem.
- Testy nastavení: validace schématu a konzistence, dědičnost vrstev, import/export a migrace šablon. Simulační test spouštěj i s **náhodně vygenerovanými platnými kombinacemi nastavení**, aby se odhalily chyby v neobvyklých kombinacích.
- Testy e-mailu proti testovacímu SMTP (např. Mailpit v Dockeru pro vývoj): ověření účtu, obnova hesla, vypršelé a opakovaně použité tokeny, limity odesílání.
- Testy AI asistenta a MCP (s napodobeným modelem, bez skutečného API): asistent nikdy nezmění nastavení bez potvrzení, nemůže víc než uživatel, respektuje „kdy lze měnit“, do kontextu modelu se nikdy nedostanou karty, stav balíčku, soukromé zprávy ani tajné hlasy, každý nový parametr ze schématu se automaticky objeví mezi nástroji.
- Testy vestavěných šablon: každá šablona projde validací schématu, simulace s boty ji odehraje do konce, odhad délky odpovídá simulaci, „Retro“ šablony nemají zapnutou žádnou novou funkci.
- Testy časování (fake timers): každá varianta time banku (zásobník s doplňováním a stropem, na handu, prodlužovací žetony, Fischer a Bronstein, shot clock), vyvolání hodin, oddělený čas při odpojení, správná automatická akce po vypršení. Časovač běží na serveru, klient ho jen zobrazuje.
- Testy výpočtu pravděpodobnosti: porovnání s referenčními hodnotami známých situací (např. AA vs KK preflop, flush draw vs. top pair), součet šancí = 100 % včetně dělby, správný okamžik zobrazení (nikdy dřív, než jsou všichni all-in nebo akce skončila).
- Testy ratingu a XP: výměna při vyřazení je nulový součet, porážka silnějšího přinese víc než porážka slabšího, nový hráč se mění rychleji než ustálený, zpětný přepočet z historie dá stejný výsledek jako průběžný výpočet, simulace stovek turnajů s boty různé síly ukáže, že se rating seřadí podle skutečné síly botů.
- Testy oprávnění: každá serverová akce a Socket.IO zpráva má test, že bez oprávnění je odmítnutá. Hierarchie síly (nelze povýšit sebe ani přidělit vyšší roli), rozsahy, časově omezené role, limity, princip čtyř očí (nelze schválit vlastní požadavek), ochrana posledního hlavního administrátora.
- Testy motivů: validace a migrace JSON, kontrola, že žádná komponenta nepoužívá napevno barvu, font ani velikost mimo tokeny (lint pravidlo), automatická kontrola kontrastu u vestavěných motivů ve světlém i tmavém režimu.
- Testy zvukových emotikonů: odmítnutí špatného formátu a příliš velkého nebo dlouhého souboru, převod a normalizace, cooldowny a limity, ztlumení příjemcem.
- Test plánovače s posunutým časem (fake timers): celý plánovaný turnaj od otevření registrace po výplatu proběhne s boty bez jediného ručního zásahu, včetně zrušení při nedostatku hráčů a restartu serveru uprostřed turnaje.
- Jednoduchý bot (náhodné legální akce) pro testy a ladění.

## Mimo rozsah první verze
- **Hlasový a video hovor** zatím nedělej (bude se řešit později, hráči mezitím použijí Discord). V UI nech jen místo, kam ho půjde později doplnit.

## Fáze
1. **Systém nastavení** (schéma, vrstvy, generovaný formulář, šablony), **design tokeny a světlý/tmavý režim** (celé UI od začátku jen přes tokeny), engine, adaptér, systém modulů, jeden stůl NLHE, cash game, základní UI stolu, testy
2. Účty, pozvánky, **role a oprávnění (hierarchie síly, rozsahy, limity, schvalování, audit log)**, **e-mail (SMTP v GUI, ověření účtu, obnova hesla, šablony)**, peněženka a účetní kniha, lobby, **samostatný chat (kanály, soukromé zprávy, online stav)**, reconnect a ukládání stavu
3. Turnaje: freezeout, rebuy/addon, re-entry, editor blindů, prize pool, **výplaty a poplatky** (house cut, rake, fondy, jackpoty, garance, slidery s živým náhledem), účet domu, vyúčtování
4. Bounty a PKO, dealy (ICM, chip chop), run it twice a ostatní speciální prvky
5. **Plánované turnaje:** plánovač, opakování, automatický průběh, kalendář, připomínky a push notifikace, série a ligy
6. Rozšíření chatu (push notifikace, zmínky, obrázky, propojení s hrou, moderování), **zvukové emotikony** (knihovna, nahrávání a ořez MP3, sekce v nastavení), **XP, hodnosti, úspěchy a herní rating** (OpenSkill, výměna při vyřazení, divize, zpětný přepočet), **ankety a hlasování** (podmínky oprávnění, váhy, kvórum, navázané akce), statistiky, žebříček a sezóny, historie hand
7. **Editor vzhledu** (živý náhled, kontrola kontrastu), vestavěné motivy, ukládání, sdílení a import/export motivů
8. **Režim živé hry a TV režim**, hlasatel, herní večer
9. **Sázky vedle hry, odměna na hlavu, sdílení a rozbor hand, nástupová znělka, kosmetické odměny a obchod, poznámky o hráčích, osobní limity**
10. **Home Assistant (MQTT, webhooky), REST API, Discord**
11. **AI asistent nastavení** (Gemini výchozí, přepínatelní poskytovatelé, návrh a potvrzení změn) a **MCP server**
12. Doladění: PWA, zvuky, animace

Po každé fázi aplikaci spusť, otestuj a stručně shrň, co funguje a co zbývá.

## Dodávka
- Git repozitář s README **v češtině** pro laika: instalace do LXC (Docker, Docker Compose), nastavení proxy hostu `poker.example.cz` v Nginx Proxy Manager (včetně zapnutí „Websockets Support“), záloha databáze, aktualizace a **nastavení odesílání e-mailů přes Gmail** krok za krokem (dvoufázové ověření, vytvoření hesla aplikace, vyplnění v administraci, testovací e-mail).
- `.env.example` se všemi proměnnými, `docker-compose.yml`, healthcheck.
- Účet **hlavního administrátora** se vytvoří při prvním startu (heslo z `.env` nebo vypsané do logu). README obsahuje i postup nouzové obnovy přístupu přes příkaz v kontejneru.
