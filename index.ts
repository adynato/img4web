#!/usr/bin/env bun
import * as p from "@clack/prompts";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { readdir, stat, mkdir } from "fs/promises";
import { join, basename, extname, dirname, relative } from "path";
import { $ } from "bun";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".gif"];
const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];

interface MediaFile {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  type: "image" | "video";
  width?: number;
  height?: number;
}

async function findMedia(dir: string, baseDir: string): Promise<MediaFile[]> {
  const media: MediaFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const subMedia = await findMedia(fullPath, baseDir);
      media.push(...subMedia);
    } else {
      const ext = extname(entry.name).toLowerCase();
      const fileStat = await stat(fullPath);

      if (IMAGE_EXTS.includes(ext)) {
        media.push({
          path: fullPath,
          name: entry.name,
          relativePath: relative(baseDir, fullPath),
          size: fileStat.size,
          type: "image"
        });
      } else if (VIDEO_EXTS.includes(ext)) {
        media.push({
          path: fullPath,
          name: entry.name,
          relativePath: relative(baseDir, fullPath),
          size: fileStat.size,
          type: "video"
        });
      }
    }
  }

  return media;
}

async function getVideoDimensions(path: string): Promise<{ width: number; height: number }> {
  try {
    const result = await $`${ffprobePath.path} -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${path}`.text();
    const [width, height] = result.trim().split("x").map(Number);
    return { width: width || 0, height: height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function compressVideo(inputPath: string, outputPath: string, maxWidth?: number): Promise<void> {
  const args = ["-y", "-i", inputPath, "-c:v", "libx264", "-crf", "28", "-preset", "fast", "-c:a", "aac", "-b:a", "128k"];

  if (maxWidth && maxWidth > 0) {
    args.push("-vf", `scale='min(${maxWidth},iw)':-2`);
  }

  args.push(outputPath);

  // CRF 28 is good balance for web, -preset fast for speed
  await $`${ffmpegPath} ${args}`.quiet();
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

  const allMedia = await findMedia(folderPath, folderPath);

  if (allMedia.length === 0) {
    p.log.error("No images or videos found");
    process.exit(1);
  }

  const images = allMedia.filter((m) => m.type === "image");
  const videos = allMedia.filter((m) => m.type === "video");

  // Get dimensions for images
  for (const img of images) {
    const metadata = await sharp(img.path).metadata();
    img.width = metadata.width;
    img.height = metadata.height;
  }

  // Get dimensions for videos
  for (const vid of videos) {
    const dims = await getVideoDimensions(vid.path);
    vid.width = dims.width;
    vid.height = dims.height;
  }

  const totalSize = allMedia.reduce((sum, m) => sum + m.size, 0);
  const mediaToProcess = [...images, ...videos];

  p.log.info(`Found ${images.length} images, ${videos.length} videos (${formatBytes(totalSize)})`);

  const mode = await p.select({
    message: "Mode",
    options: [
      { value: "fast", label: "Fast - compress only, keep dimensions" },
      { value: "custom", label: "Custom - set dimensions per file" },
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

    for (let i = 0; i < mediaToProcess.length; i++) {
      const file = mediaToProcess[i]!;
      spinner.message(`${file.name} (${i + 1}/${mediaToProcess.length})`);

      if (file.type === "image") {
        const outputRelative = file.relativePath.replace(/\.[^.]+$/, ".webp");
        const outputPath = join(outputDir, outputRelative);
        await mkdir(dirname(outputPath), { recursive: true });

        await sharp(file.path)
          .webp({ quality: 75 })
          .toFile(outputPath);

        const outputStat = await stat(outputPath);
        totalOriginal += file.size;
        totalCompressed += outputStat.size;
      } else {
        const outputRelative = file.relativePath.replace(/\.[^.]+$/, ".mp4");
        const outputPath = join(outputDir, outputRelative);
        await mkdir(dirname(outputPath), { recursive: true });

        await compressVideo(file.path, outputPath);

        const outputStat = await stat(outputPath);
        totalOriginal += file.size;
        totalCompressed += outputStat.size;
      }
    }

    spinner.stop("Done!");
  } else {
    // Custom mode - ask per file
    for (let i = 0; i < mediaToProcess.length; i++) {
      const file = mediaToProcess[i]!;

      p.log.info(`\n${file.relativePath} - ${file.width}x${file.height} (${formatBytes(file.size)}) [${file.type}]`);

      const maxWidth = await p.select({
        message: "Max width",
        options: [
          { value: 0, label: `Keep original (${file.width}px)` },
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

      if (file.type === "image") {
        const outputRelative = file.relativePath.replace(/\.[^.]+$/, ".webp");
        const outputPath = join(outputDir, outputRelative);
        await mkdir(dirname(outputPath), { recursive: true });

        let pipeline = sharp(file.path);

        if ((maxWidth as number) > 0) {
          pipeline = pipeline.resize(maxWidth as number, null, {
            withoutEnlargement: true,
          });
        }

        await pipeline.webp({ quality: 75 }).toFile(outputPath);

        const outputStat = await stat(outputPath);
        totalOriginal += file.size;
        totalCompressed += outputStat.size;

        const saved = ((1 - outputStat.size / file.size) * 100).toFixed(0);
        p.log.success(`→ ${formatBytes(outputStat.size)} (${saved}% smaller)`);
      } else {
        const outputRelative = file.relativePath.replace(/\.[^.]+$/, ".mp4");
        const outputPath = join(outputDir, outputRelative);
        await mkdir(dirname(outputPath), { recursive: true });

        await compressVideo(file.path, outputPath, maxWidth as number);

        const outputStat = await stat(outputPath);
        totalOriginal += file.size;
        totalCompressed += outputStat.size;

        const saved = ((1 - outputStat.size / file.size) * 100).toFixed(0);
        p.log.success(`→ ${formatBytes(outputStat.size)} (${saved}% smaller)`);
      }
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
