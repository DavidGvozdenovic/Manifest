# Publish F2A (Windows + macOS)

End users should never run `npm`. Ship two artifacts: the Figma Community plugin and a `.zxp` for Illustrator.

## 1. Build

```bash
npm install
npm run build
npm run typecheck
npm run pack:zxp
```

`dist/F2A-0.1.0.zxp` is the Illustrator package (unsigned unless you sign it).

## 2. Sign the ZXP (required for strangers)

1. Install Adobe `ZXPSignCmd`.
2. Create or buy a code-signing certificate.
3. Pack and sign:

```bash
# Windows PowerShell
$env:F2A_ZXP_CERT = "C:\certs\f2a.p12"
$env:F2A_ZXP_PASS = "…"
$env:ZXPSIGNCMD = "C:\Tools\ZXPSignCmd.exe"
npm run pack:zxp
```

```bash
# macOS
export F2A_ZXP_CERT="$HOME/certs/f2a.p12"
export F2A_ZXP_PASS="…"
export ZXPSIGNCMD="/usr/local/bin/ZXPSignCmd"
npm run pack:zxp
```

Self-signed is enough for a private beta. A public “anyone can install” build should use a real CA cert.

Users install the `.zxp` with [Anastasiy’s Extension Manager](https://install.anastasiy.com/) (Win + Mac). They should **not** enable `PlayerDebugMode`.

Do **not** start with Adobe Exchange — review is slow and CEP is being retired.

## 3. Figma Community

1. Open the plugin in Figma desktop → publish from the plugin manifest.
2. Figma assigns a numeric production id — paste it into `packages/figma-plugin/manifest.json` `id` and rebuild.
3. `networkAccess.allowedDomains` must stay `http://localhost:7531` with the existing `reasoning`.
4. Paste [community-listing.md](community-listing.md) into the Community form (English).
5. Screenshots: plugin color step + resulting Illustrator artboards.

Desktop is the supported client. Figma web may be blocked by Private Network Access.

## 4. GitHub Release

After the `.zxp` is signed:

```bash
gh release create v0.1.0 dist/F2A-0.1.0.zxp --title "F2A 0.1.0" --notes-file docs/community-listing.md
```

Attach the zxp only (not the unsigned zip) unless you are publishing a dev snapshot.

## 5. What to tell users

- Figma desktop + Illustrator 2022+ on the **same** computer
- Illustrator must be running so the background F2A service can listen
- Fonts must be installed in Illustrator
- Bleed is written with a documented `.ai` patch; if a future Illustrator build breaks it, set bleed by hand
- CEP will not last forever — see [roadmap.md](roadmap.md)
