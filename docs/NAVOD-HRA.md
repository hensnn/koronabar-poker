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

Šablony spravuješ ve **Správa → Šablony**: vestavěné jsou jen ke čtení (tlačítko *Kopírovat jako vlastní* z nich udělá upravitelnou kopii), vlastní šablony zakládáš, upravuješ a mažeš. Úprava šablony platí pro nově založené hry – běžící stoly a turnaje si nesou hodnoty z doby založení. Hodnoty šablony vidíš a můžeš je přepsat i při zakládání stolu nebo turnaje (po výběru šablony se zobrazí formulář) a později tlačítkem **Upravit** u konkrétní hry; tlačítko **Pravidla** u stolu či turnaje ukáže, co přesně platí. Hodnota ze šablony má přednost před globálním nastavením.

**Odhad délky turnaje** (v náhledu poplatků při zakládání) počítá podle struktury blindů a počtu žetonů ve hře: turnaj obvykle končí na levelu, kde velký blind dosáhne zhruba 1/20 všech žetonů; rozmezí odpovídá rychlému (1/30) a pomalému (1/12) průběhu, připočítají se přestávky a odhad rebuy/add-on žetonů. Je to orientační číslo, ne simulace.

U každého parametru je napsáno, **kdy jde měnit**: hned, od další handy, jen před startem, nebo jen administrátor. Změny během hry se hráčům oznámí v chatu a jsou v audit logu. Když si nevíš rady, zeptej se asistenta 🤖 („co dělá …“, „nastav …“); změnu jen navrhne a ty ji potvrdíš.

## 3. Jak založit turnaj

**Turnaje → Založit turnaj** (hned) nebo **Naplánovat turnaj** (s datem; registrace se otevře sama, hráčům chodí připomínky).

1. **Název a šablona.** Pro začátek: *Freezeout* (bez rebuy, klidné tempo), *Rebuy* (dokupování v první části), *Turbo* (rychlé levely na večer). Pod šablonou jsou tři karty s tím hlavním: **Peníze a výplaty**, **Rebuy, add-on a re-entry** a **Struktura blindů**; zbytek je pod „Upravit podrobné nastavení“.
2. **Buy-in a poplatek** (`tournament.buyIn`, `tournament.fee`): buy-in jde do prize poolu, poplatek domu (volitelný). Dále část poolu do fondu nebo domu v procentech, garance (dům doplní, když se sejde málo hráčů).
3. **Startovní stack** a **struktura blindů**: v kartě *Struktura blindů* zadej cílovou délku, délku levelu, stack a očekávaný počet hráčů a klikni *Vygenerovat blindy podle cílové délky* – vznikne rostoucí struktura (s ante od poloviny), kterou můžeš ručně doladit (zápis „25/50, 50/100/10“). Prázdné pole = vygeneruje se automaticky při startu. Vlastní struktury si ulož pod názvem (Správa → Struktury blindů, nebo přímo z karty tlačítkem *Uložit jako strukturu*): při výběru v jiném turnaji se blindy přepočítají podle jeho startovního stacku. Hned vidíš odhad délky; za posledním levelem se blindy dál zdvojnásobují, takže se turnaj vždy dohraje. Levely podle času nebo podle počtu hand; přestávka po každých N levelech.
4. **Hráči:** minimum pro start, co dělat při nedostatku (zrušit nebo odložit), pozdní registrace do levelu N, odhlášení do N minut před startem, automatický start při naplnění.
5. **Rebuy, add-on, re-entry:** zapnutí, cena a žetony, do kterého levelu, kolikrát nejvýš. Rebuy když stack klesne pod hranici (`rebuyWhen`).
6. **Výplaty** (`tournament.payoutPreset`): *standard* (podle počtu hráčů), *wta* (vítěz bere vše), *top2*, *top3*, nebo *custom* (např. `50,30,20`). Zaokrouhlení a co se zbytkem.
7. **Bounty (volitelné):** fixní (každý má na hlavě částku), progresivní PKO (část jde výherci, část na vlastní hlavu), mystery bounty (losuje se z „pytle“).
8. **Dohoda (deal):** zda se hráči na konci smí dohodnout (ICM, chip chop, rovným dílem, vlastní), kolik procent zůstane ve hře.
9. **Více stolů:** `tournament.maxTables` a povolený rozdíl obsazení; stoly se vyvažují a ruší samy, finálový stůl a hand-for-hand na bublině jsou automatické.
10. **Živý turnaj** (`tournament.live`): hodiny, registrace a vyřazení zapisuje ředitel, hráči vidí stav na mobilu.

