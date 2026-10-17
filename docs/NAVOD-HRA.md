# Krátký návod: jak herna funguje a jak nastavit turnaj

Pro majitele a organizátory. Nic tady není peníze: hraje se o **virtuální měnu (KČ)**, která nemá peněžní hodnotu, nejde koupit ani vybrat. Všechno nastavení je v GUI, do kódu se nesahá.

## 1. Základní logika

**Účty a role.** Registrace je jen na pozvánku (Správa → Pozvánky). Co kdo smí, určují role (Správa → Role): hráč, organizátor (zakládá a řídí hry), ředitel turnajů (zásahy do běžící hry), kurátor (schvaluje zvuky a motivy), administrátor. Role lze přidělit i jen pro konkrétní stůl nebo turnaj.

**Peněženka.** Každý hráč má peněženku. Žetony mu dobije správce v Pokladně (nebo si hráč požádá a správce schválí). Všechny pohyby jdou přes účetní knihu: buy-in odečte z peněženky a převede na stůl nebo do turnaje, výhra se vrátí zpět. Nic nevzniká ani nemizí, součet vždy sedí; vidíš to v Peněžence a správce ve Financích.

**Dva druhy hry.**
- **Cash stůl:** přisedneš s buy-inem (v násobcích big blindu), kdykoli odejdeš a žetony se ti vrátí do peněženky. Blindy jsou stálé.
- **Turnaj:** zaplatíš buy-in, dostaneš startovní stack turnajových žetonů (ty nejsou měna), blindy rostou po levelech a hraje se, dokud nezůstane jeden. Výhry se rozdělí podle výplatní struktury z prize poolu.

**Průběh handy** (server rozdává, klient jen zobrazuje, cizí karty nikdy nedostane): blindy → preflop → flop → turn → river → showdown. Na tah je časovač (Nastavení → Časovač tahu), po vypršení má hráč time bank, pak fold/check. Volitelné prvky: straddle, run it twice, bomb pot, rabbit hunt, 7-2 bonus, šance na výhru při all-inu.

**Živá hra** (Živý cash, živý turnaj): hrajete s opravdovými kartami u stolu a aplikace jen vede žetony, blindy, hodiny a vyúčtování. Ředitel zapisuje vyřazení a výsledky.

## 2. Nastavení: tři vrstvy

Každý parametr má výchozí hodnotu, kterou jde přepsat na třech místech. Platí vždy ta nejkonkrétnější:

1. **Globální** (Správa → Nastavení): výchozí pro všechny hry.
2. **Šablona**: hotová sada hodnot (Klasika, Hluboké stacky, Freezeout, Rebuy, Turbo, Re-entry, Hyper, Deepstack, Winner takes all, Heads-up, Retro…).
3. **Konkrétní stůl nebo turnaj**: při zakládání nebo později tlačítkem Upravit.

U každého parametru je napsáno, **kdy jde měnit**: hned, od další handy, jen před startem, nebo jen administrátor. Změny během hry se hráčům oznámí v chatu a jsou v audit logu. Když si nevíš rady, zeptej se asistenta 🤖 („co dělá …“, „nastav …“); změnu jen navrhne a ty ji potvrdíš.

## 3. Jak založit turnaj

**Turnaje → Založit turnaj** (hned) nebo **Naplánovat turnaj** (s datem; registrace se otevře sama, hráčům chodí připomínky).

1. **Název a šablona.** Pro začátek: *Freezeout* (bez rebuy, klidné tempo), *Rebuy* (dokupování v první části), *Turbo* (rychlé levely na večer).
2. **Buy-in a poplatek** (`tournament.buyIn`, `tournament.fee`): buy-in jde do prize poolu, poplatek domu (volitelný). Dále část poolu do fondu nebo domu v procentech, garance (dům doplní, když se sejde málo hráčů).
3. **Startovní stack** (`tournament.startingStack`) a **struktura blindů** (`tournament.structure`, editor levelů). Levely podle času (`levelMinutes`) nebo podle počtu hand. Přestávka po každých N levelech (`breakEveryLevels`, `breakMinutes`). Nebo zadej cílovou délku (`targetMinutes`) a struktura se dopočítá.
4. **Hráči:** minimum pro start, co dělat při nedostatku (zrušit nebo odložit), pozdní registrace do levelu N, odhlášení do N minut před startem, automatický start při naplnění.
5. **Rebuy, add-on, re-entry:** zapnutí, cena a žetony, do kterého levelu, kolikrát nejvýš. Rebuy když stack klesne pod hranici (`rebuyWhen`).
6. **Výplaty** (`tournament.payoutPreset`): *standard* (podle počtu hráčů), *wta* (vítěz bere vše), *top2*, *top3*, nebo *custom* (např. `50,30,20`). Zaokrouhlení a co se zbytkem.
7. **Bounty (volitelné):** fixní (každý má na hlavě částku), progresivní PKO (část jde výherci, část na vlastní hlavu), mystery bounty (losuje se z „pytle“).
8. **Dohoda (deal):** zda se hráči na konci smí dohodnout (ICM, chip chop, rovným dílem, vlastní), kolik procent zůstane ve hře.
9. **Více stolů:** `tournament.maxTables` a povolený rozdíl obsazení; stoly se vyvažují a ruší samy, finálový stůl a hand-for-hand na bublině jsou automatické.
10. **Živý turnaj** (`tournament.live`): hodiny, registrace a vyřazení zapisuje ředitel, hráči vidí stav na mobilu.

Po založení: hráči se registrují (nebo je organizátor přihlásí), start ručně nebo automaticky, průběh řídí server (levely, přestávky, pauzy, vyřazení, výplaty). Výsledky jdou do statistik, XP, ratingu a herního večera. Hlasatel a TV režim hlásí a ukazují průběh.

## 4. Kde co najdeš

| Chci | Kde |
|---|---|
| Výchozí blindy, místa, straddle, ante | Nastavení → Stůl |
| Čas na tah, time bank, prodlevy animací | Nastavení → Časovač tahu, Časování průběhu handy |
| Buy-in cash, hit-and-run, čekací listina | Nastavení → Cash game |
| Rake, jackpoty, časový poplatek | Nastavení → Rake |
| Levely, rebuy, výplaty, bounty, dohody, poplatky | Nastavení → Turnaj a podkategorie (rebuy, výplaty, bounty, dohody, poplatky a garance, plánování) |
| Plánování, připomínky, série a ligy | Turnaje → Naplánovat, Série a ligy |
| XP, hodnosti, úspěchy, rating | Nastavení → Zkušenosti a hodnosti, Herní rating |
| Zvuky, hlasatel, TV | Profil (osobní), Správa → Hlasatel, Správa → TV |
| Kdo co smí | Správa → Role |
| Peníze hráčům | Správa → Pokladna |
| Co se stalo | Správa → Audit log, Finance |

Tip: pro první večer stačí jeden cash stůl ze šablony Klasika a jeden turnaj Freezeout s výplatou *top3*. Zbytek dolaď, až uvidíš, jak se hraje.
