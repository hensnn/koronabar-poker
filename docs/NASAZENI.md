# Nasazení v LXC kontejneru v Proxmoxu, krok za krokem

Návod pro první nasazení KoronaBar Poker (adresa `https://poker.example.cz` je v příkladech zástupná, dosaď svou doménu). Předpokládá, že máš Proxmox, běžící Nginx Proxy Manager (NPM) a doménu nasměrovanou na svou veřejnou IP adresu s přesměrovanými porty 80 a 443 na NPM. Každý blok příkazů spouštěj tam, kde je uvedeno (hostitel Proxmoxu, nebo uvnitř kontejneru).

## Rychlá cesta: instalační skript (na hostiteli Proxmoxu)

Kroky 1 až 4 udělá za tebe skript. Na hostiteli Proxmoxu jako root spusť:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/hensnn/koronabar-poker/main/scripts/proxmox-install.sh)
```

Vytvoří LXC 120 (Debian 12, Nesting, 2 jádra, 2 GB RAM, 16 GB disk na `local-lvm`, síť DHCP na `vmbr0`), nainstaluje Docker, stáhne projekt, vygeneruje hesla a `MASTER_KEY`, spustí aplikaci a na konci vypíše hesla a údaje pro NPM (ulož si je hned, podruhé se nevypíší). Jiné hodnoty zadáš proměnnými před příkazem, například:

```bash
CTID=130 STORAGE=local-zfs IP_CONF=192.168.1.50/24,gw=192.168.1.1 ADMIN_NICKNAME=Michal bash <(curl -fsSL https://raw.githubusercontent.com/hensnn/koronabar-poker/main/scripts/proxmox-install.sh)
```

Pokud příkaz skončí chybou 404, je repozitář na GitHubu soukromý: buď ho zveřejni (Settings → Danger Zone → Change visibility), nebo použij token jen pro čtení (Settings → Developer settings → Fine-grained tokens, Contents: Read-only):

```bash
TOKEN=github_pat_...; REPO="https://$TOKEN@github.com/hensnn/koronabar-poker.git" bash <(curl -fsSL -H "Authorization: token $TOKEN" https://raw.githubusercontent.com/hensnn/koronabar-poker/main/scripts/proxmox-install.sh)
```

Token pak zůstane uložený v kontejneru kvůli aktualizacím (`git pull`), zacházej s ním jako s heslem.

Po doběhnutí pokračuj krokem 5 (NPM). Ruční postup níže dělá totéž po krocích.

## 1. Vytvoření LXC kontejneru (na hostiteli Proxmoxu)

Docker uvnitř LXC potřebuje zapnuté **Nesting** (a pro jistotu **keyctl**). Kontejner může být neprivilegovaný.

Stáhni šablonu Debian 12 (pokud ji ještě nemáš):

```bash
pveam update && pveam available --section system | grep debian-12
```

```bash
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
```

(Název šablony vezmi z výpisu, verze se může lišit.)

Vytvoř kontejner (změň `120` na volné ID, `local-lvm` na své úložiště a heslo roota):

```bash
pct create 120 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst --hostname poker --cores 2 --memory 2048 --swap 512 --rootfs local-lvm:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 --password 'ZmenMeHeslo123'
```

Totéž jde naklikat v GUI: Create CT → Unprivileged container zapnuto → šablona Debian 12 → 16 GB disk → 2 jádra → 2048 MB RAM → síť DHCP. Potom v **Options → Features** zapni **Nesting** a **keyctl** a v **Options → Start at boot** dej Yes.

Spusť kontejner a zjisti jeho IP adresu (budeš ji potřebovat v NPM):

```bash
pct start 120 && sleep 5 && pct exec 120 -- hostname -I
```

Doporučení: v routeru nebo v Proxmoxu dej kontejneru pevnou IP (DHCP rezervaci), aby se adresa v NPM neměnila.

## 2. Instalace Dockeru (uvnitř kontejneru)

Přihlas se do kontejneru:

```bash
pct enter 120
```

Aktualizace a základní nástroje:

```bash
apt update && apt -y upgrade && apt -y install curl git ca-certificates nano
```

Časové pásmo (časy v logu a e-mailech):

```bash
timedatectl set-timezone Europe/Prague
```

Docker oficiálním instalačním skriptem:

```bash
curl -fsSL https://get.docker.com | sh
```

Ověření:

```bash
docker compose version && docker run --rm hello-world
```

Pokud `hello-world` selže na oprávnění, zkontroluj v Proxmoxu, že má kontejner zapnutý Nesting, a restartuj ho (`pct reboot 120` na hostiteli).

## 3. Stažení projektu a nastavení `.env` (uvnitř kontejneru)

```bash
git clone https://github.com/hensnn/koronabar-poker.git /opt/koronabar && cd /opt/koronabar
```

(Pokud je repozitář soukromý, GitHub se zeptá na jméno a místo hesla chce **Personal Access Token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained, oprávnění Contents: Read.)

Vytvoř `.env` z předlohy:

```bash
cp .env.example .env
```

Vygeneruj hesla a šifrovací klíč (výstup si zkopíruj do `.env` a klíč navíc do správce hesel):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' )"; echo "MASTER_KEY=$(openssl rand -hex 32)"
```

Uprav `.env`:

```bash
nano .env
```

Vyplň: `POSTGRES_PASSWORD`, `ADMIN_NICKNAME` (tvoje přezdívka), `ADMIN_PASSWORD` (min. 12 znaků), `MASTER_KEY`. `PUBLIC_URL` nastav na svou skutečnou adresu (v příkladech je `https://poker.example.cz`), `PORT` nech `3000`. Uložíš Ctrl+O, Enter, zavřeš Ctrl+X.

## 4. První spuštění (uvnitř kontejneru)

```bash
cd /opt/koronabar && docker compose up -d --build
```

První sestavení trvá 5 až 10 minut. Potom:

```bash
docker compose ps
```

Obě služby `app` i `db` musí být `healthy` (u `app` to může trvat půl minuty). Log aplikace:

```bash
docker compose logs app --tail 50
```

Zkouška zevnitř kontejneru:

```bash
curl -s http://localhost:3000/health
```

Má vrátit `{"ok":true}`.

## 5. Nginx Proxy Manager

V NPM **Hosts → Proxy Hosts → Add Proxy Host**:

- **Domain Names:** `poker.example.cz`
- **Scheme:** `http`, **Forward Hostname / IP:** IP adresa LXC kontejneru z kroku 1, **Forward Port:** `3000`
- Zapni **Websockets Support** (bez něj nepojede hra ani chat) a **Block Common Exploits**
- Záložka **SSL:** Request a new SSL certificate (Let's Encrypt), zapni **Force SSL** a **HTTP/2 Support**, souhlas s podmínkami, Save.

Pak otevři `https://poker.example.cz` a přihlas se přezdívkou a heslem z `.env`.

## 6. Po přihlášení

1. **Správa → Nastavení → Systém:** zkontroluj veřejnou adresu.
2. **Správa → Pozvánky:** vytvoř pozvánky pro kamarády (registrace je jen na pozvánku).
3. **Správa → Pokladna:** dobij hráčům virtuální měnu.
4. Volitelně **Správa → Tajné údaje** a **Správa → E-mail** (Gmail podle README), hlasatel, AI, Home Assistant.
5. Na telefonu otevři adresu v Chromu nebo Safari a nainstaluj aplikaci (Profil → Nainstalovat aplikaci; na iPhonu Sdílet → Přidat na plochu).

## 7. Provoz

Zálohy databáze běží samy (služba `backup`, denně, 14 dní). Zkopírovat je ven:

```bash
cd /opt/koronabar && docker compose cp backup:/backups /root/zalohy
```

Záloha celého kontejneru v Proxmoxu (Datacenter → Backup) zálohuje i Docker svazky, takže ji doporučuju nastavit také. `MASTER_KEY` z `.env` měj uložený ještě jinde.

Aktualizace na novou verzi:

```bash
cd /opt/koronabar && git pull && docker compose up -d --build
```

Restart aplikace:

```bash
cd /opt/koronabar && docker compose restart app
```

Zapomenuté heslo hlavního administrátora:

```bash
cd /opt/koronabar && docker compose exec app node dist/cli.js recover-admin PREZDIVKA NOVE-HESLO
```

Volitelný český hlas pro hlasatele (Piper, stáhne si model při prvním startu):

```bash
cd /opt/koronabar && docker compose --profile piper up -d
```

a v aplikaci **Správa → Hlasatel** zadej adresu `piper` a port `10200`.

## Když něco nejede

- `docker compose ps` ukazuje `app` jako `unhealthy` nebo restartující: `docker compose logs app --tail 100` a pošli mi výpis.
- Stránka se načte, ale hra nebo chat „nežije“: v NPM chybí **Websockets Support**.
- Přihlášení hlásí chybu původu (FORBIDDEN_ORIGIN): `PUBLIC_URL` v `.env` neodpovídá adrese, ze které aplikaci otevíráš; po úpravě `docker compose up -d`.
- Push upozornění nechodí: vyžadují HTTPS (přes NPM) a povolení v prohlížeči; na iPhonu jen u nainstalované aplikace.

## Před ostrým provozem: jednorázová příprava (smazání zkušebních dat)

Po testování se dá vše zkušební smazat jedním krokem: **Správa → Údržba → Příprava na ostrý provoz** (karta nahoře). Uživatelé a jejich účty, globální nastavení, šablony stolů a turnajů, struktury blindů, motivy, role, napojení a osobní rozložení panelů **zůstávají**.

1. Udělej zálohu (snímek kontejneru v Proxmoxu a záloha databáze) a ulož si `MASTER_KEY`.
2. Otevři Údržbu, u každé položky vidíš, kolik se smaže: zavřít stoly a zrušit turnaje, postup a statistiky, hotové hry z Historie, historie chatu, upozornění ve zvonečku, peněženky na 0.
3. Zaškrtni, co chceš, napiš potvrzovací slovo a potvrď. Akce je nevratná a zapíše se do audit logu.
4. Hráčům pak dobij měnu v **Správa → Pokladna** (po vynulování mají nulu).

### Smazání uživatelů a úplný reset (do budoucna)

- **Smazání uživatelů:** v kartě Příprava na ostrý provoz zaškrtni, koho smazat (nebo tlačítko Smazat u uživatele ve Správa → Uživatelé). Hlavního správce, sebe, hráče u stolu nebo v otevřeném turnaji a hráče s otevřenou sázkou nebo odměnou na hlavu server přeskočí a řekne proč. Zůstatek smazaného se vrátí do virtuální měny.
- **Úplný reset (jako po instalaci):** karta Úplný reset v téže Údržbě. Smaže všechna data včetně uživatelů, nastavení, šablon, rolí, tajných údajů i nahraných souborů a aplikace se restartuje (Docker ji znovu spustí). Hlavní správce se vytvoří znovu podle `.env` (`ADMIN_NICKNAME`, `ADMIN_PASSWORD`). Smí jen hlavní správce, vyžaduje potvrzovací slovo a je nevratný, proto předem zálohu.

## Veřejné přehledy (žebříček na sdíleném odkazu)

Žebříček hráčů (zisk, zkušenosti, level, hodnocení, výhry…) můžeš ukázat komukoli na internetu **bez registrace** pod tajným odkazem.

1. V **Nastavení → Statistiky** zapni „Veřejné přehledy zapnuty“ (ve výchozím stavu je vypnuto a žádný odkaz nefunguje).
2. Ve **Správa → Veřejné přehledy** klikni na „Nový přehled“. Vznikne odkaz ve tvaru `https://poker.example.cz/verejne/…`; tlačítkem „Kopírovat odkaz“ ho pošli, komu chceš.
3. „Upravit“ nastaví, co se ukáže: sloupce, řazení, období (celá doba, 30/90 dní, rok), počet řádků, minimum odehraných her, přezdívky celé nebo jen první písmeno, skrytí částek a skrytí vybraných hráčů.
4. „Nový odkaz“ starý odkaz okamžitě zneplatní; „Vypnutý“ stránku dočasně schová; „Smazat“ ji zruší.

Mezi sloupci je i „Stav peněženky“ (počet virtuálních žetonů; skryje se spolu s ostatními částkami). Pod tabulkou je graf vývoje zisku z turnajů v čase u nejlepších hráčů (jde vypnout a nastavit počet hráčů).

Stránka nikdy neukazuje e-maily ani jiné osobní údaje než přezdívku (a jen s vypnutými částkami ani žádné peníze), vyhledávače ji neindexují a počet dotazů z jedné adresy je omezený. Odkaz zná jen ten, komu ho pošleš, takže ho sdílej jen s lidmi, kterým důvěřuješ.

## Discord: propojení přes webhook (zprávy z herny do kanálu)

Herna umí posílat vybrané události (registrace a konec turnaje, vyřazení hráče, all-in, velký pot, bad beat, nová anketa, konec večera…) jako zprávy do Discord kanálu. Bot ani účet navíc není potřeba, stačí **webhook**: tajná adresa kanálu. Jde jen jedním směrem (herna → Discord), hráči přes Discord nic nezadávají.

### 1. Vytvoř webhook v Discordu (potřebuješ oprávnění spravovat server)
1. V Discordu otevři server a vyber **kanál**, kam mají zprávy chodit (nebo ho nejdřív vytvoř, třeba `#poker`).
2. Klikni u kanálu na ozubené kolečko **Upravit kanál** → **Integrace** → **Webhooky** → **Nový webhook**.
3. Pojmenuj ho (třeba KoronaBar) a případně nahraj ikonu. To je jméno, pod kterým zprávy přijdou.
4. Klikni na **Kopírovat URL webhooku**. Adresa vypadá jako `https://discord.com/api/webhooks/číslo/dlouhý-text`. **Je to heslo ke kanálu**: kdo ji má, může do kanálu psát. Nikam ji nevkládej veřejně.

### 2. Vlož adresu do herny
1. Přihlas se jako hlavní správce → **Správa → Tajné údaje**.
2. U **Adresa Discord webhooku** vlož zkopírovanou adresu a ulož. Uloží se šifrovaně a už se nikdy nezobrazí celá (jen poslední znaky).

### 3. Zapni napojení
1. **Správa → Globální nastavení** → kategorie **Napojení ven**.
2. Zapni **Napojení ven** (hlavní vypínač) a **Discord**.
3. Událost vyber v **Správa → Napojení ven** (část Discord): zaškrtni jen to, co chceš v kanálu číst. Doporučuji začít střídmě: registrace a konec turnaje, konec večera. Velké pushování (každý all-in, chat) kanál rychle zaplaví.

### 4. Vyzkoušej
1. **Správa → Napojení ven** → u Discordu klikni **Poslat zkušební zprávu**.
2. V kanálu se objeví zpráva. Zobrazí-li se hláška "Adresa webhooku Discordu zatím není zadaná", vrať se ke kroku 2.
3. Skutečné události uvidíš, jakmile nastanou (třeba otevři registraci turnaje). Doručení a případné chyby jsou v logu na stejné stránce.

### Když to nejde
- **Zkušební zpráva nedojde:** zkontroluj, že je zapnuté **Napojení ven** i **Discord** a že adresa není smazaná (v Discordu se webhook dá smazat). Chybová hláška je v logu doručení.
- **Změna kanálu:** vytvoř nový webhook a adresu v Tajných údajích přepiš.
- **Únik adresy:** v Discordu webhook smaž, vytvoř nový a vlož ho znovu. Starý přestane fungovat okamžitě.
- **Soukromí:** posílají se jen přezdívky a veřejné informace, nikdy cizí karty ani skrytá herní data. Zprávy jsou bez označení @všichni a bez pingů.

## Roční statistika („výdělek v roce“) a co se komu ukazuje

Každý hráč má ve **Statistikách → Rok** přehled za kalendářní rok: výdělek (turnaje, cash game, živý cash), součet výher a ztrát, žetony **nabité** a **strhnuté** správcem (pokladna), zůstatek 1. ledna a na konci roku, počet turnajů a cash hand a graf po měsících. Hráč vidí jen svoje čísla.

**Co se komu ukáže, nastavuješ ve Správa → Roční statistika:** tabulka zaškrtávátek, kde pro každý údaj zvlášť vybereš, zda je na **webu**, v **e-mailu** a v **API**. Změna platí hned.
- **E-mail:** hráč si souhrn pošle tlačítkem „Poslat souhrn e-mailem“. V **Nastavení → Statistiky** můžeš zapnout i **automatické rozeslání** v prvních dnech nového roku (každému jednou za uplynulý rok; hráč si ho může vypnout v osobním nastavení). Pravidla odesílání (komu a které druhy) platí stejná jako u ostatních e-mailů, text lze upravit ve Správa → E-maily (šablona „Roční souhrn výdělku“).
- **API:** osobní token s oprávněním „stats:read“ dostane na `/api/v1/stats/year?year=2026` jen údaje povolené pro API.
- **Vypnutí:** v Nastavení → Statistiky „Roční statistika zapnuta“ vypne všechno najednou (web, e-mail i API).

Do „nabito“ se počítá jen dobití, které hráči udělal správce v pokladně; počáteční vklad při registraci a dobíjení žetonů u stolu ne. Hranice roku se počítá v české časové zóně.

## Účet domu (herny): počáteční vklad a doplnění

Dům sbírá rake, poplatky a odvody turnajů i strženou měnu. Počáteční vklad nebo doplnění uděláš ve **Správa → Finance** u účtu herny: zadej částku a důvod a klikni na **Vložit do domu** (měna se nově vydá).

**Výdaje domu** (provoz, ceny pro vítěze, akce…) zapíšeš na stejném místě: vyber **kategorii**, částku a poznámku a klikni na **Zapsat výdaj**. Měna odejde z domu zpět do zásoby; dům nesmí jít do mínusu. Pod formulářem je přehled příjmů a výdajů podle kategorií **za tento měsíc a za tento rok** a seznam posledních výdajů. Kategorie si upravíš v Globálním nastavení → Ekonomika → Kategorie výdajů domu (výchozí: provoz, ceny, akce, ostatní).

Vše jde do účetní knihy a auditu a vyžaduje oprávnění „Ruční úprava knihy“. Mají ho **hlavní správce** (hned) a **pokladník** (jeho výdaj nebo vklad čeká na schválení, např. hlavním správcem v Správa → Schvalování; do přehledu a do knihy se zapíše až po schválení). Roli „Správce“ toto oprávnění ve výchozím stavu nemá; dá se přidat ve Správa → Role. Garance turnajů se doplácí z domu, co dům nepokryje, se vydá nově, takže vklad do domu není nutný.

### Více Discord kanálů (až čtyři)

Každý ze **čtyř kanálů** má vlastní webhook, název, vypínač a vlastní události, takže třeba turnaje půjdou do `#turnaje` a chat do `#hospoda`.

1. V Discordu vytvoř pro každý cílový kanál **vlastní webhook** (Upravit kanál → Integrace → Webhooky → Nový webhook → Kopírovat URL).
2. **Správa → Tajné údaje:** vlož adresy do položek „Adresa Discord webhooku (kanál 1)“ až „(kanál 4)“.
3. **Správa → Napojení ven:** u každého Discord kanálu pojmenuj kanál (jen pro tvůj přehled), zapni **Posílat do tohoto kanálu**, zaškrtni události a ulož.
4. Tlačítkem **Poslat zkušební zprávu** ověř každý kanál zvlášť. Log doručení ukazuje, do kterého kanálu zpráva šla.

Kanál bez adresy, nebo vypnutý, nic nedostane. Dříve nastavený jediný webhook je teď kanál 1.

## Převod Koron do jiné aplikace (žádost o výběr)

Korony jsou společná měna více vašich aplikací (her), proto si hráč může v **Peněžence** požádat o **převod do jiné aplikace**. Jde jen o záznam v účetní knize, **žádné platby ani směna za peníze**.

1. **Zapnutí:** Globální nastavení → Ekonomika → **Převody Koron do jiných aplikací** (ve výchozím stavu je vypnuto). Tamtéž vyplň **Cílové aplikace** (názvy oddělené čárkou, hráč jednu vybere) a nejmenší a největší částku jedné žádosti.
2. **Hráč:** v Peněžence → karta **Převod do jiné aplikace** vybere cíl a částku. Žádost nejde odeslat na víc, než kolik má, ani mimo povolený rozsah.
3. **Pokladník:** žádost vyřídí v Pokladně (stejný seznam jako žádosti o dobití, sloupec Druh říká „Převod do: …“). Schválení znovu ověří zůstatek. Korony se odepíšou z peněženky na účet „převod ven“ a zapíšou se do knihy (Druh „Převod do jiné aplikace“). Žádost si hráč nemůže schválit sám.
4. **Druhá aplikace:** dobití tam uděláte u ní ručně (pokladník ji dobije o stejnou částku). Aplikace spolu zatím nekomunikují automaticky.

## Výsledky turnajů s náklady a stavy účtů pro pokladníka

- **Výsledek turnaje** (okno po skončení, stránka turnaje i TV) ukazuje u každého hráče: buy-in, rebuye, add-ony (počet a částka včetně poplatků), zaplaceno celkem, výhru za umístění, bounty a **zisk = výhra + bounty − zaplaceno**. Dřív se u hotového turnaje ukazovala jen výhra za umístění, takže při rebuy mohli být vedle sebe dva „výherci“, i když oba měli v součtu ztrátu. Na TV je u každého hráče i zisk.
- **Pokladník** vidí ve Správa → Pokladna kartu **Stavy účtů hráčů**: zůstatek každého hráče, poslední pohyb, hledání podle přezdívky a součty (peněženky hráčů, účet domu).
- **Testy:** v `scenario-matrix.test.ts` a `tournament-deep.test.ts` se odehrávají turnaje s rebuy, add-onem, bounty (fixní, PKO, mystery), garancí a dohodou (ICM, podle žetonů, rovným dílem), včetně dvou hráčů a živého turnaje. U každého se kontroluje, že kniha je vyrovnaná, přehled sedí s peněženkami a součet zisků hráčů nikdy není kladný (zisky hráčů jsou přesně úbytek domu a fondů).

**Export výsledků turnaje:** u hotového turnaje je na jeho stránce a v okně s výsledky odkaz **Stáhnout výsledky (CSV)**. Soubor (kódování UTF-8 s BOM, oddělovač středník, otevře se v Excelu) obsahuje u každého hráče místo, buy-in, rebuye a add-ony (počty a částky), zaplaceno celkem, výhru za umístění, bounty a zisk a nakonec řádek Celkem. Stáhnout ho může každý přihlášený hráč, který turnaj vidí (jde o stejná čísla jako na stránce turnaje).

**Řazení klikem na záhlaví** funguje i ve Správa → Finance (turnaje, fondy a výdaje domu), stejně jako v účetní knize.

**Pokladna: kniha s filtry a rozpad vydané měny.** Účetní kniha (Správa → Pokladna) se dá filtrovat podle druhu pohybu, hráče nebo účtu (včetně domu a zásoby měny), období, textu v poznámce a nejmenší částky, a řadit klikem na záhlaví (čas, druh, největší částka; druhým kliknutím se směr obrátí); zobrazí až 500 pohybů a u účtů ukazuje přezdívky místo identifikátorů. Tlačítko **Stáhnout (CSV)** uloží knihu se stejnými filtry a řazením (až 5000 pohybů, UTF-8 s BOM, středníky). Karta **Stavy účtů hráčů** má rozbalovací část **Kolik Koron se vydalo a kde je**: součet všech vydaných Koron se rozpadne na peněženky, dům, fondy, stoly, turnaje a převody ven a vypíše posledních 30 vydání (registrace, dobití, doplatek garance…) s příjemcem. Pokud součet peněženek a domu nesedí s tím, co jsi hráčům dal, najdeš tam, odkud se rozdíl vzal.

## AI asistent: úspora a bezplatný plán Gemini

Asistent je nastavený tak, aby s bezplatným plánem Gemini (nízké limity volání) vystačil:
- **Rychlý a hlavní model:** otázky na vysvětlení (kontexty Pravidla, Lobby, Stůl) běží na rychlém modelu `gemini-3.5-flash-lite` a bez nástrojů pro návrhy změn; návrhy změn a plánování na hlavním modelu `gemini-3.5-flash`. Vlastní modely nastavíš v Nastavení → Asistent (Model pro vysvětlování, Model pro plánování).
- **Nejdřív návod:** jednoduché otázky typu „co je straddle“ se zodpoví přímo z návodu **bez volání AI** (nestojí limit poskytovatele ani denní limity). Zopakuješ-li stejnou otázku, odpoví už model. Žádosti o změnu jdou vždy na model. Vypíná se volbou „Nejdřív odpovědět z návodu“.
- **Limit za minutu:** aplikace pošle nejvýš 8 volání modelu za minutu (bezplatný plán povoluje asi 10). Nad limit se dotaz hned odmítne hláškou „zkus za X s“, poskytovatel se nezahltí.
- **Celkový časový strop 90 s** na jednu otázku (místo násobků limitu jednoho volání). Vypršení času a vyčerpaný limit poskytovatele se už neopakují.
- **Kratší kontext:** historie 6 zpráv, nejvýš 4 kroky s nástroji, výsledky nástrojů zkrácené na 3000 znaků.
- **Spotřeba:** ve Správa → Asistent → Spotřeba je počet dotazů, tokenů a odpovědí z návodu bez AI; od 80 % denního limitu se ukáže upozornění (i v okně asistenta).
Všechny hodnoty se mění v Nastavení → Asistent.

**Změna modelu Gemini:** Starší modely Gemini 2.5 už nefungují, výchozí je proto `gemini-3.5-flash` (hlavní) a `gemini-3.5-flash-lite` (rychlý). Pokud jsi si název modelu dříve ukládal v Nastavení → Asistent, uložená hodnota má přednost: přepiš ji na `gemini-3.5-flash` (nebo smaž pomocí tlačítka pro výchozí hodnotu). Přesné názvy modelů a limity bezplatného plánu najdeš v dokumentaci Google AI Studio; po změně ověř tlačítkem „Vyzkoušet připojení“ ve Správa → Asistent.

## Logo aplikace

Ve **Správa → Logo aplikace** nahraješ obrázek loga (PNG, JPG, WebP nebo GIF; SVG se z bezpečnostních důvodů nepřijímá, nejlépe PNG s průhledným pozadím na šířku). Logo je hlavním prvkem aplikace:
- v **hlavičce** vlevo (po klepnutí vede na hlavní stránku),
- na **přihlašovací a registrační stránce** (větší),
- jako **ikona záložky** prohlížeče.

Můžeš nastavit, zda se vedle loga ukáže i název aplikace, a velikost loga (40 až 400 %). Tlačítkem Odebrat logo se vrátí text. Logo je veřejné (musí být vidět i před přihlášením), nahrávat ho smí jen správce nastavení. Hodnoty jsou také v Nastavení → Vzhled a motivy.

**Tmavý režim a přihlašovací stránka.** Ve Správa → Logo aplikace můžeš nahrát i **samostatné logo pro tmavý režim**; bez něj se v tmavém režimu běžné logo položí na světlý podklad (jde vypnout), aby tmavé logo nezmizelo. Na užších obrazovkách se vedle loga neukazuje název, aby hlavička zbytečně nezabírala místo. **Pozadí přihlašovací stránky** se volí: plstěný stůl v barvách vybraného motivu (výchozí), jednobarevné, nebo vlastní obrázek; značka na ní leží na podkladu karty, takže je čitelná na jakémkoli pozadí.
