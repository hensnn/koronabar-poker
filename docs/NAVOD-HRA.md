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

## 2. Nastavení: kde co je

Rozhoduje, **co se týká celé aplikace** a **co se týká jedné hry**:

1. **Správa → Nastavení (obecné)**: jen pravidla celé aplikace (limity, ekonomika, sázky, napojení ven, systém). Žádné herní nastavení tam není.
2. **Šablona** (Správa → Šablony): hotová sada všech herních nastavení (Klasika, Hluboké stacky, Freezeout, Rebuy, Turbo, Re-entry, Hyper, Deepstack, Winner takes all, Heads-up, Retro…). Šablonu jde upravit celou, nebo **hromadně změnit** jedno nastavení ve více šablonách najednou (*Změnit nastavení ve více šablonách*).
3. **Konkrétní stůl nebo turnaj**: při zakládání (Hra → Stoly) nebo později tlačítkem Upravit. Je tam úplně všechno; nahoře jsou **Hlavní nastavení** (buy-in, rebuy, add-on, bounty, dohoda, odměny na hlavu, výplaty, délka levelu) a **Speciální prvky**, zbytek je pod *Zobrazit rozšířené*.
4. **Osobní nastavení** (Nastavení → Osobní nastavení): vzhled, zvuky, panely, hustota zobrazení. Jde nastavit zvlášť pro telefon a tablet a zvlášť pro počítač.

Šablony spravuješ ve **Správa → Šablony**: vestavěné jde upravit nebo smazat a kdykoli obnovit do původní podoby, vlastní šablony zakládáš, kopíruješ, upravuješ a mažeš. Změna šablony platí pro nově založené hry; běžící hry si nesou původní hodnoty.

**Odhad délky turnaje** (v náhledu poplatků při zakládání) počítá podle struktury blindů a počtu žetonů ve hře: turnaj obvykle končí na levelu, kde velký blind dosáhne zhruba 1/20 všech žetonů; rozmezí odpovídá rychlému (1/30) a pomalému (1/12) průběhu, připočítají se přestávky a odhad rebuy/add-on žetonů. Je to orientační číslo, ne simulace.

U každého parametru je napsáno, **kdy jde měnit**: hned, od další handy, jen před startem, nebo jen administrátor. Změny během hry se hráčům oznámí v chatu a jsou v audit logu. Když si nevíš rady, zeptej se asistenta 🤖 („co dělá …“, „nastav …“); změnu jen navrhne a ty ji potvrdíš.

## 3. Jak založit turnaj

**Hra → Stoly → Založit turnaj** (hned) nebo **Naplánovat turnaj** (s datem; registrace se otevře sama, hráčům chodí připomínky).

1. **Název a šablona.** Pro začátek: *Freezeout* (bez rebuy, klidné tempo), *Rebuy* (dokupování v první části), *Turbo* (rychlé levely na večer). Pod šablonou jsou tři karty s tím hlavním: **Peníze a výplaty**, **Rebuy, add-on a re-entry** a **Struktura blindů**; zbytek je pod „Upravit podrobné nastavení“.
2. **Buy-in a poplatek** (`tournament.buyIn`, `tournament.fee`): buy-in jde do prize poolu, poplatek domu (volitelný). Dále část poolu do fondu nebo domu v procentech, garance (dům doplní, když se sejde málo hráčů).
3. **Startovní stack** a **struktura blindů**: v kartě *Struktura blindů* zadej cílovou délku, délku levelu, stack a očekávaný počet hráčů a klikni *Vygenerovat blindy podle cílové délky* – vznikne rostoucí struktura (s ante od poloviny), kterou můžeš ručně doladit (zápis „25/50, 50/100/10“). Prázdné pole = vygeneruje se automaticky při startu. Vlastní struktury si ulož pod názvem (Správa → Struktury blindů, nebo přímo z karty tlačítkem *Uložit jako strukturu*): při výběru v jiném turnaji se blindy přepočítají podle jeho startovního stacku. Hned vidíš odhad délky; za posledním levelem se blindy dál zdvojnásobují, takže se turnaj vždy dohraje. Levely podle času nebo podle počtu hand; přestávka po každých N levelech.
4. **Hráči:** minimum pro start, co dělat při nedostatku (zrušit nebo odložit), pozdní registrace do levelu N, odhlášení do N minut před startem, automatický start při naplnění.
5. **Rebuy, add-on, re-entry:** zapnutí, cena a žetony, do kterého levelu, kolikrát nejvýš. Rebuy když stack klesne pod hranici (`rebuyWhen`). Když hráč vypadne a může si koupit rebuy, má na rozhodnutí `rebuyDecisionSeconds`; při zapnutém „Hra čeká na rozhodnutí o rebuy“ mezitím nezačne další handa a všem u stolu se ukáže pruh s odpočtem (u odpojeného hráče se čeká nejvýš `rebuyOfflineMaxSeconds`).
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

