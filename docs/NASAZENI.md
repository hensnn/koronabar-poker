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
