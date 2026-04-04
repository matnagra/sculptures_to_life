import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getSceneAssetKind, type SceneAsset } from "@/lib/sceneLayout";

type AnchoredScene = {
  root: THREE.Group;
  instances: Array<{ layoutIndex: number; object: THREE.Object3D }>;
  syncLayout: (layout: SceneAsset[], options?: { skipTransformIndices?: Set<number> }) => Promise<void>;
  setOccludersVisible: (visible: boolean) => void;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
};

type SceneQuality = "preview" | "mobile";
type SceneAssetSource = "editor" | "public";
export type SceneLoadProgress =
  | { phase: "models"; loaded: number; total: number; unit: "models" }
  | { phase: "instances"; loaded: number; total: number; unit: "instances" };

type CreateAnchoredSceneOptions = {
  layout?: SceneAsset[];
  quality?: SceneQuality;
  showHelpers?: boolean;
  assetSource?: SceneAssetSource;
  onProgress?: (progress: SceneLoadProgress) => void;
};

const DEFAULT_SCALE = 0.2;

// Convert semantic XYZ (X ancho, Y largo, Z vertical) to Three.js axes.
// Three scene here uses X (width), Z (depth), Y (height).
export const toThreePosition = (position: [number, number, number]): [number, number, number] => {
  const [x, y, z] = position;
  return [x, z, y];
};

export const fromThreePosition = (position: THREE.Vector3): [number, number, number] => {
  return [position.x, position.z, position.y];
};

export const toThreeScale = (scale: [number, number, number]): [number, number, number] => {
  const [x, y, z] = scale;
  return [x, z, y];
};

/** Must match how we serialize/apply scene rotations. */
export const LAYOUT_EULER_ORDER: THREE.EulerOrder = "YXZ";

export const getLayoutRotation = (asset: SceneAsset): [number, number, number] => {
  if (asset.rotation) return asset.rotation;
  return [0, asset.rotationZ ?? 0, 0];
};

export const fromThreeRotation = (object: THREE.Object3D): [number, number, number] => {
  const euler = new THREE.Euler(0, 0, 0, LAYOUT_EULER_ORDER);
  euler.setFromQuaternion(object.quaternion, LAYOUT_EULER_ORDER);
  return [euler.x, euler.y, euler.z];
};

export const getLayoutScale = (asset: SceneAsset): [number, number, number] => {
  if (asset.scale3) return asset.scale3;
  const uniform = asset.scale ?? DEFAULT_SCALE;
  return [uniform, uniform, uniform];
};

export const fromThreeScale = (object: THREE.Object3D): [number, number, number] => {
  return [object.scale.x, object.scale.z, object.scale.y];
};

const createAxisLabel = (label: "X" | "Y" | "Z", color: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.arc(64, 64, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "bold 66px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 64, 68);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.14, 0.14, 0.14);

  return { sprite, texture, material };
};

const DEFAULT_HOUSE_LAYOUT: SceneAsset[] = [
  { collection: "medieval-village", file: "Floor_WoodDark.gltf", position: [0, 0, 0] },
  { collection: "medieval-village", file: "Wall_Plaster_Door_Flat.gltf", position: [0, 0.65, 0], rotationZ: 0 },
  { collection: "medieval-village", file: "Wall_Plaster_Straight.gltf", position: [0, -0.65, 0], rotationZ: Math.PI },
  { collection: "medieval-village", file: "Wall_Plaster_Straight.gltf", position: [0.65, 0, 0], rotationZ: Math.PI / 2 },
  { collection: "medieval-village", file: "Wall_Plaster_Straight.gltf", position: [-0.65, 0, 0], rotationZ: -Math.PI / 2 },
  { collection: "medieval-village", file: "Roof_Wooden_2x1.gltf", position: [0, 0, 0.62], rotationZ: 0 },
];

const sharedLoader = new GLTFLoader();
const modelTemplateCache = new Map<string, Promise<THREE.Object3D>>();

const buildAssetUrl = (asset: SceneAsset, assetSource: SceneAssetSource): string => {
  const collection = assetSource === "editor" ? asset.sourceCollection ?? asset.collection : asset.collection;
  const encodedCollection = encodeURIComponent(collection);
  const encodedFilePath = asset.file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (assetSource === "editor") {
    return `/api/editor/models/${encodedCollection}/${encodedFilePath}`;
  }
  return `/assets/models/assets_library/${encodedCollection}/${encodedFilePath}`;
};

const buildInstanceKey = (asset: SceneAsset, assetSource: SceneAssetSource): string =>
  `${buildAssetUrl(asset, assetSource)}::${getSceneAssetKind(asset)}`;

const prepareModel = (object: THREE.Object3D, quality: SceneQuality = "preview") => {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = false;
    node.receiveShadow = false;
    node.frustumCulled = true;
    if (quality !== "mobile") return;

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => {
      if (!material) return;
      material.side = THREE.FrontSide;
      material.precision = "lowp";
      if ("map" in material && material.map) {
        material.map.anisotropy = 1;
      }
      if ("normalMap" in material && material.normalMap) {
        material.normalMap.anisotropy = 1;
      }
    });
  });
};