## 4b. Když se u stolu čeká: co hráč vidí

U stolu je pod stolem vždy řádek, který říká, na co se čeká, a kde to jde, s odpočtem:

- **Jsi na tahu / někdo je na tahu:** odpočet času na tah (včetně time banku, zavolaného času).
- **Hlasování** (run it twice): kdo hlasoval a kolik zbývá času; hlasující mají okno s tlačítky.
- **Showdown:** „Hráči se rozhodují, zda ukážou karty“ s odpočtem; rozhodující mají okno Ukázat / Muck.
- **Mezi handami:** „Další handa začne za N s“; při málo hráčích „Čeká se na další hráče“; při pauze „Hra je pozastavená“.
- **Turnaj:** řádek s názvem turnaje nad stolem ukazuje přestávku s odpočtem, pauzu ředitelem, hand-for-hand na bublině a rozhodování o rebuy (kdo, kolik zbývá, nebo že hra čeká na odpojeného).
- **Zvláštní události** (7-2 bonus, bomb pot, jackpot) se na pár sekund objeví nad stolem a zároveň jdou do chatu u stolu.
- **Vypršel čas hráči:** když server za něj zahraje fold nebo check, nad stolem se krátce ukáže, že šlo o vypršení času.
- **Lišta nástrojů nad stolem** má jen ikony (po najetí myší se ukáže název): 💬 sdílet v chatu, 🧾 vyúčtování, 🗳️ anketa, ⏸/▶ pauza, 📱/🖥️ mobilní rozložení, ⚙ panely, 📜 historie, ⛶ celá obrazovka; 💤 s číslem znamená, kolik hráčů je v sit outu. Na telefonu jsou stejné nástroje s textem pod tlačítkem ⋯.
- **Time bank:** v widgetu o stole (u turnaje v hodinách turnaje) je vidět, kolik rezervy času ti zbývá (pokud je rezerva zapnutá).
- **Velikost a umístění plochy hry:** tlačítko 📐 v liště nástrojů otevře posuvníky **Plocha hry** (50 až 100 % šířky okna: levý panel, stůl a pravý sloupec dohromady, panely se přisunou ke stolu), **Stůl: šířka** a **Stůl: výška** a tlačítka **Vlevo / Na střed / Vpravo**. Díky tomu hra nemusí zabírat celé okno prohlížeče a vedle ní zůstane místo třeba pro video. Výchozí je celá šířka a umístění na střed. Totéž je v Osobním nastavení a jde nastavit zvlášť pro počítač a telefon; na telefonu se plocha hry nemění.
- **Akce hráčů** (fold, check, call, bet, raise, re-raise, all-in) mají každá vlastní animaci u sedadla; rozdávání, otočení karet, výhra a vyřazení také.

Všechna tato hlášení si každý hráč vypne nebo zapne v **Nastavení → Osobní nastavení → Vzhled a ovládání**: *U stolu ukazovat, na co se čeká*, *Čekání turnaje v řádku s názvem*, *Oznámení nad stolem (bonus, bomb pot, jackpot)* a *Oznámit vypršení času hráče*. Správce může nastavit výchozí hodnoty pro všechny (Správa → Výchozí osobní nastavení).

## 4c. Stůl na telefonu

