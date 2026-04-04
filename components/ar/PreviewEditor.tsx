"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Image from "next/image";
import ScenePreview from "@/components/ar/ScenePreview";
import {
  cloneCollectionInstance,
  cloneSceneAsset,
  cloneSceneEditorData,
  getSceneAssetKind,
  getCollectionInstanceMatrixFromWorldAsset,
  normalizeSceneEditorData,
  resolveSceneEditorData,
  type EditorSceneAsset,
  type OwnCollectionDefinition,
  type OwnCollectionInstance,
  type ResolvedSceneAsset,
  type SceneAsset,
  type SceneAssetKind,
  type SceneEditorData,
  type SceneGroup,
  type SceneLayout,
} from "@/lib/sceneLayout";
import styles from "@/components/ar/PreviewEditor.module.css";

type AssetCollection = {
  source: "public" | "root";
  id: string;
  thumbnailCollectionId: string;
  name: string;
  assets: string[];
};

type TransformMode = "observe" | "translate" | "rotate" | "scale";

type SelectedTarget =
  | { kind: "asset"; assetIds: string[] }
  | { kind: "group"; groupId: string }
  | { kind: "instance"; instanceId: string }
  | null;

type ClipboardSelection =
  | { kind: "asset"; assets: EditorSceneAsset[]; scopeKey: string }
  | { kind: "group"; groupId: string; scopeKey: string }
  | { kind: "instance"; instanceId: string }
  | null;

const EMPTY_ASSETS: EditorSceneAsset[] = [];
const EMPTY_GROUPS: SceneGroup[] = [];
const EMPTY_INSTANCES: OwnCollectionInstance[] = [];
const EMPTY_RESOLVED_ASSETS: ResolvedSceneAsset[] = [];

const spawnPositionForIndex = (index: number): [number, number, number] => {
  if (index === 0) return [0, 0, 0];
  const step = 0.32;
  const col = index % 4;
  const row = Math.floor(index / 4);
  return [(col - 1.5) * step, (row - 1.5) * step, 0];
};

const cloneAsset = <T extends SceneAsset>(asset: T): T => cloneSceneAsset(asset);
const cloneInstance = (instance: OwnCollectionInstance): OwnCollectionInstance => cloneCollectionInstance(instance);

const offsetAssetForPaste = <T extends SceneAsset>(asset: T): T => ({
  ...asset,
  position: [asset.position[0] + 0.12, asset.position[1] + 0.12, asset.position[2]] as [number, number, number],
  rotation: asset.rotation ? [...asset.rotation] as [number, number, number] : undefined,
  scale3: asset.scale3 ? [...asset.scale3] as [number, number, number] : undefined,
});

const offsetInstanceForPaste = (instance: OwnCollectionInstance): OwnCollectionInstance => ({
  ...instance,
  position: [instance.position[0] + 0.12, instance.position[1] + 0.12, instance.position[2]] as [number, number, number],
  rotation: instance.rotation ? [...instance.rotation] as [number, number, number] : undefined,
  scale3: instance.scale3 ? [...instance.scale3] as [number, number, number] : undefined,
});

const getNodeScale = (asset: Pick<SceneAsset, "scale" | "scale3">): [number, number, number] => {
  if (asset.scale3) return asset.scale3;
  const uniform = asset.scale ?? 1;
  return [uniform, uniform, uniform];
};

const getNodeRotation = (asset: Pick<SceneAsset, "rotation" | "rotationZ">): [number, number, number] => {
  return asset.rotation ?? [0, asset.rotationZ ?? 0, 0];
};

const radiansToDegrees = (value: number) => (value * 180) / Math.PI;
const degreesToRadians = (value: number) => (value * Math.PI) / 180;
const roundDegrees = (value: number) => Math.round(value * 100) / 100;

const collectDescendantGroupIds = (groups: SceneGroup[], groupId: string): Set<string> => {
  const descendants = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.parentId && descendants.has(group.parentId) && !descendants.has(group.id)) {
        descendants.add(group.id);
        changed = true;
      }
    }
  }
  return descendants;
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};

