#!/usr/bin/env bash
# Runs the ExtendScript builder on an IR fixture through Illustrator's AppleScript bridge.
# Usage: bash scripts/ai-test.sh fixtures/ir/page-01-lite.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="${1:?usage: scripts/ai-test.sh fixtures/ir/page-01-lite.json}"
ASSET_DIR="${2:-fixtures/out/assets}"

FIXTURE_PATH="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$ROOT/$FIXTURE")"
ASSETS="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$ROOT/$ASSET_DIR")"
OUT_DIR="$ROOT/fixtures/out"
mkdir -p "$OUT_DIR"

PAYLOAD="$OUT_DIR/payload.json"
python3 - <<PY
import json, pathlib
root = pathlib.Path(r"""$ROOT""")
doc = json.loads(pathlib.Path(r"""$FIXTURE_PATH""").read_text(encoding="utf-8"))
doc["assetDir"] = r"""$ASSETS""".replace("\\", "/")
pathlib.Path(r"""$PAYLOAD""").write_text(json.dumps(doc), encoding="utf-8")
PY

BUILDER="$ROOT/packages/ai-panel/jsx/builder.jsx"
STEM="$(basename "$FIXTURE" .json)"
PNG="$OUT_DIR/$STEM.png"

osascript <<APPLESCRIPT
tell application "Adobe Illustrator"
  activate
  set js to "$.evalFile('$BUILDER'); var result = f2aBuild('$PAYLOAD'); try { var opts = new ExportOptionsPNG24(); opts.artBoardClipping = true; opts.horizontalScale = 200; opts.verticalScale = 200; app.activeDocument.exportFile(new File('$PNG'), ExportType.PNG24, opts); } catch (e) { result = result.replace(/}$/, ',\"exportError\":\"' + e.message + '\"}'); } result;"
  do javascript js
end tell
APPLESCRIPT
