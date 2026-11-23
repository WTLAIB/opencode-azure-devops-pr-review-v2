#!/usr/bin/env python3
"""Check settings and add defaults without exposing private values; settings of AZPR 0.4.x are carried over unchanged."""
import json
import math
import sys


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key; resolve it before installation.")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Non-standard JSON numeric constant.")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number.")
    return number


def load(path):
    # newline="" keeps line endings as they are: a file that is carried over unchanged is carried over byte for byte.
    with open(path, encoding="utf-8", newline="") as stream:
        raw = stream.read()
    value = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant, parse_float=finite_float)
    if not isinstance(value, dict):
        raise ValueError("Settings must be a JSON object.")
    return raw, value


def merge(existing, defaults, prefix=""):
    added = []
    for key, value in defaults.items():
        path = prefix + key
        if key not in existing:
            existing[key] = value
            added.append(path)
        elif isinstance(existing[key], dict) and isinstance(value, dict):
            added.extend(merge(existing[key], value, path + "."))
    return added


REMOVED_SETTINGS = ("steps", "maxStageCharacters", "structuredOutput", "comments", "auxiliaryModels", "outputRetries", "verification", "shellToolPermission")
MODES = ("review", "deep", "quick")
# What the models of a mode were called before the reviewer lists (AZPR 0.4.x, settings version 2).
EARLIER_MODEL_KEYS = ("functional", "risk", "verifier", "reviewer")


def settings_version(existing):
    """The layout of a settings file: 3, the current one (also for a file that names none), or 2 (AZPR 0.4.x)."""
    version = existing.get("version", 3)
    if type(version) is not int or version not in (2, 3):
        raise ValueError("Unsupported settings version.")
    return version


def current_settings(existing):
    """Accept the current layout only (reviewer lists per mode); no other layout gets this version's defaults."""
    if settings_version(existing) != 3:
        raise ValueError("Not the current settings version.")
    models = existing.get("models", {})
    if not isinstance(models, dict):
        raise ValueError("Models must be a current-layout JSON object.")
    if any(key in models for key in ("freeA", "freeB", "final", "_help")):
        raise ValueError("Legacy model settings are unsupported.")
    for mode in MODES:
        if mode not in models:
            continue
        group = models[mode]
        if not isinstance(group, dict):
            raise ValueError("Model settings must use the current nested layout.")
        # A file that names no version and has the earlier model keys is of the earlier layout: stamping
        # this version on it would hide it from the update that /pr-setup offers.
        if any(key in group for key in EARLIER_MODEL_KEYS):
            raise ValueError("Model settings of an earlier layout.")
        if "reviewers" in group and not isinstance(group["reviewers"], list):
            raise ValueError("Reviewers must be a list.")
    if any(key in existing for key in REMOVED_SETTINGS):
        raise ValueError("Removed settings are unsupported.")
    if "azure" in existing and not isinstance(existing["azure"], dict):
        raise ValueError("Azure settings must be a JSON object.")


def main():
    if len(sys.argv) != 4:
        print("Usage: merge-settings.py DEFAULTS SOURCE DESTINATION", file=sys.stderr)
        return 2
    defaults_path, source_path, destination = sys.argv[1:]
    try:
        _, defaults = load(defaults_path)
        raw, existing = load(source_path)
        current_settings(defaults)
        # Settings of AZPR 0.4.x are carried over byte for byte: this version does not use them until /pr-setup
        # has updated them, which shows the change and needs the person's confirmation. Merging this version's
        # defaults into them would leave a file of neither layout. Source files stay untouched in any case.
        earlier = settings_version(existing) == 2
        if earlier:
            added, content = [], raw
        else:
            current_settings(existing)
            added = merge(existing, defaults)
            content = json.dumps(existing, ensure_ascii=False, indent=2, allow_nan=False) + "\n" if added else raw
        with open(destination, "x", encoding="utf-8", newline="") as stream:
            stream.write(content)
    except (ValueError, OSError, UnicodeError, RecursionError):
        # Parser exceptions can contain secrets from the profile. Never print them.
        print("ERROR: Settings must be readable, valid JSON objects with unique keys, finite numbers, and the current version-3 layout (a list of reviewer models per mode) without removed settings; a version-2 file of AZPR 0.4.x is kept as it is. No installed files were replaced. Fix the selected settings file or choose --settings FILE.", file=sys.stderr)
        return 1
    if earlier:
        print("Settings of AZPR 0.4.x (settings version 2) were kept exactly as they are. This version does not use them until they are updated: restart OpenCode and run /pr-setup, which shows what changes and writes the new file after you confirm.")
    else:
        print("Settings defaults added: " + (", ".join(added) if added else "none."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
