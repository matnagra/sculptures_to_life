import { readdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CollectionResponse = {
  source: "public" | "root";
  id: string;
  thumbnailCollectionId: string;
  name: string;
  assets: string[];
};

const ROOT_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "assets_library");

const toPosixPath = (value: string) => value.split(path.sep).join("/");

const isSupportedModelFile = (fileName: string) => fileName.endsWith(".gltf") || fileName.endsWith(".glb");

const listModelFilesRecursive = async (directory: string, baseDirectory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await listModelFilesRecursive(absolutePath, baseDirectory);
      }
      if (entry.isFile() && isSupportedModelFile(entry.name)) {
        const relative = path.relative(baseDirectory, absolutePath);
        return [toPosixPath(relative)];
      }
      return [];
    }),
  );
  return nested.flat().sort((a, b) => a.localeCompare(b));
};

const safeCollectionId = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

const readCollections = async (
  source: "public" | "root",
  basePath: string,
  idPrefix = "",
): Promise<CollectionResponse[]> => {
  try {
    const entries = await readdir(basePath, { withFileTypes: true });
    const collectionDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name !== "thumbnails")
      .sort((a, b) => a.name.localeCompare(b.name));

    const collections = await Promise.all(
      collectionDirs.map(async (directory): Promise<CollectionResponse> => {
        const collectionPath = path.join(basePath, directory.name);
        const assets = await listModelFilesRecursive(collectionPath, collectionPath);
        return {
          source,
          id: source === "public" ? directory.name : `${idPrefix}${safeCollectionId(directory.name)}`,
          thumbnailCollectionId: safeCollectionId(directory.name),
          name: directory.name,
          assets,
        };
      }),
    );

    return collections.filter((collection) => collection.assets.length > 0);
  } catch {
    return [];
  }
};

export async function GET() {
  try {
    const collections = await readCollections("root", ROOT_ASSETS_LIBRARY_DIR, "root-");

    return Response.json({ collections });
  } catch (error) {
    console.error("Failed to read assets library", error);
    return Response.json({ error: "No se pudo listar la libreria de assets." }, { status: 500 });
  }
}
