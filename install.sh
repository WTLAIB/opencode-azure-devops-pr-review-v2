#!/bin/sh
# Install only this integration. Never edit OpenCode configuration or execute settings.
set -eu
umask 077

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
root=${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}/opencode
profile=
replace=0

usage() {
  cat <<'TXT'
Usage: sh install.sh [--settings FILE] [--replace] [--config-dir DIR]
  --settings    Select a trusted version-2 JSON profile and add missing defaults.
  --replace     Replace this V2 integration without keeping an installation backup.
                Preserve operational settings and add missing defaults.
  --config-dir  OpenCode configuration directory (default: XDG_CONFIG_HOME/opencode).
Retired models._help documentation is omitted with a notice.
Python 3 (standard library only) is required to merge JSON safely.
No npm install, pip packages, jq, sudo, or network access is required.
README.md, docs/, uninstall.sh, and config/settings.schema.json are optional.
Installed module metadata is generated; the source package.json is not required.
TXT
}
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --settings) [ "$#" -ge 2 ] || die '--settings needs a file'; profile=$2; shift 2 ;;
    --config-dir) [ "$#" -ge 2 ] || die '--config-dir needs a directory'; root=$2; shift 2 ;;
    --replace) replace=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
command -v python3 >/dev/null 2>&1 || die 'Python 3 is required for safe JSON settings merging. Install python3 and retry; no installation files were changed.'
runtime_files='session.mjs runtime.mjs comments.mjs config.mjs output.mjs diagnostics.mjs attribution.mjs plugin.js'
prompt_names='common check functional risk deep final comment-policy comment-plan comment-publish'
command_names='pr-check pr-review pr-deep pr-stop pr-comment'
require_file() { [ -f "$src/$1" ] && [ -r "$src/$1" ] || die "Incomplete package: $1 is missing or unreadable."; }
for file in scripts/merge-settings.py config/settings.example.json; do require_file "$file"; done
for file in $runtime_files; do require_file "src/$file"; done
for name in $prompt_names; do require_file "src/prompts/$name.md"; done
copy_optional() {
  if [ -f "$src/$1" ]; then
    cp "$src/$1" "$stage/new/plugins/azpr-v2/" || printf 'WARNING: Could not copy optional file: %s\n' "$1" >&2
  fi
}
if [ -n "$profile" ]; then
  [ -f "$profile" ] && [ -r "$profile" ] || die 'The settings file is not readable.'
