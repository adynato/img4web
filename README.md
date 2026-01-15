# img4web

Drop a folder of images and videos, get web-ready assets.

## Install

```bash
bun install
```

## Usage

### Interactive mode

```bash
bun start
```

1. Drop a folder
2. Pick mode:
   - **Fast** - compress only, keep original dimensions
   - **Custom** - set max width per file
3. Get `{folder}-compressed/` next to your input

### CLI mode

```bash
bun start /path/to/folder
```

Runs in fast mode (compress only, keep dimensions). Output goes to `{folder}-compressed/`.

## What it does

**Images:** Converts to WebP at 75% quality

**Videos:** Converts to H.264 MP4 (CRF 28, AAC audio)

Preserves folder structure. Shows before/after file sizes.

## Why

Designers hand you 5MB PNGs and 100MB MOVs. This makes them web-ready.
