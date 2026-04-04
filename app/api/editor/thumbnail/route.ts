import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clampText = (value: string, max: number): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
};

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const safeText = (value: string): string => {
  return value.replace(/[<>&"']/g, (match) => {
    if (match === "<") return "&lt;";
    if (match === ">") return "&gt;";
    if (match === "&") return "&amp;";
    if (match === '"') return "&quot;";
    return "&#39;";
  });
};

const safeCollectionId = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
};

const isSafeCollectionId = (value: string): boolean => {
  return /^[a-z0-9-]{1,80}$/.test(value);
};

const normalizeAssetPath = (input: string): string | null => {
  if (!input || input.includes("\0") || input.includes("\\")) return null;
  const normalized = path.posix.normalize(input);
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
};

const detectContentType = (filePath: string): string => {
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "image/svg+xml; charset=utf-8";
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const collection = clampText(url.searchParams.get("collection") ?? "collection", 72);
  const collectionIdParam = url.searchParams.get("collectionId") ?? "";
  const rawAsset = url.searchParams.get("asset") ?? "asset.gltf";
  const normalizedAsset = normalizeAssetPath(rawAsset);
  const asset = clampText(normalizedAsset ?? "asset.gltf", 120);
  const base = asset.split("/").pop() ?? asset;
  const title = clampText(base.replace(/\.gl(?:tf|b)$/i, ""), 20);
  const hash = hashString(`${collection}:${asset}`);
  const hue = hash % 360;

  if (normalizedAsset) {
    const collectionId = isSafeCollectionId(collectionIdParam) ? collectionIdParam : safeCollectionId(collection);
    const baseNoExt = normalizedAsset.replace(/\.gl(?:tf|b)$/i, "");
    const candidates = [".webp", ".png", ".jpg", ".jpeg", ".svg"];
    for (const ext of candidates) {
      const relativeThumb = `${baseNoExt}${ext}`;
      const absoluteThumb = path.join(process.cwd(), "assets_library/thumbnails", collectionId, relativeThumb);
      try {
        const content = await readFile(absoluteThumb);
        return new Response(content, {
          headers: {
            "Content-Type": detectContentType(relativeThumb),
            "Cache-Control": "no-store",
          },
        });
      } catch {
        // fallback below
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${safeText(title)}">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 75% 48%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 42) % 360} 75% 32%)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="96" height="96" rx="12" fill="#0f172a"/>
  <rect x="5" y="5" width="86" height="86" rx="10" fill="url(#g)" opacity="0.9"/>
  <rect x="12" y="14" width="72" height="46" rx="8" fill="rgba(2,6,23,0.28)" stroke="rgba(255,255,255,0.3)"/>
  <path d="M26 44l13-14 10 10 7-8 14 12" stroke="rgba(255,255,255,0.84)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="48" y="71" text-anchor="middle" fill="#e2e8f0" font-size="10" font-family="Arial, sans-serif">${safeText(title)}</text>
  <text x="48" y="84" text-anchor="middle" fill="rgba(226,232,240,0.8)" font-size="7" font-family="Arial, sans-serif">${safeText(clampText(collection, 22))}</text>
</svg>`;

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
