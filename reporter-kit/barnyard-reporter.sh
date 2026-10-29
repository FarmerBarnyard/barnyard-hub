#!/bin/sh
# barnyard-reporter: one small report from this server to the Barnyard Worker, once a minute (systemd timer).
#
#   barnyard-reporter            collect, then POST to the Worker (exit 0 = accepted)
#   barnyard-reporter --dry-run  collect and PRINT the report; send nothing, needs no key (the self-test)
#
# What it sends (ClaudeRepo cloudflare-worker/src/monitor-reporters.js normalizeReport is the other half of this contract):
# the server's own name, load, memory used %, disk used % for the mounts you list, uptime, whether the services you list
# are active, and whether the other servers you list can be reached from here (so the servers report on each other).
# It sends nothing else: no file names, no process list, no addresses of this machine.
#
# Settings come from the environment, normally the root-only file /etc/barnyard-reporter/env (see env.example):
#   BR_SERVER    app02 | cld01 | vtt | <name>   which server this is (the key is tied to one); <name> is the lower-case name your own Monitoring page gives a server
#   BR_KEY       mr_<id>_<secret>          made in the hub's Monitoring page, shown once
#   BR_URL       https://api.barnyard.site/mon/report
#   BR_DISKS     "/ /data"                 mount points to report (default "/")
#   BR_SERVICES  "cloudflared docker"      systemd units to report as running or not (default none)
#   BR_PEERS     "vtt=https://vtt.barnyard.site/ cld01=tcp:203.0.113.10:22"   other servers to try to reach from here
#   BR_INTERVAL  60                        seconds between runs, 30 to 300 (must match the timer)
#   BR_TIMEOUT   8                         seconds to wait for each peer
# Test hooks (never needed on a real server): BR_PROC, BR_DF_FILE, BR_SYSTEMCTL, BR_CURL, BR_NC, BR_CONF.
#
# POSIX sh and standard tools only (awk, grep, df, curl, and nc for tcp peers). The key goes to curl on its standard input,
# never on a command line, so it does not show in `ps`.

VERSION="1.0"
LC_ALL=C; export LC_ALL
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; export PATH
umask 077
set -u
set -f                       # no filename expansion of the lists below

fail() { echo "barnyard-reporter: $1" >&2; exit "${2:-1}"; }
num() { case "$1" in ''|*[!0-9.]*|.*|*.*.*) return 1 ;; esac; return 0; }

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) fail "usage: barnyard-reporter [--dry-run]" ;;
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
URL="${BR_URL:-https://api.barnyard.site/mon/report}"
case "$URL" in https://*|http://127.0.0.1*|http://localhost*) ;; *) fail "BR_URL must be an https address" ;; esac
KEY="${BR_KEY:-}"
if [ "$DRY" = 0 ]; then
  [ -n "$KEY" ] || fail "BR_KEY is not set (make a key in the Monitoring page and put it in the env file)"
  printf '%s' "$KEY" | grep -Eq '^mr_[a-f0-9]{12}_[A-Za-z0-9_-]{32}$' || fail "BR_KEY does not look like a reporter key"
fi
INTERVAL="${BR_INTERVAL:-60}"
if num "$INTERVAL" && [ "${INTERVAL%%.*}" -ge 30 ] && [ "${INTERVAL%%.*}" -le 300 ]; then INTERVAL="${INTERVAL%%.*}"; else INTERVAL=60; fi
TIMEOUT="${BR_TIMEOUT:-8}"
num "$TIMEOUT" || TIMEOUT=8
TIMEOUT="${TIMEOUT%%.*}"; [ "${TIMEOUT:-0}" -ge 1 ] 2>/dev/null || TIMEOUT=8
CURL="${BR_CURL:-curl}"
SYSTEMCTL="${BR_SYSTEMCTL:-systemctl}"
NC="${BR_NC:-nc}"
PROC="${BR_PROC:-/proc}"

# ---- load ---------------------------------------------------------------------------------------
LOAD_JSON=null
if [ -r "$PROC/loadavg" ]; then
  read -r L1 _rest < "$PROC/loadavg"
  CORES=$(grep -c '^processor' "$PROC/cpuinfo" 2>/dev/null || true)
  case "${CORES:-}" in ''|*[!0-9]*|0) CORES=$(nproc 2>/dev/null || echo 1) ;; esac
  num "${L1:-}" && LOAD_JSON="{\"l1\":$L1,\"cores\":$CORES}"
fi

# ---- memory used, as a percent of the total -----------------------------------------------------
MEM_JSON=null
if [ -r "$PROC/meminfo" ]; then
  MEM_JSON=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t > 0 && a != "") printf "{\"usedPct\":%.1f}", (t - a) * 100 / t; else print "null" }' "$PROC/meminfo")
fi

