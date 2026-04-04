import * as THREE from "three";
import { fromThreePosition, fromThreeRotation, fromThreeScale, toThreePosition, toThreeScale } from "@/components/ar/createScene";

export type SceneAsset = {
  id?: string;
  collection: string;
  file: string;
  kind?: "model" | "occluder";
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

export type EditorSceneAsset = SceneAsset & {
  id: string;
};

export type OwnCollectionDefinition = {
  id: string;
  name: string;
  assets: EditorSceneAsset[];
  groups?: SceneGroup[];
};

export type OwnCollectionInstance = {
  id: string;
  ownCollectionId: string;
  name?: string;
  parentId?: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  rotationZ?: number;
  scale?: number;
  scale3?: [number, number, number];
};

export type SceneEditorData = {
  sceneAssets: EditorSceneAsset[];
  sceneGroups: SceneGroup[];
  ownCollections: OwnCollectionDefinition[];
  collectionInstances: OwnCollectionInstance[];
};

export type ResolvedSceneAssetSource =
  | { kind: "sceneAsset"; assetId: string }
  | { kind: "collectionInstance"; instanceId: string; collectionId: string; assetId: string };

export type ResolvedSceneAsset = SceneAsset & {
  source: ResolvedSceneAssetSource;
};

export type ResolvedSceneData = {
  assets: ResolvedSceneAsset[];
};

export type SceneLayout = {
  assets: SceneAsset[];
  groups?: SceneGroup[];
  editor?: SceneEditorData;
};

export type SceneAssetKind = NonNullable<SceneAsset["kind"]>;

export const LAYOUT_EULER_ORDER: THREE.EulerOrder = "YXZ";

const MAX_ASSETS = 1000;
const MAX_FILE_LENGTH = 320;
const MAX_COLLECTION_LENGTH = 120;
const MAX_SOURCE_COLLECTION_LENGTH = 180;
const MAX_GROUPS = 1000;
const MAX_GROUP_ID_LENGTH = 80;
const MAX_GROUP_NAME_LENGTH = 80;
const MAX_OWN_COLLECTIONS = 300;
const MAX_INSTANCES = 1000;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isPosition = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const isRotation = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const isScale3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

const isSafeSegment = (value: string): boolean => !value.includes("..") && !value.includes("/") && !value.includes("\\") && /^[A-Za-z0-9._-]+$/.test(value);
const isSafeRelativePath = (value: string): boolean =>
  !value.includes("..") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  value.split("/").every((part) => part.length > 0 && /^[A-Za-z0-9._-]+$/.test(part));
const isSafeCollectionName = (value: string): boolean =>
  Boolean(value) && value.length <= MAX_SOURCE_COLLECTION_LENGTH && !value.includes("\0") && !value.includes("/") && !value.includes("\\") && !value.includes("..");
const isSafeEntityId = (value: string): boolean => Boolean(value) && value.length <= MAX_GROUP_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
const isSafeGroupName = (value: string): boolean => Boolean(value) && value.length <= MAX_GROUP_NAME_LENGTH && !value.includes("\0");

export const cloneSceneAsset = <T extends SceneAsset>(asset: T): T => ({
  ...asset,
  position: [...asset.position] as [number, number, number],
  rotation: asset.rotation ? [...asset.rotation] as [number, number, number] : undefined,
  rotationZ: asset.rotation ? undefined : asset.rotationZ,
  scale: asset.scale3 ? undefined : asset.scale,
  scale3: asset.scale3 ? [...asset.scale3] as [number, number, number] : undefined,
});

const inferOccluderFromCollection = (asset: Pick<SceneAsset, "collection" | "sourceCollection">) => {
  const collection = asset.collection.toLowerCase();
  const sourceCollection = asset.sourceCollection?.toLowerCase() ?? "";
  return collection === "occluders" || sourceCollection === "occluders" || collection.includes("occluder") || sourceCollection.includes("occluder");
};

export const getSceneAssetKind = (
  asset: Pick<SceneAsset, "kind" | "collection" | "sourceCollection">,
): SceneAssetKind => {
  if (asset.kind) return asset.kind;
  return inferOccluderFromCollection(asset) ? "occluder" : "model";
};

export const cloneSceneGroup = (group: SceneGroup): SceneGroup => ({ ...group });

export const cloneOwnCollectionDefinition = (definition: OwnCollectionDefinition): OwnCollectionDefinition => ({
  id: definition.id,
  name: definition.name,
  assets: definition.assets.map((asset) => cloneSceneAsset(asset)),
  groups: (definition.groups ?? []).map(cloneSceneGroup),
});

export const cloneCollectionInstance = (instance: OwnCollectionInstance): OwnCollectionInstance => ({
  ...instance,
  position: [...instance.position] as [number, number, number],
  rotation: instance.rotation ? [...instance.rotation] as [number, number, number] : undefined,
  rotationZ: instance.rotation ? undefined : instance.rotationZ,
  scale: instance.scale3 ? undefined : instance.scale,
  scale3: instance.scale3 ? [...instance.scale3] as [number, number, number] : undefined,
});

export const cloneSceneEditorData = (editor: SceneEditorData): SceneEditorData => ({
  sceneAssets: editor.sceneAssets.map((asset) => cloneSceneAsset(asset)),
  sceneGroups: editor.sceneGroups.map(cloneSceneGroup),
  ownCollections: editor.ownCollections.map(cloneOwnCollectionDefinition),
  collectionInstances: editor.collectionInstances.map((instance) => cloneCollectionInstance(instance)),
});

const getNodeRotation = (node: Pick<SceneAsset, "rotation" | "rotationZ">): [number, number, number] => {
  if (node.rotation) return [...node.rotation] as [number, number, number];
  return [0, node.rotationZ ?? 0, 0];
};

const getNodeScale = (node: Pick<SceneAsset, "scale" | "scale3">): [number, number, number] => {
  if (node.scale3) return [...node.scale3] as [number, number, number];
  const uniform = node.scale ?? 1;
  return [uniform, uniform, uniform];
};

const writeObjectTransform = (
  object: THREE.Object3D,
  node: Pick<SceneAsset, "position" | "rotation" | "rotationZ" | "scale" | "scale3">,
) => {
  object.position.set(...toThreePosition(node.position));
  const [rx, ry, rz] = getNodeRotation(node);
  object.rotation.order = LAYOUT_EULER_ORDER;
  object.rotation.set(rx, ry, rz, LAYOUT_EULER_ORDER);
  object.scale.set(...toThreeScale(getNodeScale(node)));
};

export const matrixToSceneTransform = (matrix: THREE.Matrix4) => {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const object = new THREE.Object3D();
  object.position.copy(position);
  object.quaternion.copy(quaternion);
  object.scale.copy(scale);
  return {
    position: fromThreePosition(position),
    rotation: fromThreeRotation(object),
    scale3: fromThreeScale(object),
  };
};

const resolveInstanceAsset = (asset: EditorSceneAsset, instance: OwnCollectionInstance): SceneAsset => {
  const local = new THREE.Object3D();
  const parent = new THREE.Object3D();
  writeObjectTransform(local, asset);
  writeObjectTransform(parent, instance);
  parent.updateMatrixWorld(true);
  local.updateMatrixWorld(true);
  const worldMatrix = parent.matrixWorld.clone().multiply(local.matrix);
  const transform = matrixToSceneTransform(worldMatrix);
  return {
    collection: asset.collection,
    file: asset.file,
    sourceCollection: asset.sourceCollection,
    position: transform.position,
    rotation: transform.rotation,
    scale3: transform.scale3,
  };
};

export const getLocalAssetMatrix = (asset: Pick<SceneAsset, "position" | "rotation" | "rotationZ" | "scale" | "scale3">): THREE.Matrix4 => {
  const object = new THREE.Object3D();
  writeObjectTransform(object, asset);
  object.updateMatrix();
  return object.matrix.clone();
};

export const getCollectionInstanceMatrixFromWorldAsset = (
  localAsset: Pick<SceneAsset, "position" | "rotation" | "rotationZ" | "scale" | "scale3">,
  worldAsset: Pick<SceneAsset, "position" | "rotation" | "rotationZ" | "scale" | "scale3">,
) => {
  const localMatrix = getLocalAssetMatrix(localAsset);
  const worldMatrix = getLocalAssetMatrix(worldAsset);
  return matrixToSceneTransform(worldMatrix.multiply(localMatrix.invert()));
};

const sanitizeAsset = <T extends SceneAsset>(asset: T): T => cloneSceneAsset(asset);

const sanitizeGroup = (group: SceneGroup): SceneGroup => cloneSceneGroup(group);

const isValidAsset = (value: unknown, options?: { requireId?: boolean }): value is SceneAsset => {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<SceneAsset>;

  if (options?.requireId && (typeof asset.id !== "string" || !isSafeEntityId(asset.id))) return false;
  if (asset.id !== undefined && (typeof asset.id !== "string" || !isSafeEntityId(asset.id))) return false;
  if (asset.kind !== undefined && asset.kind !== "model" && asset.kind !== "occluder") return false;
  if (typeof asset.collection !== "string" || asset.collection.length === 0 || asset.collection.length > MAX_COLLECTION_LENGTH || !isSafeSegment(asset.collection)) {
    return false;
  }
  if (
    typeof asset.file !== "string" ||
    asset.file.length === 0 ||
    asset.file.length > MAX_FILE_LENGTH ||
    (!asset.file.endsWith(".gltf") && !asset.file.endsWith(".glb")) ||
    !isSafeRelativePath(asset.file)
  ) {
    return false;
  }
  if (asset.sourceCollection !== undefined && (typeof asset.sourceCollection !== "string" || !isSafeCollectionName(asset.sourceCollection))) return false;
  if (asset.groupId !== undefined && (typeof asset.groupId !== "string" || !isSafeEntityId(asset.groupId))) return false;
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
  return (
    typeof group.id === "string" &&
    isSafeEntityId(group.id) &&
    typeof group.name === "string" &&
    isSafeGroupName(group.name) &&
    (group.parentId === undefined || (typeof group.parentId === "string" && isSafeEntityId(group.parentId)))
  );
};

const isValidCollectionInstance = (value: unknown): value is OwnCollectionInstance => {
  if (!value || typeof value !== "object") return false;
  const instance = value as Partial<OwnCollectionInstance>;
  return (
    typeof instance.id === "string" &&
    isSafeEntityId(instance.id) &&
    typeof instance.ownCollectionId === "string" &&
    isSafeEntityId(instance.ownCollectionId) &&
    (instance.name === undefined || (typeof instance.name === "string" && isSafeGroupName(instance.name))) &&
    (instance.parentId === undefined || (typeof instance.parentId === "string" && isSafeEntityId(instance.parentId))) &&
    isPosition(instance.position) &&
    (instance.rotation === undefined || isRotation(instance.rotation)) &&
    (instance.rotationZ === undefined || isFiniteNumber(instance.rotationZ)) &&
    (instance.scale === undefined || isFiniteNumber(instance.scale)) &&
    (instance.scale3 === undefined || isScale3(instance.scale3))
  );
};

const isValidOwnCollectionDefinition = (value: unknown): value is OwnCollectionDefinition => {
  if (!value || typeof value !== "object") return false;
  const definition = value as Partial<OwnCollectionDefinition>;
  if (typeof definition.id !== "string" || !isSafeEntityId(definition.id)) return false;
  if (typeof definition.name !== "string" || !isSafeGroupName(definition.name)) return false;
  if (!Array.isArray(definition.assets) || definition.assets.length > MAX_ASSETS || !definition.assets.every((asset) => isValidAsset(asset, { requireId: true }))) {
    return false;
  }
  if (definition.groups !== undefined && (!Array.isArray(definition.groups) || definition.groups.length > MAX_GROUPS || !definition.groups.every(isValidGroup))) {
    return false;
  }
  return true;
};

const isValidEditorData = (value: unknown): value is SceneEditorData => {
  if (!value || typeof value !== "object") return false;
  const editor = value as Partial<SceneEditorData>;
  if (!Array.isArray(editor.sceneAssets) || editor.sceneAssets.length > MAX_ASSETS || !editor.sceneAssets.every((asset) => isValidAsset(asset, { requireId: true }))) {
    return false;
  }
  if (!Array.isArray(editor.sceneGroups) || editor.sceneGroups.length > MAX_GROUPS || !editor.sceneGroups.every(isValidGroup)) return false;
  if (!Array.isArray(editor.ownCollections) || editor.ownCollections.length > MAX_OWN_COLLECTIONS || !editor.ownCollections.every(isValidOwnCollectionDefinition)) {
    return false;
  }
  if (!Array.isArray(editor.collectionInstances) || editor.collectionInstances.length > MAX_INSTANCES || !editor.collectionInstances.every(isValidCollectionInstance)) {
    return false;
  }
  return true;
};

export const resolveSceneEditorData = (editor: SceneEditorData): ResolvedSceneData => {
  const collectionById = new Map(editor.ownCollections.map((collection) => [collection.id, collection]));
  const assets: ResolvedSceneAsset[] = editor.sceneAssets.map((asset) => ({
    ...cloneSceneAsset(asset),
    source: { kind: "sceneAsset", assetId: asset.id },
  }));

  editor.collectionInstances.forEach((instance) => {
    const definition = collectionById.get(instance.ownCollectionId);
    if (!definition) return;
    definition.assets.forEach((asset) => {
      const resolvedAsset = resolveInstanceAsset(asset, instance);
      assets.push({
        ...resolvedAsset,
        source: {
          kind: "collectionInstance",
          instanceId: instance.id,
          collectionId: definition.id,
          assetId: asset.id,
        },
      });
    });
  });

  return { assets };
};

export const compileSceneLayoutFromEditor = (editor: SceneEditorData): Pick<SceneLayout, "assets" | "groups"> => {
  const compiledAssets: SceneAsset[] = editor.sceneAssets.map((asset) => sanitizeAsset(asset));
  const compiledGroups: SceneGroup[] = editor.sceneGroups.map(sanitizeGroup);
  const collectionById = new Map(editor.ownCollections.map((collection) => [collection.id, collection]));

  editor.collectionInstances.forEach((instance) => {
    const definition = collectionById.get(instance.ownCollectionId);
    if (!definition) return;
    const rootGroupId = `ocinst_${instance.id}`;
    compiledGroups.push({
      id: rootGroupId,
      name: instance.name?.trim() || definition.name,
      parentId: instance.parentId,
    });

    const definitionGroups = definition.groups ?? [];
    const groupIdMap = new Map(definitionGroups.map((group) => [group.id, `${instance.id}_${group.id}`]));
    definitionGroups.forEach((group) => {
      compiledGroups.push({
        id: groupIdMap.get(group.id) ?? group.id,
        name: group.name,
        parentId: group.parentId ? (groupIdMap.get(group.parentId) ?? rootGroupId) : rootGroupId,
      });
    });

    definition.assets.forEach((asset) => {
      const resolvedAsset = resolveInstanceAsset(asset, instance);
      compiledAssets.push({
        ...resolvedAsset,
        groupId: asset.groupId ? (groupIdMap.get(asset.groupId) ?? rootGroupId) : rootGroupId,
      });
    });
  });

  return { assets: compiledAssets, groups: compiledGroups };
};

const validateGroupsAndAssignments = (groups: SceneGroup[], assets: SceneAsset[]) => {
  const groupIdSet = new Set(groups.map((group) => group.id));
  if (groupIdSet.size !== groups.length) return false;
  if (groups.some((group) => group.parentId !== undefined && !groupIdSet.has(group.parentId))) return false;
  if (assets.some((asset) => asset.groupId !== undefined && !groupIdSet.has(asset.groupId))) return false;
  return true;
};

const validateEditorRelations = (editor: SceneEditorData) => {
  const sceneAssetIds = new Set(editor.sceneAssets.map((asset) => asset.id));
  if (sceneAssetIds.size !== editor.sceneAssets.length) return false;
  if (!validateGroupsAndAssignments(editor.sceneGroups, editor.sceneAssets)) return false;

  const collectionIds = new Set(editor.ownCollections.map((collection) => collection.id));
  if (collectionIds.size !== editor.ownCollections.length) return false;

  for (const collection of editor.ownCollections) {
    const groups = collection.groups ?? [];
    const assetIds = new Set(collection.assets.map((asset) => asset.id));
    if (assetIds.size !== collection.assets.length) return false;
    if (!validateGroupsAndAssignments(groups, collection.assets)) return false;
  }

  const instanceIds = new Set(editor.collectionInstances.map((instance) => instance.id));
  if (instanceIds.size !== editor.collectionInstances.length) return false;
  const sceneGroupIds = new Set(editor.sceneGroups.map((group) => group.id));
  if (editor.collectionInstances.some((instance) => !collectionIds.has(instance.ownCollectionId))) return false;
  if (editor.collectionInstances.some((instance) => instance.parentId !== undefined && !sceneGroupIds.has(instance.parentId))) return false;
  return true;
};

const sanitizeEditorData = (editor: SceneEditorData): SceneEditorData => cloneSceneEditorData(editor);

const toEditorSceneAsset = (asset: SceneAsset, index: number): EditorSceneAsset => ({
  ...cloneSceneAsset(asset),
  id: asset.id ?? `asset_${index.toString(36)}`,
});

export const normalizeSceneEditorData = (layout: SceneLayout): SceneEditorData => {
  if (layout.editor) return cloneSceneEditorData(layout.editor);
  return {
    sceneAssets: layout.assets.map((asset, index) => toEditorSceneAsset(asset, index)),
    sceneGroups: (layout.groups ?? []).map(sanitizeGroup),
    ownCollections: [],
    collectionInstances: [],
  };
};

export const sanitizeSceneLayout = (input: unknown): SceneLayout | null => {
  if (!input || typeof input !== "object") return null;
  const payload = input as Partial<SceneLayout>;

  if (payload.editor !== undefined) {
    if (!isValidEditorData(payload.editor)) return null;
    const editor = sanitizeEditorData(payload.editor);
    if (!validateEditorRelations(editor)) return null;
    const compiled = compileSceneLayoutFromEditor(editor);
    return {
      assets: compiled.assets,
      groups: compiled.groups,
      editor,
    };
  }

  if (!Array.isArray(payload.assets) || payload.assets.length > MAX_ASSETS || !payload.assets.every((asset) => isValidAsset(asset))) {
    return null;
  }
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  if (groups.length > MAX_GROUPS || !groups.every(isValidGroup) || !validateGroupsAndAssignments(groups, payload.assets)) {
    return null;
  }

  return {
    assets: payload.assets.map((asset) => sanitizeAsset(asset)),
    groups: groups.map((group) => sanitizeGroup(group)),
  };
};
