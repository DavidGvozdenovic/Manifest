# Manifest

**Manifest by davidflow**

Send selected Figma frames to Adobe Illustrator as editable, print-ready artboards. Everything stays on your computer.

## Requirements

- Figma desktop (Windows or Mac)
- Adobe Illustrator 2022 or later on the **same** machine
- The Manifest Illustrator extension (`Window → Extensions → Manifest`, or the background service that starts with Illustrator)

Download the Illustrator panel (`.zxp`) from the project’s GitHub Releases and install it with Anastasiy’s Extension Manager / ZXPInstaller.

## What you get

- Artboards from frames, with bleed from a slice named **Trimbox** or a manual mm value
- Live text with character styles, embedded photos, vectors, clips, and fade masks
- CMYK and spot swatches, with an on-screen proof from Illustrator’s color settings
- Linear and radial gradients; inside / outside strokes
- **Save .manifest** when Illustrator is closed — import the file from the Manifest panel later

## What you do not get (yet)

- Angular or diamond gradients
- Live Pathfinder boolean operations (shapes are flattened paths)
- Shadows, blurs, and other Figma effects

## Privacy

The plugin only contacts `http://localhost:7531` on your machine. Your file is not uploaded to any Manifest server.

## How to use

1. Start Illustrator (leave it running).
2. Select one or more frames in Figma.
3. Run **Manifest**.
4. Review colors, then **Send to Illustrator** — or **Save .manifest**.
