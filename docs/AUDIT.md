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
