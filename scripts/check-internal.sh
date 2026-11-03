#!/bin/bash
# Fails if the tracked tree or the commit history carries something that belongs to a private setup:
#   - private addresses (10/8, 172.16/12, 192.168/16) and shared address space (100.64/10);
#   - e-mail addresses other than noreply ones and reserved example domains (RFC 2606/6761);
#   - issue-tracker keys (capitals, a dash and digits) and `*.lan.*` host names;
#   - in the history, an author or committer whose e-mail is not a noreply address.
# A list of extra words (account ids, own domains) can be passed with --names <file>, one per line; that list is never committed.
#
#   scripts/check-internal.sh [--names <file>] [<git revision range>]   (default range: HEAD)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

nombres=""
if [ "${1:-}" = "--names" ]; then nombres="${2:?--names needs a file}"; shift 2; fi
# The history checked is exactly this range. In CI it is the commits of the pull request (base..head) or of the push (before..after):
# never the merge commit GitHub synthesizes for a pull_request event, which carries the account's own e-mail and never reaches main.
rango="${1:-HEAD}"
git rev-list --quiet "$rango" -- || { echo "::error::check-internal: not a valid revision range: $rango" >&2; exit 1; }

IP='\b(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.[0-9]{1,3}\.[0-9]{1,3}\b'
CLAVE='\b[[:upper:]][[:upper:][:digit:]]{1,9}-[[:digit:]]{1,6}\b'
TECNICO='\b(SHA|UTF|ISO|RFC|AES|TLS|HTTP|CVE|BSD|CC0|BY|EPL|GPL|LGPL|AGPL|MPL|OFL|CDDL|EUPL)-[[:digit:]]'
LAN='[a-z0-9-]+\.lan\.[a-z0-9-]+'
CORREO='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
PERMITIDO='noreply|@example\.(com|net|org)\b|\.(test|example|invalid|localhost)\b'

fallos=0
informa() { echo "::error::$1"; fallos=$((fallos + 1)); }

# ---- the tree
mapfile -t ficheros < <(git ls-files)
if [ "${#ficheros[@]}" -gt 0 ]; then
  while IFS= read -r l; do informa "$l (private address)"; done < <(grep -nHE "$IP" -- "${ficheros[@]}" || true)
  while IFS= read -r l; do informa "$l (issue key)"; done < <(grep -nHE "$CLAVE" -- "${ficheros[@]}" | grep -vE "$TECNICO" || true)
  while IFS= read -r l; do informa "$l (lan host)"; done < <(grep -nHE "$LAN" -- "${ficheros[@]}" || true)
  # package-lock.json (this folder's and paseo-plugin/'s) is generated: its third-party deprecation notices carry maintainers' addresses
  while IFS= read -r l; do informa "$l (e-mail)"; done < <(grep -nHoE "$CORREO" -- "${ficheros[@]}" | grep -vE '^([^:]*/)?package-lock\.json:' | grep -vE "$PERMITIDO" || true)
  if [ -n "$nombres" ]; then
    while IFS= read -r l; do informa "$l (private name)"; done < <(grep -v '^\s*\(#\|$\)' "$nombres" | grep -nHwiF -f - -- "${ficheros[@]}" || true)
  fi
fi

# ---- the history: authors, committers and messages
while IFS=$'\t' read -r sha autor committer; do
  for quien in "$autor" "$committer"; do
    case "$quien" in *noreply*) ;; *) informa "commit $sha: author/committer is not a noreply address: $quien" ;; esac
  done
done < <(git log --format='%h%x09%an <%ae>%x09%cn <%ce>' "$rango")

while IFS= read -r sha; do
  cuerpo="$(git log -1 --format='%B' "$sha")"
  printf '%s\n' "$cuerpo" | grep -qE "$IP" && informa "commit $sha: private address in the message"
  printf '%s\n' "$cuerpo" | grep -E "$CLAVE" | grep -qvE "$TECNICO" && informa "commit $sha: issue key in the message"
  printf '%s\n' "$cuerpo" | grep -qE "$LAN" && informa "commit $sha: lan host in the message"
  printf '%s\n' "$cuerpo" | grep -oE "$CORREO" | grep -qvE "$PERMITIDO" && informa "commit $sha: e-mail in the message"
  if [ -n "$nombres" ]; then
    printf '%s\n' "$cuerpo" | grep -qwiF -f <(grep -v '^\s*\(#\|$\)' "$nombres") && informa "commit $sha: private name in the message"
  fi
done < <(git log --format='%h' "$rango")

if [ "$fallos" -gt 0 ]; then
  echo "check-internal: $fallos finding(s)" >&2
  exit 1
fi
echo "check-internal: tree and history of $rango are clean"