const makeEntityId = (prefix: string, occupied: Set<string>) => {
  let id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  while (occupied.has(id)) {
    id = `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }
  occupied.add(id);
  return id;
};

const buildEditorSignature = (editor: SceneEditorData) => JSON.stringify(editor);

const buildThumbnailUrl = (collectionId: string, collectionName: string, assetPath: string) =>
  `/api/editor/thumbnail?collectionId=${encodeURIComponent(collectionId)}&collection=${encodeURIComponent(collectionName)}&asset=${encodeURIComponent(assetPath)}`;

const isOccluderCollection = (collection: Pick<AssetCollection, "name">) => /occluder/i.test(collection.name);

const asResolvedAsset = (asset: EditorSceneAsset): ResolvedSceneAsset => ({
  ...cloneAsset(asset),
  source: { kind: "sceneAsset", assetId: asset.id },
});

export default function PreviewEditor() {
  const [collections, setCollections] = useState<AssetCollection[]>([]);
  const [editorData, setEditorData] = useState<SceneEditorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importingAssetKey, setImportingAssetKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [collapsedSceneGroups, setCollapsedSceneGroups] = useState<Record<string, boolean>>({});
  const [collapsedOwnCollections, setCollapsedOwnCollections] = useState<Record<string, boolean>>({});
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("observe");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [hoverPreview, setHoverPreview] = useState<{ src: string; label: string; x: number; y: number } | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);

  const editorStateRef = useRef<SceneEditorData | null>(null);
  const historyRef = useRef<SceneEditorData[]>([]);
  const historyIndexRef = useRef(-1);
  const savedSignatureRef = useRef("");
  const lastCoalesceOpRef = useRef<{ key: string; at: number } | null>(null);
  const clipboardSelectionRef = useRef<ClipboardSelection>(null);
  const hoverPreviewTimeoutRef = useRef<number | null>(null);

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const setSnapshotAsCurrent = useCallback((nextEditor: SceneEditorData) => {
    const snapshot = cloneSceneEditorData(nextEditor);
    editorStateRef.current = snapshot;
    setEditorData(snapshot);
    setDirty(buildEditorSignature(snapshot) !== savedSignatureRef.current);
  }, []);

  const commitHistorySnapshot = useCallback(
    (nextEditor: SceneEditorData, options?: { coalesceKey?: string }) => {
      const snapshot = cloneSceneEditorData(nextEditor);
      const nextSig = buildEditorSignature(snapshot);

      if (historyIndexRef.current >= 0) {
        const currentSig = buildEditorSignature(historyRef.current[historyIndexRef.current]);
        if (currentSig === nextSig) return snapshot;
      }

      const now = Date.now();
      const coalesceKey = options?.coalesceKey;
      const previousCoalesce = lastCoalesceOpRef.current;
      const canCoalesce = Boolean(
        coalesceKey &&
          previousCoalesce &&
          previousCoalesce.key === coalesceKey &&
          now - previousCoalesce.at < 250 &&
          historyIndexRef.current >= 0,
      );

      const nextEntries = historyRef.current.slice(0, historyIndexRef.current + 1);
      if (canCoalesce) {
        nextEntries[historyIndexRef.current] = snapshot;
      } else {
        nextEntries.push(snapshot);
        historyIndexRef.current = nextEntries.length - 1;
      }

      historyRef.current = nextEntries;
      lastCoalesceOpRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
      setDirty(buildEditorSignature(snapshot) !== savedSignatureRef.current);
      syncHistoryFlags();
      return snapshot;
    },
    [syncHistoryFlags],
  );

  const initializeHistory = useCallback(
    (nextEditor: SceneEditorData) => {
      const snapshot = cloneSceneEditorData(nextEditor);
      historyRef.current = [snapshot];
      historyIndexRef.current = 0;
      savedSignatureRef.current = buildEditorSignature(snapshot);
      lastCoalesceOpRef.current = null;
      editorStateRef.current = snapshot;
      setEditorData(snapshot);
      setDirty(false);
      syncHistoryFlags();
    },
    [syncHistoryFlags],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    lastCoalesceOpRef.current = null;
    setSnapshotAsCurrent(historyRef.current[historyIndexRef.current]);
    syncHistoryFlags();
  }, [setSnapshotAsCurrent, syncHistoryFlags]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    lastCoalesceOpRef.current = null;
    setSnapshotAsCurrent(historyRef.current[historyIndexRef.current]);
    syncHistoryFlags();
  }, [setSnapshotAsCurrent, syncHistoryFlags]);

  const loadInitialData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assetsRes, layoutRes] = await Promise.all([
        fetch("/api/editor/assets", { cache: "no-store" }),
        fetch("/api/editor/layout", { cache: "no-store" }),
      ]);
      if (!assetsRes.ok) throw new Error("No se pudo cargar la libreria de assets.");
      if (!layoutRes.ok) throw new Error("No se pudo cargar el layout.");

      const assetsJson = (await assetsRes.json()) as { collections: AssetCollection[] };
      const layoutJson = (await layoutRes.json()) as SceneLayout;
      setCollections(assetsJson.collections ?? []);
      initializeHistory(normalizeSceneEditorData(layoutJson));
      setSelectedTarget(null);
      setActiveCollectionId(null);
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : "Error al cargar datos del editor.");
    } finally {
      setLoading(false);
    }
  }, [initializeHistory]);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    editorStateRef.current = editorData;
  }, [editorData]);

  useEffect(() => {
    return () => {
      if (hoverPreviewTimeoutRef.current) {
        window.clearTimeout(hoverPreviewTimeoutRef.current);
      }
    };
  }, []);

  const currentCollection = useMemo(
    () => (activeCollectionId && editorData ? editorData.ownCollections.find((collection) => collection.id === activeCollectionId) ?? null : null),
    [activeCollectionId, editorData],
  );

  const editingCollection = Boolean(currentCollection);
  const scopeKey = currentCollection ? `collection:${currentCollection.id}` : "scene";

  const sceneAssets = editorData?.sceneAssets ?? EMPTY_ASSETS;
  const sceneGroups = editorData?.sceneGroups ?? EMPTY_GROUPS;
  const sceneInstances = editorData?.collectionInstances ?? EMPTY_INSTANCES;
  const currentAssets = currentCollection?.assets ?? sceneAssets;
  const currentGroups = currentCollection?.groups ?? sceneGroups;

  const previewAssets = useMemo(() => {
    if (!editorData) return EMPTY_RESOLVED_ASSETS;
    if (currentCollection) return currentCollection.assets.map(asResolvedAsset);
    return resolveSceneEditorData(editorData).assets;
  }, [currentCollection, editorData]);

  const getOccupiedIds = useCallback(() => {
    const editor = editorStateRef.current;
    const occupied = new Set<string>();
    if (!editor) return occupied;
    editor.sceneAssets.forEach((asset) => occupied.add(asset.id));
    editor.sceneGroups.forEach((group) => occupied.add(group.id));
    editor.ownCollections.forEach((collection) => {
      occupied.add(collection.id);
      collection.assets.forEach((asset) => occupied.add(asset.id));
      (collection.groups ?? []).forEach((group) => occupied.add(group.id));
    });
    editor.collectionInstances.forEach((instance) => occupied.add(instance.id));
    return occupied;
  }, []);

  const updateEditorData = useCallback(
    (updater: (current: SceneEditorData) => SceneEditorData, options?: { coalesceKey?: string }) => {
      const current = editorStateRef.current;
      if (!current) return null;
      const next = updater(cloneSceneEditorData(current));
      const snapshot = commitHistorySnapshot(next, options);
      editorStateRef.current = snapshot;
      setEditorData(snapshot);
      return snapshot;
    },
    [commitHistorySnapshot],
  );

  const scheduleHoverPreview = (src: string, label: string, event: ReactMouseEvent<HTMLElement>) => {
    if (hoverPreviewTimeoutRef.current) {
      window.clearTimeout(hoverPreviewTimeoutRef.current);
    }
    const x = Math.min(event.clientX + 18, window.innerWidth - 320);
    const y = Math.min(event.clientY + 18, window.innerHeight - 360);
    hoverPreviewTimeoutRef.current = window.setTimeout(() => {
      setHoverPreview({ src, label, x, y });
    }, 1000);
  };

  const clearHoverPreview = () => {
    if (hoverPreviewTimeoutRef.current) {
      window.clearTimeout(hoverPreviewTimeoutRef.current);
      hoverPreviewTimeoutRef.current = null;
    }
    setHoverPreview(null);
  };

  const addAsset = async (collection: AssetCollection, assetPath: string, kind: SceneAssetKind = "model") => {
    const actionKey = `${collection.source}:${collection.name}:${assetPath}`;
    setImportingAssetKey(actionKey);
    setError(null);

    try {
      const importRes = await fetch("/api/editor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: collection.source,
          id: collection.id,
          name: collection.name,
          assetPath,
        }),
      });

      if (!importRes.ok) {
        const body = (await importRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "No se pudo importar el asset.");
      }

      const imported = (await importRes.json()) as { collection: string; file: string; sourceCollection?: string };
      const occupied = getOccupiedIds();
      const nextAsset: EditorSceneAsset = {
        id: makeEntityId("asset", occupied),
        collection: imported.collection,
        file: imported.file,
        kind: kind === "occluder" ? "occluder" : undefined,
        sourceCollection: imported.sourceCollection,
        position: spawnPositionForIndex(currentAssets.length),
        rotation: [0, 0, 0],
      };

      updateEditorData((current) => {
        if (currentCollection) {
          return {
            ...current,
            ownCollections: current.ownCollections.map((item) =>
              item.id === currentCollection.id ? { ...item, assets: [...item.assets, nextAsset] } : item,
            ),
          };
        }
        return { ...current, sceneAssets: [...current.sceneAssets, nextAsset] };
      });

      setSelectedTarget({ kind: "asset", assetIds: [nextAsset.id] });
      if (transformMode !== "observe") {
        setTransformMode("translate");
      }
    } catch (importError) {
      console.error(importError);
      setError(importError instanceof Error ? importError.message : "Error al importar asset.");
    } finally {
      setImportingAssetKey(null);
    }
  };

  const saveLayout = async () => {
    const current = editorStateRef.current;
    if (!current) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/editor/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editor: current }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "No se pudo guardar el layout.");
      }
      savedSignatureRef.current = buildEditorSignature(current);
      setDirty(false);
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : "Error al guardar.");
    } finally {
      setSaving(false);
    }
  };

  const updateAssetsInScope = useCallback(
    (changes: Array<{ assetId: string; asset: EditorSceneAsset }>, coalesceKey?: string) => {
      if (changes.length === 0) return;
      const changeMap = new Map(changes.map((change) => [change.assetId, change.asset]));
      updateEditorData(
        (current) => {
          if (currentCollection) {
            return {
              ...current,
              ownCollections: current.ownCollections.map((collection) =>
                collection.id === currentCollection.id
                  ? { ...collection, assets: collection.assets.map((asset) => changeMap.get(asset.id) ?? asset) }
                  : collection,
              ),
            };
          }
          return {
            ...current,
            sceneAssets: current.sceneAssets.map((asset) => changeMap.get(asset.id) ?? asset),
          };
        },
        { coalesceKey },
      );
    },
    [currentCollection, updateEditorData],
  );

  const updateInstance = useCallback(
    (instanceId: string, updater: (instance: OwnCollectionInstance) => OwnCollectionInstance, coalesceKey?: string) => {
      updateEditorData(
        (current) => ({
          ...current,
          collectionInstances: current.collectionInstances.map((instance) => (instance.id === instanceId ? updater(cloneInstance(instance)) : instance)),
        }),
        { coalesceKey },
      );
    },
    [updateEditorData],
  );

  const removeAssetIds = useCallback(
    (assetIds: string[]) => {
      const selected = new Set(assetIds);
      updateEditorData((current) => {
        if (currentCollection) {
          return {
            ...current,
            ownCollections: current.ownCollections.map((collection) =>
              collection.id === currentCollection.id
                ? { ...collection, assets: collection.assets.filter((asset) => !selected.has(asset.id)) }
                : collection,
            ),
          };
        }
        return {
          ...current,
          sceneAssets: current.sceneAssets.filter((asset) => !selected.has(asset.id)),
        };
      });
    },
    [currentCollection, updateEditorData],
  );

  const deleteGroup = useCallback(
    (groupId: string) => {
      const descendants = collectDescendantGroupIds(currentGroups, groupId);
      updateEditorData((current) => {
        if (currentCollection) {
          return {
            ...current,
            ownCollections: current.ownCollections.map((collection) =>
              collection.id === currentCollection.id
                ? {
                    ...collection,
                    groups: (collection.groups ?? []).filter((group) => !descendants.has(group.id)),
                    assets: collection.assets.filter((asset) => !(asset.groupId && descendants.has(asset.groupId))),
                  }
                : collection,
            ),
          };
        }
        return {
          ...current,
          sceneGroups: current.sceneGroups.filter((group) => !descendants.has(group.id)),
          sceneAssets: current.sceneAssets.filter((asset) => !(asset.groupId && descendants.has(asset.groupId))),
          collectionInstances: current.collectionInstances.filter((instance) => !(instance.parentId && descendants.has(instance.parentId))),
        };
      });
      if (selectedTarget?.kind === "group" && descendants.has(selectedTarget.groupId)) {
        setSelectedTarget(null);
      }
    },
    [currentCollection, currentGroups, selectedTarget, updateEditorData],
  );

  const deleteInstance = useCallback(
    (instanceId: string) => {
      updateEditorData((current) => ({
        ...current,
        collectionInstances: current.collectionInstances.filter((instance) => instance.id !== instanceId),
      }));
      if (selectedTarget?.kind === "instance" && selectedTarget.instanceId === instanceId) {
        setSelectedTarget(null);
      }
    },
    [selectedTarget, updateEditorData],
  );

  const createGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const occupied = getOccupiedIds();
    const nextGroup: SceneGroup = {
      id: makeEntityId("grp", occupied),
      name,
      parentId: undefined,
    };

    updateEditorData((current) => {
      if (currentCollection) {
        return {
          ...current,
          ownCollections: current.ownCollections.map((collection) =>
            collection.id === currentCollection.id
              ? { ...collection, groups: [...(collection.groups ?? []), nextGroup] }
              : collection,
          ),
        };
      }
      return { ...current, sceneGroups: [...current.sceneGroups, nextGroup] };
    });

    setNewGroupName("");
  };

  const renameGroup = (groupId: string, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    updateEditorData((current) => {
      if (currentCollection) {
        return {
          ...current,
          ownCollections: current.ownCollections.map((collection) =>
            collection.id === currentCollection.id
              ? {
                  ...collection,
                  groups: (collection.groups ?? []).map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)),
                }
              : collection,
          ),
        };
      }
      return {
        ...current,
        sceneGroups: current.sceneGroups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)),
      };
    });
  };

  const promptRenameGroup = (groupId: string) => {
    const target = currentGroups.find((group) => group.id === groupId);
    if (!target) return;
    const nextName = window.prompt("Nuevo nombre del grupo", target.name);
    if (nextName === null) return;
    renameGroup(groupId, nextName);
  };

  const changeGroupParent = (groupId: string, parentId: string) => {
    const normalizedParentId = parentId || undefined;
    if (normalizedParentId === groupId) return;
    if (normalizedParentId) {
      const descendants = collectDescendantGroupIds(currentGroups, groupId);
      if (descendants.has(normalizedParentId)) return;
    }

    updateEditorData((current) => {
      if (currentCollection) {
        return {
          ...current,
          ownCollections: current.ownCollections.map((collection) =>
            collection.id === currentCollection.id
              ? {
                  ...collection,
                  groups: (collection.groups ?? []).map((group) =>
                    group.id === groupId ? { ...group, parentId: normalizedParentId } : group,
                  ),
                }
              : collection,
          ),
        };
      }
      return {
        ...current,
        sceneGroups: current.sceneGroups.map((group) =>
          group.id === groupId ? { ...group, parentId: normalizedParentId } : group,
        ),
      };
    });
  };

  const copyGroup = useCallback(
    (groupId: string) => {
      const occupied = getOccupiedIds();
      const descendants = collectDescendantGroupIds(currentGroups, groupId);
      const groupsToCopy = currentGroups.filter((group) => descendants.has(group.id));
      if (groupsToCopy.length === 0) return;

      const groupIdMap = new Map<string, string>();
      groupsToCopy.forEach((group) => {
        groupIdMap.set(group.id, makeEntityId("grp", occupied));
      });

      const copiedAssets = currentAssets
        .filter((asset) => asset.groupId && descendants.has(asset.groupId))
        .map((asset) =>
          offsetAssetForPaste({
            ...cloneAsset(asset),
            id: makeEntityId("asset", occupied),
            groupId: asset.groupId ? groupIdMap.get(asset.groupId) : undefined,
          }),
        );

      updateEditorData((current) => {
        if (currentCollection) {
          return {
            ...current,
            ownCollections: current.ownCollections.map((collection) =>
              collection.id === currentCollection.id
                ? {
                    ...collection,
                    groups: [
                      ...(collection.groups ?? []),
                      ...groupsToCopy.map((group) => ({
                        id: groupIdMap.get(group.id) ?? group.id,
                        name: `${group.name} (copia)`,
                        parentId: group.parentId && descendants.has(group.parentId) ? groupIdMap.get(group.parentId) : group.parentId,
                      })),
                    ],
                    assets: [...collection.assets, ...copiedAssets],
                  }
                : collection,
            ),
          };
        }

        const copiedInstances = current.collectionInstances
          .filter((instance) => instance.parentId && descendants.has(instance.parentId))
          .map((instance) =>
            offsetInstanceForPaste({
              ...cloneInstance(instance),
              id: makeEntityId("inst", occupied),
              parentId: instance.parentId ? groupIdMap.get(instance.parentId) : undefined,
            }),
          );

        return {
          ...current,
          sceneGroups: [
            ...current.sceneGroups,
            ...groupsToCopy.map((group) => ({
              id: groupIdMap.get(group.id) ?? group.id,
              name: `${group.name} (copia)`,
              parentId: group.parentId && descendants.has(group.parentId) ? groupIdMap.get(group.parentId) : group.parentId,
            })),
          ],
          sceneAssets: [...current.sceneAssets, ...copiedAssets],
          collectionInstances: [...current.collectionInstances, ...copiedInstances],
        };
      });

      const copiedRootId = groupIdMap.get(groupId);
      if (copiedRootId) {
        setSelectedTarget({ kind: "group", groupId: copiedRootId });
        if (transformMode !== "observe") {
          setTransformMode("translate");
        }
      }
    },
    [currentAssets, currentCollection, currentGroups, getOccupiedIds, transformMode, updateEditorData],
  );

  const assignAssetToGroup = (assetId: string, groupId: string) => {
    const asset = currentAssets.find((item) => item.id === assetId);
    if (!asset) return;
    updateAssetsInScope([{ assetId, asset: { ...cloneAsset(asset), groupId: groupId || undefined } }], `group:${assetId}`);
  };

  const assignInstanceToGroup = (instanceId: string, groupId: string) => {
    updateInstance(instanceId, (instance) => ({ ...instance, parentId: groupId || undefined }), `instance-group:${instanceId}`);
  };

  const createOwnCollectionFromGroup = useCallback(
    (groupId: string) => {
      if (currentCollection) return;
      const rootGroup = sceneGroups.find((group) => group.id === groupId);
      if (!rootGroup) return;

      const descendants = collectDescendantGroupIds(sceneGroups, groupId);
      const assetsToMove = sceneAssets.filter((asset) => asset.groupId && descendants.has(asset.groupId));
      if (assetsToMove.length === 0) {
        setError("Ese grupo no tiene assets propios para convertir a ownCollection.");
        return;
      }

      const centroid = assetsToMove.reduce<[number, number, number]>(
        (acc, asset) => [acc[0] + asset.position[0], acc[1] + asset.position[1], acc[2] + asset.position[2]],
        [0, 0, 0],
      ).map((value) => value / assetsToMove.length) as [number, number, number];

      const occupied = getOccupiedIds();
      const collectionId = makeEntityId("own", occupied);
      const instanceId = makeEntityId("inst", occupied);
      const groupIdMap = new Map<string, string>();

      sceneGroups
        .filter((group) => descendants.has(group.id))
        .forEach((group) => {
          groupIdMap.set(group.id, makeEntityId("grp", occupied));
        });

      const ownCollection: OwnCollectionDefinition = {
        id: collectionId,
        name: rootGroup.name,
        groups: sceneGroups
          .filter((group) => descendants.has(group.id))
          .map((group) => ({
            id: groupIdMap.get(group.id) ?? group.id,
            name: group.name,
            parentId: group.parentId && descendants.has(group.parentId) ? groupIdMap.get(group.parentId) : undefined,
          })),
        assets: assetsToMove.map((asset) => ({
          ...cloneAsset(asset),
          id: makeEntityId("asset", occupied),
          groupId: asset.groupId ? groupIdMap.get(asset.groupId) : undefined,
          position: [
            asset.position[0] - centroid[0],
            asset.position[1] - centroid[1],
            asset.position[2] - centroid[2],
          ],
        })),
      };

      const instance: OwnCollectionInstance = {
        id: instanceId,
        ownCollectionId: collectionId,
        name: rootGroup.name,
        parentId: rootGroup.parentId,
        position: centroid,
        rotation: [0, 0, 0],
        scale3: [1, 1, 1],
      };

      updateEditorData((current) => ({
        ...current,
        sceneGroups: current.sceneGroups.filter((group) => !descendants.has(group.id)),
        sceneAssets: current.sceneAssets.filter((asset) => !(asset.groupId && descendants.has(asset.groupId))),
        ownCollections: [...current.ownCollections, ownCollection],
        collectionInstances: [...current.collectionInstances, instance],
      }));

      setSelectedTarget({ kind: "instance", instanceId });
    },
    [currentCollection, getOccupiedIds, sceneAssets, sceneGroups, updateEditorData],
  );

  const addOwnCollectionInstance = useCallback(
    (ownCollectionId: string) => {
      const definition = editorData?.ownCollections.find((collection) => collection.id === ownCollectionId);
      if (!definition) return;
      const occupied = getOccupiedIds();
      const instanceId = makeEntityId("inst", occupied);
      const nextInstance: OwnCollectionInstance = {
        id: instanceId,
        ownCollectionId,
        name: definition.name,
        parentId: selectedTarget?.kind === "group" ? selectedTarget.groupId : undefined,
        position: spawnPositionForIndex(sceneAssets.length + sceneInstances.length),
        rotation: [0, 0, 0],
        scale3: [1, 1, 1],
      };

      updateEditorData((current) => ({
        ...current,
        collectionInstances: [...current.collectionInstances, nextInstance],
      }));

      setSelectedTarget({ kind: "instance", instanceId });
      if (transformMode !== "observe") {
        setTransformMode("translate");
      }
    },
    [editorData, getOccupiedIds, sceneAssets.length, sceneInstances.length, selectedTarget, transformMode, updateEditorData],
  );

  const breakInstanceLink = useCallback(
    (instanceId: string) => {
      const editor = editorStateRef.current;
      if (!editor) return;
      const instance = editor.collectionInstances.find((item) => item.id === instanceId);
      if (!instance) return;
      const definition = editor.ownCollections.find((item) => item.id === instance.ownCollectionId);
      if (!definition) return;

      const resolved = resolveSceneEditorData(editor).assets.filter(
        (asset) => asset.source.kind === "collectionInstance" && asset.source.instanceId === instanceId,
      );

      const occupied = getOccupiedIds();
      const rootGroupId = makeEntityId("grp", occupied);
      const groupIdMap = new Map<string, string>();
      (definition.groups ?? []).forEach((group) => {
        groupIdMap.set(group.id, makeEntityId("grp", occupied));
      });

      const liftedGroups: SceneGroup[] = [
        {
          id: rootGroupId,
          name: instance.name?.trim() || definition.name,
          parentId: instance.parentId,
        },
        ...(definition.groups ?? []).map((group) => ({
          id: groupIdMap.get(group.id) ?? group.id,
          name: group.name,
          parentId: group.parentId ? (groupIdMap.get(group.parentId) ?? rootGroupId) : rootGroupId,
        })),
      ];

      const liftedAssets = definition.assets.reduce<EditorSceneAsset[]>((acc, asset) => {
        const worldAsset = resolved.find(
          (resolvedAsset) =>
            resolvedAsset.source.kind === "collectionInstance" &&
            resolvedAsset.source.instanceId === instanceId &&
            resolvedAsset.source.assetId === asset.id,
        );
        if (!worldAsset) return acc;
        acc.push({
          ...cloneAsset(asset),
          id: makeEntityId("asset", occupied),
          groupId: asset.groupId ? (groupIdMap.get(asset.groupId) ?? rootGroupId) : rootGroupId,
          position: [...worldAsset.position] as [number, number, number],
          rotation: worldAsset.rotation ? [...worldAsset.rotation] as [number, number, number] : undefined,
          rotationZ: worldAsset.rotation ? undefined : worldAsset.rotationZ,
          scale: undefined,
          scale3: getNodeScale(worldAsset),
        });
        return acc;
      }, []);

      updateEditorData((current) => ({
        ...current,
        sceneGroups: [...current.sceneGroups, ...liftedGroups],
        sceneAssets: [...current.sceneAssets, ...liftedAssets],
        collectionInstances: current.collectionInstances.filter((item) => item.id !== instanceId),
      }));

      setSelectedTarget({ kind: "group", groupId: rootGroupId });
    },
    [getOccupiedIds, updateEditorData],
  );

  const renameOwnCollection = (collectionId: string) => {
    const target = editorData?.ownCollections.find((collection) => collection.id === collectionId);
    if (!target) return;
    const nextName = window.prompt("Nuevo nombre de ownCollection", target.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;

    updateEditorData((current) => ({
      ...current,
      ownCollections: current.ownCollections.map((collection) =>
        collection.id === collectionId ? { ...collection, name: trimmed } : collection,
      ),
    }));
  };

  const deleteOwnCollection = (collectionId: string) => {
    updateEditorData((current) => ({
      ...current,
      ownCollections: current.ownCollections.filter((collection) => collection.id !== collectionId),
      collectionInstances: current.collectionInstances.filter((instance) => instance.ownCollectionId !== collectionId),
    }));
    if (activeCollectionId === collectionId) {
      setActiveCollectionId(null);
    }
    if (selectedTarget?.kind === "instance") {
      const removed = sceneInstances.find((instance) => instance.id === selectedTarget.instanceId && instance.ownCollectionId === collectionId);
      if (removed) setSelectedTarget(null);
    }
  };

  const deleteSelectedSceneObjects = useCallback(() => {
    if (!selectedTarget) return;
    if (selectedTarget.kind === "group") {
      deleteGroup(selectedTarget.groupId);
      return;
    }
    if (selectedTarget.kind === "instance") {
      deleteInstance(selectedTarget.instanceId);
      return;
    }
    removeAssetIds(selectedTarget.assetIds);
    setSelectedTarget(null);
  }, [deleteGroup, deleteInstance, removeAssetIds, selectedTarget]);

  const copySelection = useCallback(() => {
    if (!selectedTarget) return;
    if (selectedTarget.kind === "group") {
      clipboardSelectionRef.current = { kind: "group", groupId: selectedTarget.groupId, scopeKey };
      return;
    }
    if (selectedTarget.kind === "instance") {
      clipboardSelectionRef.current = { kind: "instance", instanceId: selectedTarget.instanceId };
      return;
    }
    const selectedIds = new Set(selectedTarget.assetIds);
    const assets = currentAssets.filter((asset) => selectedIds.has(asset.id)).map((asset) => cloneAsset(asset));
    if (assets.length === 0) return;
    clipboardSelectionRef.current = { kind: "asset", assets, scopeKey };
  }, [currentAssets, scopeKey, selectedTarget]);

  const pasteSelection = useCallback(() => {
    const clipboard = clipboardSelectionRef.current;
    if (!clipboard) return;

    if (clipboard.kind === "group") {
      if (clipboard.scopeKey === scopeKey) {
        copyGroup(clipboard.groupId);
      }
      return;
    }

    if (clipboard.kind === "instance") {
      if (editingCollection) return;
      const instance = sceneInstances.find((item) => item.id === clipboard.instanceId);
      if (!instance) return;
      const occupied = getOccupiedIds();
      const pasted = offsetInstanceForPaste({
        ...cloneInstance(instance),
        id: makeEntityId("inst", occupied),
      });
      updateEditorData(
        (current) => ({
          ...current,
          collectionInstances: [...current.collectionInstances, pasted],
        }),
        { coalesceKey: "paste-instance" },
      );
      setSelectedTarget({ kind: "instance", instanceId: pasted.id });
      if (transformMode !== "observe") {
        setTransformMode("translate");
      }
      return;
    }

    if (clipboard.scopeKey !== scopeKey) return;

    const occupied = getOccupiedIds();
    const pastedAssets = clipboard.assets.map((asset) =>
      offsetAssetForPaste({
        ...cloneAsset(asset),
        id: makeEntityId("asset", occupied),
      }),
    );

    updateEditorData(
      (current) => {
        if (currentCollection) {
          return {
            ...current,
            ownCollections: current.ownCollections.map((collection) =>
              collection.id === currentCollection.id
                ? { ...collection, assets: [...collection.assets, ...pastedAssets] }
                : collection,
            ),
          };
        }
        return {
          ...current,
          sceneAssets: [...current.sceneAssets, ...pastedAssets],
        };
      },
      { coalesceKey: "paste-assets" },
    );

    setSelectedTarget({ kind: "asset", assetIds: pastedAssets.map((asset) => asset.id) });
    if (transformMode !== "observe") {
      setTransformMode("translate");
    }
  }, [copyGroup, currentCollection, editingCollection, getOccupiedIds, sceneInstances, scopeKey, transformMode, updateEditorData]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedTarget(null);
        return;
      }
      const isDelete = event.key === "Delete" || event.key === "Backspace";
      if (isDelete && selectedTarget) {
        event.preventDefault();
        deleteSelectedSceneObjects();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelectedSceneObjects, selectedTarget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      const meta = event.metaKey || event.ctrlKey;
      const isUndo = meta && !event.shiftKey && event.key.toLowerCase() === "z";
      const isRedo = meta && ((event.shiftKey && event.key.toLowerCase() === "z") || (!event.shiftKey && event.key.toLowerCase() === "y"));
      const isCopy = meta && !event.shiftKey && event.key.toLowerCase() === "c";
      const isPaste = meta && !event.shiftKey && event.key.toLowerCase() === "v";

      if (isUndo && canUndo) {
        event.preventDefault();
        undo();
      } else if (isRedo && canRedo) {
        event.preventDefault();
        redo();
      } else if (isCopy && selectedTarget) {
        event.preventDefault();
        copySelection();
      } else if (isPaste && clipboardSelectionRef.current) {
        event.preventDefault();
        pasteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canRedo, canUndo, copySelection, pasteSelection, redo, selectedTarget, undo]);

  useEffect(() => {
    if (!editorData) return;
    if (activeCollectionId && !editorData.ownCollections.some((collection) => collection.id === activeCollectionId)) {
      setActiveCollectionId(null);
      setSelectedTarget(null);
    }
  }, [activeCollectionId, editorData]);

  const groupsByParent = useMemo(() => {
    const map = new Map<string, SceneGroup[]>();
    currentGroups.forEach((group) => {
      const key = group.parentId ?? "__root__";
      const bucket = map.get(key);
      if (bucket) bucket.push(group);
      else map.set(key, [group]);
    });
    for (const [, bucket] of map) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [currentGroups]);

  const groupOptions = useMemo(
    () => [...currentGroups].sort((a, b) => a.name.localeCompare(b.name)),
    [currentGroups],
  );

  const ungroupedAssets = useMemo(() => currentAssets.filter((asset) => !asset.groupId), [currentAssets]);
  const ungroupedInstances = useMemo(
    () => (editingCollection ? [] : sceneInstances.filter((instance) => !instance.parentId)),
    [editingCollection, sceneInstances],
  );

  const selectedAssetIds = useMemo(
    () => (selectedTarget?.kind === "asset" ? selectedTarget.assetIds : []),
    [selectedTarget],
  );
  const selectedAssetIdSet = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);

  const selectedEditableAsset = useMemo(() => {
    if (selectedTarget?.kind !== "asset" || selectedTarget.assetIds.length !== 1) return null;
    return currentAssets.find((asset) => asset.id === selectedTarget.assetIds[0]) ?? null;
  }, [currentAssets, selectedTarget]);

  const selectedInstance = useMemo(() => {
    if (editingCollection || selectedTarget?.kind !== "instance") return null;
    return sceneInstances.find((instance) => instance.id === selectedTarget.instanceId) ?? null;
  }, [editingCollection, sceneInstances, selectedTarget]);

  const selectedTransformNode = selectedEditableAsset ?? selectedInstance;
  const selectedAssetKind = selectedEditableAsset ? getSceneAssetKind(selectedEditableAsset) : null;
  const selectedRotation = selectedTransformNode ? getNodeRotation(selectedTransformNode) : [0, 0, 0];
  const selectedRotationDegrees = selectedRotation.map((value) => roundDegrees(radiansToDegrees(value))) as [number, number, number];
  const selectedScale = selectedTransformNode ? getNodeScale(selectedTransformNode) : null;

  const selectedResolvedIndices = useMemo(() => {
    if (!selectedTarget) return [] as number[];
    if (selectedTarget.kind === "instance") {
      return previewAssets
        .map((asset, index) => ({ asset, index }))
        .filter(({ asset }) => asset.source.kind === "collectionInstance" && asset.source.instanceId === selectedTarget.instanceId)
        .map(({ index }) => index);
    }
    if (selectedTarget.kind === "asset") {
      const ids = new Set(selectedTarget.assetIds);
      return previewAssets
        .map((asset, index) => ({ asset, index }))
        .filter(({ asset }) => asset.source.kind === "sceneAsset" && ids.has(asset.source.assetId))
        .map(({ index }) => index);
    }
    const descendants = collectDescendantGroupIds(currentGroups, selectedTarget.groupId);
    return previewAssets
      .map((asset, index) => ({ asset, index }))
      .filter(({ asset }) => {
        const source = asset.source;
        if (asset.source.kind === "sceneAsset") {
          const item = currentAssets.find((currentAsset) => currentAsset.id === source.assetId);
          return Boolean(item?.groupId && descendants.has(item.groupId));
        }
        if (editingCollection) return false;
        if (source.kind !== "collectionInstance") return false;
        const instance = sceneInstances.find((item) => item.id === source.instanceId);
        return Boolean(instance?.parentId && descendants.has(instance.parentId));
      })
      .map(({ index }) => index);
  }, [currentAssets, currentGroups, editingCollection, previewAssets, sceneInstances, selectedTarget]);

  const applyPreviewChanges = useCallback(
    (changes: Array<{ index: number; asset: SceneAsset }>, coalesceKey: string) => {
      if (changes.length === 0) return;

      const sceneAssetChanges = new Map<string, EditorSceneAsset>();
      const instanceChanges = new Map<string, { assetId: string; worldAsset: SceneAsset }>();

      for (const change of changes) {
        const source = previewAssets[change.index]?.source;
        if (!source) continue;

        if (source.kind === "sceneAsset") {
          const asset = currentAssets.find((item) => item.id === source.assetId);
          if (!asset) continue;
          sceneAssetChanges.set(source.assetId, {
            ...cloneAsset(asset),
            position: [...change.asset.position] as [number, number, number],
            rotation: change.asset.rotation ? [...change.asset.rotation] as [number, number, number] : undefined,
            rotationZ: change.asset.rotation ? undefined : change.asset.rotationZ,
            scale: undefined,
            scale3: getNodeScale(change.asset),
          });
          continue;
        }

        if (!instanceChanges.has(source.instanceId)) {
          instanceChanges.set(source.instanceId, {
            assetId: source.assetId,
            worldAsset: change.asset,
          });
        }
      }

      if (sceneAssetChanges.size > 0) {
        updateAssetsInScope(
          Array.from(sceneAssetChanges.entries()).map(([assetId, asset]) => ({ assetId, asset })),
          coalesceKey,
        );
      }

      if (!editingCollection && instanceChanges.size > 0) {
        updateEditorData(
          (current) => ({
            ...current,
            collectionInstances: current.collectionInstances.map((instance) => {
              const instanceChange = instanceChanges.get(instance.id);
              if (!instanceChange) return instance;
              const definition = current.ownCollections.find((collection) => collection.id === instance.ownCollectionId);
              if (!definition) return instance;
              const localAsset = definition.assets.find((asset) => asset.id === instanceChange.assetId);
              if (!localAsset) return instance;

              const nextTransform = getCollectionInstanceMatrixFromWorldAsset(localAsset, instanceChange.worldAsset);
              return {
                ...instance,
                position: nextTransform.position,
                rotation: nextTransform.rotation,
                rotationZ: undefined,
                scale: undefined,
                scale3: nextTransform.scale3,
              };
            }),
          }),
          { coalesceKey },
        );
      }
    },
    [currentAssets, editingCollection, previewAssets, updateAssetsInScope, updateEditorData],
  );

  const virtualTransform = useMemo(() => {
    if (!selectedInstance) return null;
    return {
      indices: selectedResolvedIndices,
      position: [...selectedInstance.position] as [number, number, number],
      rotation: [...getNodeRotation(selectedInstance)] as [number, number, number],
      scale3: [...getNodeScale(selectedInstance)] as [number, number, number],
    };
  }, [selectedInstance, selectedResolvedIndices]);

  const handleSceneSelectionChange = ({ indices }: { indices: number[] }) => {
    if (indices.length === 0) {
      setSelectedTarget(null);
      return;
    }

    const sources = indices.map((index) => previewAssets[index]?.source).filter(Boolean);
    const instanceIds = [...new Set(sources.filter((source) => source.kind === "collectionInstance").map((source) => source.instanceId))];
    if (!editingCollection && instanceIds.length === 1 && sources.every((source) => source.kind === "collectionInstance" && source.instanceId === instanceIds[0])) {
      setSelectedTarget({ kind: "instance", instanceId: instanceIds[0] });
      return;
    }

    const assetIds = [...new Set(sources.filter((source) => source.kind === "sceneAsset").map((source) => source.assetId))];
    if (assetIds.length > 0) {
      setSelectedTarget({ kind: "asset", assetIds });
      return;
    }
  };

  const updateSelectedNumeric = (kind: "position" | "rotation" | "scale", axis: 0 | 1 | 2, rawValue: string) => {
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed) || !selectedTransformNode) return;

    if (selectedInstance) {
      updateInstance(
        selectedInstance.id,
        (instance) => {
          if (kind === "position") {
            const position = [...instance.position] as [number, number, number];
            position[axis] = parsed;
            return { ...instance, position };
          }
          if (kind === "rotation") {
            const rotation = [...selectedRotation] as [number, number, number];
            rotation[axis] = degreesToRadians(parsed);
            return { ...instance, rotation, rotationZ: undefined };
          }
          const scale3 = [...getNodeScale(instance)] as [number, number, number];
          scale3[axis] = parsed;
          return { ...instance, scale3, scale: undefined };
        },
        `instance-transform:${selectedInstance.id}`,
      );
      return;
    }

    if (!selectedEditableAsset) return;
    const nextAsset = cloneAsset(selectedEditableAsset);
    if (kind === "position") {
      const position = [...nextAsset.position] as [number, number, number];
      position[axis] = parsed;
      nextAsset.position = position;
    } else if (kind === "rotation") {
      const rotation = [...selectedRotation] as [number, number, number];
      rotation[axis] = degreesToRadians(parsed);
      nextAsset.rotation = rotation;
      nextAsset.rotationZ = undefined;
    } else {
      const scale3 = [...getNodeScale(nextAsset)] as [number, number, number];
      scale3[axis] = parsed;
      nextAsset.scale3 = scale3;
      nextAsset.scale = undefined;
    }
    updateAssetsInScope([{ assetId: nextAsset.id, asset: nextAsset }], `asset-transform:${nextAsset.id}`);
  };

  const rotateSelectedAxisBy90 = (axis: 0 | 1 | 2) => {
    if (!selectedTransformNode) return;
    if (selectedInstance) {
      updateInstance(
        selectedInstance.id,
        (instance) => {
          const rotation = [...selectedRotation] as [number, number, number];
          rotation[axis] += Math.PI / 2;
          return { ...instance, rotation, rotationZ: undefined };
        },
        `instance-transform:${selectedInstance.id}`,
      );
      return;
    }
    if (!selectedEditableAsset) return;
    const rotation = [...selectedRotation] as [number, number, number];
    rotation[axis] += Math.PI / 2;
    updateAssetsInScope(
      [{ assetId: selectedEditableAsset.id, asset: { ...cloneAsset(selectedEditableAsset), rotation, rotationZ: undefined } }],
      `asset-transform:${selectedEditableAsset.id}`,
    );
  };

  const updateSelectedAssetKind = (kind: SceneAssetKind) => {
    if (!selectedEditableAsset) return;
    updateAssetsInScope(
      [
        {
          assetId: selectedEditableAsset.id,
          asset: {
            ...cloneAsset(selectedEditableAsset),
            kind: kind === "occluder" ? "occluder" : undefined,
          },
        },
      ],
      `asset-kind:${selectedEditableAsset.id}`,
    );
  };

  const hasAssets = useMemo(() => collections.some((collection) => collection.assets.length > 0), [collections]);
  const orderedCollections = useMemo(() => [...collections].sort((a, b) => a.name.localeCompare(b.name)), [collections]);
  const normalizedAssetSearch = assetSearch.trim().toLowerCase();
  const filteredCollections = useMemo(() => {
    if (!normalizedAssetSearch) return orderedCollections;
    return orderedCollections
      .map((collection) => ({
        ...collection,
        assets: collection.assets.filter((assetPath) => assetPath.toLowerCase().includes(normalizedAssetSearch)),
      }))
      .filter((collection) => collection.assets.length > 0);
  }, [normalizedAssetSearch, orderedCollections]);

  const openAssetAncestors = (assetId: string) => {
    const asset = currentAssets.find((item) => item.id === assetId);
    const nextCollapsed: Record<string, boolean> = {};
    currentGroups.forEach((group) => {
      nextCollapsed[group.id] = true;
    });

    if (asset?.groupId) {
      const parentById = new Map(currentGroups.map((group) => [group.id, group.parentId]));
      let cursor: string | undefined = asset.groupId;
      while (cursor) {
        nextCollapsed[cursor] = false;
        cursor = parentById.get(cursor);
      }
    }

    setCollapsedSceneGroups(nextCollapsed);
  };

  const renderAssetCard = (asset: EditorSceneAsset) => {
    const thumbCollection = asset.sourceCollection ?? asset.collection;
    const assetKind = getSceneAssetKind(asset);
    return (
      <div
        key={asset.id}
        className={styles.sceneAssetCard}
        onMouseEnter={(event) => scheduleHoverPreview(buildThumbnailUrl(asset.collection, thumbCollection, asset.file), asset.file.replace(/^.*\//, ""), event)}
        onMouseLeave={clearHoverPreview}
      >
        <Image
          className={styles.assetThumb}
          alt={asset.file}
          loading="lazy"
          width={44}
          height={44}
          unoptimized
          src={buildThumbnailUrl(asset.collection, thumbCollection, asset.file)}
        />
        <button
          type="button"
          className={selectedAssetIdSet.has(asset.id) ? styles.sceneAssetLabelActive : styles.sceneAssetLabel}
          onClick={(event) => {
            openAssetAncestors(asset.id);
            if (event.shiftKey && selectedTarget?.kind === "asset") {
              const nextIds = selectedTarget.assetIds.includes(asset.id)
                ? selectedTarget.assetIds.filter((id) => id !== asset.id)
                : [...selectedTarget.assetIds, asset.id];
              setSelectedTarget(nextIds.length > 0 ? { kind: "asset", assetIds: nextIds } : null);
              return;
            }
            setSelectedTarget({ kind: "asset", assetIds: [asset.id] });
          }}
          onMouseEnter={(event) => scheduleHoverPreview(buildThumbnailUrl(asset.collection, thumbCollection, asset.file), asset.file.replace(/^.*\//, ""), event)}
          onMouseLeave={clearHoverPreview}
        >
          {asset.file.replace(/^.*\//, "")}
        </button>
        {assetKind === "occluder" ? <div className={styles.occluderBadge}>oclusor</div> : null}
        <select className={styles.groupSelect} value={asset.groupId ?? ""} onChange={(event) => assignAssetToGroup(asset.id, event.target.value)}>
          <option value="">Sin grupo</option>
          {groupOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <button type="button" className={styles.removeButton} onClick={() => removeAssetIds([asset.id])} disabled={saving}>
          Quitar
        </button>
      </div>
    );
  };

  const renderInstanceCard = (instance: OwnCollectionInstance) => {
    const definition = editorData?.ownCollections.find((collection) => collection.id === instance.ownCollectionId);
    return (
      <div key={instance.id} className={styles.sceneAssetCard}>
        <div className={styles.instanceBadge}>ownCollection</div>
        <button
          type="button"
          className={selectedTarget?.kind === "instance" && selectedTarget.instanceId === instance.id ? styles.sceneAssetLabelActive : styles.sceneAssetLabel}
          onClick={() => setSelectedTarget({ kind: "instance", instanceId: instance.id })}
        >
          {instance.name?.trim() || definition?.name || "OwnCollection"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setActiveCollectionId(instance.ownCollectionId)}>
          Editar
        </button>
        <select className={styles.groupSelect} value={instance.parentId ?? ""} onChange={(event) => assignInstanceToGroup(instance.id, event.target.value)}>
          <option value="">Sin grupo</option>
          {groupOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <button type="button" className={styles.secondaryButton} onClick={() => breakInstanceLink(instance.id)}>
          Romper link
        </button>
        <button type="button" className={styles.removeButton} onClick={() => deleteInstance(instance.id)}>
          Quitar
        </button>
      </div>
    );
  };

  const renderGroupTree = (group: SceneGroup): React.JSX.Element => {
    const children = groupsByParent.get(group.id) ?? [];
    const nodeAssets = currentAssets.filter((asset) => asset.groupId === group.id);
    const nodeInstances = editingCollection ? [] : sceneInstances.filter((instance) => instance.parentId === group.id);
    const isCollapsed = Boolean(collapsedSceneGroups[group.id]);
    const descendants = collectDescendantGroupIds(currentGroups, group.id);

    return (
      <div key={group.id} className={styles.collection}>
        <div className={styles.collectionHeader}>
          <button
            type="button"
            className={styles.groupToggleButton}
            onClick={() => setCollapsedSceneGroups((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
            title={isCollapsed ? "Expandir grupo" : "Contraer grupo"}
          >
            <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
          </button>
          <button
            type="button"
            className={selectedTarget?.kind === "group" && selectedTarget.groupId === group.id ? styles.groupNameButtonActive : styles.groupNameButton}
            onClick={() => setSelectedTarget({ kind: "group", groupId: group.id })}
          >
            {group.name} - {nodeAssets.length + nodeInstances.length} items
          </button>
        </div>
        {!isCollapsed ? (
          <div className={styles.groupBody}>
            <div className={styles.groupActions}>
              <select className={styles.groupSelect} value={group.parentId ?? ""} onChange={(event) => changeGroupParent(group.id, event.target.value)}>
                <option value="">Root</option>
                {groupOptions
                  .filter((option) => option.id !== group.id && !descendants.has(option.id))
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
              </select>
              <button type="button" className={styles.iconButton} onClick={() => copyGroup(group.id)} title="Copiar grupo">
                📄
              </button>
              {!editingCollection ? (
                <button type="button" className={styles.iconButton} onClick={() => createOwnCollectionFromGroup(group.id)} title="Convertir a ownCollection">
                  🧩
                </button>
              ) : null}
              <button type="button" className={styles.iconButton} onClick={() => promptRenameGroup(group.id)} title="Renombrar grupo">
                ✏️
              </button>
              <button type="button" className={styles.removeButton} onClick={() => deleteGroup(group.id)}>
                Eliminar grupo
              </button>
            </div>
            {nodeAssets.length > 0 || nodeInstances.length > 0 ? (
              <div className={styles.assetList}>
                {nodeAssets.map(renderAssetCard)}
                {nodeInstances.map(renderInstanceCard)}
              </div>
            ) : null}
            {children.map((child) => renderGroupTree(child))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className={styles.editor}>
      <aside className={styles.panel}>
        <div className={styles.panelHeader}>
          <h1 className={styles.title}>Editor de Preview</h1>
          <p className={styles.subtitle}>
            {editingCollection ? "Editando ownCollection." : "Agrega assets, agrupalos o conviertelos en ownCollections."}
          </p>
        </div>

        <div className={styles.toolbar}>
          <button type="button" className={styles.secondaryButton} onClick={() => void loadInitialData()} disabled={loading || saving}>
            Recargar
          </button>
          {editingCollection ? (
            <button type="button" className={styles.secondaryButton} onClick={() => { setActiveCollectionId(null); setSelectedTarget(null); }}>
              Volver a escena
            </button>
          ) : null}
          <button type="button" className={styles.primaryButton} onClick={() => void saveLayout()} disabled={loading || saving || !dirty}>
            {saving ? "Guardando..." : dirty ? "Guardar cambios" : "Guardado"}
          </button>
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Colecciones</h2>
          <input
            className={styles.groupInput}
            type="text"
            placeholder="Buscar asset por nombre..."
            value={assetSearch}
            onChange={(event) => setAssetSearch(event.target.value)}
          />
          {!loading && !hasAssets ? <p className={styles.empty}>No hay assets disponibles.</p> : null}
          {!loading && hasAssets && filteredCollections.length === 0 ? <p className={styles.empty}>Sin resultados.</p> : null}
          <div className={styles.sectionScrollable}>
            {filteredCollections.map((collection) => {
              const isCollapsed = Boolean(collapsedCollections[collection.id]);
              return (
                <div key={`${collection.source}:${collection.id}`} className={styles.collection}>
                  <button
                    type="button"
                    className={styles.collectionHeader}
                    onClick={() => setCollapsedCollections((prev) => ({ ...prev, [collection.id]: !prev[collection.id] }))}
                  >
                    <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
                    <span className={styles.collectionName}>
                      {collection.name} - {collection.assets.length} assets
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className={styles.assetList}>
                      {collection.assets.map((assetPath) => {
                        const occluderAsset = isOccluderCollection(collection);
                        return (
                          <button
                            key={`${collection.name}:${assetPath}`}
                            type="button"
                            className={styles.assetButton}
                            onClick={() => void addAsset(collection, assetPath, occluderAsset ? "occluder" : "model")}
                            onMouseEnter={(event) => scheduleHoverPreview(buildThumbnailUrl(collection.thumbnailCollectionId, collection.name, assetPath), assetPath.replace(/^.*\//, ""), event)}
                            onMouseLeave={clearHoverPreview}
                            disabled={loading || saving || importingAssetKey !== null}
                            title={occluderAsset ? "Agregar como oclusor" : "Agregar a la escena"}
                          >
                            <Image
                              className={styles.assetThumb}
                              alt={assetPath}
                              loading="lazy"
                              width={44}
                              height={44}
                              unoptimized
                              src={buildThumbnailUrl(collection.thumbnailCollectionId, collection.name, assetPath)}
                            />
                            <span className={styles.assetLabel}>{assetPath.replace(/^.*\//, "")}</span>
                            {occluderAsset ? <span className={styles.occluderBadge}>oclusor</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {!editingCollection ? (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>OwnCollections ({editorData?.ownCollections.length ?? 0})</h2>
            <div className={styles.sectionScrollable}>
              {(editorData?.ownCollections ?? []).map((collection) => {
                const isCollapsed = Boolean(collapsedOwnCollections[collection.id]);
                const usages = sceneInstances.filter((instance) => instance.ownCollectionId === collection.id).length;
                return (
                  <div key={collection.id} className={styles.collection}>
                    <button
                      type="button"
                      className={styles.collectionHeader}
                      onClick={() => setCollapsedOwnCollections((prev) => ({ ...prev, [collection.id]: !prev[collection.id] }))}
                    >
                      <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
                      <span className={styles.collectionName}>
                        {collection.name} - {collection.assets.length} assets - {usages} usos
                      </span>
                    </button>
                    {!isCollapsed ? (
                      <div className={styles.groupBody}>
                        <div className={styles.groupActions}>
                          <button type="button" className={styles.secondaryButton} onClick={() => { setActiveCollectionId(collection.id); setSelectedTarget(null); }}>
                            Editar
                          </button>
                          <button type="button" className={styles.secondaryButton} onClick={() => addOwnCollectionInstance(collection.id)}>
                            Agregar a escena
                          </button>
                          <button type="button" className={styles.iconButton} onClick={() => renameOwnCollection(collection.id)} title="Renombrar ownCollection">
                            ✏️
                          </button>
                          <button type="button" className={styles.removeButton} onClick={() => deleteOwnCollection(collection.id)}>
                            Eliminar
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {(editorData?.ownCollections.length ?? 0) === 0 ? <p className={styles.empty}>Convierte un grupo en ownCollection para reutilizarlo.</p> : null}
            </div>
          </div>
        ) : null}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            {editingCollection ? `Editando: ${currentCollection?.name ?? ""}` : `Objetos en escena (${sceneAssets.length + sceneInstances.length})`}
          </h2>
          <div className={styles.groupCreator}>
            <input
              className={styles.groupInput}
              type="text"
              placeholder="Nombre del grupo"
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
            />
            <button type="button" className={styles.secondaryButton} onClick={createGroup} disabled={!newGroupName.trim()}>
              Crear grupo
            </button>
          </div>
          {(currentAssets.length + ungroupedInstances.length) === 0 ? (
            <p className={styles.empty}>Todavia no agregaste objetos.</p>
          ) : (
            <div className={styles.sectionScrollable}>
              {(groupsByParent.get("__root__") ?? []).map((group) => renderGroupTree(group))}
              {ungroupedAssets.length > 0 || ungroupedInstances.length > 0 ? (
                <div className={styles.collection}>
                  <p className={styles.collectionName}>Sin grupo - {ungroupedAssets.length + ungroupedInstances.length}</p>
                  <div className={styles.assetList}>
                    {ungroupedAssets.map(renderAssetCard)}
                    {ungroupedInstances.map(renderInstanceCard)}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <div className={styles.previewArea}>
        {hoverPreview ? (
          <div className={styles.assetHoverPreview} style={{ left: hoverPreview.x, top: hoverPreview.y }} onMouseLeave={clearHoverPreview}>
            <Image className={styles.assetHoverPreviewImage} alt={hoverPreview.label} src={hoverPreview.src} width={288} height={288} unoptimized />
            <p className={styles.assetHoverPreviewLabel}>{hoverPreview.label}</p>
          </div>
        ) : null}

        <div className={styles.previewTopRightTools}>
          <span className={styles.transformTitle}>Modo</span>
          <div className={styles.transformButtons}>
            <button type="button" className={transformMode === "observe" ? styles.transformButtonActive : styles.transformButton} onClick={() => setTransformMode("observe")}>
              Observar
            </button>
            <button type="button" className={transformMode === "translate" ? styles.transformButtonActive : styles.transformButton} onClick={() => setTransformMode("translate")}>
              Mover
            </button>
            <button type="button" className={transformMode === "rotate" ? styles.transformButtonActive : styles.transformButton} onClick={() => setTransformMode("rotate")}>
              Rotar
            </button>
            <button type="button" className={transformMode === "scale" ? styles.transformButtonActive : styles.transformButton} onClick={() => setTransformMode("scale")}>
              Escalar
            </button>
          </div>
        </div>

        {selectedTransformNode ? (
          <div className={styles.previewBottomPanel}>
            <p className={styles.previewBottomTitle}>
              {selectedEditableAsset ? selectedEditableAsset.file.replace(/^.*\//, "") : selectedInstance?.name?.trim() || "OwnCollection"}
            </p>
            {selectedEditableAsset ? (
              <div className={styles.kindToggleRow}>
                <span className={styles.paramLabel}>Tipo</span>
                <div className={styles.kindToggleButtons}>
                  <button
                    type="button"
                    className={selectedAssetKind === "model" ? styles.transformButtonActive : styles.transformButton}
                    onClick={() => updateSelectedAssetKind("model")}
                  >
                    Visible
                  </button>
                  <button
                    type="button"
                    className={selectedAssetKind === "occluder" ? styles.transformButtonActive : styles.transformButton}
                    onClick={() => updateSelectedAssetKind("occluder")}
                  >
                    Oclusor
                  </button>
                </div>
              </div>
            ) : null}
            {transformMode === "translate" ? (
              <div className={styles.paramRows}>
                {[0, 1, 2].map((axis) => (
                  <label key={axis} className={styles.paramRow}>
                    <span className={styles.paramLabel}>{`Pos ${axis === 0 ? "X" : axis === 1 ? "Y" : "Z"}`}</span>
                    <input className={styles.paramInput} type="number" step="0.01" value={selectedTransformNode.position[axis]} onChange={(event) => updateSelectedNumeric("position", axis as 0 | 1 | 2, event.target.value)} />
                  </label>
                ))}
              </div>
            ) : null}
            {transformMode === "rotate" ? (
              <div className={styles.paramRows}>
                {[0, 1, 2].map((axis) => (
                  <div key={axis} className={styles.paramRow}>
                    <span className={styles.paramLabel}>{`Rot ${axis === 0 ? "X" : axis === 1 ? "Y" : "Z"}`}</span>
                    <input className={styles.paramInput} type="number" step="1" value={selectedRotationDegrees[axis]} onChange={(event) => updateSelectedNumeric("rotation", axis as 0 | 1 | 2, event.target.value)} />
                    <button type="button" className={styles.axisStepButton} onClick={() => rotateSelectedAxisBy90(axis as 0 | 1 | 2)}>
                      +90°
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {transformMode === "scale" ? (
              <div className={styles.paramRows}>
                {[0, 1, 2].map((axis) => (
                  <label key={axis} className={styles.paramRow}>
                    <span className={styles.paramLabel}>{`Esc ${axis === 0 ? "X" : axis === 1 ? "Y" : "Z"}`}</span>
                    <input className={styles.paramInput} type="number" step="0.01" min="0.001" value={selectedScale?.[axis] ?? 1} onChange={(event) => updateSelectedNumeric("scale", axis as 0 | 1 | 2, event.target.value)} />
                  </label>
                ))}
              </div>
            ) : null}
            {transformMode !== "observe" ? (
              <p className={styles.previewBottomValues}>Valores en unidades de escena (rotacion en grados).</p>
            ) : (
              <p className={styles.previewBottomValues}>
                {selectedEditableAsset
                  ? selectedAssetKind === "occluder"
                    ? "Este asset se guarda como oclusor: visible en el preview, invisible en AR real."
                    : "Este asset se renderiza normalmente en el preview y en AR real."
                  : "Selecciona mover, rotar o escalar para editar esta instancia."}
              </p>
            )}
          </div>
        ) : null}

        {editorData ? (
          <ScenePreview
            layout={previewAssets.map((asset) => ({
              collection: asset.collection,
              file: asset.file,
              kind: asset.kind,
              sourceCollection: asset.sourceCollection,
              position: asset.position,
              rotation: asset.rotation,
              rotationZ: asset.rotationZ,
              scale: asset.scale,
              scale3: asset.scale3,
            }))}
            selectedAssetIndices={selectedResolvedIndices}
            transformMode={transformMode}
            onSelectionChange={handleSceneSelectionChange}
            onAssetTransform={(index, asset) => applyPreviewChanges([{ index, asset }], `preview:${index}`)}
            onAssetsTransform={(changes, coalesceKey) => applyPreviewChanges(changes, coalesceKey ?? "preview-multi")}
            virtualTransform={virtualTransform}
            onVirtualTransform={
              selectedInstance
                ? (transform) =>
                    updateInstance(
                      selectedInstance.id,
                      (instance) => ({
                        ...instance,
                        position: transform.position,
                        rotation: transform.rotation,
                        rotationZ: undefined,
                        scale: undefined,
                        scale3: transform.scale3,
                      }),
                      `instance-transform:${selectedInstance.id}`,
                    )
                : undefined
            }
          />
        ) : (
          <section className={styles.previewLoading}>
            <p className={styles.empty}>Cargando escena...</p>
          </section>
        )}
      </div>
    </section>
  );
}
