import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneAsset } from "@/lib/sceneLayout";

type AnchoredScene = {
  root: THREE.Group;
  instances: Array<{ layoutIndex: number; object: THREE.Object3D }>;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
};

type CreateAnchoredSceneOptions = {
  layout?: SceneAsset[];
};

const DEFAULT_SCALE = 0.2;

// Convert semantic XYZ (X ancho, Y largo, Z vertical) to Three.js axes.
// Three scene here uses X (width), Z (depth), Y (height).
const toThreePosition = (position: [number, number, number]): [number, number, number] => {
  const [x, y, z] = position;
  return [x, z, y];
};

export const fromThreePosition = (position: THREE.Vector3): [number, number, number] => {
  return [position.x, position.z, position.y];
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

const loadModel = async (loader: GLTFLoader, path: string) => {
  return await loader.loadAsync(path);
};

const buildAssetUrl = (asset: SceneAsset): string => {
  const encodedCollection = encodeURIComponent(asset.collection);
  const encodedFilePath = asset.file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/assets/models/assets_library/${encodedCollection}/${encodedFilePath}`;
};

const prepareModel = (object: THREE.Object3D) => {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = false;
    node.receiveShadow = false;
  });
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

export const createAnchoredScene = async (options: CreateAnchoredSceneOptions = {}): Promise<AnchoredScene> => {
  const layout = options.layout && options.layout.length > 0 ? options.layout : DEFAULT_HOUSE_LAYOUT;
  const root = new THREE.Group();
  root.name = "sculpture-anchor-root";
  root.scale.setScalar(0.22);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.95);
  hemiLight.position.set(0, 1, 0);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.65);
  dirLight.position.set(1, 2, 1);
  root.add(hemiLight, dirLight);

  const loader = new GLTFLoader();

  const ring = new THREE.Mesh(
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

  const axisLabelResources: Array<{ texture: THREE.CanvasTexture; material: THREE.SpriteMaterial }> = [];
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

  const settledLoads = await Promise.allSettled(
    layout.map((asset) => loadModel(loader, buildAssetUrl(asset))),
  );

  let loadedCount = 0;
  const instances: Array<{ layoutIndex: number; object: THREE.Object3D }> = [];
  settledLoads.forEach((result, index) => {
    const asset = layout[index];
    if (result.status !== "fulfilled") {
      console.warn(`[house] Asset no cargado: ${asset.collection}/${asset.file}`);
      return;
    }

    const instance = result.value.scene;
    removeGroundArtifacts(instance);
    prepareModel(instance);
    instance.position.set(...toThreePosition(asset.position));
    const [rx, ry, rz] = getLayoutRotation(asset);
    instance.rotation.order = LAYOUT_EULER_ORDER;
    instance.rotation.set(rx, ry, rz, LAYOUT_EULER_ORDER);
    instance.scale.setScalar(asset.scale ?? DEFAULT_SCALE);
    instance.userData.layoutIndex = index;
    instance.traverse((node) => {
      node.userData.layoutIndex = index;
    });
    root.add(instance);
    instances.push({ layoutIndex: index, object: instance });
    loadedCount += 1;
  });

  if (loadedCount === 0) {
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.2, 2.2),
      new THREE.MeshStandardMaterial({ color: 0xb08a64 }),
    );
    fallback.position.set(...toThreePosition([0, 0, 0.08]));
    root.add(fallback);
  }

  let elapsed = 0;

  const update = (deltaSeconds: number) => {
    elapsed += deltaSeconds;
    ring.scale.setScalar(1 + Math.sin(elapsed * 1.8) * 0.01);
  };

  const dispose = () => {
    const ringGeometry = ring.geometry as THREE.RingGeometry;
    const ringMaterial = ring.material as THREE.MeshStandardMaterial;
    ringGeometry.dispose();
    ringMaterial.dispose();
    axisLabelResources.forEach(({ texture, material }) => {
      texture.dispose();
      material.dispose();
    });
  };

  return { root, instances, update, dispose };
};
