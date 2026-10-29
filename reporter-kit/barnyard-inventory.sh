#!/bin/sh
# barnyard-inventory: the daily software inventory of this server, sent to the Barnyard Worker (systemd timer, once a day).
#
#   barnyard-inventory            collect, then POST to the Worker (exit 0 = accepted, or sent too recently)
#   barnyard-inventory --dry-run  collect and PRINT the inventory; send nothing, needs no key (the self-test)
#
# What it sends (ClaudeRepo cloudflare-worker/src/monitor-inventory.js normalizeInventory is the other half of this
# contract): the operating system's name and version, the kernel release, the architecture, the uptime, how many
# security updates are waiting (only if the package manager can say without the network), every installed package as a
# NAME and a VERSION, the image names and tags of running Docker containers (only if this user may ask Docker), and the
# versions of a short fixed list of programs (openssl ssh nginx caddy cloudflared docker node python3 php ollama).
# It never sends file contents, users, addresses, environment variables, mounts or ports, and it never runs apt update,
# apt upgrade or anything else that changes the machine.
#
# Settings come from the same file as the reporter, /etc/barnyard-reporter/env (see env.example):
#   BR_SERVER             app02 | cld01 | vtt | <name>   which server this is (the key is tied to one)
#   BR_KEY                mr_<id>_<secret>           the reporter's key
#   BR_INVENTORY_URL      https://api.barnyard.site/mon/inventory
# Test hooks (never needed on a real server): BR_CONF, BR_OS_RELEASE, BR_UNAME, BR_PROC, BR_DPKG, BR_RPM, BR_APK, BR_APT,
# BR_DOCKER, BR_TOOLS_DIR, BR_CURL.
#
# POSIX sh and standard tools only (awk, sed, tr, grep, curl). The key goes to curl on its standard input, never on a
# command line, so it does not show in `ps`.

VERSION="1.0"
LC_ALL=C; export LC_ALL
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; export PATH
umask 077
set -u
set -f

fail() { echo "barnyard-inventory: $1" >&2; exit "${2:-1}"; }
num() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; return 0; }
# Only characters that are safe to put between JSON quotes (no quote, no backslash, no control character).
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9 ._:+~()/@=,-' | cut -c1-"${2:-80}"; }
# Run a command for at most five seconds (when `timeout` exists).
tmo() { if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"; else "$@"; fi; }

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) fail "usage: barnyard-inventory [--dry-run]" ;;
esac

CONF="${BR_CONF:-/etc/barnyard-reporter/env}"
if [ -z "${BR_SERVER:-}" ] && [ -r "$CONF" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONF"
  set +a
fi

SERVER="${BR_SERVER:-}"
# (a case pattern, not grep: grep would match one line of a value that had a newline in it)
case "$SERVER" in
  app02|cld01|vtt) ;;
  ""|-*|*[!a-z0-9-]*) fail "BR_SERVER must be app02, cld01 or vtt, or the name your own Monitoring page gave this server (lower-case letters, digits and dashes)" ;;
  *) [ "${#SERVER}" -le 24 ] || fail "BR_SERVER must be app02, cld01 or vtt, or the name your own Monitoring page gave this server (24 characters at most)" ;;
esac
URL="${BR_INVENTORY_URL:-https://api.barnyard.site/mon/inventory}"
case "$URL" in https://*|http://127.0.0.1*|http://localhost*) ;; *) fail "BR_INVENTORY_URL must be an https address" ;; esac
KEY="${BR_KEY:-}"
if [ "$DRY" = 0 ]; then
  [ -n "$KEY" ] || fail "BR_KEY is not set (make a key in the Monitoring page and put it in the env file)"
  printf '%s' "$KEY" | grep -Eq '^mr_[a-f0-9]{12}_[A-Za-z0-9_-]{32}$' || fail "BR_KEY does not look like a reporter key"
fi
if [ "${BR_INVENTORY:-1}" = "0" ]; then echo "barnyard-inventory: switched off (BR_INVENTORY=0)"; exit 0; fi

