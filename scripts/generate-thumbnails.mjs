#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const SOURCE_LIBRARY_DIR = path.join(ROOT, "assets_library");
const TARGET_DIR = path.join(ROOT, "assets_library/thumbnails");
const RENDERER_PATH = path.join(ROOT, "scripts/thumbnail-renderer.html");
const PORT = 4177;
const HOST = "127.0.0.1";
const THUMBNAIL_LIMIT = Number(process.env.THUMBNAIL_LIMIT || 0);

const toPosixPath = (value) => value.split(path.sep).join("/");

const safeCollectionId = (name) => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
};

const listGltfFilesRecursive = async (directory, baseDirectory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await listGltfFilesRecursive(absolutePath, baseDirectory);
      }
      if (entry.isFile() && entry.name.endsWith(".gltf")) {
        const relative = path.relative(baseDirectory, absolutePath);
        return [toPosixPath(relative)];
      }
      return [];
    }),
  );
  return nested.flat().sort((a, b) => a.localeCompare(b));
};

const createStaticServer = () => {
  return createServer(async (req, res) => {
    try {
      const rawUrl = req.url || "/";
      const url = new URL(rawUrl, `http://${HOST}:${PORT}`);
      let relativePath = decodeURIComponent(url.pathname);
      if (relativePath === "/") relativePath = "/scripts/thumbnail-renderer.html";
      const normalized = path.posix.normalize(relativePath);
      if (!normalized.startsWith("/") || normalized.includes("..")) {
        res.statusCode = 400;
        res.end("Bad request");
        return;
      }

      const absolutePath = path.join(ROOT, normalized.slice(1));
      if (!absolutePath.startsWith(ROOT)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      const content = await readFile(absolutePath);
      const ext = path.extname(absolutePath).toLowerCase();
      res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
};

const ensureRendererExists = async () => {
  await readFile(RENDERER_PATH, "utf-8");
};

const waitForReady = async (page) => {
  await page.waitForFunction(() => document.body?.dataset?.ready === "1" || document.body?.dataset?.error === "1", {
    timeout: 30000,
  });
  const hasError = await page.evaluate(() => document.body?.dataset?.error === "1");
  if (hasError) {
    const detail = await page.evaluate(() => window.__thumbError || "Unknown renderer error");
    throw new Error(String(detail));
  }
};

const generate = async () => {
  await ensureRendererExists();
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });

  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });

  let total = 0;
  let failed = 0;

  try {
    const rootEntries = await readdir(SOURCE_LIBRARY_DIR, { withFileTypes: true });
    const collectionDirs = rootEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

    for (const collectionDir of collectionDirs) {
      const collectionName = collectionDir.name;
      const collectionId = safeCollectionId(collectionName);
      const sourceCollectionPath = path.join(SOURCE_LIBRARY_DIR, collectionName);
      const targetCollectionPath = path.join(TARGET_DIR, collectionId);
      await mkdir(targetCollectionPath, { recursive: true });

      const assets = await listGltfFilesRecursive(sourceCollectionPath, sourceCollectionPath);
      for (const assetPath of assets) {
        if (THUMBNAIL_LIMIT > 0 && total + failed >= THUMBNAIL_LIMIT) break;
        const modelPath = `/assets_library/${encodeURIComponent(collectionName)}/${assetPath
          .split("/")
          .map((part) => encodeURIComponent(part))
          .join("/")}`;
        const pageUrl = `http://${HOST}:${PORT}/scripts/thumbnail-renderer.html?model=${encodeURIComponent(modelPath)}`;
        const outputRelative = assetPath.replace(/\.gltf$/i, ".png");
        const outputAbsolute = path.join(targetCollectionPath, outputRelative);

        try {
          await page.goto(pageUrl, { waitUntil: "networkidle" });
          await waitForReady(page);
          const base64 = await page.evaluate(() => {
            const canvas = document.querySelector("canvas");
            if (!(canvas instanceof HTMLCanvasElement)) return "";
            return canvas.toDataURL("image/png");
          });
          if (!base64.startsWith("data:image/png;base64,")) {
            throw new Error("Renderer did not produce PNG data.");
          }
          const buffer = Buffer.from(base64.replace("data:image/png;base64,", ""), "base64");
          await mkdir(path.dirname(outputAbsolute), { recursive: true });
          await writeFile(outputAbsolute, buffer);
          total += 1;
        } catch (error) {
          failed += 1;
          console.error(`Failed thumbnail for ${collectionName}/${assetPath}:`, error instanceof Error ? error.message : error);
        }
      }
      if (THUMBNAIL_LIMIT > 0 && total + failed >= THUMBNAIL_LIMIT) break;
    }
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  console.log(`Generated ${total} 3D thumbnails in ${TARGET_DIR}`);
  if (THUMBNAIL_LIMIT > 0) {
    console.log(`Limit applied: ${THUMBNAIL_LIMIT}`);
  }
  if (failed > 0) {
    console.log(`Failed: ${failed} assets`);
    process.exitCode = 1;
  }
};

generate().catch((error) => {
  console.error("Failed to generate thumbnails:", error);
  process.exit(1);
});
