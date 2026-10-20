/** Návod pro hráče: stručný start a podrobný návod (zobrazuje se v Nastavení a na hlavní stránce). */
export const csGuide: Record<string, string> = {
  'nav.guide': 'Návod',
  'guide.title': 'Návod',
  'guide.tab.settings': 'Nastavení',
  'guide.tab.guide': 'Návod',

  // ---------- podrobný návod ----------
  'guide.intro': 'Tady je podrobný přehled hry. Kapitoly otevřeš kliknutím. Hledej v nich i barevné štítky u nastavení: zelený se mění kdykoli, žlutý od další handy a červený jen před startem hry.',

  'guide.s.start.title': 'Začínáme',
  'guide.s.start.1': 'Do hry se vstupuje z pozvánky. Po přihlášení vidíš hlavní stránku: zůstatek, stoly, turnaje, žebříček.',
  'guide.s.start.2': 'Měna je virtuální a nemá peněžní hodnotu. Nic se nekupuje ani nevybírá za skutečné peníze.',
  'guide.s.start.3': 'Zůstatek doplňuje správce (pokladna). Všechny pohyby se zapisují do účetní knihy, takže nic nevznikne ani nezmizí.',
  'guide.s.start.4': 'Nabídka nahoře: Hrát, Komunita, Moje a Účet a správa. Zelená, modrá, hnědá a červená tečka odlišují skupiny.',

  'guide.s.cash.title': 'Cash game',
  'guide.s.cash.1': 'Vyber stůl a klikni na prázdné místo. Zadej částku (buy-in) mezi minimem a maximem stolu.',
  'guide.s.cash.2': 'Dokoupit žetony smíš podle pravidel stolu (nejvýš do maximálního buy-inu). Při nulovém stacku nabídne stůl rebuy.',
  'guide.s.cash.3': 'Odejít od stolu: žetony se vrátí do peněženky po dohrání rozehrané handy. Sit out tě na chvíli vyřadí z rozdávání.',
  'guide.s.cash.4': 'Ochrana „hit and run“ (když je zapnutá): po odchodu se do nastavené doby nevrátíš s menším stackem. Vrátit se smíš se stejným stackem, i nad maximální buy-in.',
  'guide.s.cash.5': 'Handa se rozdá, až jsou u stolu aspoň dva hráči. Nový hráč čeká na big blind, nebo zaplatí dead blind (podle pravidel stolu).',

  'guide.s.tournament.title': 'Turnaje',
  'guide.s.tournament.1': 'Přihlas se před začátkem (nebo v pozdní registraci, pokud ji turnaj má). Buy-in jde do prize poolu, poplatek hernímu.',
  'guide.s.tournament.2': 'Žetony v turnaji nejsou měna. Blindy rostou po levelech, mezi nimi bývají přestávky. Nahoře nad stolem vidíš název, level, čas a moje místo.',
  'guide.s.tournament.3': 'Rebuy: dokoupení žetonů po vypadnutí nebo při malém stacku (do nastaveného levelu). Add-on: jednorázové dokoupení v nastaveném okně nebo nabídka po levelu. Re-entry: nový vstup po vypadnutí.',
  'guide.s.tournament.4': 'Bounty: část vstupu jde na hlavu hráče. Fixní bounty dostane ten, kdo hráče vyřadí. U PKO se část vyplatí hned a zbytek se přičte k tvé hlavě. U mystery je hodnota tajná. Hlavu vidíš u sedadla jako ☠.',
  'guide.s.tournament.5': 'Dohoda (deal): zbývající hráči si mohou hlasováním rozdělit výhry. Hlasování se zobrazí všem a vyžaduje potřebnou většinu.',
  'guide.s.tournament.6': 'Po skončení se každému ukáže přehled výsledků. Zrušený turnaj vrátí všechny platby, vyplacené bounty zůstávají.',

  'guide.s.table.title': 'U stolu',
  'guide.s.table.1': 'Dole jsou tlačítka akcí (Fold, Check/Call, Bet/Raise, All-in), rychlé sázky a posuvník. Zkratky kláves jdou nastavit v osobním nastavení.',
  'guide.s.table.2': 'Plánovaný tah (mimo tvůj tah): předem zvolíš Fold, Check/Fold, Check nebo Call a provede se, až budeš na řadě. Vedle je přepínač Straddle, pokud ho stůl povoluje.',
  'guide.s.table.3': 'Na tah máš omezený čas. Pak může pomoci time bank. Když nestihneš, zahraje se check nebo fold.',
  'guide.s.table.4': 'Ukázání karet: po handě, kterou všichni složili, můžeš ukázat obě nebo jednu kartu (lišta v pravém dolním rohu nebo klepnutí na vlastní kartu). Rabbit hunt ukáže, co by přišlo.',
  'guide.s.table.5': 'Run it twice, straddle, bomb pot a další zvláštnosti zapíná správce u stolu. Štítky stolu ti napoví, co platí.',
  'guide.s.table.6': 'Najetím myší (nebo klepnutím) na hráče uvidíš jeho žetony, v turnaji i pořadí, rebuy, add-on a odměny.',

  'guide.s.panels.title': 'Panely a vzhled',
  'guide.s.panels.1': 'Levý a pravý panel jsou složené z widgetů (Můj stůl, Hráči, Chat, O hře, Odměny…). Tlačítko ⚙ Panely nad stolem otevře jejich nastavení.',
  'guide.s.panels.2': 'V nastavení panelů můžeš widgety přesouvat mezi panely, měnit pořadí, skrývat je i vypnout celý levý nebo pravý panel.',
  'guide.s.panels.3': 'Widget O hře obsahuje akce: dokoupit, odejít, sit out, volby ukázání karet, rebuy, add-on, dohodu. Barevné tlačítko jde použít, šedé teď ne.',
  'guide.s.panels.4': 'Celá obrazovka schová vše mimo stůl. Na telefonu se panely otevírají tlačítky Panel a Chat a akce jsou pod stolem.',
  'guide.s.panels.5': 'Vzhled (motiv) a animace se nastavují v osobním nastavení. Animace rozdávání a událostí turnaje jdou vypnout.',

  'guide.s.comm.title': 'Chat a komunikace',
  'guide.s.comm.1': 'Chat u stolu i všeobecný. Zprávy mohou obsahovat obrázky a reakce emoji.',
  'guide.s.comm.2': 'Zvukové emotikony přehrají krátký zvuk všem u stolu. Vlastní zvuky můžeš nahrát v nastavení.',
  'guide.s.comm.3': 'Poznámky k hráčům vidíš jen ty. Zajímavou handu můžeš sdílet do chatu a ostatní ji mohou okomentovat.',

  'guide.s.social.title': 'Ankety, večery a historie',
  'guide.s.social.1': 'Ankety slouží k domluvě (kdy a co hrát). Večer sdružuje hry jednoho setkání a na konci ukáže souhrn a vyúčtování.',
  'guide.s.social.2': 'Historie u stolu ukazuje hotové handy v přehledné tabulce. Kliknutím na řádek otevřeš podrobný průběh.',
  'guide.s.social.3': 'Statistiky, rating, hodnosti (XP) a úspěchy se počítají z odehraných her. Smazání hry z historie může jejich hodnoty změnit. Ve Statistikách → Přehled hráčů najdeš srovnání hráčů v čase a kategorie „kdo je v čem nejlepší“.',

  'guide.s.settings.title': 'Nastavení',
  'guide.s.settings.1': 'Osobní nastavení platí jen pro tebe (zvuky, vzhled, zkratky). Nastavení her a stolů mění správce.',
  'guide.s.settings.2': 'U každé položky je vysvětlení. Barevný štítek říká, kdy se změna projeví: ⚡ zelený kdykoli, ⏭ žlutý od další handy, 🔒 červený jen před startem hry.',
  'guide.s.settings.3': 'Hodnota se dědí po vrstvách: vestavěná výchozí → globální nastavení → šablona → hra → stůl → osobní. Položka, kterou nastavuješ právě v této vrstvě, je zvýrazněná štítkem Změněno a u každé je vidět, odkud hodnota pochází. Přepínač nahoře ukáže jen takové položky, tlačítko u položky vrátí zděděnou hodnotu.',
  'guide.s.settings.4': 'Záložky mají barvy podle skupin. Všechny turnajové skupiny sdílejí jednu barvu. Vyhledávání hledá v názvech i nápovědě.',

  'guide.s.admin.title': 'Pro správce',
  'guide.s.admin.1': 'Šablony stolů a turnajů se upravují ve Správě. Vestavěné šablony jde přejmenovat, upravit, smazat i obnovit.',
  'guide.s.admin.2': 'Pokladna dobíjí a stahuje měnu, finance ukazují účetnictví. Mazání z historie se peněz netýká, ale mění statistiky.',
  'guide.s.admin.3': 'Pravidla odesílání e-mailů, napojení ven, AI asistent a ochrana proti zneužití se nastavují v části Systém. Citlivé údaje se ukládají šifrovaně.',
};