CURL="${BR_CURL:-curl}"
UNAME="${BR_UNAME:-uname}"
PROC="${BR_PROC:-/proc}"
OSREL="${BR_OS_RELEASE:-/etc/os-release}"
DPKG="${BR_DPKG:-dpkg-query}"
RPM="${BR_RPM:-rpm}"
APK="${BR_APK:-apk}"
APT="${BR_APT:-apt}"
DOCKER="${BR_DOCKER:-docker}"
[ -z "${BR_TOOLS_DIR:-}" ] || PATH="$BR_TOOLS_DIR:$PATH"

# ---- operating system, kernel, architecture, uptime ------------------------------------------------
osval() { [ -r "$OSREL" ] || return 0; sed -n "s/^$1=//p" "$OSREL" | head -n 1 | tr -d '"'"'"; }
OS_ID=$(clean "$(osval ID)" 30)
OS_VER=$(clean "$(osval VERSION_ID)" 30)
OS_NAME=$(clean "$(osval PRETTY_NAME)" 80)
KERNEL=$(clean "$($UNAME -r 2>/dev/null || true)" 60)
ARCH=$(clean "$($UNAME -m 2>/dev/null || true)" 20)
UP_JSON=null
if [ -r "$PROC/uptime" ]; then
  read -r UP _rest < "$PROC/uptime"
  UP="${UP%%.*}"
  num "$UP" && UP_JSON="$UP"
fi

# ---- the installed packages: name and version only ------------------------------------------------------
PM="none"; PKGS=""
if command -v "$DPKG" >/dev/null 2>&1; then
  PM="dpkg"
  PKGS=$($DPKG -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\n' 2>/dev/null | awk -F'\t' '$1 ~ /^ii/ { print $2 "\t" $3 }' || true)
elif command -v "$RPM" >/dev/null 2>&1; then
  PM="rpm"
  PKGS=$($RPM -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n' 2>/dev/null || true)
elif command -v "$APK" >/dev/null 2>&1; then
  PM="apk"
  # apk info -v prints name-version-rN: the name is everything before the last two dashes
  PKGS=$($APK info -v 2>/dev/null | awk '{ n = split($0, a, "-"); if (n >= 3) { v = a[n-1] "-" a[n]; nm = a[1]; for (i = 2; i <= n - 2; i++) nm = nm "-" a[i]; print nm "\t" v } }' || true)
fi
PKGS_JSON=$(printf '%s\n' "$PKGS" | awk -F'\t' '
  NF >= 2 && $1 ~ /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/ && length($1) <= 80 && $2 ~ /^[A-Za-z0-9.+:~_-]+$/ && length($2) <= 80 && n < 3000 {
    printf "%s[\"%s\",\"%s\"]", (n++ ? "," : ""), $1, $2
  }')

# ---- security updates waiting (apt only, from the cache already on the machine; never apt update) -------------
PENDING_JSON=null
if [ "$PM" = "dpkg" ] && command -v "$APT" >/dev/null 2>&1; then
  APT_OUT=$(tmo "$APT" list --upgradable 2>/dev/null || true)
  if printf '%s\n' "$APT_OUT" | grep -q '^Listing'; then
    PENDING_JSON=$(printf '%s\n' "$APT_OUT" | grep -c -- '-security' || true)
    num "$PENDING_JSON" || PENDING_JSON=null
  fi
fi

# ---- running containers: image name and tag only ----------------------------------------------------------
DOCKER_STATE="absent"; CONT_JSON=""
if command -v "$DOCKER" >/dev/null 2>&1; then
  if IMAGES=$(tmo "$DOCKER" ps --format '{{.Image}}' 2>/dev/null); then
    DOCKER_STATE="ok"
    CONT_JSON=$(printf '%s\n' "$IMAGES" | sort -u | awk '
      { ref = $0; sub(/@sha256:.*$/, "", ref); tag = "latest"; slash = 0; colon = 0
        for (i = 1; i <= length(ref); i++) { c = substr(ref, i, 1); if (c == "/") slash = i; if (c == ":") colon = i }
        if (colon > slash) { tag = substr(ref, colon + 1); ref = substr(ref, 1, colon - 1) }
        if (ref ~ /^[A-Za-z0-9][A-Za-z0-9._\/:-]*$/ && length(ref) <= 120 && tag ~ /^[A-Za-z0-9._-]+$/ && length(tag) <= 60 && n < 40) {
          printf "%s{\"image\":\"%s\",\"tag\":\"%s\"}", (n++ ? "," : ""), ref, tag
        } }')
  else
    DOCKER_STATE="unavailable"
  fi
fi

# ---- the versions of a short list of programs (each asked once, for at most five seconds) -----------------
TOOLS_JSON=""; n=0
for t in openssl ssh nginx caddy cloudflared docker node python3 php ollama; do
  command -v "$t" >/dev/null 2>&1 || continue
  case "$t" in
    openssl) out=$(tmo openssl version 2>&1 | head -n 5) ;;
    ssh) out=$(tmo ssh -V 2>&1 | head -n 5) ;;
    nginx) out=$(tmo nginx -v 2>&1 | head -n 5) ;;
    caddy) out=$(tmo caddy version 2>&1 | head -n 5) ;;
    cloudflared) out=$(tmo cloudflared --version 2>&1 | head -n 5) ;;
    docker) out=$(tmo docker --version 2>&1 | head -n 5) ;;
    node) out=$(tmo node --version 2>&1 | head -n 5) ;;
    python3) out=$(tmo python3 --version 2>&1 | head -n 5) ;;
    php) out=$(tmo php --version 2>&1 | head -n 5) ;;
    ollama) out=$(tmo ollama --version 2>&1 | head -n 5) ;;
  esac
  v=$(printf '%s\n' "$out" | awk 'match($0, /[0-9]+(\.[0-9]+)+([a-z][0-9]*)?/) { print substr($0, RSTART, RLENGTH); exit }')
  case "$v" in ''|*[!A-Za-z0-9.]*) continue ;; esac
  TOOLS_JSON="$TOOLS_JSON${TOOLS_JSON:+,}{\"name\":\"$t\",\"version\":\"$v\"}"
  n=$((n + 1))
