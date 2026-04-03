"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import ScenePreview from "@/components/ar/ScenePreview";
import type { SceneAsset, SceneGroup, SceneLayout } from "@/lib/sceneLayout";
import styles from "@/components/ar/PreviewEditor.module.css";

type AssetCollection = {
  source: "public" | "root";
  id: string;
  thumbnailCollectionId: string;
  name: string;
  assets: string[];
};

type TransformMode = "observe" | "translate" | "rotate" | "scale";
type SelectedTarget = { kind: "asset"; index: number } | { kind: "group"; groupId: string } | null;

const spawnPositionForIndex = (index: number): [number, number, number] => {
  if (index === 0) return [0, 0, 0];
  const step = 0.32;
  const col = index % 4;
  const row = Math.floor(index / 4);
  return [(col - 1.5) * step, (row - 1.5) * step, 0];
};

const cloneLayout = (assets: SceneAsset[]): SceneAsset[] => {
  return assets.map((asset) => ({
    ...asset,
    position: [...asset.position] as [number, number, number],
    rotation: asset.rotation ? [...asset.rotation] as [number, number, number] : undefined,
  }));
};

const layoutSignature = (assets: SceneAsset[]): string => JSON.stringify(assets);
const groupsSignature = (groups: SceneGroup[]): string => JSON.stringify(groups);
const editorSignature = (assets: SceneAsset[], groups: SceneGroup[]): string => `${layoutSignature(assets)}__${groupsSignature(groups)}`;

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

