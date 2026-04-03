import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SceneAsset } from "@/lib/sceneLayout";
import { sanitizeSceneLayout } from "@/lib/sceneLayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENES_DIR = path.join(process.cwd(), "public/assets/scenes");
const LAYOUT_FILE_PATH = path.join(SCENES_DIR, "house-layout.json");
const ROOT_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "assets_library");
const PUBLIC_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "public/assets/models/assets_library");

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

const extractDependencyUris = (gltfJson: string): string[] => {
  try {
    const parsed = JSON.parse(gltfJson) as {
      buffers?: Array<{ uri?: string }>;
      images?: Array<{ uri?: string }>;
    };
    const uris = [...(parsed.buffers ?? []), ...(parsed.images ?? [])]
      .map((entry) => entry.uri ?? "")
      .filter((uri) => uri && !uri.startsWith("data:"));
    return Array.from(new Set(uris));
  } catch {
    return [];
  }
};

const copyKeepingRelativePath = async (sourceCollectionDir: string, targetCollectionDir: string, relativeFile: string) => {
  const sourceAbsolute = resolveInside(sourceCollectionDir, relativeFile);
  const targetAbsolute = resolveInside(targetCollectionDir, relativeFile);
  await mkdir(path.dirname(targetAbsolute), { recursive: true });
  const sourceContent = await readFile(sourceAbsolute);
  await writeFile(targetAbsolute, sourceContent);
};

const ensureAssetInPublicLibrary = async (asset: SceneAsset) => {
  const targetCollectionDir = resolveInside(PUBLIC_ASSETS_LIBRARY_DIR, asset.collection);
  const targetGltfPath = resolveInside(targetCollectionDir, asset.file);
  if (await pathExists(targetGltfPath)) return;

  const sourceCollection = asset.sourceCollection ?? asset.collection;
  const sourceCollectionDir = resolveInside(ROOT_ASSETS_LIBRARY_DIR, sourceCollection);
  const sourceGltfPath = resolveInside(sourceCollectionDir, asset.file);
  if (!(await pathExists(sourceGltfPath))) {
    throw new Error(`No existe el source para ${asset.collection}/${asset.file}`);
  }

  await copyKeepingRelativePath(sourceCollectionDir, targetCollectionDir, asset.file);

  const gltfContent = await readFile(sourceGltfPath, "utf-8");
  const dependencyUris = extractDependencyUris(gltfContent);
  const gltfParent = path.posix.dirname(asset.file);
  for (const uri of dependencyUris) {
    const dependencyRelative = normalizeSafeRelativePath(path.posix.join(gltfParent, uri));
    if (!dependencyRelative) continue;
    await copyKeepingRelativePath(sourceCollectionDir, targetCollectionDir, dependencyRelative);
  }
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

  for (const asset of assets) {
    await ensureAssetInPublicLibrary(asset);
  }

  const keepFiles = new Set<string>();
  for (const asset of assets) {
    keepFiles.add(`${asset.collection}/${asset.file}`);
  }

  for (const asset of assets) {
    const gltfPath = resolveInside(PUBLIC_ASSETS_LIBRARY_DIR, `${asset.collection}/${asset.file}`);
    if (!(await pathExists(gltfPath))) continue;
    const gltfContent = await readFile(gltfPath, "utf-8");
    const dependencyUris = extractDependencyUris(gltfContent);
    const gltfParent = path.posix.dirname(asset.file);
    for (const uri of dependencyUris) {
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
    const layout = sanitizeSceneLayout(payload);
    if (!layout) {
      return Response.json({ error: "Payload invalido." }, { status: 400 });
    }

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
