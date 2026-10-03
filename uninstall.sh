#!/bin/sh
# Archive this integration only; never delete user settings.
set -eu
umask 077
root=${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}/opencode
apply=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --config-dir) [ "$#" -ge 2 ] || exit 2; root=$2; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) printf 'Usage: sh uninstall.sh [--config-dir DIR] [--apply]\nPreview by default; --apply archives only this integration. Restart OpenCode.\n'; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -d "$root" ] || { printf 'No config directory.\n'; exit 0; }
root=$(CDPATH= cd -- "$root" && pwd -P)
lock=$root/.azpr-v2-install.lock
mkdir "$lock" 2>/dev/null || { printf 'Installation lock exists: %s\n' "$lock" >&2; exit 1; }
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 130' HUP INT TERM
for sub in plugins plugins/azpr-v2 azpr-v2-backups; do
  [ ! -L "$root/$sub" ] || { printf 'Resolve symlink manually: %s\n' "$sub" >&2; exit 1; }
done
target=$root/plugins/azpr-v2
if [ ! -e "$target" ]; then
  printf 'No Azure PR Review V2 package is installed in this configuration directory.\n'
  exit 0
fi
if [ ! -d "$target" ] || [ ! -f "$target/runtime.mjs" ] || ! grep -Fq 'AZPR opt-in OpenCode adapter' "$target/runtime.mjs"; then
  printf 'Not owned; refusing: %s\n' "$target" >&2
  exit 1
fi
if [ "$apply" -eq 0 ]; then
  printf 'Preview: archive plugins/azpr-v2/ from:\n%s\nRe-run with --apply. Existing configuration, credentials, agents, commands, and other plugins are preserved.\n' "$root"
  exit 0
fi
mkdir -p "$root/azpr-v2-backups"
backup=$(mktemp -d "$root/azpr-v2-backups/uninstalled.XXXXXX")
mkdir -p "$backup/plugins"
if ! mv -- "$target" "$backup/plugins/azpr-v2"; then
  rmdir "$backup/plugins" "$backup" 2>/dev/null || true
  printf 'Archive failed; inspect the source and destination before retrying.\n' >&2
  exit 1
fi
printf 'Archived: %s\nRestart OpenCode.\n' "$backup"
