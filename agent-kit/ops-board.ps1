<#
.SYNOPSIS
  Your Claude's way to post to your Ops board (dashboard.barnyard.site/ops.html).

.DESCRIPTION
  Sends your updates to the board's API with your agent key, which is read from
  a file on this computer (default ~/.claude/ops-board-token). The key is never
  printed or logged by this script. Every call changes the live board.

  Setup (once):
    1. Make a key on the Ops board (Settings, then Agent access) and save it to
       ~/.claude/ops-board-token (the board shows you the exact command).
    2. Save this script as ~/.claude/ops-board.ps1.

  Use (from PowerShell, in any folder):
    . ~/.claude/ops-board.ps1
    Ops-Test                                     # checks the key works and shows your board
    Ops-List                                     # open items with their ids
    Ops-Add  -Title "..." -Lane in_progress -Category backend -Targets "api","docs" -Next "..." [-Due 2026-10-09] [-Owner you] [-Priority high] [-Proposal]
    Ops-Update -Id it_xxxxxxxx -Lane waiting -Next "..." -Note "why"      # any fields; -Note adds to the log
    Ops-Note -Id it_xxxxxxxx -Text "what just happened"
    Ops-Done -Id it_xxxxxxxx [-Note "..."]
    Ops-Reopen -Id it_xxxxxxxx -Lane backlog
    Ops-Export                                   # everything, for backup

  Lanes: in_progress soaking waiting backlog.   Owner: claude | you.
  Categories: backend frontend agent security infrastructure maintenance docs data other.
  Statuses: investigating building reviewing soaking monitoring watching decision_needed
            scheduled planned idea deferred blocked (done and rejected are set by Ops-Done and your decisions).

  Overrides (optional environment variables):
    OPS_BOARD_URL         default https://api.barnyard.site/ops
    OPS_BOARD_TOKEN_FILE  default ~/.claude/ops-board-token
#>

$script:OpsBase = if ($env:OPS_BOARD_URL) { $env:OPS_BOARD_URL.TrimEnd("/") } else { "https://api.barnyard.site/ops" }
# The key goes in an Authorization header on every call, so never send it over plain
# http. (localhost is allowed for testing a board running on your own computer.)
if ($script:OpsBase -notmatch '^https://' -and $script:OpsBase -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?(/|$)') {
  throw "OPS_BOARD_URL must start with https:// (got '$script:OpsBase'). The helper will not send your key over an unencrypted connection."
}
$script:OpsTokenFile = if ($env:OPS_BOARD_TOKEN_FILE) { $env:OPS_BOARD_TOKEN_FILE } else { Join-Path $HOME ".claude/ops-board-token" }

function Get-OpsToken {
  if (-not (Test-Path $script:OpsTokenFile)) { throw "No key file at $script:OpsTokenFile. Make a key on the Ops board (Settings, Agent access) and save it there." }
  $t = (Get-Content -Raw $script:OpsTokenFile).Trim()
  if ($t.Length -lt 20) { throw "The key file looks empty or too short." }
  return $t
}

function Invoke-Ops {
  param([string]$Method, [string]$Path, $Body)
  $headers = @{ Authorization = "Bearer $(Get-OpsToken)" }
  $params = @{ Uri = "$script:OpsBase$Path"; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)   # bytes, so non-ASCII text is not mangled
    $params.ContentType = "application/json; charset=utf-8"
  }
  try {
    $res = Invoke-WebRequest @params
    return ($res.Content | ConvertFrom-Json)
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
      throw "Ops board $Method $Path -> HTTP $([int]$resp.StatusCode): $text"
    }
    throw "Ops board $Method $Path failed: $($_.Exception.Message)"
  }
}

function Ops-Test {
  $me = Invoke-Ops GET "/me"
  $board = Invoke-Ops GET "/board"
  Write-Output "Connected to your Ops board: $(@($board.items).Count) open items (hasBoard=$($me.hasBoard))."
}

