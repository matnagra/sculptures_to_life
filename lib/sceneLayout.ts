export type SceneAsset = {
  collection: string;
  file: string;
  sourceCollection?: string;
  position: [number, number, number];
  rotationZ?: number;
  scale?: number;
};

export type SceneLayout = {
  assets: SceneAsset[];
};

const MAX_ASSETS = 300;
const MAX_FILE_LENGTH = 320;
const MAX_COLLECTION_LENGTH = 120;
const MAX_SOURCE_COLLECTION_LENGTH = 180;

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const isPosition = (value: unknown): value is [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) return false;
  return value.every(isFiniteNumber);
};

const isSafeSegment = (value: string): boolean => {
  if (value.includes("..") || value.includes("/") || value.includes("\\")) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
};

const isSafeRelativePath = (value: string): boolean => {
  if (value.includes("..") || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && /^[A-Za-z0-9._-]+$/.test(part));
};

const isSafeCollectionName = (value: string): boolean => {
  if (!value || value.length > MAX_SOURCE_COLLECTION_LENGTH) return false;
  if (value.includes("\0") || value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return true;
};

const isValidAsset = (value: unknown): value is SceneAsset => {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<SceneAsset>;

  if (typeof asset.collection !== "string" || asset.collection.length === 0 || asset.collection.length > MAX_COLLECTION_LENGTH) {
    return false;
  }
  if (!isSafeSegment(asset.collection)) return false;

  if (typeof asset.file !== "string" || asset.file.length === 0 || asset.file.length > MAX_FILE_LENGTH) {
    return false;
  }
  if (!asset.file.endsWith(".gltf")) return false;
  if (!isSafeRelativePath(asset.file)) return false;
  if (asset.sourceCollection !== undefined && (typeof asset.sourceCollection !== "string" || !isSafeCollectionName(asset.sourceCollection))) {
    return false;
  }

  if (!isPosition(asset.position)) return false;
  if (asset.rotationZ !== undefined && !isFiniteNumber(asset.rotationZ)) return false;
  if (asset.scale !== undefined && !isFiniteNumber(asset.scale)) return false;

  return true;
};

export const sanitizeSceneLayout = (input: unknown): SceneLayout | null => {
  if (!input || typeof input !== "object") return null;
  const payload = input as Partial<SceneLayout>;
  if (!Array.isArray(payload.assets) || payload.assets.length > MAX_ASSETS) return null;
  if (!payload.assets.every(isValidAsset)) return null;

  return {
    assets: payload.assets.map((asset) => ({
      collection: asset.collection,
      file: asset.file,
      sourceCollection: asset.sourceCollection,
      position: [...asset.position] as [number, number, number],
      rotationZ: asset.rotationZ,
      scale: asset.scale,
    })),
  };
};
