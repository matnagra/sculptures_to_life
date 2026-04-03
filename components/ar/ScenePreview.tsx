"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { createAnchoredScene, fromThreePosition, fromThreeRotation, fromThreeScale, getLayoutRotation, getLayoutScale, LAYOUT_EULER_ORDER } from "@/components/ar/createScene";
import type { SceneAsset } from "@/lib/sceneLayout";
import styles from "@/components/ar/ScenePreview.module.css";

type TransformMode = "observe" | "translate" | "rotate" | "scale";

type ScenePreviewProps = {
  layout: SceneAsset[];
  selectedAssetIndices: number[];
  transformMode: TransformMode;
  onSelectionChange: (selection: { indices: number[] }) => void;
  onAssetTransform: (index: number, asset: SceneAsset) => void;
  onAssetsTransform: (changes: Array<{ index: number; asset: SceneAsset }>, coalesceKey?: string) => void;
};

// Stable refs that live for the entire lifetime of the mounted component.
type EngineRefs = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  anchorPreview: THREE.Group;
  raycaster: THREE.Raycaster;
};

export default function ScenePreview({
  layout,
  selectedAssetIndices,
  transformMode,
  onSelectionChange,
  onAssetTransform,
  onAssetsTransform,
}: ScenePreviewProps) {
  const normalizeIndices = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is number => Number.isInteger(item));
  };
  const getSelectionKey = (indices: number[]) => [...indices].sort((a, b) => a - b).join(",");
  const toggleSelectionIndex = (indices: number[], index: number) => {
    if (indices.includes(index)) return indices.filter((item) => item !== index);
    return [...indices, index].sort((a, b) => a - b);
  };

  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<EngineRefs | null>(null);
  const anchoredRef = useRef<Awaited<ReturnType<typeof createAnchoredScene>> | null>(null);
  const selectionBoxRef = useRef<THREE.Object3D | null>(null);
  const multiSelectionBoundsRef = useRef<THREE.Box3 | null>(null);
  const isTransformDraggingRef = useRef(false);
  const multiProxyRef = useRef<THREE.Object3D | null>(null);
  const previousProxyMatrixRef = useRef(new THREE.Matrix4());
  const lastSelectionKeyRef = useRef(getSelectionKey(normalizeIndices(selectedAssetIndices)));

  // Always-current mirrors of props used inside event handlers and async functions.
  const layoutRef = useRef(layout);
  const selectedAssetIndicesRef = useRef<number[]>(normalizeIndices(selectedAssetIndices));
  const transformModeRef = useRef(transformMode);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onAssetTransformRef = useRef(onAssetTransform);
  const onAssetsTransformRef = useRef(onAssetsTransform);

  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { selectedAssetIndicesRef.current = normalizeIndices(selectedAssetIndices); }, [selectedAssetIndices]);
  useEffect(() => { transformModeRef.current = transformMode; }, [transformMode]);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onAssetTransformRef.current = onAssetTransform; }, [onAssetTransform]);
  useEffect(() => { onAssetsTransformRef.current = onAssetsTransform; }, [onAssetsTransform]);

  const getStructuralKey = (assets: SceneAsset[]) =>
    assets.map((a) => `${a.collection}::${a.file}`).join("|");

  // "ready" is real state so effects that depend on it re-run when it changes.
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // --- helpers -----------------------------------------------------------

  const clearSelectionBox = () => {
    const engine = engineRef.current;
    if (!engine || !selectionBoxRef.current) return;
    engine.scene.remove(selectionBoxRef.current);
    const maybeGeometry = selectionBoxRef.current as unknown as { geometry?: THREE.BufferGeometry };
    if (maybeGeometry.geometry) maybeGeometry.geometry.dispose();
    const maybeMaterial = selectionBoxRef.current as unknown as { material?: THREE.Material | THREE.Material[] };
    if (maybeMaterial.material) {
      if (Array.isArray(maybeMaterial.material)) {
        maybeMaterial.material.forEach((mat) => mat.dispose());
      } else {
        maybeMaterial.material.dispose();
      }
    }
    selectionBoxRef.current = null;
    multiSelectionBoundsRef.current = null;
  };

  const detachMultiProxy = () => {
    const proxy = multiProxyRef.current;
    if (!proxy || !anchoredRef.current) return;
    anchoredRef.current.root.remove(proxy);
    multiProxyRef.current = null;
  };

  const getSelectedInstances = (indices: number[]) => {
    const anchored = anchoredRef.current;
    if (!anchored) return [];
    return indices
      .map((idx) => anchored.instances.find((item) => item.layoutIndex === idx))
      .filter((item): item is { layoutIndex: number; object: THREE.Object3D } => Boolean(item));
  };

  const ensureMultiProxy = (indices: number[]) => {
    if (!anchoredRef.current) return null;
    const instances = getSelectedInstances(indices);
    if (instances.length < 2) return null;

    const centroid = new THREE.Vector3();
    instances.forEach((instance) => centroid.add(instance.object.position));
    centroid.divideScalar(instances.length);

    let proxy = multiProxyRef.current;
    if (!proxy) {
      proxy = new THREE.Group();
      proxy.name = "multi-select-proxy";
      anchoredRef.current.root.add(proxy);
      multiProxyRef.current = proxy;
    }
    proxy.position.copy(centroid);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
    proxy.updateMatrix();
    previousProxyMatrixRef.current.copy(proxy.matrix);
    return proxy;
  };

  const applyDeltaFromProxy = (indices: number[]) => {
    const proxy = multiProxyRef.current;
    const anchored = anchoredRef.current;
    if (!proxy || !anchored) return;
    proxy.updateMatrix();
    const previous = previousProxyMatrixRef.current.clone();
    const previousInverse = previous.clone().invert();
    const delta = proxy.matrix.clone().multiply(previousInverse);

    const instances = getSelectedInstances(indices);
    const changes: Array<{ index: number; asset: SceneAsset }> = [];
    for (const instance of instances) {
      instance.object.updateMatrix();
      const nextMatrix = delta.clone().multiply(instance.object.matrix);
      nextMatrix.decompose(instance.object.position, instance.object.quaternion, instance.object.scale);
      const src = layoutRef.current[instance.layoutIndex];
      if (!src) continue;
      const rotation = fromThreeRotation(instance.object);
      const scale3 = fromThreeScale(instance.object);
      changes.push({
        index: instance.layoutIndex,
        asset: {
          ...src,
          position: fromThreePosition(instance.object.position),
          rotation,
          rotationZ: undefined,
          scale: undefined,
          scale3,
        },
      });
    }

    if (changes.length > 0) {
      const coalesceKey = `group-transform:${indices.join(",")}`;
      onAssetsTransformRef.current(changes, coalesceKey);
    }

    previousProxyMatrixRef.current.copy(proxy.matrix);
  };

  const attachGizmo = (layoutIndicesRaw: unknown) => {
    const layoutIndices = normalizeIndices(layoutIndicesRaw);
    const engine = engineRef.current;
    const anchored = anchoredRef.current;
    if (!engine) return;
    clearSelectionBox();
    detachMultiProxy();
    if (layoutIndices.length === 0 || !anchored) {
      engine.transformControls.detach();
      engine.transformControls.visible = false;
      return;
    }

    if (transformModeRef.current === "observe") {
      engine.transformControls.detach();
      engine.transformControls.visible = false;
      if (layoutIndices.length === 1) {
        const instance = anchored.instances.find((item) => item.layoutIndex === layoutIndices[0]);
        if (!instance) return;
        const box = new THREE.BoxHelper(instance.object, 0xfacc15);
        selectionBoxRef.current = box;
        engine.scene.add(box);
        return;
      }

      const instances = getSelectedInstances(layoutIndices);
      if (instances.length === 0) return;
      const bounds = new THREE.Box3();
      instances.forEach((item, index) => {
        if (index === 0) {
          bounds.setFromObject(item.object);
        } else {
          bounds.expandByObject(item.object);
        }
      });
      multiSelectionBoundsRef.current = bounds;
      const boundsHelper = new THREE.Box3Helper(bounds, 0xfacc15);
      selectionBoxRef.current = boundsHelper;
      engine.scene.add(boundsHelper);
      return;
    }

    engine.transformControls.setMode(transformModeRef.current);
    engine.transformControls.setSpace(transformModeRef.current === "translate" ? "world" : "local");
    if (layoutIndices.length === 1) {
      const instance = anchored.instances.find((item) => item.layoutIndex === layoutIndices[0]);
      if (!instance) {
        engine.transformControls.detach();
        engine.transformControls.visible = false;
        return;
      }
      engine.transformControls.attach(instance.object);
      const box = new THREE.BoxHelper(instance.object, 0xfacc15);
      selectionBoxRef.current = box;
      engine.scene.add(box);
    } else {
      const instances = getSelectedInstances(layoutIndices);
      const proxy = ensureMultiProxy(layoutIndices);
      if (!proxy) {
        engine.transformControls.detach();
        engine.transformControls.visible = false;
        return;
      }
      engine.transformControls.attach(proxy);
      const bounds = new THREE.Box3();
      instances.forEach((item, index) => {
        if (index === 0) {
          bounds.setFromObject(item.object);
        } else {
          bounds.expandByObject(item.object);
        }
      });
      multiSelectionBoundsRef.current = bounds;
      const boundsHelper = new THREE.Box3Helper(bounds, 0xfacc15);
      selectionBoxRef.current = boundsHelper;
      engine.scene.add(boundsHelper);
    }
    engine.transformControls.visible = true;
  };

  // --- one-time engine boot ----------------------------------------------

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let animationFrame = 0;
    const draggingTransform = { value: false };

    const boot = async () => {
      try {
        setStatus("loading");

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f172a);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        camera.position.set(1.35, 1.05, 1.35);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.domElement.style.cssText = "width:100%;height:100%;display:block;";
        mount.innerHTML = "";
        mount.appendChild(renderer.domElement);

        const resize = () => {
          const w = mount.clientWidth;
          const h = mount.clientHeight;
          renderer.setSize(w, h, true);
          camera.aspect = w / Math.max(h, 1);
          camera.updateProjectionMatrix();
        };
        resize();
        window.addEventListener("resize", resize);

        const orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.08;
        orbitControls.target.set(0, 0, 0);
        orbitControls.minDistance = 0.35;
        orbitControls.maxDistance = 6;
        orbitControls.maxPolarAngle = Math.PI * 0.49;
        orbitControls.update();

        const transformControls = new TransformControls(camera, renderer.domElement);
        transformControls.visible = false;
        transformControls.size = 1.5;
        scene.add(transformControls);

        // Update layout state on every transform change.
        // The layout sync skips the selected object so this never fights with TransformControls.
        transformControls.addEventListener("objectChange", () => {
          const selected = selectedAssetIndicesRef.current;
          if (selected.length === 0) return;
          if (selected.length > 1) {
            applyDeltaFromProxy(selected);
            return;
          }
          const idx = selected[0];
          const anchored = anchoredRef.current;
          if (!anchored) return;
          const inst = anchored.instances.find((i) => i.layoutIndex === idx);
          const src = layoutRef.current[idx];
          if (!inst || !src) return;
          const rotation = fromThreeRotation(inst.object);
          const scale3 = fromThreeScale(inst.object);
          onAssetTransformRef.current(idx, {
            ...src,
            position: fromThreePosition(inst.object.position),
            rotation,
            rotationZ: undefined,
            scale: undefined,
            scale3,
          });
        });

        transformControls.addEventListener("dragging-changed", (event: { value: boolean }) => {
          draggingTransform.value = event.value;
          isTransformDraggingRef.current = event.value;
          orbitControls.enabled = !event.value;
        });

        const ground = new THREE.Mesh(
          new THREE.CircleGeometry(1.8, 96),
          new THREE.MeshStandardMaterial({ color: 0x182235, roughness: 1 }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.002;
        scene.add(ground);

        const targetTexture = await new THREE.TextureLoader().loadAsync("/assets/images/target-print.png");
        const targetMaterial = new THREE.MeshBasicMaterial({ map: targetTexture, transparent: true, side: THREE.DoubleSide });
        const targetMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.9), targetMaterial);
        targetMesh.rotation.x = -Math.PI / 2;
        targetMesh.position.set(0, 0.0015, 0);

        const anchorPreview = new THREE.Group();
        anchorPreview.rotation.y = Math.PI / 2;
        anchorPreview.add(targetMesh);
        scene.add(anchorPreview);

        const anchored = await createAnchoredScene({ layout: layoutRef.current });
        if (disposed) { anchored.dispose(); return; }
        anchoredRef.current = anchored;
        loadedAssetKeysRef.current = getStructuralKey(layoutRef.current);
        anchorPreview.add(anchored.root);

        const raycaster = new THREE.Raycaster();

        engineRef.current = { scene, camera, renderer, orbitControls, transformControls, anchorPreview, raycaster };

        // Picking runs on click release so camera drags keep the selection.
        const clickState = {
          active: false,
          x: 0,
          y: 0,
          shiftKey: false,
        };
        const CLICK_MOVE_TOLERANCE_PX = 6;

        const onPointerDown = (event: PointerEvent) => {
          if (event.button !== 0 || draggingTransform.value) return;
          clickState.active = true;
          clickState.x = event.clientX;
          clickState.y = event.clientY;
          clickState.shiftKey = event.shiftKey;
        };

        const onPointerUp = (event: PointerEvent) => {
          if (!clickState.active || event.button !== 0 || draggingTransform.value) {
            clickState.active = false;
            return;
          }
          const moved = Math.hypot(event.clientX - clickState.x, event.clientY - clickState.y);
          clickState.active = false;
          if (moved > CLICK_MOVE_TOLERANCE_PX) return;

          const engine = engineRef.current;
          const anchored = anchoredRef.current;
          if (!engine || !anchored || anchored.instances.length === 0) return;
          const additive = clickState.shiftKey;

          const rect = renderer.domElement.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          const pointer = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
          );

          camera.updateMatrixWorld(true);
          anchorPreview.updateMatrixWorld(true);
          raycaster.setFromCamera(pointer, camera);

          // Try exact raycast first
          const hits = raycaster.intersectObjects(
            anchored.instances.map((inst) => inst.object),
            true,
          );
          const hit = hits.find((h) => Number.isInteger(h.object.userData.layoutIndex));

          if (hit) {
            const idx = hit.object.userData.layoutIndex as number;
            const nextSelection = additive ? toggleSelectionIndex(selectedAssetIndicesRef.current, idx) : [idx];
            onSelectionChangeRef.current({ indices: nextSelection });
            attachGizmo(nextSelection);
            return;
          }

          // Fallback: closest projected center to click
          let closestIdx: number | null = null;
          let closestPx = Number.POSITIVE_INFINITY;
          for (const inst of anchored.instances) {
            const wp = new THREE.Vector3();
            inst.object.getWorldPosition(wp);
            const proj = wp.project(camera);
            const sx = ((proj.x + 1) / 2) * rect.width + rect.left;
            const sy = ((-proj.y + 1) / 2) * rect.height + rect.top;
            const d = Math.hypot(sx - event.clientX, sy - event.clientY);
            if (d < closestPx) { closestPx = d; closestIdx = inst.layoutIndex; }
          }

          if (closestIdx !== null && closestPx < 120) {
            const nextSelection = additive ? toggleSelectionIndex(selectedAssetIndicesRef.current, closestIdx) : [closestIdx];
            onSelectionChangeRef.current({ indices: nextSelection });
            attachGizmo(nextSelection);
          } else {
            onSelectionChangeRef.current({ indices: [] });
            attachGizmo([]);
          }
        };

        const onPointerCancel = () => {
          clickState.active = false;
        };

        renderer.domElement.addEventListener("pointerdown", onPointerDown);
        renderer.domElement.addEventListener("pointerup", onPointerUp);
        renderer.domElement.addEventListener("pointercancel", onPointerCancel);

        const clock = new THREE.Clock();
        let t = 0;
        const tick = () => {
          if (disposed) return;
          animationFrame = requestAnimationFrame(tick);
          const delta = clock.getDelta();
          anchoredRef.current?.update(delta);
          if (selectionBoxRef.current instanceof THREE.BoxHelper) {
            selectionBoxRef.current.update();
          } else if (selectionBoxRef.current instanceof THREE.Box3Helper && multiSelectionBoundsRef.current) {
            const selected = normalizeIndices(selectedAssetIndicesRef.current);
            const instances = getSelectedInstances(selected);
            if (instances.length > 0) {
              const bounds = multiSelectionBoundsRef.current;
              instances.forEach((item, index) => {
                if (index === 0) bounds.setFromObject(item.object);
                else bounds.expandByObject(item.object);
              });
            }
          }
          t += delta;
          targetMesh.material.opacity = 0.9 + Math.sin(t * 1.5) * 0.05;
          orbitControls.update();
          renderer.render(scene, camera);
        };

        setReady(true);
        setStatus("ready");
        tick();

        return () => {
          disposed = true;
          cancelAnimationFrame(animationFrame);
          window.removeEventListener("resize", resize);
          renderer.domElement.removeEventListener("pointerdown", onPointerDown);
          renderer.domElement.removeEventListener("pointerup", onPointerUp);
          renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
          transformControls.detach();
          transformControls.dispose();
          orbitControls.dispose();
          detachMultiProxy();
          clearSelectionBox();
          anchoredRef.current?.dispose();
          anchoredRef.current = null;
          engineRef.current = null;
          ground.geometry.dispose();
          (ground.material as THREE.MeshStandardMaterial).dispose();
          targetMesh.geometry.dispose();
          targetMaterial.dispose();
          targetTexture.dispose();
          renderer.dispose();
          if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
          setReady(false);
          setStatus("loading");
        };
      } catch (err) {
        console.error("ScenePreview boot error", err);
        setStatus("error");
        return undefined;
      }
    };

    let cleanup: (() => void) | undefined;
    boot().then((fn) => { cleanup = fn; });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tracks which assets are loaded (collection+file), to detect structural changes.
  const loadedAssetKeysRef = useRef<string>("");

  // --- layout changes: replace anchored content --------------------------
  // This effect depends on `ready` (actual state), so it re-runs when the
  // engine finishes booting AND whenever layout changes afterwards.

  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const engine = engineRef.current;

    const nextKey = getStructuralKey(layout);
    const anchored = anchoredRef.current;

    // If same assets, just update transforms in-place — no rebuild needed.
    // Never touch the selected object: TransformControls owns its transform.
    if (nextKey === loadedAssetKeysRef.current && anchored) {
      const selectedSet = new Set(selectedAssetIndicesRef.current);
      layout.forEach((asset, index) => {
        if (selectedSet.has(index) && isTransformDraggingRef.current) return; // TransformControls is managing selected objects while dragging
        const inst = anchored.instances.find((i) => i.layoutIndex === index);
        if (!inst) return;
        const [x, y, z] = asset.position;
        const [rx, ry, rz] = getLayoutRotation(asset);
        const [sx, sy, sz] = getLayoutScale(asset);
        inst.object.position.set(x, z, y);
        inst.object.rotation.order = LAYOUT_EULER_ORDER;
        inst.object.rotation.set(rx, ry, rz, LAYOUT_EULER_ORDER);
        inst.object.scale.set(sx, sz, sy);
      });
      return;
    }

    // Assets added/removed: full rebuild.
    let cancelled = false;
    const load = async () => {
      try {
        const next = await createAnchoredScene({ layout });
        if (cancelled || !engineRef.current) { next.dispose(); return; }

        const old = anchoredRef.current;
        if (old) {
          engine.anchorPreview.remove(old.root);
          old.dispose();
        }
        anchoredRef.current = next;
        loadedAssetKeysRef.current = nextKey;
        engine.anchorPreview.add(next.root);

        attachGizmo(selectedAssetIndicesRef.current);
        setStatus("ready");
      } catch (err) {
        console.error("ScenePreview layout sync error", err);
        setStatus("error");
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [layout, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- selection changes --------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    const normalized = normalizeIndices(selectedAssetIndices);
    const nextKey = getSelectionKey(normalized);
    if (isTransformDraggingRef.current) return;
    if (nextKey === lastSelectionKeyRef.current) return;
    lastSelectionKeyRef.current = nextKey;
    attachGizmo(normalized);
  }, [selectedAssetIndices, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- transform mode changes ---------------------------------------------

  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const tc = engineRef.current.transformControls;
    if (transformMode === "observe") {
      tc.detach();
      tc.visible = false;
      return;
    }
    tc.setMode(transformMode);
    tc.setSpace(transformMode === "translate" ? "world" : "local");
    attachGizmo(selectedAssetIndicesRef.current);
  }, [transformMode, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className={styles.wrapper}>
      <div className={styles.canvas} ref={mountRef} />
      <div className={styles.hud}>
        <p className={styles.badge}>
          Estado: {status === "loading" ? "cargando escena" : status === "ready" ? "listo" : "error"}
        </p>
        <p className={styles.tip}>
          Orbitar: click izq · Zoom: rueda · Pan: click der · Click: seleccionar · Shift+click: multiseleccion
        </p>
      </div>
    </section>
  );
}
