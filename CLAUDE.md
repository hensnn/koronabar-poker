# CLAUDE.md – KoronaBar Poker

Stálá pravidla pro práci na tomto projektu. Kompletní zadání je v `docs/ZADANI.md`. Před každou fází si přečti příslušné sekce zadání znovu.

## O projektu
Self-hosted webová pokerová herna pro domácí hry přátel přes internet na vlastní doméně (v dokumentaci zástupně `poker.example.cz`). Cash game i turnaje, virtuální měna bez peněžní hodnoty, rozsáhlé nastavení všeho v GUI.

## Rozhodnutá technologie
- Server: Node.js 20+, TypeScript, Socket.IO
- Klient: React, Vite, TypeScript, Tailwind (jen přes design tokeny)
- Databáze: **PostgreSQL** (kontejner v Docker Compose)
- Nasazení: Docker Compose za Nginx Proxy Manager. Cílový server zatím není rozhodnutý, vše konfigurovat přes `.env`.
- Pokerová pravidla z hotové knihovny přes adaptér, nepsat je od nuly.

## Nepřekročitelná pravidla
1. **Server je jediná autorita.** Klient nikdy nedostane cizí karty, stav balíčku ani tajná data. Každá akce a každá Socket.IO zpráva se validuje a kontroluje oprávnění na serveru.
2. **Žádné konstanty napevno.** Každá herní, časová, finanční, UI i AI hodnota pochází z centrálního schématu nastavení s výchozí hodnotou. Nový parametr = záznam ve schématu, formulář v GUI se vygeneruje sám.
3. **Vzhled jen přes design tokeny.** Žádné barvy, fonty ani velikosti napevno v komponentách.
4. **Peníze:** částky jako celá čísla, všechny pohyby přes účetní knihu v transakci. Nic nesmí vzniknout ani zmizet. Turnajové žetony nikdy nejsou měna.
5. **Virtuální měna nemá peněžní hodnotu.** Nikdy nepřidávej skutečné platby, směnu ani výběry.
6. **Tajné údaje** (API klíče, hesla) jen šifrovaně v DB, nikdy do prohlížeče, logu ani exportu.
7. **Míchání karet** jen kryptografickým RNG.
8. **AI asistent** nikdy nemění nastavení bez potvrzení a nikdy nevidí skrytá herní data.

## Postup práce
- Pracuj **po fázích** podle `docs/ZADANI.md`. Na začátku projektu nejdřív předlož plán (volba enginu, architektura, datový model, fáze) a **počkej na schválení**.
- Na začátku každé fáze krátce shrň, co v ní uděláš. Na konci aplikaci spusť, otestuj a shrň, co funguje a co zbývá.
- Ke každé funkci piš testy (viz sekce Kvalita a testy v zadání). Fáze není hotová, dokud testy neprocházejí.
- Pokud je zadání nejasné nebo si odporuje, zeptej se, nehádej.
- Vedení stavu: soubor `docs/STAV.md` průběžně aktualizuj (hotové fáze, rozpracované, otevřené otázky, rozhodnutí a jejich důvody).
- Commituj po menších logických celcích s popisnou zprávou.

## Jazyk
- Celé UI, README, `docs/` a komunikace s majitelem **česky**. Majitel není programátor: vysvětluj srozumitelně, krok za krokem.
- Kód, názvy proměnných a komentáře v kódu anglicky. Uživatelské texty nikdy přímo v kódu, ale přes překladové soubory (kvůli budoucí vícejazyčnosti).
- Pokerové výrazy (Fold, Call, Raise, All-in…) mohou zůstat anglicky.
