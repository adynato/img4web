# img4web

Drop a folder of images and videos, get web-ready assets.

## Install

```bash
bun install
```

## Usage

```bash
bun start
```

1. Drop a folder
2. Pick mode:
   - **Fast** - compress only, keep original dimensions
   - **Custom** - set max width per file
3. Get `{folder}-compressed/` next to your input

## What it does

**Images:** Converts to WebP at 75% quality

**Videos:** Converts to H.264 MP4 (CRF 28, AAC audio)

Preserves folder structure. Shows before/after file sizes.

## Why

Designers hand you 5MB PNGs and 100MB MOVs. This makes them web-ready.
