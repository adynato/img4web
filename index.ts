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

interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
  progress: (msg: string) => void;
  done: () => void;
}

function createLogger(cli: boolean): Logger {
  if (cli) {
    return {
      info: (msg) => console.log(msg),
      error: (msg) => console.error(`Error: ${msg}`),
      success: (msg) => console.log(msg),
      progress: (msg) => process.stdout.write(`\r${msg}`),
      done: () => console.log(),
    };
  }

  const spinner = p.spinner();
  let spinnerStarted = false;

  return {
    info: (msg) => p.log.info(msg),
    error: (msg) => p.log.error(msg),
    success: (msg) => p.log.success(msg),
    progress: (msg) => {
      if (!spinnerStarted) {
        spinner.start(msg);
        spinnerStarted = true;
      } else {
        spinner.message(msg);
      }
    },
    done: () => {
      if (spinnerStarted) spinner.stop("Done!");
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizePath(input: string): string {
  return input.trim().replace(/\\ /g, " ").replace(/\/$/, "");
}

async function verifyFolder(folderPath: string): Promise<boolean> {
  try {
    const s = await stat(folderPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findMedia(dir: string, baseDir: string): Promise<MediaFile[]> {
  const media: MediaFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      media.push(...(await findMedia(fullPath, baseDir)));
    } else {
      const ext = extname(entry.name).toLowerCase();
      const fileStat = await stat(fullPath);
      const isImage = IMAGE_EXTS.includes(ext);
      const isVideo = VIDEO_EXTS.includes(ext);

      if (isImage || isVideo) {
        media.push({
          path: fullPath,
          name: entry.name,
          relativePath: relative(baseDir, fullPath),
          size: fileStat.size,
          type: isImage ? "image" : "video",
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

async function compressImage(inputPath: string, outputPath: string, maxWidth?: number): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  let pipeline = sharp(inputPath);
  if (maxWidth && maxWidth > 0) {
    pipeline = pipeline.resize(maxWidth, null, { withoutEnlargement: true });
  }
  await pipeline.webp({ quality: 75 }).toFile(outputPath);
}

async function compressVideo(inputPath: string, outputPath: string, maxWidth?: number): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const args = ["-y", "-i", inputPath, "-c:v", "libx264", "-crf", "28", "-preset", "fast", "-c:a", "aac", "-b:a", "128k"];
  if (maxWidth && maxWidth > 0) {
    args.push("-vf", `scale='min(${maxWidth},iw)':-2`);
  }
  args.push(outputPath);

  await $`${ffmpegPath} ${args}`.quiet();
}

async function processFile(file: MediaFile, outputDir: string, maxWidth?: number): Promise<number> {
  const ext = file.type === "image" ? ".webp" : ".mp4";
  const outputRelative = file.relativePath.replace(/\.[^.]+$/, ext);
  const outputPath = join(outputDir, outputRelative);

  if (file.type === "image") {
    await compressImage(file.path, outputPath, maxWidth);
  } else {
    await compressVideo(file.path, outputPath, maxWidth);
  }

  const outputStat = await stat(outputPath);
  return outputStat.size;
}

async function getFolderFromCli(): Promise<string | null> {
  const cliPath = process.argv[2];
  if (!cliPath) return null;

  const folderPath = normalizePath(cliPath);
  if (!(await verifyFolder(folderPath))) {
    console.error("Error: Invalid folder path");
    process.exit(1);
  }
  return folderPath;
}

async function getFolderInteractive(): Promise<string> {
  p.intro("img4web");

  const input = await p.text({
    message: "Drop a folder",
    placeholder: "drag & drop here, then press enter",
    validate: (val) => {
      if (!val?.trim()) return "Please provide a path";
    },
  });

  if (p.isCancel(input)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const folderPath = normalizePath(input as string);
  if (!(await verifyFolder(folderPath))) {
    p.log.error("Invalid folder path");
    process.exit(1);
  }
  return folderPath;
}

async function getModeInteractive(): Promise<"fast" | "custom"> {
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
  return mode as "fast" | "custom";
}

async function getMaxWidthInteractive(file: MediaFile): Promise<number> {
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
  return maxWidth as number;
}

async function loadDimensions(media: MediaFile[]): Promise<void> {
  for (const file of media) {
    if (file.type === "image") {
      const metadata = await sharp(file.path).metadata();
      file.width = metadata.width;
      file.height = metadata.height;
    } else {
      const dims = await getVideoDimensions(file.path);
      file.width = dims.width;
      file.height = dims.height;
    }
  }
}

async function main() {
  const cliFolder = await getFolderFromCli();
  const isCliMode = !!cliFolder;
  const folderPath = cliFolder ?? (await getFolderInteractive());
  const log = createLogger(isCliMode);

  const allMedia = await findMedia(folderPath, folderPath);
  if (allMedia.length === 0) {
    log.error("No images or videos found");
    process.exit(1);
  }

  const images = allMedia.filter((m) => m.type === "image");
  const videos = allMedia.filter((m) => m.type === "video");
  const totalSize = allMedia.reduce((sum, m) => sum + m.size, 0);

  log.info(`Found ${images.length} images, ${videos.length} videos (${formatBytes(totalSize)})`);

  const mode = isCliMode ? "fast" : await getModeInteractive();
  if (mode === "custom") await loadDimensions(allMedia);

  const outputDir = join(dirname(folderPath), `${basename(folderPath)}-compressed`);
  await mkdir(outputDir, { recursive: true });

  let totalOriginal = 0;
  let totalCompressed = 0;

  for (let i = 0; i < allMedia.length; i++) {
    const file = allMedia[i]!;
    const maxWidth = mode === "custom" ? await getMaxWidthInteractive(file) : undefined;

    log.progress(`${file.name} (${i + 1}/${allMedia.length})`);

    const compressedSize = await processFile(file, outputDir, maxWidth);
    totalOriginal += file.size;
    totalCompressed += compressedSize;

    if (mode === "custom") {
      const saved = ((1 - compressedSize / file.size) * 100).toFixed(0);
      log.success(`→ ${formatBytes(compressedSize)} (${saved}% smaller)`);
    }
  }

  log.done();

  const percent = ((1 - totalCompressed / totalOriginal) * 100).toFixed(0);
  log.success(`${formatBytes(totalOriginal)} → ${formatBytes(totalCompressed)} (${percent}% smaller)`);
  log.info(`Output: ${outputDir}`);

  if (!isCliMode) p.outro("Done!");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