Po založení jde vše upravit tlačítkem **Upravit pravidla** na stránce turnaje (zakladatel nebo správce): před startem cokoli, během turnaje jen parametry označené „lze měnit kdykoli“ nebo „od další handy“. Tlačítko **Pravidla** ukáže, co právě platí.

Po založení: hráči se registrují (nebo je organizátor přihlásí), start ručně nebo automaticky, průběh řídí server (levely, přestávky, pauzy, vyřazení, výplaty). Výsledky jdou do statistik, XP, ratingu a herního večera. Hlasatel a TV režim hlásí a ukazují průběh.

## 4. Čas na tah a time bank

Nastavení → Časovač tahu. Hráč má na rozhodnutí **Čas na tah** (`time.turnSeconds`, výchozí 30 s). Co se stane, když vyprší, určuje **Režim rezervy času** (`time.bankMode`):

- **Společná rezerva (time bank)** – výchozí: každému hráči se při usednutí přidělí zásoba (`time.timeBankSeconds`, 60 s). Po vypršení základního času se rezerva spustí sama, odečte se jen skutečně spotřebovaný čas. Dá se doplňovat po N handách (`bankRefillEveryHands`, `bankRefillSeconds`) a omezit stropem (`bankMaxSeconds`).
- **Časové žetony:** místo zásoby má hráč N žetonů (`timeChips`), každý prodlouží tah o pevný čas (`timeChipSeconds`) a spotřebuje se celý.
- **Šachové hodiny / Fischer / Bronstein:** celý tah se hraje z rezervy; Fischer po každém tahu přičte přírůstek (`incrementSeconds`), Bronstein vrátí nejvýš tolik, kolik hráč spotřeboval. Hráč má vždy aspoň `minTurnSeconds`.
- **Jen pevný limit (shot clock):** bez rezervy.

**Po uplynutí všeho času** server zahraje za hráče **Akci po vypršení** (`time.expiryAction`): *Check, jinak Fold* (výchozí) nebo *Vždy Fold*. Každé vypršení se počítá; po **N vypršeních za sebou** (`time.timeoutsToSitOut`, výchozí 3) hráč přejde do **sit outu** (handy se mu rozdávají jen s automatickým foldem, u cash game neplatí blindy). Jakmile hráč sám zahraje, počítadlo se vynuluje. Z sit outu se vrací tlačítkem **Vrátit se do hry**; u cash game je po `cash.maxSitOutMinutes` (30 min) od stolu odebrán a žetony mu jdou do peněženky, v turnaji zůstává a blindy platí dál.

Odpojený hráč (zavřená aplikace, výpadek) dostane jen **prodlevu pro odpojeného** (`time.disconnectGraceSeconds`, 30 s) a rezerva se nepoužije. Pokud je zapnuté **zavolání času** (`time.callClockEnabled`), smí soupeř pomalému hráči odpočet zkrátit na `callClockSeconds`.

## 5. Po testování: vynulování

**Správa → Údržba** (jen hlavní správce). Zaškrtni, co se má smazat všem hráčům: zavřít stoly a zrušit turnaje (žetony se vrátí), XP a úrovně, úspěchy, rating, statistiky a historie hand, peněženky na startovní zůstatek. Potvrzuje se slovem VYNULOVAT a je to nevratné (zápis v audit logu). Doporučený postup po zkušebním provozu: 1) zavřít hry, 2) vynulovat XP, úspěchy, rating a statistiky, 3) peněženky na startovní zůstatek. Zvlášť je **Nový start účetní knihy**: smaže historii všech transakcí a každému připíše počáteční zůstatek (jde jen bez otevřených stolů a běžících turnajů). Jednotlivému hráči vynuluješ XP, úspěchy a rating ve **Správa → Uživatelé** tlačítkem *Vynulovat XP a rating*. Rating navíc umí „měkký reset sezóny“ a přepočet z historie ve Statistiky → Rating (pro běžné sezóny bez mazání).

## 6. Kde co najdeš

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
