import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type AnchoredScene = {
  root: THREE.Group;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
};

type VillageAsset = {
  file: string;
  // Semantic coordinates: X=ancho, Y=largo, Z=vertical.
  position: [number, number, number];
  // Rotation around semantic Z (vertical).
  rotationZ?: number;
  scale?: number;
};

const VILLAGE_BASE_PATH = "/assets/models/medieval-village";
const DEFAULT_SCALE = 0.2;

// Convert semantic XYZ (X ancho, Y largo, Z vertical) to Three.js axes.
// Three scene here uses X (width), Z (depth), Y (height).
const toThreePosition = (position: [number, number, number]): [number, number, number] => {
  const [x, y, z] = position;
  return [x, z, y];
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

const HOUSE_LAYOUT: VillageAsset[] = [
  { file: "Floor_WoodDark.gltf", position: [0, 0, 0] },
  { file: "Wall_Plaster_Door_Flat.gltf", position: [0, 0.65, 0], rotationZ: 0 },
  { file: "Wall_Plaster_Straight.gltf", position: [0, -0.65, 0], rotationZ: Math.PI },
  { file: "Wall_Plaster_Window_Wide_Flat.gltf", position: [0.65, 0, 0], rotationZ: Math.PI / 2 },
  { file: "Wall_Plaster_Window_Thin_Round.gltf", position: [-0.65, 0, 0], rotationZ: -Math.PI / 2 },
  { file: "Roof_Wooden_2x1.gltf", position: [0, 0, 0.62], rotationZ: 0 },
  { file: "Roof_Wooden_2x1_L.gltf", position: [0.5, 0, 0.62], rotationZ: 0 },
  { file: "Roof_Wooden_2x1_R.gltf", position: [-0.5, 0, 0.62], rotationZ: 0 },
  { file: "Prop_Chimney.gltf", position: [-0.2, -0.1, 0.62], rotationZ: 0, scale: 0.17 },
];

const loadModel = async (loader: GLTFLoader, path: string) => {
  return await loader.loadAsync(path);
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

export const createAnchoredScene = async (): Promise<AnchoredScene> => {
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
    HOUSE_LAYOUT.map((asset) => loadModel(loader, `${VILLAGE_BASE_PATH}/${asset.file}`)),
  );

  let loadedCount = 0;
  settledLoads.forEach((result, index) => {
    const asset = HOUSE_LAYOUT[index];
    if (result.status !== "fulfilled") {
      console.warn(`[house] Asset no cargado: ${asset.file}`);
      return;
    }

    const instance = result.value.scene;
    removeGroundArtifacts(instance);
    prepareModel(instance);
    instance.position.set(...toThreePosition(asset.position));
    instance.rotation.y = asset.rotationZ ?? 0;
    instance.scale.setScalar(asset.scale ?? DEFAULT_SCALE);
    root.add(instance);
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

  return { root, update, dispose };
};
