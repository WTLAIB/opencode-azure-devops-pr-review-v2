#!/usr/bin/env python3
"""Check current settings and add missing defaults without exposing private values."""
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
    with open(path, encoding="utf-8") as stream:
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


def current_settings(existing):
    """Accept the current layout only; this V2 package does not migrate V1."""
    version = existing.get("version", 2)
    if type(version) is not int or version != 2:
        raise ValueError("Unsupported settings version.")
    models = existing.get("models", {})
    if not isinstance(models, dict):
        raise ValueError("Models must be a current-layout JSON object.")
    if any(key in models for key in ("freeA", "freeB", "final")):
        raise ValueError("Legacy model settings are unsupported.")
    if any(key in models and not isinstance(models[key], dict) for key in ("review", "deep")):
        raise ValueError("Model roles must use the current nested layout.")
    if any(key in existing for key in ("steps", "maxStageCharacters", "structuredOutput", "azure")):
        raise ValueError("Removed settings are unsupported.")


def main():
    if len(sys.argv) != 4:
        print("Usage: merge-settings.py DEFAULTS SOURCE DESTINATION", file=sys.stderr)
        return 2
    defaults_path, source_path, destination = sys.argv[1:]
    try:
        _, defaults = load(defaults_path)
        raw, existing = load(source_path)
        current_settings(defaults)
        current_settings(existing)
        added = merge(existing, defaults)
        content = json.dumps(existing, ensure_ascii=False, indent=2, allow_nan=False) + "\n" if added else raw
        with open(destination, "x", encoding="utf-8") as stream:
            stream.write(content)
    except (ValueError, OSError, UnicodeError, RecursionError):
        # Parser exceptions can contain secrets from the profile. Never print them.
        print("ERROR: Settings must be readable, valid JSON objects with unique keys, finite numbers, and the current version-2 nested model layout without removed settings. No installed files were replaced. Fix the selected settings file or choose --settings FILE.", file=sys.stderr)
        return 1
    print("Settings defaults added: " + (", ".join(added) if added else "none."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