fi
case $root in /*) ;; *) root=$(pwd -P)/$root ;; esac
mkdir -p "$root"
root=$(CDPATH= cd -- "$root" && pwd -P)
lock=$root/.azpr-v2-install.lock
mkdir "$lock" 2>/dev/null || die "Installation lock exists: $lock"
stage=
success=0

cleanup() {
  rc=$?
  recovery_required=0
  trap - EXIT HUP INT TERM
  if [ "$success" -ne 1 ] && [ -n "$stage" ] && [ -d "$stage" ]; then
    if [ -f "$stage/installed" ]; then
      while IFS= read -r rel; do
        [ -n "$rel" ] && rm -rf -- "$root/$rel"
      done < "$stage/installed"
    fi
    if [ -f "$stage/moved" ]; then
      while IFS= read -r rel; do
        if [ -e "$stage/previous/$rel" ] || [ -L "$stage/previous/$rel" ]; then
          mkdir -p "$(dirname -- "$root/$rel")"
          if ! mv -- "$stage/previous/$rel" "$root/$rel"; then
            recovery_required=1
            printf 'Restore manually: %s\n' "$stage/previous/$rel" >&2
          fi
        fi
      done < "$stage/moved"
    fi
  fi
  if [ "$recovery_required" -eq 0 ]; then
    [ -z "$stage" ] || rm -rf -- "$stage"
  else
    printf 'Automatic recovery failed; emergency files retained: %s\n' "$stage" >&2
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Refuse conflicts rather than trying to rewrite JSONC.
for config in "$root/opencode.json" "$root/opencode.jsonc" "$root/config.json"; do
  if [ -f "$config" ] && grep -Eq '"(pr-check|pr-review|pr-deep|pr-stop|pr-comment|azpr-[^"]+)"[[:space:]]*:' "$config"; then
    die "Reserved command/agent keys appear in $config. Resolve them manually."
  fi
done
for path in "$root"/agent/azpr-*.md "$root"/agents/azpr-*.md; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || die "Conflicting agent file: $path"
done
for sub in commands command plugins plugin plugins/azpr-v2; do
  [ ! -L "$root/$sub" ] || die "Symlinked integration directory: $root/$sub"
done
# A V1 integration shares command names and cannot coexist in this config root.
# Preserve every old file; --replace applies only to this V2 package directory.
for rel in azpr plugins/azpr plugins/azpr.js plugin/azpr plugin/azpr.js plugin/azpr-v2 .azpr-install.lock; do
  [ ! -e "$root/$rel" ] && [ ! -L "$root/$rel" ] || die "Conflicting integration path: $root/$rel. Use a separate V2 configuration directory or resolve the conflict manually."
done
for name in $command_names; do
  for sub in command commands; do
    rel=$sub/$name.md
    [ ! -e "$root/$rel" ] && [ ! -L "$root/$rel" ] || die "Conflicting command file: $root/$rel. Resolve it manually."
  done
done

target=plugins/azpr-v2
if [ -e "$root/$target" ]; then
  [ "$replace" -eq 1 ] || die "Target exists: $root/$target. Use --replace to replace this V2 integration without an installation backup."
  [ -d "$root/$target" ] && [ -f "$root/$target/runtime.mjs" ] &&
    grep -Fq 'AZPR opt-in OpenCode adapter' "$root/$target/runtime.mjs" || die "Not owned; refusing: $root/$target"
fi
stage=$(mktemp -d "$root/.azpr-v2-stage.XXXXXX")
mkdir -p "$stage/new/$target/prompts"
for file in $runtime_files; do cp "$src/src/$file" "$stage/new/$target/"; done
for name in $prompt_names; do cp "$src/src/prompts/$name.md" "$stage/new/$target/prompts/"; done
# OpenCode 2.0.22 resolves local package directories through server, then index.
# Keep the entry inside the staged package so replacement and rollback own it.
printf '%s\n' "export { default } from './plugin.js';" > "$stage/new/$target/server.js"
printf '%s\n' '{"type":"module","exports":"./server.js","private":true}' > "$stage/new/$target/package.json"
for file in config/settings.schema.json README.md uninstall.sh; do copy_optional "$file"; done
if [ -d "$src/docs" ]; then
  cp -R "$src/docs" "$stage/new/plugins/azpr-v2/docs" || printf 'WARNING: Could not copy optional docs directory.\n' >&2
fi
if [ -n "$profile" ]; then
  settings_source=$profile
elif [ "$replace" -eq 1 ] && [ -f "$root/plugins/azpr-v2/settings.json" ]; then
  settings_source=$root/plugins/azpr-v2/settings.json
else
  settings_source=$src/config/settings.example.json
fi
python3 -I "$src/scripts/merge-settings.py" "$src/config/settings.example.json" "$settings_source" "$stage/new/plugins/azpr-v2/settings.json"
chmod 600 "$stage/new/plugins/azpr-v2/settings.json"

: > "$stage/moved"
: > "$stage/installed"
if [ -e "$root/$target" ]; then
  mkdir -p "$stage/previous/plugins"
  printf '%s\n' "$target" >> "$stage/moved"
  mv -- "$root/$target" "$stage/previous/$target"
fi
mkdir -p "$root/plugins"
printf '%s\n' "$target" >> "$stage/installed"
mv -- "$stage/new/$target" "$root/$target"
success=1
printf '\nAzure PR Review installed (target host: @opencode/cli 2.0.22; Ubuntu 22.04).\nSettings: %s\n' "$root/plugins/azpr-v2/settings.json"
printf 'No installation backup is retained after success. Existing older backups are untouched.\n'
cat <<'TXT'
1. Configure models.review.functional/risk/verifier. Configure all three models.deep roles to enable /pr-deep.
2. Configure your official @azure-devops/mcp 2.9.0 host connection with codemode: false for direct MCP tools. Existing host permissions still apply; no tool mapping is required.
3. Fully restart OpenCode and run /pr-check on a small, known PR.
Settings have not been API-validated. The plugin refuses incomplete configuration.
TXT