# ---- disks --------------------------------------------------------------------------------------
if [ -n "${BR_DF_FILE:-}" ]; then DF_OUT=$(cat "$BR_DF_FILE"); else DF_OUT=$(df -P 2>/dev/null || true); fi
DISKS_JSON=""; n=0
for m in ${BR_DISKS:-/}; do
  case "$m" in ''|*[!A-Za-z0-9_./@:-]*) continue ;; esac
  [ "$n" -lt 6 ] || break
  pct=$(printf '%s\n' "$DF_OUT" | awk -v m="$m" '$6 == m { gsub("%", "", $5); print $5; exit }')
  num "$pct" || continue
  DISKS_JSON="$DISKS_JSON${DISKS_JSON:+,}{\"mount\":\"$m\",\"usedPct\":$pct}"
  n=$((n + 1))
done

# ---- uptime -------------------------------------------------------------------------------------
UP_JSON=null
if [ -r "$PROC/uptime" ]; then
  read -r UP _rest < "$PROC/uptime"
  UP="${UP%%.*}"
  num "$UP" && UP_JSON="$UP"
fi

# ---- services ------------------------------------------------------------------------------------
SERVICES_JSON=""; n=0
for s in ${BR_SERVICES:-}; do
  case "$s" in ''|*[!A-Za-z0-9_.@-]*) continue ;; esac
  [ "$n" -lt 12 ] || break
  # systemctl is-active exits 0 when the unit is running, 3 when it is not and 4 when there is no such unit. Anything else
  # (1 when it cannot talk to systemd, 127 when there is no systemctl) means "I could not tell": the service is left out of
  # the report, never reported as down, so a broken check cannot raise a false outage.
  $SYSTEMCTL is-active --quiet "$s" >/dev/null 2>&1; rc=$?
  case "$rc" in
    0) up=true ;;
    3|4) up=false ;;
    *) echo "barnyard-reporter: could not read the state of $s (systemctl exit $rc); leaving it out of the report" >&2; continue ;;
  esac
  SERVICES_JSON="$SERVICES_JSON${SERVICES_JSON:+,}{\"name\":\"$s\",\"up\":$up}"
  n=$((n + 1))
done

# ---- the other servers, as seen from here -------------------------------------------------------
PEERS_JSON=""; n=0
for p in ${BR_PEERS:-}; do
  id="${p%%=*}"; target="${p#*=}"
  case "$id" in app02|cld01|vtt) ;; *) continue ;; esac
  [ "$id" != "$SERVER" ] || continue
  [ "$n" -lt 6 ] || break
  ok=null; ms=null
  case "$target" in
    http://*|https://*)
      out=$($CURL -s -o /dev/null -m "$TIMEOUT" -w '%{http_code} %{time_total}' "$target" 2>/dev/null || true)
      code="${out%% *}"; secs="${out#* }"
      case "$code" in
        [0-9][0-9][0-9]) if [ "$code" -ge 100 ] && [ "$code" -lt 500 ]; then ok=true; else ok=false; fi ;;
        *) ok=false ;;
      esac
      if num "$secs"; then ms=$(awk -v s="$secs" 'BEGIN { printf "%d", s * 1000 }'); fi
      ;;
    tcp:*)
      hp="${target#tcp:}"; host="${hp%:*}"; port="${hp##*:}"
      case "$host" in ''|*[!A-Za-z0-9.-]*) continue ;; esac
      case "$port" in ''|*[!0-9]*) continue ;; esac
      if command -v "$NC" >/dev/null 2>&1; then
        if $NC -z -w "$TIMEOUT" "$host" "$port" >/dev/null 2>&1; then ok=true; else ok=false; fi
      fi
      ;;
    *) continue ;;
  esac
  PEERS_JSON="$PEERS_JSON${PEERS_JSON:+,}{\"id\":\"$id\",\"ok\":$ok,\"ms\":$ms}"
  n=$((n + 1))
done

BODY=$(printf '{"server":"%s","interval":%s,"version":"%s","load":%s,"mem":%s,"disks":[%s],"uptime":%s,"services":[%s],"peers":[%s]}' \
  "$SERVER" "$INTERVAL" "$VERSION" "$LOAD_JSON" "$MEM_JSON" "$DISKS_JSON" "$UP_JSON" "$SERVICES_JSON" "$PEERS_JSON")

if [ "$DRY" = 1 ]; then
  printf '%s\n' "$BODY"
  echo "barnyard-reporter: dry run, nothing was sent" >&2
  exit 0
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/barnyard-reporter.XXXXXX") || fail "could not make a temporary file" 2
trap 'rm -f "$TMP"' EXIT INT TERM
printf '%s' "$BODY" > "$TMP"
code=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | $CURL -sS -m 20 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$TMP" -K - "$URL" 2>/dev/null || true)
case "$code" in
  200) echo "barnyard-reporter: reported ($SERVER)"; exit 0 ;;
  401) fail "the Worker refused the key (revoked, expired or wrong): make a new key in the Monitoring page" 2 ;;
  429) echo "barnyard-reporter: reported too soon, will try again next time"; exit 0 ;;
  *) fail "the report was not accepted (HTTP ${code:-none})" 2 ;;
esac
