"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import ScenePreview from "@/components/ar/ScenePreview";
import type { SceneAsset, SceneLayout } from "@/lib/sceneLayout";
import styles from "@/components/ar/PreviewEditor.module.css";

type AssetCollection = {
  source: "public" | "root";
  id: string;
  thumbnailCollectionId: string;
  name: string;
  assets: string[];
};

const spawnPositionForIndex = (index: number): [number, number, number] => {
  if (index === 0) return [0, 0, 0];
  const step = 0.32;
  const col = index % 4;
  const row = Math.floor(index / 4);
  return [(col - 1.5) * step, (row - 1.5) * step, 0];
};

export default function PreviewEditor() {
  const [collections, setCollections] = useState<AssetCollection[]>([]);
  const [layout, setLayout] = useState<SceneAsset[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importingAssetKey, setImportingAssetKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [collapsedSceneGroups, setCollapsedSceneGroups] = useState<Record<string, boolean>>({});

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
      setLayout(layoutJson.assets ?? []);
      setDirty(false);
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : "Error al cargar datos del editor.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

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
      setLayout((prev) => [
        ...(prev ?? []),
        {
          collection: imported.collection,
          file: imported.file,
          sourceCollection: imported.sourceCollection,
          position: spawnPositionForIndex((prev ?? []).length),
          rotationZ: 0,
        },
      ]);
      setDirty(true);
    } catch (importError) {
      console.error(importError);
      setError(importError instanceof Error ? importError.message : "Error al importar asset.");
    } finally {
      setImportingAssetKey(null);
    }
  };

  const removeAssetAt = (index: number) => {
    setLayout((prev) => (prev ?? []).filter((_, i) => i !== index));
    setDirty(true);
  };

  const saveLayout = async () => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/editor/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: layout ?? [] }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "No se pudo guardar el layout.");
      }
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
  const groupedSceneAssets = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; displayName: string; thumbnailCollectionId: string; items: Array<{ index: number; asset: SceneAsset }> }
    >();
    (layout ?? []).forEach((asset, index) => {
      const key = asset.collection;
      const displayName = asset.sourceCollection ?? asset.collection;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push({ index, asset });
        return;
      }
      groups.set(key, {
        key,
        displayName,
        thumbnailCollectionId: asset.collection,
        items: [{ index, asset }],
      });
    });
    return Array.from(groups.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [layout]);

  const toggleCollection = (collectionId: string) => {
    setCollapsedCollections((prev) => ({ ...prev, [collectionId]: !prev[collectionId] }));
  };

  const toggleSceneGroup = (groupId: string) => {
    setCollapsedSceneGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
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
          {!loading && !hasAssets ? <p className={styles.empty}>No hay assets disponibles.</p> : null}
          <div className={styles.sectionScrollable}>
            {orderedCollections.map((collection) => {
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
          {(layout?.length ?? 0) === 0 ? (
            <p className={styles.empty}>Todavia no agregaste objetos.</p>
          ) : (
            <div className={styles.sectionScrollable}>
              {groupedSceneAssets.map((group) => {
                const isCollapsed = Boolean(collapsedSceneGroups[group.key]);
                return (
                  <div key={group.key} className={styles.collection}>
                    <button
                      type="button"
                      className={styles.collectionHeader}
                      onClick={() => toggleSceneGroup(group.key)}
                      title={isCollapsed ? "Expandir grupo" : "Contraer grupo"}
                    >
                      <span className={styles.collectionChevron}>{isCollapsed ? "▸" : "▾"}</span>
                      <span className={styles.collectionName}>
                        {group.displayName} - {group.items.length} en escena
                      </span>
                    </button>
                    {!isCollapsed ? (
                      <div className={styles.assetList}>
                        {group.items.map(({ index, asset }) => (
                          <div key={`${asset.collection}/${asset.file}:${index}`} className={styles.sceneAssetCard}>
                            <Image
                              className={styles.assetThumb}
                              alt={asset.file}
                              loading="lazy"
                              width={44}
                              height={44}
                              unoptimized
                              src={`/api/editor/thumbnail?collectionId=${encodeURIComponent(group.thumbnailCollectionId)}&collection=${encodeURIComponent(group.displayName)}&asset=${encodeURIComponent(asset.file)}`}
                            />
                            <span className={styles.assetLabel}>{asset.file.replace(/^.*\//, "")}</span>
                            <button type="button" className={styles.removeButton} onClick={() => removeAssetAt(index)} disabled={saving}>
                              Quitar
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className={styles.previewArea}>
        {layout ? (
          <ScenePreview layout={layout} />
        ) : (
          <section className={styles.previewLoading}>
            <p className={styles.empty}>Cargando escena...</p>
          </section>
        )}
      </div>
    </section>
  );
}
