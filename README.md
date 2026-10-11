# Manifest

**Manifest by davidflow** — a local bridge from Figma frames to an editable, print-ready Illustrator document. Artwork stays on the machine: the plugin talks to a panel on `localhost:7531`.

Works on **Windows and macOS** with Figma desktop and Adobe Illustrator 2022+.

Serbian notes for the team: [docs/SOP.md](docs/SOP.md).

## What it does

- Selected frames become artboards, with bleed from a `Trimbox` slice or a manual mm value
- Editable text (per-character style), photos (fill/fit/crop, embed), vectors, clips, fade masks
- CMYK / spot swatches with an Illustrator proof (ΔE2000)
- Linear and radial fills; inside / outside strokes (double-width + clip)
- Offline fallback: **Save .manifest** in Figma, **Import .manifest** in the Illustrator panel

## What it does not do yet

- Angular / diamond gradients (exported as a solid)
- Live Pathfinder booleans (geometry is flattened, still editable as paths)
- Drop shadow, blur, and other layer effects
- Figma web is best-effort (Private Network Access)

## Install (designers)

You need Figma desktop and Illustrator 2022+ on the same computer.

### 1. Figma plugin

- **Community (after listing):** Plugins → search **Manifest**
- **Development / GitHub:** `Plugins → Development → Import plugin from manifest…` → `packages/figma-plugin/manifest.json` (run `npm run build` first)

### 2. Illustrator panel

1. Download `Manifest-x.y.z.zxp` from [GitHub Releases](../../releases) (or build it with `npm run pack:zxp`).
2. Install it with [Anastasiy’s Extension Manager](https://install.anastasiy.com/) or ZXPInstaller (Windows and Mac).
3. Restart Illustrator. Manifest starts in the background. Optional: `Window → Extensions → Manifest` for the log and **Import .manifest**.

A signed `.zxp` does **not** need `PlayerDebugMode`. Unsigned builds are for developers only (`npm run install:cep`).

### 3. Use it

1. Leave Illustrator running (Manifest listens on `localhost:7531`).
2. In Figma, select frames → run **Manifest** → **Next: colors** / **Prepare**.
3. Review CMYK, then **Send to Illustrator**, or **Save .manifest** and import it in the panel.

## Install (developers)

```bash
npm install
npm run build
npm run install:cep   # symlink + PlayerDebugMode (CSXS 9–12)
npm run dev           # watch the Figma plugin
```

Restart Illustrator. Import `packages/figma-plugin/manifest.json` in Figma desktop.

Windows fixture test:

```powershell
powershell -File scripts/ai-test.ps1 fixtures/ir/page-01-lite.json
```

macOS fixture test:

```bash
bash scripts/ai-test.sh fixtures/ir/page-01-lite.json
```

Pack an Illustrator installer:

```bash
npm run pack:zxp
```

Signing and Community publish: [docs/publish.md](docs/publish.md). Listing copy: [docs/community-listing.md](docs/community-listing.md).

## Security

The panel binds to `127.0.0.1` / `::1` only. POST routes require a per-session token from `GET /ping`. Browser pages with a real `Origin` are rejected. Any local process can still call the server — do not treat this as a multi-user lock.

## License

[MIT](LICENSE) — Manifest by davidflow
