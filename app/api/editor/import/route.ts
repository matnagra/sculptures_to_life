import { stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "assets_library");

type ImportPayload = {
  source: "public" | "root";
  id: string;
  name: string;
  assetPath: string;
};

const normalizeSafeRelativePath = (input: string): string | null => {
  if (!input || input.includes("\0") || input.includes("\\")) return null;
  const normalized = path.posix.normalize(input);
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
};

const safeCollectionId = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

const resolveInside = (base: string, relativePath: string): string => {
  const absolute = path.resolve(base, relativePath);
  const relativeFromBase = path.relative(base, absolute);
  if (relativeFromBase.startsWith("..") || path.isAbsolute(relativeFromBase)) {
    throw new Error("Path fuera de rango.");
  }
  return absolute;
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Partial<ImportPayload>;
    const source = payload.source;
    const collectionName = typeof payload.name === "string" ? payload.name : "";
    const assetPathRaw = typeof payload.assetPath === "string" ? payload.assetPath : "";
    const assetPath = normalizeSafeRelativePath(assetPathRaw);

    if (!source || (source !== "public" && source !== "root")) {
      return Response.json({ error: "Source invalido." }, { status: 400 });
    }
    if (!collectionName || !assetPath || (!assetPath.endsWith(".gltf") && !assetPath.endsWith(".glb"))) {
      return Response.json({ error: "Payload invalido." }, { status: 400 });
    }

    if (source === "public") {
      return Response.json({
        collection: payload.id || collectionName,
        file: assetPath,
        sourceCollection: collectionName,
      });
    }

    const sourceCollectionDir = resolveInside(ROOT_ASSETS_LIBRARY_DIR, collectionName);
    const sourceAssetAbsolute = resolveInside(sourceCollectionDir, assetPath);
    await stat(sourceAssetAbsolute);

    const targetCollection = safeCollectionId(collectionName);

    return Response.json({
      collection: targetCollection,
      file: assetPath,
      sourceCollection: collectionName,
    });
  } catch (error) {
    console.error("Failed to import asset", error);
    return Response.json({ error: "No se pudo importar el asset." }, { status: 500 });
  }
}