Na telefonu (úzký displej, nebo telefon na šířku) je stůl samostatná obrazovka bez rolování:
- **nahoře lišta:** ← zpět, blindy (u turnaje 🏆) a tři ikony: 💬 chat (s počtem nepřečtených), ℹ️ informace o hře (panely z počítače: Můj stůl, Moje kombinace, Hráči, O hře…) a ☰ nabídka stolu (nástroje, sit out, dokoupit, odejít, dohoda, zvuky);
- **uprostřed stůl**, který vyplní výšku displeje;
- **dole velká tlačítka:** když nejsi na tahu, **plánované tahy** (Fold, Check/Fold, Check, Call, Straddle); když jsi na tahu, tlačítka akcí a posuvník sázky.

Na počítači se nic nemění. Starší rozložení (vše pod stolem) zůstává jako **Klasický vzhled**: přepíná se v nabídce stolu (🔀) nebo v Osobním nastavení (Vzhled stolu na telefonu). Osobní nastavení lze mít zvlášť pro telefon a počítač.

## 5. Po testování: vynulování

**Správa → Údržba** (jen hlavní správce). Zaškrtni, co se má smazat všem hráčům: zavřít stoly a zrušit turnaje (žetony se vrátí), XP a úrovně, úspěchy, rating, statistiky a historie hand, peněženky na startovní zůstatek. Potvrzuje se slovem VYNULOVAT a je to nevratné (zápis v audit logu). Doporučený postup po zkušebním provozu: 1) zavřít hry, 2) vynulovat XP, úspěchy, rating a statistiky, 3) peněženky na startovní zůstatek. Zvlášť je **Nový start účetní knihy**: smaže historii všech transakcí a každému připíše počáteční zůstatek (jde jen bez otevřených stolů a běžících turnajů). Jednotlivému hráči vynuluješ XP, úspěchy a rating ve **Správa → Uživatelé** tlačítkem *Vynulovat XP a rating*. Rating navíc umí „měkký reset sezóny“ a přepočet z historie ve Statistiky → Rating (pro běžné sezóny bez mazání).

## 6. Kde co najdeš

| Chci | Kde |
|---|---|
| Blindy, místa, straddle, ante | Šablona nebo úprava stolu → Stůl |
| Čas na tah, time bank, prodlevy animací | Šablona nebo úprava hry → Časovač tahu, Časování průběhu handy |
| Buy-in cash, hit-and-run, čekací listina | Šablona nebo úprava stolu → Cash game |
| Rake a časový poplatek | Šablona nebo úprava stolu → Rake |
| Run it twice, bomb pot, jackpoty, rebuy, add-on, re-entry, bounty, dohoda, odměny na hlavu, sázky | Speciální prvky (rozdělené do podskupin); u turnaje také v hlavním nastavení nahoře |
| Levely, výplaty, poplatky, plánování | Šablona nebo úprava turnaje → rozšířené nastavení → Turnaj a podkategorie |
| Plánování, připomínky, série a ligy | Hra → Stoly → Naplánovat, Série a ligy |
| Peněženka, žádosti o dobití, vyúčtování večera (filtr Vše / Cash / Turnaje) | Hra → Peněženka |
| XP, hodnosti, úspěchy, rating | Nastavení → Zkušenosti a hodnosti, Herní rating |
| Vzhled, hustota zobrazení, zvuky, panely, odhlášení | Nastavení → Osobní nastavení (Odhlásit je vpravo nahoře) |
| Hlasatel, TV | Správa → Hlasatel, Správa → TV |
| Home Assistant, Discord, webhooky | Správa → Napojení ven; postup v `docs/HOME-ASSISTANT.md` |
| Kdo co smí | Správa → Role |
| Peníze hráčům | Správa → Pokladna |
| Co se stalo | Správa → Audit log, Finance |
| Jak se mi daří (grafy zůstatku, výsledků, XP, ratingu) | Hra → Statistiky → Moje statistiky → Jak se mi daří |
| Přehled a srovnání všech hráčů | Hra → Statistiky → Přehled hráčů (správce může vypnout: Správa → Nastavení → Statistiky) |

Tip: pro první večer stačí jeden cash stůl ze šablony Klasika a jeden turnaj Freezeout s výplatou *top3*. Zbytek dolaď, až uvidíš, jak se hraje.
