import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT_ASSETS_LIBRARY_DIR = path.join(process.cwd(), "assets_library");

const resolveInside = (base: string, relativePath: string): string => {
  const absolute = path.resolve(base, relativePath);
  const relativeFromBase = path.relative(base, absolute);
  if (relativeFromBase.startsWith("..") || path.isAbsolute(relativeFromBase)) {
    throw new Error("Path fuera de rango.");
  }
  return absolute;
};

const contentTypeFor = (assetPath: string) => {
  const ext = path.extname(assetPath).toLowerCase();
  switch (ext) {
    case ".gltf":
      return "model/gltf+json; charset=utf-8";
    case ".bin":
      return "application/octet-stream";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string; assetPath: string[] }> },
) {
  try {
    const { collection, assetPath } = await context.params;
    const collectionDir = resolveInside(ROOT_ASSETS_LIBRARY_DIR, collection);
    const relativeAssetPath = assetPath.join("/");
    const absoluteFilePath = resolveInside(collectionDir, relativeAssetPath);
    const content = await readFile(absoluteFilePath);

    return new Response(content, {
      headers: {
        "Content-Type": contentTypeFor(relativeAssetPath),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to read editor model", error);
    return new Response("Not found", { status: 404 });
  }
}
