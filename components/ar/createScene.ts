import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type AnchoredScene = {
  root: THREE.Group;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
};

const MODEL_PATHS = {
  character: "/assets/models/character-placeholder.glb",
  sculpture: "/assets/models/sculpture-placeholder.glb",
};

const loadModel = async (loader: GLTFLoader, path: string) => {
  return await loader.loadAsync(path);
};

export const createAnchoredScene = async (): Promise<AnchoredScene> => {
  const root = new THREE.Group();
  root.name = "sculpture-anchor-root";
  root.scale.setScalar(0.4);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.95);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.65);
  dirLight.position.set(1, 2, 1);
  root.add(hemiLight, dirLight);

  const loader = new GLTFLoader();
  const mixers: THREE.AnimationMixer[] = [];

  const sculpture = await loadModel(loader, MODEL_PATHS.sculpture);
  sculpture.scene.position.set(0, 0.05, 0);
  sculpture.scene.scale.setScalar(0.38);
  root.add(sculpture.scene);

  // Depth-only occluder to hide content behind the sculpture volume.
  const occluderGeometry = new THREE.CylinderGeometry(0.19, 0.19, 0.5, 24);
  const occluderMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
  occluderMaterial.colorWrite = false;
  occluderMaterial.depthWrite = true;
  const occluderMesh = new THREE.Mesh(occluderGeometry, occluderMaterial);
  occluderMesh.position.set(0, 0.25, 0);
  root.add(occluderMesh);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.5, 48),
    new THREE.MeshStandardMaterial({ color: 0x58d6ff, metalness: 0.1, roughness: 0.6 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  root.add(ring);

  const characterPivot = new THREE.Group();
  root.add(characterPivot);

  let character: THREE.Object3D | null = null;
  let fallbackWalker: THREE.Mesh | null = null;

  try {
    const characterModel = await loadModel(loader, MODEL_PATHS.character);
    character = characterModel.scene;
    // Keep the fox fixed on top of the target plane.
    character.position.set(0, 0, 0.2);
    character.scale.setScalar(0.015);
    character.rotation.y = Math.PI;
    characterPivot.add(character);

    if (characterModel.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(character);
      const preferredClip =
        characterModel.animations.find((clip) => /survey|idle|stand/i.test(clip.name)) ??
        characterModel.animations[0];
      const action = mixer.clipAction(preferredClip);
      action.play();
      mixers.push(mixer);
    }
  } catch {
    fallbackWalker = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.16, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xff8b5f }),
    );
    fallbackWalker.position.set(0, 0.08, 0.2);
    characterPivot.add(fallbackWalker);
  }

  const update = (deltaSeconds: number) => {
    mixers.forEach((mixer) => mixer.update(deltaSeconds));
  };

  const dispose = () => {
    occluderGeometry.dispose();
    occluderMaterial.dispose();
  };

  return { root, update, dispose };
};