export default function PreviewEditor() {
  const [collections, setCollections] = useState<AssetCollection[]>([]);
  const [layout, setLayout] = useState<SceneAsset[] | null>(null);
  const [sceneGroups, setSceneGroups] = useState<SceneGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importingAssetKey, setImportingAssetKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [collapsedSceneGroups, setCollapsedSceneGroups] = useState<Record<string, boolean>>({});
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("observe");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const layoutStateRef = useRef<SceneAsset[] | null>(null);
  const groupsStateRef = useRef<SceneGroup[]>([]);
  const [assetSearch, setAssetSearch] = useState("");

  const historyRef = useRef<SceneAsset[][]>([]);
  const historyIndexRef = useRef(-1);
  const savedSignatureRef = useRef("");
  const lastCoalesceOpRef = useRef<{ key: string; at: number } | null>(null);
  const [newGroupName, setNewGroupName] = useState("");

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const setSnapshotAsCurrent = useCallback((assets: SceneAsset[]) => {
    const snapshot = cloneLayout(assets);
    layoutStateRef.current = snapshot;
    setLayout(snapshot);
    setDirty(editorSignature(snapshot, groupsStateRef.current) !== savedSignatureRef.current);
  }, []);

  const commitHistorySnapshot = useCallback(
    (assets: SceneAsset[], options?: { coalesceKey?: string }) => {
      const snapshot = cloneLayout(assets);
      const nextSig = layoutSignature(snapshot);

      if (historyIndexRef.current >= 0) {
        const currentSig = layoutSignature(historyRef.current[historyIndexRef.current]);
        if (currentSig === nextSig) return snapshot;
      }

      const now = Date.now();
      const coalesceKey = options?.coalesceKey;
      const canCoalesce =
        Boolean(coalesceKey) &&
        lastCoalesceOpRef.current?.key === coalesceKey &&
        now - lastCoalesceOpRef.current.at < 250 &&
        historyIndexRef.current >= 0;

      const nextEntries = historyRef.current.slice(0, historyIndexRef.current + 1);
      if (canCoalesce) {
        nextEntries[historyIndexRef.current] = snapshot;
      } else {
        nextEntries.push(snapshot);
        historyIndexRef.current = nextEntries.length - 1;
      }

      historyRef.current = nextEntries;
      lastCoalesceOpRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
      setDirty(editorSignature(snapshot, groupsStateRef.current) !== savedSignatureRef.current);
      syncHistoryFlags();
      return snapshot;
    },
    [syncHistoryFlags],
  );

  const initializeHistory = useCallback(
    (assets: SceneAsset[]) => {
      const snapshot = cloneLayout(assets);
      historyRef.current = [snapshot];
      historyIndexRef.current = 0;
      savedSignatureRef.current = editorSignature(snapshot, groupsStateRef.current);
      lastCoalesceOpRef.current = null;
      layoutStateRef.current = snapshot;
      setLayout(snapshot);
      setDirty(false);
      syncHistoryFlags();
    },
    [syncHistoryFlags],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    lastCoalesceOpRef.current = null;
    setSnapshotAsCurrent(snapshot);
    syncHistoryFlags();
  }, [setSnapshotAsCurrent, syncHistoryFlags]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    lastCoalesceOpRef.current = null;
    setSnapshotAsCurrent(snapshot);
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
      const initialGroups = layoutJson.groups ?? [];
      groupsStateRef.current = initialGroups;
      setSceneGroups(initialGroups);
      initializeHistory(layoutJson.assets ?? []);
      setSelectedTarget(null);
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
    layoutStateRef.current = layout;
  }, [layout]);

  useEffect(() => {
    groupsStateRef.current = sceneGroups;
  }, [sceneGroups]);

  const addAsset = async (collection: AssetCollection, assetPath: string) => {
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
      const base = layoutStateRef.current ?? [];
      const insertedIndex = base.length;
      const next = [
        ...base,
        {
          collection: imported.collection,
          file: imported.file,
          sourceCollection: imported.sourceCollection,
          position: spawnPositionForIndex(insertedIndex),
          rotation: [0, 0, 0] as [number, number, number],
        },
      ];
      const snapshot = commitHistorySnapshot(next);
      layoutStateRef.current = snapshot;
      setLayout(snapshot);
      setSelectedTarget({ kind: "asset", index: insertedIndex });
      lastCoalesceOpRef.current = null;
    } catch (importError) {
      console.error(importError);
      setError(importError instanceof Error ? importError.message : "Error al importar asset.");
    } finally {
      setImportingAssetKey(null);
    }
  };

  const removeAssetAt = (index: number) => {
    const base = layoutStateRef.current ?? [];
    const next = base.filter((_, i) => i !== index);
    const snapshot = commitHistorySnapshot(next);
    layoutStateRef.current = snapshot;
    setLayout(snapshot);
    setSelectedTarget((prev) => {
      if (!prev || prev.kind !== "asset") return prev;
      if (prev.index === index) return null;
      if (prev.index > index) return { kind: "asset", index: prev.index - 1 };
      return prev;
    });
    lastCoalesceOpRef.current = null;
  };

  const updateAssetAt = (index: number, asset: SceneAsset, options?: { coalesceKey?: string }) => {
    const base = layoutStateRef.current ?? [];
    const next = [...base];
    if (!next[index]) return;
    next[index] = asset;
    const snapshot = commitHistorySnapshot(next, { coalesceKey: options?.coalesceKey ?? `transform:${index}` });
    layoutStateRef.current = snapshot;
    setLayout(snapshot);
  };

  const updateAssetsAt = (changes: Array<{ index: number; asset: SceneAsset }>, coalesceKey = "multi-transform") => {
    if (changes.length === 0) return;
    const base = layoutStateRef.current ?? [];
    const next = [...base];
    let touched = false;
    for (const change of changes) {
      if (!next[change.index]) continue;
      next[change.index] = change.asset;
      touched = true;
    }
    if (!touched) return;
    const snapshot = commitHistorySnapshot(next, { coalesceKey });
    layoutStateRef.current = snapshot;
    setLayout(snapshot);
  };

  const saveLayout = async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/editor/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: layout ?? [], groups: sceneGroups }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "No se pudo guardar el layout.");
      }
      savedSignatureRef.current = editorSignature(layout ?? [], sceneGroups);
      setDirty(false);
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : "Error al guardar.");
    } finally {
      setSaving(false);
    }
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
  const sceneAssetsWithIndex = useMemo(
    () => (layout ?? []).map((asset, index) => ({ asset, index })),
    [layout],
  );

  const groupsByParent = useMemo(() => {
    const map = new Map<string, SceneGroup[]>();
    for (const group of sceneGroups) {
      const key = group.parentId ?? "__root__";
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(group);
      } else {
        map.set(key, [group]);
      }
    }
    for (const [, bucket] of map) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [sceneGroups]);

  const groupOptions = useMemo(
    () => sceneGroups.map((group) => ({ id: group.id, name: group.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [sceneGroups],
  );

  const ungroupedAssets = useMemo(
    () => sceneAssetsWithIndex.filter(({ asset }) => !asset.groupId),
    [sceneAssetsWithIndex],
  );

  const selectedAssetIndices = useMemo(() => {
    if (!layout || !selectedTarget) return [] as number[];
    if (selectedTarget.kind === "asset") {
      if (selectedTarget.index < 0 || selectedTarget.index >= layout.length) return [] as number[];
      return [selectedTarget.index];
    }
    const groupIds = collectDescendantGroupIds(sceneGroups, selectedTarget.groupId);
    return layout
      .map((asset, index) => ({ asset, index }))
      .filter(({ asset }) => asset.groupId && groupIds.has(asset.groupId))
      .map(({ index }) => index);
  }, [layout, sceneGroups, selectedTarget]);

  const selectedAsset = useMemo(() => {
    if (!layout || selectedAssetIndices.length !== 1) return null;
    return layout[selectedAssetIndices[0]] ?? null;
  }, [layout, selectedAssetIndices]);

  useEffect(() => {
    if (!layout || !selectedTarget) return;
    if (selectedTarget.kind === "asset" && selectedTarget.index >= layout.length) {
      setSelectedTarget(null);
    }
    if (selectedTarget.kind === "group" && !sceneGroups.some((group) => group.id === selectedTarget.groupId)) {
      setSelectedTarget(null);
    }
  }, [layout, sceneGroups, selectedTarget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
      const isRedo =
        (event.metaKey || event.ctrlKey) &&
        ((event.shiftKey && event.key.toLowerCase() === "z") || (!event.shiftKey && event.key.toLowerCase() === "y"));

      if (isUndo && canUndo) {
        event.preventDefault();
        undo();
      } else if (isRedo && canRedo) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canRedo, canUndo, redo, undo]);

  const toggleCollection = (collectionId: string) => {
    setCollapsedCollections((prev) => ({ ...prev, [collectionId]: !prev[collectionId] }));
  };

  const toggleSceneGroup = (groupId: string) => {
    setCollapsedSceneGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const commitGroups = (nextGroups: SceneGroup[]) => {
    groupsStateRef.current = nextGroups;
    setSceneGroups(nextGroups);
    setDirty(editorSignature(layoutStateRef.current ?? [], nextGroups) !== savedSignatureRef.current);
    lastCoalesceOpRef.current = null;
  };

  const makeGroupId = (occupied?: Set<string>) => {
    const taken = occupied ?? new Set(sceneGroups.map((group) => group.id));
    let id = `grp_${Math.random().toString(36).slice(2, 10)}`;
    while (taken.has(id)) {
      id = `grp_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    }
    taken.add(id);
    return id;
  };

  const createGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const nextGroup: SceneGroup = {
      id: makeGroupId(),
      name,
      parentId: undefined,
    };
    commitGroups([...sceneGroups, nextGroup]);
    setNewGroupName("");
  };

  const renameGroup = (groupId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = sceneGroups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group));
    commitGroups(next);
  };

  const promptRenameGroup = (groupId: string) => {
    const target = sceneGroups.find((group) => group.id === groupId);
    if (!target) return;
    const nextName = window.prompt("Nuevo nombre del grupo", target.name);
    if (nextName === null) return;
    renameGroup(groupId, nextName);
  };

  const deleteGroup = (groupId: string) => {
    const descendants = collectDescendantGroupIds(sceneGroups, groupId);
    const nextGroups = sceneGroups.filter((group) => !descendants.has(group.id));
    commitGroups(nextGroups);
    const base = layoutStateRef.current ?? [];
    const nextAssets = base.filter((asset) => !(asset.groupId && descendants.has(asset.groupId)));
    const snapshot = commitHistorySnapshot(nextAssets);
    layoutStateRef.current = snapshot;
    setLayout(snapshot);
  };

  const changeGroupParent = (groupId: string, parentId: string) => {
    const normalizedParentId = parentId || undefined;
    if (normalizedParentId === groupId) return;
    if (normalizedParentId) {
      const descendants = collectDescendantGroupIds(sceneGroups, groupId);
      if (descendants.has(normalizedParentId)) return;
    }
    const nextGroups = sceneGroups.map((group) =>
      group.id === groupId ? { ...group, parentId: normalizedParentId } : group,
    );
    commitGroups(nextGroups);
  };

  const copyGroup = (groupId: string) => {
    const descendants = collectDescendantGroupIds(sceneGroups, groupId);
    const groupsToCopy = sceneGroups.filter((group) => descendants.has(group.id));
    if (groupsToCopy.length === 0) return;

    const idMap = new Map<string, string>();
    const occupied = new Set(sceneGroups.map((group) => group.id));
    const nextGroupsSeed = [...sceneGroups];
    for (const group of groupsToCopy) {
      const newId = makeGroupId(occupied);
      idMap.set(group.id, newId);
      nextGroupsSeed.push({
        id: newId,
        name: `${group.name} (copia)`,
        parentId: undefined,
      });
    }

    const nextGroups = nextGroupsSeed.map((group) => {
      const source = groupsToCopy.find((item) => idMap.get(item.id) === group.id);
      if (!source) return group;
      const mappedParent = source.parentId && idMap.has(source.parentId) ? idMap.get(source.parentId) : source.parentId;
      return { ...group, parentId: mappedParent };
    });
    commitGroups(nextGroups);

    const baseAssets = layoutStateRef.current ?? [];
    const copiedAssets = baseAssets
      .filter((asset) => asset.groupId && descendants.has(asset.groupId))
      .map((asset) => ({
        ...asset,
        position: [...asset.position] as [number, number, number],
        rotation: asset.rotation ? [...asset.rotation] as [number, number, number] : undefined,
        groupId: asset.groupId ? idMap.get(asset.groupId) : undefined,
      }));
    const snapshot = commitHistorySnapshot([...baseAssets, ...copiedAssets]);
    layoutStateRef.current = snapshot;
    setLayout(snapshot);

    const rootCopyId = idMap.get(groupId);
    if (rootCopyId) {
      setSelectedTarget({ kind: "group", groupId: rootCopyId });
      setTransformMode("translate");
    }
  };

  const assignAssetToGroup = (index: number, groupId: string) => {
    const asset = (layoutStateRef.current ?? [])[index];
    if (!asset) return;
    updateAssetAt(index, {
      ...asset,
      groupId: groupId || undefined,
    }, { coalesceKey: `group:${index}` });
  };

  const selectedRotation = selectedAsset?.rotation ?? [0, selectedAsset?.rotationZ ?? 0, 0];

  const updateSelectedNumeric = (kind: "position" | "rotation" | "scale", axis: 0 | 1 | 2 | null, rawValue: string) => {
    if (!selectedAsset || selectedAssetIndices.length !== 1) return;
    const selectedIndex = selectedAssetIndices[0];
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) return;

    if (kind === "position" && axis !== null) {
      const nextPosition = [...selectedAsset.position] as [number, number, number];
      nextPosition[axis] = parsed;
      updateAssetAt(selectedIndex, {
        ...selectedAsset,
        position: nextPosition,
      });
      return;
    }

    if (kind === "rotation" && axis !== null) {
      const base = [...selectedRotation] as [number, number, number];
      base[axis] = parsed;
      updateAssetAt(selectedIndex, {
        ...selectedAsset,
        rotation: base,
        rotationZ: undefined,
      });
      return;
    }

    if (kind === "scale") {
      updateAssetAt(selectedIndex, {
        ...selectedAsset,
        scale: parsed,
      });
    }
  };

  const handleSceneSelectionChange = (index: number | null) => {
    if (index === null) {
      setSelectedTarget(null);
      return;
    }
    const assets = layoutStateRef.current ?? [];
    const selected = assets[index];
    const groups = groupsStateRef.current;
    const nextCollapsed: Record<string, boolean> = {};
    groups.forEach((group) => {
      nextCollapsed[group.id] = true;
    });

    if (selected?.groupId) {
      const parentById = new Map(groups.map((group) => [group.id, group.parentId]));
      let cursor: string | undefined = selected.groupId;
      while (cursor) {
        nextCollapsed[cursor] = false;
        cursor = parentById.get(cursor);
      }
    }
    setCollapsedSceneGroups(nextCollapsed);
    setSelectedTarget({ kind: "asset", index });
  };

  return (
    <section className={styles.editor}>
      <aside className={styles.panel}>
        <div className={styles.panelHeader}>
          <h1 className={styles.title}>Editor de Preview</h1>
          <p className={styles.subtitle}>Click en un asset para insertarlo en escena.</p>
        </div>

        <div className={styles.toolbar}>
          <button type="button" className={styles.secondaryButton} onClick={() => void loadInitialData()} disabled={loading || saving}>
            Recargar
          </button>
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
          {!loading && hasAssets && filteredCollections.length === 0 ? <p className={styles.empty}>Sin resultados para la busqueda.</p> : null}
          <div className={styles.sectionScrollable}>
            {filteredCollections.map((collection) => {
              const isCollapsed = Boolean(collapsedCollections[collection.id]);
              return (
                <div key={`${collection.source}:${collection.id}`} className={styles.collection}>
                  <button
                    type="button"
                    className={styles.collectionHeader}
                    onClick={() => toggleCollection(collection.id)}
                    title={isCollapsed ? "Expandir coleccion" : "Contraer coleccion"}
                  >
                    <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
                    <span className={styles.collectionName}>
                      {collection.name} - {collection.assets.length} assets
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className={styles.assetList}>
                      {collection.assets.map((asset) => (
                        <button
                          key={`${collection.name}:${asset}`}
                          type="button"
                          className={styles.assetButton}
                          onClick={() => void addAsset(collection, asset)}
                          disabled={loading || saving || importingAssetKey !== null}
                        >
                          <Image
                            className={styles.assetThumb}
                            alt={asset}
                            loading="lazy"
                            width={44}
                            height={44}
                            unoptimized
                            src={`/api/editor/thumbnail?collectionId=${encodeURIComponent(collection.thumbnailCollectionId)}&collection=${encodeURIComponent(collection.name)}&asset=${encodeURIComponent(asset)}`}
                          />
                          <span className={styles.assetLabel}>{asset.replace(/^.*\//, "")}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Objetos en escena ({layout?.length ?? 0})</h2>
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
          {(layout?.length ?? 0) === 0 ? (
            <p className={styles.empty}>Todavia no agregaste objetos.</p>
          ) : (
            <div className={styles.sectionScrollable}>
              {(groupsByParent.get("__root__") ?? []).map((group) => {
                const renderGroup = (node: SceneGroup) => {
                  const children = groupsByParent.get(node.id) ?? [];
                  const nodeAssets = sceneAssetsWithIndex.filter(({ asset }) => asset.groupId === node.id);
                  const isCollapsed = Boolean(collapsedSceneGroups[node.id]);
                  const descendants = collectDescendantGroupIds(sceneGroups, node.id);
                  return (
                    <div key={node.id} className={styles.collection}>
                      <div className={styles.collectionHeader}>
                        <button
                          type="button"
                          className={styles.groupToggleButton}
                          onClick={() => toggleSceneGroup(node.id)}
                          title={isCollapsed ? "Expandir grupo" : "Contraer grupo"}
                        >
                          <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
                        </button>
                        <button
                          type="button"
                          className={
                            selectedTarget?.kind === "group" && selectedTarget.groupId === node.id
                              ? styles.groupNameButtonActive
                              : styles.groupNameButton
                          }
                          onClick={() => {
                            setSelectedTarget({ kind: "group", groupId: node.id });
                            setTransformMode("translate");
                          }}
                          title="Seleccionar grupo"
                        >
                          {node.name} - {nodeAssets.length} assets
                        </button>
                      </div>
                      {!isCollapsed ? (
                        <div className={styles.groupBody}>
                          <div className={styles.groupActions}>
                            <select
                              className={styles.groupSelect}
                              value={node.parentId ?? ""}
                              onChange={(event) => changeGroupParent(node.id, event.target.value)}
                            >
                              <option value="">Root</option>
                              {groupOptions
                                .filter((option) => {
                                  if (option.id === node.id) return false;
                                  return !descendants.has(option.id);
                                })
                                .map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.name}
                                  </option>
                                ))}
                            </select>
                            <button type="button" className={styles.iconButton} onClick={() => copyGroup(node.id)} title="Copiar grupo">
                              📄
                            </button>
                            <button type="button" className={styles.iconButton} onClick={() => promptRenameGroup(node.id)} title="Renombrar grupo">
                              ✏️
                            </button>
                            <button type="button" className={styles.removeButton} onClick={() => deleteGroup(node.id)}>
                              Eliminar grupo
                            </button>
                          </div>
                          {nodeAssets.length > 0 ? (
                            <div className={styles.assetList}>
                              {nodeAssets.map(({ index, asset }) => (
                                <div key={`${asset.collection}/${asset.file}:${index}`} className={styles.sceneAssetCard}>
                                  <Image
                                    className={styles.assetThumb}
                                    alt={asset.file}
                                    loading="lazy"
                                    width={44}
                                    height={44}
                                    unoptimized
                                    src={`/api/editor/thumbnail?collectionId=${encodeURIComponent(asset.collection)}&collection=${encodeURIComponent(asset.sourceCollection ?? asset.collection)}&asset=${encodeURIComponent(asset.file)}`}
                                  />
                                  <button
                                    type="button"
                                    className={selectedTarget?.kind === "asset" && selectedTarget.index === index ? styles.sceneAssetLabelActive : styles.sceneAssetLabel}
                                    onClick={() => {
                                      setSelectedTarget({ kind: "asset", index });
                                      setTransformMode("translate");
                                    }}
                                  >
                                    {asset.file.replace(/^.*\//, "")}
                                  </button>
                                  <select
                                    className={styles.groupSelect}
                                    value={asset.groupId ?? ""}
                                    onChange={(event) => assignAssetToGroup(index, event.target.value)}
                                  >
                                    <option value="">Sin grupo</option>
                                    {groupOptions.map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button type="button" className={styles.removeButton} onClick={() => removeAssetAt(index)} disabled={saving}>
                                    Quitar
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {children.map((child) => renderGroup(child))}
                        </div>
                      ) : null}
                    </div>
                  );
                };
                return renderGroup(group);
              })}

              {ungroupedAssets.length > 0 ? (
                <div className={styles.collection}>
                  <p className={styles.collectionName}>Sin grupo - {ungroupedAssets.length}</p>
                  <div className={styles.assetList}>
                    {ungroupedAssets.map(({ index, asset }) => (
                      <div key={`${asset.collection}/${asset.file}:${index}`} className={styles.sceneAssetCard}>
                        <Image
                          className={styles.assetThumb}
                          alt={asset.file}
                          loading="lazy"
                          width={44}
                          height={44}
                          unoptimized
                          src={`/api/editor/thumbnail?collectionId=${encodeURIComponent(asset.collection)}&collection=${encodeURIComponent(asset.sourceCollection ?? asset.collection)}&asset=${encodeURIComponent(asset.file)}`}
                        />
                        <button
                          type="button"
                          className={selectedTarget?.kind === "asset" && selectedTarget.index === index ? styles.sceneAssetLabelActive : styles.sceneAssetLabel}
                          onClick={() => {
                            setSelectedTarget({ kind: "asset", index });
                            setTransformMode("translate");
                          }}
                        >
                          {asset.file.replace(/^.*\//, "")}
                        </button>
                        <select
                          className={styles.groupSelect}
                          value={asset.groupId ?? ""}
                          onChange={(event) => assignAssetToGroup(index, event.target.value)}
                        >
                          <option value="">Sin grupo</option>
                          {groupOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                        <button type="button" className={styles.removeButton} onClick={() => removeAssetAt(index)} disabled={saving}>
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <div className={styles.previewArea}>
        <div className={styles.previewTopRightTools}>
          <span className={styles.transformTitle}>Modo</span>
          <div className={styles.transformButtons}>
            <button
              type="button"
              className={transformMode === "observe" ? styles.transformButtonActive : styles.transformButton}
              onClick={() => setTransformMode("observe")}
            >
              Observar
            </button>
            <button
              type="button"
              className={transformMode === "translate" ? styles.transformButtonActive : styles.transformButton}
              onClick={() => setTransformMode("translate")}
            >
              Mover
            </button>
            <button
              type="button"
              className={transformMode === "rotate" ? styles.transformButtonActive : styles.transformButton}
              onClick={() => setTransformMode("rotate")}
            >
              Rotar
            </button>
            <button
              type="button"
              className={transformMode === "scale" ? styles.transformButtonActive : styles.transformButton}
              onClick={() => setTransformMode("scale")}
            >
              Escalar
            </button>
          </div>
        </div>

        {transformMode !== "observe" && selectedAsset ? (
          <div className={styles.previewBottomPanel}>
            <p className={styles.previewBottomTitle}>
              {selectedAsset.file.replace(/^.*\//, "")}
            </p>
            {transformMode === "translate" ? (
              <div className={styles.paramRows}>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Pos X</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedAsset.position[0]}
                    onChange={(event) => updateSelectedNumeric("position", 0, event.target.value)}
                  />
                </label>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Pos Y</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedAsset.position[1]}
                    onChange={(event) => updateSelectedNumeric("position", 1, event.target.value)}
                  />
                </label>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Pos Z</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedAsset.position[2]}
                    onChange={(event) => updateSelectedNumeric("position", 2, event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {transformMode === "rotate" ? (
              <div className={styles.paramRows}>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Rot X</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedRotation[0]}
                    onChange={(event) => updateSelectedNumeric("rotation", 0, event.target.value)}
                  />
                </label>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Rot Y</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedRotation[1]}
                    onChange={(event) => updateSelectedNumeric("rotation", 1, event.target.value)}
                  />
                </label>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Rot Z</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    value={selectedRotation[2]}
                    onChange={(event) => updateSelectedNumeric("rotation", 2, event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {transformMode === "scale" ? (
              <div className={styles.paramRows}>
                <label className={styles.paramRow}>
                  <span className={styles.paramLabel}>Escala</span>
                  <input
                    className={styles.paramInput}
                    type="number"
                    step="0.01"
                    min="0.001"
                    value={selectedAsset.scale ?? 0.2}
                    onChange={(event) => updateSelectedNumeric("scale", null, event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            <p className={styles.previewBottomValues}>Valores en unidades de escena (rotacion en radianes).</p>
          </div>
        ) : null}

        {layout ? (
          <ScenePreview
            layout={layout}
            selectedAssetIndices={selectedAssetIndices}
            transformMode={transformMode}
            onSelectionChange={handleSceneSelectionChange}
            onAssetTransform={updateAssetAt}
            onAssetsTransform={updateAssetsAt}
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
