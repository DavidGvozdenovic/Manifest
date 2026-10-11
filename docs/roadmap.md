# Manifest roadmap (after the first public build)

## Done in this pass

- Invisible CEP service (`com.davidflow.manifest.service`) starts with Illustrator so the panel does not have to stay open
- Linear and radial gradient fills
- Inside / outside strokes (double-width + clip / send-to-back)
- Save / Import `.manifest`, session token, English UI + Serbian locale

## Still later (M6 leftovers)

- Angular and diamond gradients (today: solid mid-stop)
- Live Pathfinder booleans (today: flattened editable paths)
- Drop shadow, inner shadow, layer blur as live Illustrator effects
- Multiple fills/strokes via Appearance

## Hub / UXP (not v1)

Adobe is retiring CEP. When Illustrator UXP can host a local listener (or we accept a small native helper):

1. **Thin UXP panel** that only evals the builder, plus
2. **Optional Tauri hub** (Win + Mac installers, notarized) that owns `localhost:7531` and never needs `Window → Extensions`

Do not start the hub until CEP actually breaks for the versions we support. A notarized `.app` / EV-signed `.exe` is months of store setup, not a weekend.

## Known print risk

`jsx/bleed.jsx` patches an uncompressed `.ai` because `DocumentPreset.documentBleedOffsetRect` is ignored. Re-test bleed on each major Illustrator release.
