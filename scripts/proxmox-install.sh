#!/usr/bin/env bash
# KoronaBar Poker: instalace do nového LXC kontejneru na hostiteli Proxmoxu.
#
# Spuštění NA HOSTITELI PROXMOXU (jako root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/hensnn/koronabar-poker/main/scripts/proxmox-install.sh)
# nebo po stažení:  bash proxmox-install.sh
#
# Co udělá: stáhne šablonu Debian 12, vytvoří neprivilegovaný LXC s Nesting, nainstaluje v něm Docker,
# stáhne projekt, vygeneruje hesla a šifrovací klíč do .env, spustí aplikaci a vypíše údaje pro NPM.
# Nic se neposílá ven kromě stahování balíčků a projektu. Hodnoty jde změnit proměnnými prostředí, např.:
#   CTID=130 STORAGE=local-zfs BRIDGE=vmbr0 bash proxmox-install.sh
set -euo pipefail

CTID="${CTID:-120}"
HOSTNAME_CT="${HOSTNAME_CT:-poker}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP_CONF="${IP_CONF:-dhcp}"              # např. 192.168.1.50/24,gw=192.168.1.1
DISK_GB="${DISK_GB:-32}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-2048}"
SWAP_MB="${SWAP_MB:-512}"
REPO="${REPO:-https://github.com/hensnn/koronabar-poker.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/koronabar}"
PUBLIC_URL="${PUBLIC_URL:-}"           # např. https://poker.example.cz; prázdné = skript se zeptá
ADMIN_NICKNAME="${ADMIN_NICKNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"     # prázdné = vygeneruje se
ROOT_PASSWORD="${ROOT_PASSWORD:-}"       # heslo roota v kontejneru; prázdné = vygeneruje se
TZ_NAME="${TZ_NAME:-Europe/Prague}"
YES="${YES:-0}"                          # YES=1 = bez dotazu

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mCHYBA: %s\033[0m\n' "$*" >&2; exit 1; }
# LANG=C.UTF-8: v čerstvém kontejneru nejsou vygenerované locale a apt by vypisoval varování.
inct() { pct exec "$CTID" -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 bash -c "$*"; }
gen() { openssl rand -base64 "$1" | tr -d '/+=' | cut -c1-"$2"; }

[ "$(id -u)" = 0 ] || die "spusť jako root na hostiteli Proxmoxu"
command -v pct >/dev/null || die "příkaz pct nenalezen: tohle není hostitel Proxmoxu"
command -v openssl >/dev/null || die "chybí openssl"
pct status "$CTID" >/dev/null 2>&1 && die "kontejner $CTID už existuje; zvol jiné CTID=…"

if [ -z "$PUBLIC_URL" ]; then
  [ "$YES" != 1 ] || die "zadej PUBLIC_URL=https://tvoje.domena"
  read -r -p "Veřejná adresa aplikace (např. https://poker.example.cz): " PUBLIC_URL
fi
[[ "$PUBLIC_URL" =~ ^https?://[^/]+$ ]] || die "PUBLIC_URL musí být ve tvaru https://domena (bez lomítka na konci)"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(gen 24 20)}"
ROOT_PASSWORD="${ROOT_PASSWORD:-$(gen 24 20)}"
POSTGRES_PASSWORD="$(gen 36 32)"
MASTER_KEY="$(openssl rand -hex 32)"

cat <<EOF

KoronaBar Poker: instalace do LXC
  Kontejner:    $CTID ($HOSTNAME_CT), $CORES jádra, $MEMORY_MB MB RAM, disk $DISK_GB GB na $STORAGE, síť $BRIDGE ($IP_CONF)
  Projekt:      $REPO ($BRANCH) → $APP_DIR
  Veřejná adresa: $PUBLIC_URL
  Administrátor:  $ADMIN_NICKNAME
EOF
if [ "$YES" != 1 ]; then
  read -r -p "Pokračovat? [a/N] " ans
  [[ "$ans" =~ ^[aAyY]$ ]] || exit 0
fi

say "Šablona Debian 12"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard_' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "šablona debian-12-standard není v nabídce (pveam available)"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

say "Vytvářím kontejner $CTID"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_CT" --cores "$CORES" --memory "$MEMORY_MB" --swap "$SWAP_MB" \
  --rootfs "$STORAGE:$DISK_GB" --net0 "name=eth0,bridge=$BRIDGE,ip=$IP_CONF" \
  --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 --timezone "$TZ_NAME" \
  --password "$ROOT_PASSWORD" >/dev/null
pct start "$CTID"

say "Čekám na síť v kontejneru"
for _ in $(seq 1 60); do
  if inct "getent hosts deb.debian.org >/dev/null 2>&1"; then break; fi
  sleep 2
done
inct "getent hosts deb.debian.org >/dev/null" || die "kontejner nemá přístup na internet (DNS)"

say "Instaluji balíčky a Docker (několik minut)"
inct "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get -y -qq -o Dpkg::Use-Pty=0 upgrade >/dev/null && apt-get -y -qq -o Dpkg::Use-Pty=0 install curl git ca-certificates nano locales >/dev/null; sed -i -e 's/^# *cs_CZ.UTF-8/cs_CZ.UTF-8/' -e 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen >/dev/null"
inct "command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1"
inct "docker compose version >/dev/null" || die "Docker Compose v kontejneru nefunguje; zkontroluj Nesting"

say "Stahuji projekt"
inct "test -d '$APP_DIR/.git' || git clone -q --branch '$BRANCH' '$REPO' '$APP_DIR'"

say "Zapisuji .env"
ENV_TMP="$(mktemp)"
cat > "$ENV_TMP" <<EOF
# Vytvořeno instalačním skriptem $(date '+%Y-%m-%d %H:%M'). Hesla si ulož do správce hesel, MASTER_KEY zvlášť od záloh databáze.
PORT=3000
PUBLIC_URL=$PUBLIC_URL
TZ=$TZ_NAME
ALLOWED_ORIGINS=
POSTGRES_USER=koronabar
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=koronabar
ADMIN_NICKNAME=$ADMIN_NICKNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
MASTER_KEY=$MASTER_KEY
MASTER_KEY_VERSION=1
BACKUP_KEEP_DAYS=14
BACKUP_EVERY_HOURS=24
PIPER_VOICE=cs_CZ-jirka-medium
EOF
pct push "$CTID" "$ENV_TMP" "$APP_DIR/.env" --perms 0600 --user 0 --group 0
rm -f "$ENV_TMP"

say "Sestavuji a spouštím aplikaci (první sestavení trvá 5 až 10 minut)"
inct "cd '$APP_DIR' && docker compose up -d --build" 2>&1 | grep -vE '^\s*$' | tail -5 || true

say "Čekám, až bude aplikace zdravá"
ok=0
for _ in $(seq 1 60); do
  if inct "curl -fs http://localhost:3000/health >/dev/null 2>&1"; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { inct "cd '$APP_DIR' && docker compose ps && docker compose logs app --tail 40"; die "aplikace neodpovídá na /health; výpis výše pošli vývojáři"; }

CT_IP="$(inct "hostname -I | awk '{print \$1}'")"
cat <<EOF

$(printf '\033[1;32m')HOTOVO$(printf '\033[0m'): KoronaBar Poker běží v kontejneru $CTID na adrese http://$CT_IP:3000

Údaje (ulož je do správce hesel, znovu se nevypíší):
  root kontejneru:          $ROOT_PASSWORD
  hlavní administrátor:     $ADMIN_NICKNAME / $ADMIN_PASSWORD
  MASTER_KEY (zálohuj):     $MASTER_KEY
  soubor s nastavením:      $APP_DIR/.env (v kontejneru)

Teď v Nginx Proxy Manageru přidej Proxy Host:
  Domain Names: ${PUBLIC_URL#https://}   Scheme: http   Forward: $CT_IP port 3000
  Zapni Websockets Support a Block Common Exploits, na záložce SSL vyžádej certifikát Let's Encrypt a zapni Force SSL.
Potom otevři $PUBLIC_URL a přihlas se.

Do kontejneru se dostaneš příkazem: pct enter $CTID   (projekt je v $APP_DIR)
EOF