const createOccluderMaterial = (visible: boolean) => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  material.depthTest = true;
  material.toneMapped = false;

  if (visible) {
    material.color.setHex(0x38bdf8);
    material.transparent = true;
    material.opacity = 0.28;
    material.colorWrite = true;
    material.depthWrite = false;
    material.blending = THREE.NormalBlending;
    material.name = "occluder-preview";
    return material;
  }

  material.transparent = false;
  material.opacity = 1;
  material.colorWrite = false;
  material.depthWrite = true;
  material.blending = THREE.NoBlending;
  material.name = "occluder-depth";
  return material;
};

const applyOccluderMaterial = (object: THREE.Object3D, visible: boolean) => {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.material = createOccluderMaterial(visible);
    node.material.needsUpdate = true;
    node.castShadow = false;
    node.receiveShadow = false;
    node.renderOrder = visible ? 10 : -10;
  });
};

const getOccluderPreviewObject = (object: THREE.Object3D): THREE.Object3D | null =>
  object.userData.occluderPreview instanceof THREE.Object3D ? object.userData.occluderPreview : null;

const applyOccluderVisibility = (object: THREE.Object3D, quality: SceneQuality, visible: boolean) => {
  if (quality !== "mobile") {
    applyOccluderMaterial(object, true);
    return;
  }

  const previewObject = getOccluderPreviewObject(object);
  if (previewObject) {
    previewObject.visible = visible;
  } else {
    applyOccluderMaterial(object, visible);
  }
};

const prepareOccluder = (object: THREE.Object3D, quality: SceneQuality) => {
  if (quality !== "mobile") {
    applyOccluderMaterial(object, true);
    return;
  }

  applyOccluderMaterial(object, false);
};

const createOccluderInstance = async (
  template: THREE.Object3D,
  quality: SceneQuality,
) => {
  if (quality !== "mobile") {
    const instance = cloneSkeleton(template);
    prepareModel(instance, quality);
    prepareOccluder(instance, quality);
    return instance;
  }

  const depthInstance = cloneSkeleton(template);
  prepareModel(depthInstance, quality);
  applyOccluderMaterial(depthInstance, false);

  const previewInstance = cloneSkeleton(template);
  prepareModel(previewInstance, quality);
  applyOccluderMaterial(previewInstance, true);
  previewInstance.visible = false;

  const group = new THREE.Group();
  group.name = "occluder-group";
  group.userData.occluderPreview = previewInstance;
  group.add(depthInstance, previewInstance);
  return group;
};

const removeGroundArtifacts = (object: THREE.Object3D) => {
  const toRemove: THREE.Object3D[] = [];
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;

    const name = node.name.toLowerCase();
    if (name.includes("shadow") || name.includes("plane") || name.includes("ground")) {
      toRemove.push(node);
    }
  });

  toRemove.forEach((node) => node.parent?.remove(node));
};

const setLayoutIndex = (object: THREE.Object3D, layoutIndex: number) => {
  object.userData.layoutIndex = layoutIndex;
  object.traverse((node) => {
    node.userData.layoutIndex = layoutIndex;
  });
};

const applyAssetTransform = (object: THREE.Object3D, asset: SceneAsset) => {
  object.position.set(...toThreePosition(asset.position));
  const [rx, ry, rz] = getLayoutRotation(asset);
  object.rotation.order = LAYOUT_EULER_ORDER;
  object.rotation.set(rx, ry, rz, LAYOUT_EULER_ORDER);
  object.scale.set(...toThreeScale(getLayoutScale(asset)));
};

