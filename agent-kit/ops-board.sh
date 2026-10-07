#!/usr/bin/env bash
# Your Claude's way to post to your Ops board (dashboard.barnyard.site/ops.html).
#
# Sends your updates to the board's API with your agent key, read from a file on
# this computer (default ~/.claude/ops-board-token). The key is never printed or
# logged by this script, and is not put on a command line. Every call changes
# the live board. Needs bash and curl (jq is used for tidy lists if you have it).
#
# Setup (once):
#   1. Make a key on the Ops board (Settings, then Agent access) and save it to
#      ~/.claude/ops-board-token (the board shows you the exact command).
#   2. Save this script as ~/.claude/ops-board.sh
#
# Use (in any folder):
#   source ~/.claude/ops-board.sh
#   ops_test                                       # checks the key works
#   ops_list                                       # open items with their ids
#   ops_add --title "..." --lane in_progress --category backend --targets "api,docs" --next "..." [--due 2026-10-09] [--owner you] [--priority high] [--details "..."] [--proposal]
#   ops_update it_xxxxxxxx --lane waiting --next "..." --note "why"     # any fields; --note adds to the log
#   ops_note it_xxxxxxxx "what just happened"
#   ops_done it_xxxxxxxx ["note"]
#   ops_reopen it_xxxxxxxx [lane] ["note"]
#   ops_export                                     # everything, for backup
#
# Lanes: in_progress soaking waiting backlog.   Owner: claude | you.
# Categories: backend frontend agent security infrastructure maintenance docs data other.
# Statuses: investigating building reviewing soaking monitoring watching decision_needed
#           scheduled planned idea deferred blocked (done and rejected are set by ops_done and your decisions).
#
# Overrides (optional environment variables):
#   OPS_BOARD_URL         default https://api.barnyard.site/ops
#   OPS_BOARD_TOKEN_FILE  default ~/.claude/ops-board-token

OPS_BOARD_URL="${OPS_BOARD_URL:-https://api.barnyard.site/ops}"
OPS_BOARD_URL="${OPS_BOARD_URL%/}"
OPS_BOARD_TOKEN_FILE="${OPS_BOARD_TOKEN_FILE:-$HOME/.claude/ops-board-token}"

_ops_token() {
  if [ ! -r "$OPS_BOARD_TOKEN_FILE" ]; then
    echo "No key file at $OPS_BOARD_TOKEN_FILE. Make a key on the Ops board (Settings, Agent access) and save it there." >&2
    return 1
  fi
  local t
  t="$(tr -d '[:space:]' < "$OPS_BOARD_TOKEN_FILE")"
  if [ "${#t}" -lt 20 ]; then echo "The key file looks empty or too short." >&2; return 1; fi
  printf '%s' "$t"
}

# JSON string escaping that works with the awk on macOS and Linux.
_ops_esc() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r");
    if (NR > 1) printf "\\n"; print }'
}

# "a, b ,c" -> ["a","b","c"]
_ops_array() {
  local out="" item rest="$1"
  while [ -n "$rest" ]; do
    item="${rest%%,*}"
    if [ "$item" = "$rest" ]; then rest=""; else rest="${rest#*,}"; fi
    item="$(printf '%s' "$item" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$item" ] && out="$out${out:+,}\"$(_ops_esc "$item")\""
  done
  printf '[%s]' "$out"
}

# _ops_call METHOD /path ['{"json":"body"}']  -> prints the response body; non-zero on an error status.
_ops_call() {
  local method="$1" path="$2" body="${3-}" tok out tmp="" status
  tok="$(_ops_token)" || return 1
  out="$(mktemp)"
  if [ -n "$body" ]; then tmp="$(mktemp)"; printf '%s' "$body" > "$tmp"; fi
  # The key goes to curl on stdin as a config line, not as an argument, so it never shows in a process list.
  if [ -n "$body" ]; then
    status="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS --max-time 30 -K - -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data-binary @"$tmp" "$OPS_BOARD_URL$path")"
  else
    status="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS --max-time 30 -K - -o "$out" -w '%{http_code}' -X "$method" "$OPS_BOARD_URL$path")"
  fi
  local rc=$?
  [ -n "$tmp" ] && rm -f "$tmp"
  if [ $rc -ne 0 ]; then rm -f "$out"; echo "Ops board $method $path failed (curl exit $rc)" >&2; return 1; fi
  case "$status" in
    2??) cat "$out"; rm -f "$out"; echo ;;
    *) echo "Ops board $method $path -> HTTP $status: $(cat "$out")" >&2; rm -f "$out"; return 1 ;;
  esac
}

