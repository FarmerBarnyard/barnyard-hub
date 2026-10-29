#!/bin/sh
# Installs (or removes) the Barnyard reporter on this server. Run as root from this folder:
#
#   sudo sh install.sh              install the script and the systemd timer; make the env file if there is none
#   sudo sh install.sh --uninstall  stop and remove them (the env file, which holds the key, is left alone)
#
# It installs two small programs: the reporter (a report a minute) and the inventory (a list of installed software, once a
# day between 02:00 and 04:00). Running it again over an older install upgrades it and keeps the env file.
# After the first run, edit /etc/barnyard-reporter/env (BR_SERVER and BR_KEY at least), check what it would send with
#   sudo barnyard-reporter --dry-run      and      sudo barnyard-inventory --dry-run
# and run this script again: it starts the timer once the env file has a key. Nothing is installed anywhere else, nothing is
# downloaded, and the service runs as the unprivileged user nobody (with the group nogroup, or nobody where that is its name).
#
# Running it again on a server that already has the reporter UPGRADES it: the script and both units are replaced, systemd
# is reloaded and the timer is restarted (the env file and its key are never touched).

set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=/usr/local/bin/barnyard-reporter
INV_BIN=/usr/local/bin/barnyard-inventory
UNITS=/etc/systemd/system
ENVDIR=/etc/barnyard-reporter
ENVFILE=$ENVDIR/env

[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo sh install.sh)." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "This needs systemd." >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now barnyard-reporter.timer 2>/dev/null || true
  systemctl disable --now barnyard-inventory.timer 2>/dev/null || true
  rm -f "$UNITS/barnyard-reporter.service" "$UNITS/barnyard-reporter.timer" "$BIN"
  rm -f "$UNITS/barnyard-inventory.service" "$UNITS/barnyard-inventory.timer" "$INV_BIN"
  rm -rf "$UNITS/barnyard-inventory.service.d"
  systemctl daemon-reload
  echo "Removed. $ENVFILE (it holds the key) was left in place; delete it yourself, and revoke the key in the Monitoring page."
  exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "curl is needed (apt install curl)." >&2; exit 1; }
command -v awk >/dev/null 2>&1 || { echo "awk is needed." >&2; exit 1; }

install -m 0755 "$HERE/barnyard-reporter.sh" "$BIN"
# The unit runs as the fixed user nobody. Its group is nogroup on Debian and Ubuntu and nobody on Red Hat family systems.
id nobody >/dev/null 2>&1 || { echo "The user nobody does not exist on this machine, so the reporter cannot be installed." >&2; exit 1; }
if getent group nogroup >/dev/null 2>&1; then GRP=nogroup; elif getent group nobody >/dev/null 2>&1; then GRP=nobody; else GRP=""; fi
install -m 0644 "$HERE/barnyard-reporter.service" "$UNITS/barnyard-reporter.service"
if [ -n "$GRP" ]; then
  sed -i "s/^Group=.*/Group=$GRP/" "$UNITS/barnyard-reporter.service"
else
  sed -i "/^Group=/d" "$UNITS/barnyard-reporter.service"
fi
install -m 0644 "$HERE/barnyard-reporter.timer" "$UNITS/barnyard-reporter.timer"
# The daily inventory (new in reporter 1.1): installing again over an older install adds it, and installing again over this
# one changes nothing that was already there.
install -m 0755 "$HERE/barnyard-inventory.sh" "$INV_BIN"
install -m 0644 "$HERE/barnyard-inventory.service" "$UNITS/barnyard-inventory.service"
if [ -n "$GRP" ]; then
  sed -i "s/^Group=.*/Group=$GRP/" "$UNITS/barnyard-inventory.service"
else
  sed -i "/^Group=/d" "$UNITS/barnyard-inventory.service"
fi
install -m 0644 "$HERE/barnyard-inventory.timer" "$UNITS/barnyard-inventory.timer"
mkdir -p "$ENVDIR"
chmod 0700 "$ENVDIR"
if [ ! -f "$ENVFILE" ]; then
  install -m 0600 "$HERE/env.example" "$ENVFILE"
  echo "Made $ENVFILE. Edit it (BR_SERVER and BR_KEY), then run this script again."
fi
chmod 0600 "$ENVFILE"

# Docker access for the inventory is opt-in (BR_INVENTORY_DOCKER=1): the docker group can control Docker, so it is only added
# when you ask for it and the group exists. Otherwise containers are not listed.
DROPIN="$UNITS/barnyard-inventory.service.d"
want_docker=$(sed -n 's/^BR_INVENTORY_DOCKER=//p' "$ENVFILE" | tr -d ' "'"'" | head -n 1)
if [ "$want_docker" = "1" ] && getent group docker >/dev/null 2>&1; then
  mkdir -p "$DROPIN"
  printf '[Service]\nSupplementaryGroups=docker\n' > "$DROPIN/docker.conf"
  chmod 0644 "$DROPIN/docker.conf"
else
  rm -rf "$DROPIN"
fi
systemctl daemon-reload

key=$(sed -n 's/^BR_KEY=//p' "$ENVFILE" | tr -d ' "'"'" | head -n 1)
server=$(sed -n 's/^BR_SERVER=//p' "$ENVFILE" | tr -d ' "'"'" | head -n 1)
if [ -n "$key" ] && [ -n "$server" ]; then
  systemctl enable --now barnyard-reporter.timer
  inv_was_on=no
  systemctl is-enabled --quiet barnyard-inventory.timer 2>/dev/null && inv_was_on=yes
  systemctl enable --now barnyard-inventory.timer
  # the very first time, send an inventory now rather than waiting for tonight (a second install later does not)
  if [ "$inv_was_on" = "no" ]; then systemctl start --no-block barnyard-inventory.service || true; fi
  systemctl restart barnyard-reporter.timer
  echo "Started. Check it: systemctl status barnyard-reporter.timer; journalctl -u barnyard-reporter -n 5"
  echo "In the Monitoring page the reporter should show as reporting within two minutes."
  echo "The daily inventory runs between 02:00 and 04:00 (and once now the first time): journalctl -u barnyard-inventory -n 5"
else
  echo "Not started yet: BR_SERVER or BR_KEY is empty in $ENVFILE."
fi