const loadModelTemplate = async (path: string) => {
  let pending = modelTemplateCache.get(path);
  if (!pending) {
    pending = sharedLoader.loadAsync(path).then((gltf) => {
      const template = gltf.scene;
      removeGroundArtifacts(template);
      prepareModel(template);
      return template;
    });
    modelTemplateCache.set(path, pending);
  }

  try {
    return await pending;
  } catch (error) {
    modelTemplateCache.delete(path);
    throw error;
  }
};

const createModelInstance = async (
  asset: SceneAsset,
  assetSource: SceneAssetSource,
  quality: SceneQuality = "preview",
) => {
  const template = await loadModelTemplate(buildAssetUrl(asset, assetSource));
  if (getSceneAssetKind(asset) === "occluder") {
    return createOccluderInstance(template, quality);
  }
  const instance = cloneSkeleton(template);
  prepareModel(instance, quality);
  return instance;
};

export const createAnchoredScene = async (options: CreateAnchoredSceneOptions = {}): Promise<AnchoredScene> => {
  const layout = options.layout && options.layout.length > 0 ? options.layout : DEFAULT_HOUSE_LAYOUT;
  const quality = options.quality ?? "preview";
  const showHelpers = options.showHelpers ?? true;
  const assetSource = options.assetSource ?? "public";
  const reportProgress = options.onProgress ?? (() => {});
  const root = new THREE.Group();
  root.name = "sculpture-anchor-root";
  root.scale.setScalar(0.22);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.95);
  hemiLight.position.set(0, 1, 0);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.65);
  dirLight.position.set(1, 2, 1);
  root.add(hemiLight, dirLight);

  const axisLabelResources: Array<{ texture: THREE.CanvasTexture; material: THREE.SpriteMaterial }> = [];
  let ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshStandardMaterial> | null = null;
  if (showHelpers) {
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.05, 64),
      new THREE.MeshStandardMaterial({ color: 0x58d6ff, metalness: 0.1, roughness: 0.6 }),
    );
    // Semantic XY plane.
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(...toThreePosition([0, 0, 0.01]));
    root.add(ring);

    const axesLength = 0.8;
    const axesOrigin = new THREE.Vector3(...toThreePosition([0, 0, 0.02]));
    const xAxis = new THREE.ArrowHelper(new THREE.Vector3(...toThreePosition([1, 0, 0])).normalize(), axesOrigin, axesLength, 0xff5555);
    const yAxis = new THREE.ArrowHelper(new THREE.Vector3(...toThreePosition([0, 1, 0])).normalize(), axesOrigin, axesLength, 0x55ff55);
    const zAxis = new THREE.ArrowHelper(new THREE.Vector3(...toThreePosition([0, 0, 1])).normalize(), axesOrigin, axesLength, 0x5599ff);
    root.add(xAxis, yAxis, zAxis);

    const xLabel = createAxisLabel("X", "#ff6666");
    const yLabel = createAxisLabel("Y", "#66ff66");
    const zLabel = createAxisLabel("Z", "#6699ff");
    if (xLabel) {
      xLabel.sprite.position.set(...toThreePosition([axesLength + 0.1, 0, 0.02]));
      root.add(xLabel.sprite);
      axisLabelResources.push({ texture: xLabel.texture, material: xLabel.material });
    }
    if (yLabel) {
      yLabel.sprite.position.set(...toThreePosition([0, axesLength + 0.1, 0.02]));
      root.add(yLabel.sprite);
      axisLabelResources.push({ texture: yLabel.texture, material: yLabel.material });
    }
    if (zLabel) {
      zLabel.sprite.position.set(...toThreePosition([0, 0, axesLength + 0.12]));
      root.add(zLabel.sprite);
      axisLabelResources.push({ texture: zLabel.texture, material: zLabel.material });
    }
  }

  const fallback = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.2, 2.2),
    new THREE.MeshStandardMaterial({ color: 0xb08a64 }),
  );
  fallback.position.set(...toThreePosition([0, 0, 0.08]));
  fallback.visible = false;
  root.add(fallback);

  const instances: Array<{ layoutIndex: number; object: THREE.Object3D; assetKey: string }> = [];
  let syncVersion = 0;
  let disposed = false;
  let occludersVisible = false;
  let currentLayout = layout;

  const sortInstances = () => {
    instances.sort((a, b) => a.layoutIndex - b.layoutIndex);
  };

  const removeInstanceAt = (instanceIndex: number) => {
    const [removed] = instances.splice(instanceIndex, 1);
    if (!removed) return;
    root.remove(removed.object);
  };

  const syncLayout = async (
    nextLayout: SceneAsset[],
    syncOptions?: { skipTransformIndices?: Set<number> },
  ) => {
    currentLayout = nextLayout;
    const version = ++syncVersion;
    const skipTransformIndices = syncOptions?.skipTransformIndices ?? new Set<number>();

    for (let index = instances.length - 1; index >= 0; index -= 1) {
      const instance = instances[index];
      const asset = nextLayout[instance.layoutIndex];
      const assetKey = asset ? buildInstanceKey(asset, assetSource) : null;
      if (!asset || assetKey !== instance.assetKey) {
        removeInstanceAt(index);
      }
    }

    for (const instance of instances) {
      const asset = nextLayout[instance.layoutIndex];
      if (!asset || skipTransformIndices.has(instance.layoutIndex)) continue;
      applyAssetTransform(instance.object, asset);
      setLayoutIndex(instance.object, instance.layoutIndex);
    }

    const existingIndices = new Set(instances.map((instance) => instance.layoutIndex));
    const pendingAdds = nextLayout
      .map((asset, index) => ({ asset, index, assetKey: buildInstanceKey(asset, assetSource) }))
      .filter(({ index }) => !existingIndices.has(index));

    const uniqueModelEntries = Array.from(
      new Map(nextLayout.map((asset) => [buildAssetUrl(asset, assetSource), asset])).entries(),
    ).map(([assetKey, asset]) => ({ assetKey, asset }));
    reportProgress({ phase: "models", loaded: 0, total: uniqueModelEntries.length, unit: "models" });

    let loadedModels = 0;
    await Promise.allSettled(
      uniqueModelEntries.map(async ({ assetKey }) => {
        try {
          await loadModelTemplate(assetKey);
        } finally {
          loadedModels += 1;
          reportProgress({ phase: "models", loaded: loadedModels, total: uniqueModelEntries.length, unit: "models" });
        }
      }),
    );

    if (disposed || version !== syncVersion) return;

    const totalInstances = nextLayout.length;
    let loadedInstances = totalInstances - pendingAdds.length;
    reportProgress({ phase: "instances", loaded: loadedInstances, total: totalInstances, unit: "instances" });

    const settledLoads = await Promise.allSettled(
      pendingAdds.map(async ({ asset, index, assetKey }) => {
        try {
          return {
            index,
            asset,
            assetKey,
            object: await createModelInstance(asset, assetSource, quality),
          };
        } finally {
          loadedInstances += 1;
          reportProgress({ phase: "instances", loaded: loadedInstances, total: totalInstances, unit: "instances" });
        }
      }),
    );

    if (disposed || version !== syncVersion) return;

    settledLoads.forEach((result) => {
      if (result.status !== "fulfilled") {
        const failedAsset = pendingAdds[settledLoads.indexOf(result)]?.asset;
        if (failedAsset) {
          console.warn(`[house] Asset no cargado: ${failedAsset.collection}/${failedAsset.file}`);
        }
        return;
      }

      const { index, asset, assetKey, object } = result.value;
      applyAssetTransform(object, asset);
      if (getSceneAssetKind(asset) === "occluder") {
        applyOccluderVisibility(object, quality, occludersVisible);
      }
      setLayoutIndex(object, index);
      root.add(object);
      instances.push({ layoutIndex: index, object, assetKey });
    });

    sortInstances();
    fallback.visible = instances.length === 0;
  };

  await syncLayout(layout);

  if (instances.length === 0) {
    fallback.visible = true;
  }

  let elapsed = 0;

  const update = (deltaSeconds: number) => {
    elapsed += deltaSeconds;
    ring?.scale.setScalar(1 + Math.sin(elapsed * 1.8) * 0.01);
  };

  const setOccludersVisible = (visible: boolean) => {
    occludersVisible = visible;
    instances.forEach((instance) => {
      const asset = currentLayout[instance.layoutIndex];
      if (!asset || getSceneAssetKind(asset) !== "occluder") return;
      applyOccluderVisibility(instance.object, quality, visible);
    });
  };

  const dispose = () => {
    disposed = true;
    instances.splice(0, instances.length).forEach(({ object }) => {
      root.remove(object);
    });
    ring?.geometry.dispose();
    ring?.material.dispose();
    fallback.geometry.dispose();
    (fallback.material as THREE.MeshStandardMaterial).dispose();
    axisLabelResources.forEach(({ texture, material }) => {
      texture.dispose();
      material.dispose();
    });
  };

  return { root, instances, syncLayout, setOccludersVisible, update, dispose };
};
