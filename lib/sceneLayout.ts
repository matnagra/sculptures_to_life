export type SceneAsset = {
  collection: string;
  file: string;
  sourceCollection?: string;
  groupId?: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  rotationZ?: number;
  scale?: number;
  scale3?: [number, number, number];
};

export type SceneGroup = {
  id: string;
  name: string;
  parentId?: string;
};

export type SceneLayout = {
  assets: SceneAsset[];
  groups?: SceneGroup[];
};

const MAX_ASSETS = 300;
const MAX_FILE_LENGTH = 320;
const MAX_COLLECTION_LENGTH = 120;
const MAX_SOURCE_COLLECTION_LENGTH = 180;
const MAX_GROUPS = 300;
const MAX_GROUP_ID_LENGTH = 80;
const MAX_GROUP_NAME_LENGTH = 80;

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const isPosition = (value: unknown): value is [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) return false;
  return value.every(isFiniteNumber);
};

const isRotation = (value: unknown): value is [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) return false;
  return value.every(isFiniteNumber);
};

const isScale3 = (value: unknown): value is [number, number, number] => {
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

const isSafeGroupId = (value: string): boolean => {
  if (!value || value.length > MAX_GROUP_ID_LENGTH) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
};

const isSafeGroupName = (value: string): boolean => {
  if (!value || value.length > MAX_GROUP_NAME_LENGTH) return false;
  if (value.includes("\0")) return false;
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
  if (asset.groupId !== undefined && (typeof asset.groupId !== "string" || !isSafeGroupId(asset.groupId))) {
    return false;
  }

  if (!isPosition(asset.position)) return false;
  if (asset.rotation !== undefined && !isRotation(asset.rotation)) return false;
  if (asset.rotationZ !== undefined && !isFiniteNumber(asset.rotationZ)) return false;
  if (asset.scale !== undefined && !isFiniteNumber(asset.scale)) return false;
  if (asset.scale3 !== undefined && !isScale3(asset.scale3)) return false;

  return true;
};

const isValidGroup = (value: unknown): value is SceneGroup => {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<SceneGroup>;
  if (typeof group.id !== "string" || !isSafeGroupId(group.id)) return false;
  if (typeof group.name !== "string" || !isSafeGroupName(group.name)) return false;
  if (group.parentId !== undefined && (typeof group.parentId !== "string" || !isSafeGroupId(group.parentId))) return false;
  return true;
};

export const sanitizeSceneLayout = (input: unknown): SceneLayout | null => {
  if (!input || typeof input !== "object") return null;
  const payload = input as Partial<SceneLayout>;
  if (!Array.isArray(payload.assets) || payload.assets.length > MAX_ASSETS) return null;
  if (!payload.assets.every(isValidAsset)) return null;
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  if (groups.length > MAX_GROUPS) return null;
  if (!groups.every(isValidGroup)) return null;

  const groupIdSet = new Set(groups.map((group) => group.id));
  if (groupIdSet.size !== groups.length) return null;
  if (groups.some((group) => group.parentId !== undefined && !groupIdSet.has(group.parentId))) return null;
  if (payload.assets.some((asset) => asset.groupId !== undefined && !groupIdSet.has(asset.groupId))) return null;

  return {
    assets: payload.assets.map((asset) => ({
      collection: asset.collection,
      file: asset.file,
      sourceCollection: asset.sourceCollection,
      groupId: asset.groupId,
      position: [...asset.position] as [number, number, number],
      rotation: asset.rotation ? [...asset.rotation] as [number, number, number] : undefined,
      rotationZ: asset.rotation ? undefined : asset.rotationZ,
      scale: asset.scale3 ? undefined : asset.scale,
      scale3: asset.scale3 ? [...asset.scale3] as [number, number, number] : undefined,
    })),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      parentId: group.parentId,
    })),
  };
};
