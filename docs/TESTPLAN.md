# Testovací plán KoronaBar Poker

Rozdělení: co hlídají automatické testy (běží při každé změně) a co je potřeba projít ručně na skutečném zařízení.

## 1. Automatické kontroly (spouští se před každým pushem)
- `npx vitest run`: všechny testy (server, web, sdílené balíčky, herní jádro, účetní kniha).
- `pnpm -r typecheck`: kontrola typů ve všech balíčcích.
- `pnpm lint`: kontrola kódu (nepoužité proměnné, pravidla Reactu).
- Simulace s boty (`apps/server/scripts/simulate.ts`): po každém kroku platí, že součet všech účtů je nula a účet stolu odpovídá žetonům hráčů.
- Kontrola konzistence knihy: ve Správě (Údržba) nebo `GET /api/admin/consistency`, všech 12 kontrol musí být v pořádku.

## 2. Ruční scénáře na telefonu (svisle i na šířku)
1. **Dolní lišta**: Ke stolu, Lobby, Stoly, Chat, Více. Ve „Více“ otevřít zvonek (nahoře musí být vidět seznam i volba „Posílat upozornění i mimo aplikaci“), zvuk, asistenta.
2. **Chat**: poslat zprávu v Hospodě, v chatu stolu, soukromou zprávu; zmínka přes @; reakce, odpověď, úprava, smazání, připnutí. Seznam místností je jeden řádek posouvaný do stran.
3. **Stůl**: usednout s buy-inem, odehrát pár hand (call, fold, all-in), dokoupit žetony, odejít. Zůstatek peněženky musí sedět (buy-in minus odchod).
4. **Obrazovky u stolu**: listování prstem mezi obrazovkami, tečky, návrat na stůl při mém tahu, pevný ovládací panel, tlačítko ☰.
5. **Otočení telefonu**: na šířku je stůl vlevo a vpravo pruh času a ovládací panel; po otočení zpět se vrací svislé rozložení.
6. **Celá obrazovka** a automatická celá obrazovka (jen na skutečném zařízení).
7. **Zvuky**: zvuky hry, emotikony, hlasatel, vibrace při mém tahu (jen na skutečném zařízení).

## 3. Ruční scénáře nastavení
1. Osobní nastavení, záložky Oboje / Počítač / Telefon: změna na jedné záložce se neprojeví na druhé, Telefon jde upravit z počítače.
2. Rozmístění widgetů na telefonu (3 obrazovky, hlavní obrazovka, ikony nahoře, skryté) zvlášť pro výšku a šířku.
3. Chat: vzhled seznamu (Kompaktní / Karty), stoly spolu s kanály, skrytí prázdných oddílů; zvlášť pro telefon a počítač.
4. Sdílení: Sdílet sadu (Stůl na telefonu), obnovit výchozí, převzít z kódu; po převzetí vypadá všechno stejně.
5. Správa: vypnout „Skupinové chaty“ a ověřit, že zmizí tlačítko i seznam skupin hned u všech přihlášených (bez obnovení stránky); zapnout zpět.
6. Měřítko okna: v Osobním nastavení zvolit Tlačítko, u stolu v 📐 Velikost stolu zvolit 🔒 Podle výšky; zmenšit okno (třeba vedle Discordu): stůl, panely i písmo se zmenší úměrně, nemusí se rolovat, tlačítka akcí jsou vidět; 🔓 vrátí původní vzhled; Vypnuto = žádná změna proti dřívějšku.
7. Zabalené karty: zabalit kartu, obnovit stránku, přepnout zařízení; stav se pamatuje pro daný typ zařízení.

## 4. Souběh a odolnost
- Dvě zařízení téhož hráče: změna nastavení na jednom se hned ukáže na druhém.
- Server se restartuje při otevřeném chatu a stole: klient se znovu připojí a zprávy i stav stolu se obnoví.
- Odpojení během tahu: časovač doběhne, hráč se zahodí nebo sedí mimo; účty zůstanou v pořádku.
- Dva hráči se pokusí sednout na stejné místo: uspěje jen jeden, druhý dostane srozumitelnou chybu.

## 5. Co je třeba ověřit jen na skutečném zařízení
Hmatový dojem listování, velikost tlačítek prstem, rozložení na šířku na konkrétním telefonu, celá obrazovka, zvuk a vibrace.

## Poslední běh (3. 11. 2026)
Automaticky: 1401 testů, typy a lint v pořádku, kontrola knihy v pořádku po hře se třemi boty (all-in, rebuy, odchod). Ručně v prohlížeči (okno telefonu i počítače): zprávy v kanálu a v chatu stolu, usednutí a odchod, rebuy, vypnutí skupin za běhu, nastavení zvlášť pro telefon a počítač, sdílení sady. Nalezeno a opraveno: změna globálního nastavení se ostatním projevila až po obnovení stránky; stav zabalení karet s počtem v názvu se ztrácel při změně počtu.
