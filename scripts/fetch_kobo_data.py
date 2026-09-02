#!/usr/bin/env python3
"""
Pulls submissions from the Kwara State ISS KoboToolbox form and writes a
flattened, dashboard-ready JSON snapshot into data/.

Run by the GitHub Action on a schedule (see .github/workflows/refresh-data.yml).
Requires env var KOBO_API_TOKEN. Never hardcode the token in this file.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

KOBO_HOST = "kf.kobotoolbox.org"
ASSET_UID = "a3px58eSfDuyg3PLUdNBpR"
TOKEN = os.environ.get("KOBO_API_TOKEN", "").strip()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
SUBMISSIONS_OUT = os.path.join(DATA_DIR, "live_submissions.json")
META_OUT = os.path.join(DATA_DIR, "live_meta.json")

# Group prefixes stripped from each flattened field name.
GROUP_PREFIXES = [
    "visit_profile/", "dom1/", "dom2/", "dom3/", "dom4/", "dom5/", "dom6/",
    "indicator_review/", "actions_group/",
]

TOP_LEVEL_KEEP = {
    "_id", "_uuid", "_submission_time", "start", "end", "today",
    "critical_red_flags", "overall_score", "classification",
}


def strip_prefix(key: str) -> str:
    for p in GROUP_PREFIXES:
        if key.startswith(p):
            return key[len(p):]
    return key


def fetch_all_submissions():
    if not TOKEN:
        print("KOBO_API_TOKEN not set; writing an empty snapshot.", file=sys.stderr)
        return []

    results = []
    url = f"https://{KOBO_HOST}/api/v2/assets/{ASSET_UID}/data/?format=json&limit=1000"
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Token {TOKEN}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            print(f"Kobo API error {e.code}: {e.read().decode('utf-8')}", file=sys.stderr)
            break
        results.extend(payload.get("results", []))
        url = payload.get("next")
    return results


def flatten(raw: dict) -> dict:
    flat = {}
    for key, value in raw.items():
        if key.startswith("_") and key not in TOP_LEVEL_KEEP:
            continue
        if key in ("formhub/uuid", "meta/instanceID", "__version__"):
            continue
        flat_key = strip_prefix(key)
        if isinstance(value, list) and flat_key == "actions":
            cleaned = []
            for item in value:
                cleaned.append({strip_prefix(k): v for k, v in item.items()})
            flat[flat_key] = cleaned
        else:
            flat[flat_key] = value
    return flat


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    raw = fetch_all_submissions()
    flattened = [flatten(r) for r in raw]

    with open(SUBMISSIONS_OUT, "w") as f:
        json.dump(flattened, f, indent=1)

    meta = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(flattened),
        "asset_uid": ASSET_UID,
        "source": f"https://{KOBO_HOST}/api/v2/assets/{ASSET_UID}/",
    }
    with open(META_OUT, "w") as f:
        json.dump(meta, f, indent=1)

    print(f"Wrote {len(flattened)} submissions to {SUBMISSIONS_OUT}")


if __name__ == "__main__":
    main()