ops_test() {
  local me board
  me="$(_ops_call GET /me)" || return 1
  board="$(_ops_call GET /board)" || return 1
  if command -v jq >/dev/null 2>&1; then
    echo "Connected to your Ops board: $(printf '%s' "$board" | jq '.items | length') open items."
  else
    echo "Connected to your Ops board."
  fi
}

ops_list() {
  local board
  board="$(_ops_call GET /board)" || return 1
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$board" | jq -r '.items | sort_by(.lane, .addedAt)[] | [.id, .lane, .status, .owner, .due, .title] | @tsv'
  else
    printf '%s\n' "$board"
  fi
}

ops_add() {
  local title="" lane="" status="" category="" owner="" priority="" due="" targets="" next="" details="" proposal=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="$2"; shift 2 ;; --lane) lane="$2"; shift 2 ;; --status) status="$2"; shift 2 ;;
      --category) category="$2"; shift 2 ;; --owner) owner="$2"; shift 2 ;; --priority) priority="$2"; shift 2 ;;
      --due) due="$2"; shift 2 ;; --targets) targets="$2"; shift 2 ;; --next) next="$2"; shift 2 ;;
      --details) details="$2"; shift 2 ;; --proposal) proposal=1; shift ;;
      *) echo "ops_add: unknown option $1" >&2; return 2 ;;
    esac
  done
  [ -n "$title" ] || { echo "ops_add: --title is required" >&2; return 2; }
  local body="{\"title\":\"$(_ops_esc "$title")\""
  [ -n "$lane" ] && body="$body,\"lane\":\"$(_ops_esc "$lane")\""
  [ -n "$status" ] && body="$body,\"status\":\"$(_ops_esc "$status")\""
  [ -n "$category" ] && body="$body,\"category\":\"$(_ops_esc "$category")\""
  [ -n "$owner" ] && body="$body,\"owner\":\"$(_ops_esc "$owner")\""
  [ -n "$priority" ] && body="$body,\"priority\":\"$(_ops_esc "$priority")\""
  [ -n "$due" ] && body="$body,\"due\":\"$(_ops_esc "$due")\""
  [ -n "$targets" ] && body="$body,\"targets\":$(_ops_array "$targets")"
  [ -n "$next" ] && body="$body,\"next\":\"$(_ops_esc "$next")\""
  [ -n "$details" ] && body="$body,\"details\":\"$(_ops_esc "$details")\""
  [ -n "$proposal" ] && body="$body,\"proposal\":true"
  body="$body}"
  _ops_call POST /items "$body"
}

ops_update() {
  local id="${1-}"
  [ -n "$id" ] || { echo "ops_update: item id required" >&2; return 2; }
  shift
  local body="" key
  while [ $# -gt 0 ]; do
    case "$1" in
      --title|--lane|--status|--category|--owner|--priority|--due|--next|--details|--note)
        key="${1#--}"; body="$body${body:+,}\"$key\":\"$(_ops_esc "$2")\""; shift 2 ;;     # pass "" to clear --due
      --targets) body="$body${body:+,}\"targets\":$(_ops_array "$2")"; shift 2 ;;
      *) echo "ops_update: unknown option $1" >&2; return 2 ;;
    esac
  done
  _ops_call PATCH "/items/$id" "{$body}"
}

ops_note() {
  [ -n "${1-}" ] && [ -n "${2-}" ] || { echo "usage: ops_note it_xxxxxxxx \"text\"" >&2; return 2; }
  _ops_call POST "/items/$1/note" "{\"note\":\"$(_ops_esc "$2")\"}"
}

ops_done() {
  [ -n "${1-}" ] || { echo "usage: ops_done it_xxxxxxxx [\"note\"]" >&2; return 2; }
  if [ -n "${2-}" ]; then _ops_call POST "/items/$1/finish" "{\"note\":\"$(_ops_esc "$2")\"}"; else _ops_call POST "/items/$1/finish" "{}"; fi
}

ops_reopen() {
  [ -n "${1-}" ] || { echo "usage: ops_reopen it_xxxxxxxx [lane] [\"note\"]" >&2; return 2; }
  local body="{\"lane\":\"$(_ops_esc "${2:-backlog}")\""
  [ -n "${3-}" ] && body="$body,\"note\":\"$(_ops_esc "$3")\""
  _ops_call POST "/items/$1/reopen" "$body}"
}

ops_export() { _ops_call GET /export; }
