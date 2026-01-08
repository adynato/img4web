# img4web

Drop a folder of images, get web-ready webps.

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
   - **Custom** - set max width per image
3. Get `{folder}-compressed/` next to your input

## What it does

- Converts images to WebP at 75% quality
- Preserves folder structure
- Shows before/after file sizes

## Why

Designers hand you 5MB PNGs. This makes them 300KB webps.