done

BODY=$(printf '{"server":"%s","version":"%s","os":{"id":"%s","version":"%s","name":"%s"},"kernel":"%s","arch":"%s","uptime":%s,"pkgManager":"%s","pendingSecurity":%s,"packages":[%s],"docker":"%s","containers":[%s],"tools":[%s]}' \
  "$SERVER" "$VERSION" "$OS_ID" "$OS_VER" "$OS_NAME" "$KERNEL" "$ARCH" "$UP_JSON" "$PM" "$PENDING_JSON" "$PKGS_JSON" "$DOCKER_STATE" "$CONT_JSON" "$TOOLS_JSON")

if [ "$DRY" = 1 ]; then
  printf '%s\n' "$BODY"
  echo "barnyard-inventory: dry run, nothing was sent" >&2
  exit 0
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/barnyard-inventory.XXXXXX") || fail "could not make a temporary file" 2
trap 'rm -f "$TMP"' EXIT INT TERM
printf '%s' "$BODY" > "$TMP"
SIZE=$(wc -c < "$TMP" | tr -d ' ')
[ "${SIZE:-0}" -le 200000 ] || fail "the inventory is too large to send ($SIZE bytes)" 2
code=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | $CURL -sS -m 60 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$TMP" -K - "$URL" 2>/dev/null || true)
case "$code" in
  200) echo "barnyard-inventory: sent ($SERVER, $PM)"; exit 0 ;;
  401) fail "the Worker refused the key (revoked, expired or wrong): make a new key in the Monitoring page" 2 ;;
  429) echo "barnyard-inventory: one was sent recently, will try again tomorrow"; exit 0 ;;
  404) fail "the Worker does not know the inventory address yet (is the Worker updated?)" 2 ;;
  *) fail "the inventory was not accepted (HTTP ${code:-none})" 2 ;;
esac