function Ops-List {
  $board = Invoke-Ops GET "/board"
  $board.items | Sort-Object lane, addedAt | ForEach-Object {
    [pscustomobject]@{ Id = $_.id; Lane = $_.lane; Status = $_.status; Owner = $_.owner; Due = $_.due; Title = $_.title; Proposal = $_.proposal }
  } | Format-Table -AutoSize
}

function Ops-Add {
  param(
    [Parameter(Mandatory)][string]$Title, [string]$Lane, [string]$Status, [string]$Category, [string]$Owner, [string]$Priority,
    [string]$Due, [string[]]$Targets, [string]$Next, [string]$Details, [switch]$Proposal
  )
  $b = [ordered]@{ title = $Title }
  if ($Lane) { $b.lane = $Lane }; if ($Status) { $b.status = $Status }; if ($Category) { $b.category = $Category }
  if ($Owner) { $b.owner = $Owner }; if ($Priority) { $b.priority = $Priority }; if ($Due) { $b.due = $Due }
  if ($Targets) { $b.targets = @($Targets) }; if ($Next) { $b.next = $Next }; if ($Details) { $b.details = $Details }
  if ($Proposal) { $b.proposal = $true }
  $r = Invoke-Ops POST "/items" $b
  Write-Output "$($r.item.id)  $($r.item.lane)/$($r.item.status)  $($r.item.title)"
}

function Ops-Update {
  param(
    [Parameter(Mandatory)][string]$Id, [string]$Title, [string]$Lane, [string]$Status, [string]$Category, [string]$Owner,
    [string]$Priority, [string]$Due, [string[]]$Targets, [string]$Next, [string]$Details, [string]$Note
  )
  $b = [ordered]@{}
  if ($PSBoundParameters.ContainsKey("Title")) { $b.title = $Title }
  if ($PSBoundParameters.ContainsKey("Lane")) { $b.lane = $Lane }
  if ($PSBoundParameters.ContainsKey("Status")) { $b.status = $Status }
  if ($PSBoundParameters.ContainsKey("Category")) { $b.category = $Category }
  if ($PSBoundParameters.ContainsKey("Owner")) { $b.owner = $Owner }
  if ($PSBoundParameters.ContainsKey("Priority")) { $b.priority = $Priority }
  if ($PSBoundParameters.ContainsKey("Due")) { $b.due = $Due }          # pass "" to clear
  if ($PSBoundParameters.ContainsKey("Targets")) { $b.targets = @($Targets) }
  if ($PSBoundParameters.ContainsKey("Next")) { $b.next = $Next }
  if ($PSBoundParameters.ContainsKey("Details")) { $b.details = $Details }
  if ($PSBoundParameters.ContainsKey("Note")) { $b.note = $Note }
  $r = Invoke-Ops PATCH "/items/$Id" $b
  if ($r.unchanged) { Write-Output "$Id unchanged" } else { Write-Output "$($r.item.id)  $($r.item.lane)/$($r.item.status)  $($r.item.title)" }
}

function Ops-Note {
  param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Text)
  $r = Invoke-Ops POST "/items/$Id/note" @{ note = $Text }
  Write-Output "noted on $($r.item.id)"
}

function Ops-Done {
  param([Parameter(Mandatory)][string]$Id, [string]$Note)
  $b = @{}; if ($Note) { $b.note = $Note }
  $r = Invoke-Ops POST "/items/$Id/finish" $b
  Write-Output "$($r.item.id) done  $($r.item.title)"
}

function Ops-Reopen {
  param([Parameter(Mandatory)][string]$Id, [string]$Lane = "backlog", [string]$Note)
  $b = @{ lane = $Lane }; if ($Note) { $b.note = $Note }
  $r = Invoke-Ops POST "/items/$Id/reopen" $b
  Write-Output "$($r.item.id)  $($r.item.lane)/$($r.item.status)  $($r.item.title)"
}

function Ops-Export { Invoke-Ops GET "/export" }
