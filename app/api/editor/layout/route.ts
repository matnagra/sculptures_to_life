import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SceneAsset } from "@/lib/sceneLayout";
import { sanitizeSceneLayout } from "@/lib/sceneLayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENES_DIR = path.join(process.cwd(), "public/assets/scenes");
const LAYOUT_FILE_PATH = path.join(SCENES_DIR, "house-layout.json");
const ROOT_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "assets_library");
const PUBLIC_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "public/assets/models/assets_library");
const MOBILE_TEXTURE_MAX_SIZE = 512;
const MOBILE_TEXTURE_QUALITY = 62;

type ParsedGltf = {
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string }>;
};

const toPosixPath = (value: string) => value.split(path.sep).join("/");

const normalizeSafeRelativePath = (input: string): string | null => {
  if (!input || input.includes("\0") || input.includes("\\")) return null;
  const normalized = path.posix.normalize(input);
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
};

const resolveInside = (base: string, relativePath: string): string => {
  const absolute = path.resolve(base, relativePath);
  const relativeFromBase = path.relative(base, absolute);
  if (relativeFromBase.startsWith("..") || path.isAbsolute(relativeFromBase)) {
    throw new Error("Path fuera de rango.");
  }
  return absolute;
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const safeCollectionId = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

const parseGltf = (gltfJson: string): ParsedGltf => {
  return JSON.parse(gltfJson) as ParsedGltf;
};

const isOptimizableImageUri = (uri: string) => /\.(png|jpe?g|webp)$/i.test(uri);

const toOptimizedImageRelativePath = (relativeFile: string) => {
  return relativeFile.replace(/\.(png|jpe?g|webp)$/i, ".webp");
};

const copyKeepingRelativePath = async (sourceCollectionDir: string, targetCollectionDir: string, relativeFile: string) => {
  const sourceAbsolute = resolveInside(sourceCollectionDir, relativeFile);
  const targetAbsolute = resolveInside(targetCollectionDir, relativeFile);
  await mkdir(path.dirname(targetAbsolute), { recursive: true });
  await copyFile(sourceAbsolute, targetAbsolute);
};

const optimizeImageIntoPublicLibrary = async (
  sourceCollectionDir: string,
  targetCollectionDir: string,
  relativeFile: string,
) => {
  const sourceAbsolute = resolveInside(sourceCollectionDir, relativeFile);
  const optimizedRelative = toOptimizedImageRelativePath(relativeFile);
  const targetAbsolute = resolveInside(targetCollectionDir, optimizedRelative);
  await mkdir(path.dirname(targetAbsolute), { recursive: true });
  await sharp(sourceAbsolute)
    .rotate()
    .resize(MOBILE_TEXTURE_MAX_SIZE, MOBILE_TEXTURE_MAX_SIZE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: MOBILE_TEXTURE_QUALITY, effort: 4 })
    .toFile(targetAbsolute);
  return optimizedRelative;
};

const exportOptimizedAssetToPublicLibrary = async (asset: SceneAsset) => {
  const targetCollectionDir = resolveInside(PUBLIC_ASSETS_LIBRARY_DIR, asset.collection);
  const sourceCollection = asset.sourceCollection ?? asset.collection;
  const sourceCollectionDir = resolveInside(ROOT_ASSETS_LIBRARY_DIR, sourceCollection);
  const sourceGltfPath = resolveInside(sourceCollectionDir, asset.file);
  if (!(await pathExists(sourceGltfPath))) {
    throw new Error(`No existe el source para ${asset.collection}/${asset.file}`);
  }

  const gltfContent = await readFile(sourceGltfPath, "utf-8");
  const parsed = parseGltf(gltfContent);
  const gltfParent = path.posix.dirname(asset.file);

  for (const buffer of parsed.buffers ?? []) {
    const uri = buffer.uri ?? "";
    if (!uri || uri.startsWith("data:")) continue;
    const dependencyRelative = normalizeSafeRelativePath(path.posix.join(gltfParent, uri));
    if (!dependencyRelative) continue;
    await copyKeepingRelativePath(sourceCollectionDir, targetCollectionDir, dependencyRelative);
  }

  for (const image of parsed.images ?? []) {
    const uri = image.uri ?? "";
    if (!uri || uri.startsWith("data:")) continue;
    const dependencyRelative = normalizeSafeRelativePath(path.posix.join(gltfParent, uri));
    if (!dependencyRelative) continue;

    if (isOptimizableImageUri(uri)) {
      const optimizedRelative = await optimizeImageIntoPublicLibrary(sourceCollectionDir, targetCollectionDir, dependencyRelative);
      image.uri = path.posix.relative(gltfParent, optimizedRelative);
      continue;
    }

    await copyKeepingRelativePath(sourceCollectionDir, targetCollectionDir, dependencyRelative);
  }

  const targetGltfPath = resolveInside(targetCollectionDir, asset.file);
  await mkdir(path.dirname(targetGltfPath), { recursive: true });
  await writeFile(targetGltfPath, JSON.stringify(parsed), "utf-8");
};

