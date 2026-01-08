#!/usr/bin/env bun
import * as p from "@clack/prompts";
import sharp from "sharp";
import { readdir, stat, mkdir } from "fs/promises";
import { join, basename, extname, dirname, relative } from "path";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".gif"];

interface ImageFile {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  width?: number;
  height?: number;
}

async function findImages(dir: string, baseDir: string): Promise<ImageFile[]> {
  const images: ImageFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const subImages = await findImages(fullPath, baseDir);
      images.push(...subImages);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        const fileStat = await stat(fullPath);
        images.push({
          path: fullPath,
          name: entry.name,
          relativePath: relative(baseDir, fullPath),
          size: fileStat.size
        });
      }
    }
  }

  return images;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  p.intro("img4web");

  const input = await p.text({
    message: "Drop a folder",
    placeholder: "drag & drop here, then press enter",
    validate: (val) => {
      if (!val || val.trim() === "") return "Please provide a path";
    },
  });

  if (p.isCancel(input)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const folderPath = (input as string).trim().replace(/\\ /g, " ").replace(/\/$/, "");
  const folderName = basename(folderPath);

  // Verify it's a directory
  try {
    const s = await stat(folderPath);
    if (!s.isDirectory()) {
      p.log.error("Please provide a folder, not a file");
      process.exit(1);
    }
  } catch {
    p.log.error("Folder not found");
    process.exit(1);
  }

  const allImages = await findImages(folderPath, folderPath);

  if (allImages.length === 0) {
    p.log.error("No images found");
    process.exit(1);
  }

  // Get dimensions for all images
  for (const img of allImages) {
    const metadata = await sharp(img.path).metadata();
    img.width = metadata.width;
    img.height = metadata.height;
  }

  const totalSize = allImages.reduce((sum, img) => sum + img.size, 0);
  p.log.info(`Found ${allImages.length} images (${formatBytes(totalSize)})`);

  const mode = await p.select({
    message: "Mode",
    options: [
      { value: "fast", label: "Fast - compress only, keep dimensions" },
      { value: "custom", label: "Custom - set dimensions per image" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Create output folder next to input
  const outputDir = join(dirname(folderPath), `${folderName}-compressed`);
  await mkdir(outputDir, { recursive: true });

  let totalOriginal = 0;
  let totalCompressed = 0;

  if (mode === "fast") {
    const spinner = p.spinner();
    spinner.start("Processing...");

    for (let i = 0; i < allImages.length; i++) {
      const img = allImages[i]!;
      spinner.message(`${img.name} (${i + 1}/${allImages.length})`);

      // Preserve directory structure
      const outputRelative = img.relativePath.replace(/\.[^.]+$/, ".webp");
      const outputPath = join(outputDir, outputRelative);
      await mkdir(dirname(outputPath), { recursive: true });

      await sharp(img.path)
        .webp({ quality: 75 })
        .toFile(outputPath);

      const outputStat = await stat(outputPath);
      totalOriginal += img.size;
      totalCompressed += outputStat.size;
    }

    spinner.stop("Done!");
  } else {
    // Custom mode - ask per image
    for (let i = 0; i < allImages.length; i++) {
      const img = allImages[i]!;

      p.log.info(`\n${img.relativePath} - ${img.width}x${img.height} (${formatBytes(img.size)})`);

      const maxWidth = await p.select({
        message: "Max width",
        options: [
          { value: 0, label: `Keep original (${img.width}px)` },
          { value: 400, label: "400px (thumbnail)" },
          { value: 800, label: "800px (small)" },
          { value: 1200, label: "1200px (medium)" },
          { value: 1920, label: "1920px (large)" },
          { value: 2560, label: "2560px (retina)" },
        ],
      });

      if (p.isCancel(maxWidth)) {
        p.cancel("Cancelled");
        process.exit(0);
      }

      // Preserve directory structure
      const outputRelative = img.relativePath.replace(/\.[^.]+$/, ".webp");
      const outputPath = join(outputDir, outputRelative);
      await mkdir(dirname(outputPath), { recursive: true });

      let pipeline = sharp(img.path);

      if ((maxWidth as number) > 0) {
        pipeline = pipeline.resize(maxWidth as number, null, {
          withoutEnlargement: true,
        });
      }

      await pipeline.webp({ quality: 75 }).toFile(outputPath);

      const outputStat = await stat(outputPath);
      totalOriginal += img.size;
      totalCompressed += outputStat.size;

      const saved = ((1 - outputStat.size / img.size) * 100).toFixed(0);
      p.log.success(`→ ${formatBytes(outputStat.size)} (${saved}% smaller)`);
    }
  }

  const savings = totalOriginal - totalCompressed;
  const percent = ((savings / totalOriginal) * 100).toFixed(0);

  p.log.success(`${formatBytes(totalOriginal)} → ${formatBytes(totalCompressed)} (${percent}% smaller)`);
  p.log.info(`Output: ${outputDir}`);

  p.outro("Done!");
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