const listFilesRecursive = async (directory: string, base: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await listFilesRecursive(absolutePath, base);
      }
      if (entry.isFile()) {
        const relativePath = path.relative(base, absolutePath);
        return [toPosixPath(relativePath)];
      }
      return [];
    }),
  );
  return nested.flat();
};

const removeEmptyDirectoriesRecursive = async (directory: string): Promise<void> => {
  if (!(await pathExists(directory))) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    await removeEmptyDirectoriesRecursive(child);
  }

  const refreshed = await readdir(directory, { withFileTypes: true });
  if (refreshed.length === 0 && directory !== PUBLIC_ASSETS_LIBRARY_DIR) {
    await rm(directory, { recursive: true, force: true });
  }
};

const syncPublicLibraryWithLayout = async (assets: SceneAsset[]) => {
  await mkdir(PUBLIC_ASSETS_LIBRARY_DIR, { recursive: true });

  const keepFiles = new Set<string>();

  const uniqueAssets = Array.from(
    new Map(
      assets.map((asset) => {
        const normalizedCollection = safeCollectionId(asset.sourceCollection ?? asset.collection);
        return [
          `${normalizedCollection}::${asset.file}`,
          { ...asset, collection: normalizedCollection },
        ];
      }),
    ).values(),
  );

  for (const asset of uniqueAssets) {
    await exportOptimizedAssetToPublicLibrary(asset);
    keepFiles.add(`${asset.collection}/${asset.file}`);

    const gltfPath = resolveInside(PUBLIC_ASSETS_LIBRARY_DIR, `${asset.collection}/${asset.file}`);
    const gltfContent = await readFile(gltfPath, "utf-8");
    const parsed = parseGltf(gltfContent);
    const gltfParent = path.posix.dirname(asset.file);

    for (const buffer of parsed.buffers ?? []) {
      const uri = buffer.uri ?? "";
      if (!uri || uri.startsWith("data:")) continue;
      const dependencyRelative = normalizeSafeRelativePath(path.posix.join(gltfParent, uri));
      if (!dependencyRelative) continue;
      keepFiles.add(`${asset.collection}/${dependencyRelative}`);
    }

    for (const image of parsed.images ?? []) {
      const uri = image.uri ?? "";
      if (!uri || uri.startsWith("data:")) continue;
      const dependencyRelative = normalizeSafeRelativePath(path.posix.join(gltfParent, uri));
      if (!dependencyRelative) continue;
      keepFiles.add(`${asset.collection}/${dependencyRelative}`);
    }
  }

  const existingFiles = await listFilesRecursive(PUBLIC_ASSETS_LIBRARY_DIR, PUBLIC_ASSETS_LIBRARY_DIR);
  const filesToDelete = existingFiles.filter((relativePath) => !keepFiles.has(relativePath));
  await Promise.all(filesToDelete.map((relativePath) => rm(resolveInside(PUBLIC_ASSETS_LIBRARY_DIR, relativePath), { force: true })));
  await removeEmptyDirectoriesRecursive(PUBLIC_ASSETS_LIBRARY_DIR);
};

const readLayout = async () => {
  const raw = await readFile(LAYOUT_FILE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return sanitizeSceneLayout(parsed);
};

export async function GET() {
  try {
    const layout = await readLayout();
    if (!layout) {
      return Response.json({ error: "El layout guardado es invalido." }, { status: 500 });
    }

    return Response.json(layout);
  } catch (error) {
    console.error("Failed to read editor layout", error);
    return Response.json({ error: "No se pudo leer el layout." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as unknown;
    const sanitizedLayout = sanitizeSceneLayout(payload);
    if (!sanitizedLayout) {
      return Response.json({ error: "Payload invalido." }, { status: 400 });
    }
    const layout = {
      ...sanitizedLayout,
      assets: sanitizedLayout.assets.map((asset) => ({
        ...asset,
        collection: safeCollectionId(asset.sourceCollection ?? asset.collection),
      })),
    };

    await mkdir(SCENES_DIR, { recursive: true });
    const json = `${JSON.stringify(layout, null, 2)}\n`;
    const tmpFilePath = `${LAYOUT_FILE_PATH}.tmp`;
    await writeFile(tmpFilePath, json, "utf-8");
    await rename(tmpFilePath, LAYOUT_FILE_PATH);
    await syncPublicLibraryWithLayout(layout.assets);

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Failed to write editor layout", error);
    return Response.json({ error: "No se pudo guardar el layout." }, { status: 500 });
  }
}
