"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createAnchoredScene, type SceneLoadProgress } from "@/components/ar/createScene";
import type { SceneLayout } from "@/lib/sceneLayout";
import styles from "@/components/ar/WebARScene.module.css";

type ARStatus = "loading" | "running" | "error";

type MindARThreeInstance = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  addAnchor: (targetIndex: number) => {
    group: THREE.Group;
    onTargetFound?: () => void;
    onTargetLost?: () => void;
  };
  start: () => Promise<void>;
  stop: () => void;
};

type MindARWindow = Window & {
  MINDAR?: {
    IMAGE?: {
      MindARThree?: new (options: {
        container: HTMLElement;
        imageTargetSrc: string;
        uiLoading?: boolean;
        uiScanning?: boolean;
        uiError?: boolean;
      }) => MindARThreeInstance;
    };
  };
};

const MINDAR_SCRIPT_ID = "mindar-image-three-script";
const MINDAR_SCRIPT_URL = "/vendor/mindar-image-three.prod.js";
const MINDAR_IMPORTMAP_ID = "mindar-importmap";

const ensureImportMap = (): void => {
  if (document.getElementById(MINDAR_IMPORTMAP_ID)) return;

  const importMap = {
    imports: {
      three: "/vendor/three/three.module.js",
      "three/addons/": "/vendor/three/addons/",
    },
  };

  const script = document.createElement("script");
  script.id = MINDAR_IMPORTMAP_ID;
  script.type = "importmap";
  script.textContent = JSON.stringify(importMap);
  document.head.appendChild(script);
};

const loadMindARScript = async (): Promise<void> => {
  ensureImportMap();

  const existing = document.getElementById(MINDAR_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    if ((window as MindARWindow).MINDAR?.IMAGE?.MindARThree) return;
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("MindAR script failed to load")), { once: true });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = MINDAR_SCRIPT_ID;
    script.src = MINDAR_SCRIPT_URL;
    script.type = "module";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("MindAR script failed to load"));
    document.head.appendChild(script);
  });
};

const cleanupContainer = (container: HTMLElement | null) => {
  if (!container) return;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
};

const loadSavedLayout = async () => {
  const response = await fetch("/api/editor/layout", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("No se pudo leer el layout guardado");
  }
  const layout = (await response.json()) as SceneLayout;
  return layout.assets;
};

export default function WebARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchoredSceneRef = useRef<Awaited<ReturnType<typeof createAnchoredScene>> | null>(null);
  const [status, setStatus] = useState<ARStatus>("loading");
  const [targetFound, setTargetFound] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [occludersVisible, setOccludersVisible] = useState(false);
  const [loadProgress, setLoadProgress] = useState<SceneLoadProgress>({
    phase: "models",
    loaded: 0,
    total: 0,
    unit: "models",
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const progressRatio = loadProgress.total > 0 ? loadProgress.loaded / loadProgress.total : 0;
  const progressPercent =
    status === "loading"
      ? 8
      : loadProgress.phase === "models"
        ? Math.round(progressRatio * 80)
        : Math.round(80 + progressRatio * 20);

  useEffect(() => {
    if (!hasStarted) return;

    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let mindar: MindARThreeInstance | null = null;
    let clearScene: (() => void) | null = null;

    const boot = async () => {
      cleanupContainer(container);

      setStatus("loading");
      setTargetFound(false);
      setSceneReady(false);
      setOccludersVisible(false);
      setLoadProgress({ phase: "models", loaded: 0, total: 0, unit: "models" });
      setErrorMessage(null);

      try {
        const [, layout] = await Promise.all([loadMindARScript(), loadSavedLayout()]);
        const MindARThree = (window as MindARWindow).MINDAR?.IMAGE?.MindARThree;
        if (!MindARThree) {
          throw new Error("MindAR global is unavailable");
        }

        mindar = new MindARThree({
          container,
          imageTargetSrc: "/assets/targets/sculpture.mind",
          uiLoading: false,
          uiScanning: false,
          uiError: false,
        });

        const { renderer, scene, camera } = mindar;
        renderer.setClearColor(0x000000, 0);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.setPixelRatio(1);

        const anchor = mindar.addAnchor(0);
        let anchoredScene: Awaited<ReturnType<typeof createAnchoredScene>> | null = null;

        anchor.onTargetFound = () => {
          setTargetFound(true);
        };
        anchor.onTargetLost = () => {
          setTargetFound(false);
        };

        await mindar.start();
        if (disposed) {
          try {
            mindar.stop();
          } catch {
            // no-op cleanup
          }
          cleanupContainer(container);
          return;
        }

        const clock = new THREE.Clock();
        setStatus("running");
        renderer.setAnimationLoop(() => {
          const delta = clock.getDelta();
          anchoredScene?.update(delta);
          renderer.render(scene, camera);
        });

        void createAnchoredScene({
          layout,
          quality: "mobile",
          showHelpers: false,
          assetSource: "public",
          onProgress: (progress) => {
            if (disposed) return;
            setLoadProgress(progress);
          },
        })
          .then((nextScene) => {
            if (disposed) {
              nextScene.dispose();
              return;
            }
            anchoredScene = nextScene;
            anchoredSceneRef.current = nextScene;
            // Align content with the tracked image plane (instead of popping out perpendicular).
            anchoredScene.root.rotation.x = Math.PI / 2;
            // Target image is portrait-oriented; rotate 90deg on the anchor plane so X follows width.
            anchoredScene.root.rotation.y = Math.PI / 2;
            anchoredScene.root.position.z = 0.001;
            anchor.group.add(anchoredScene.root);
            setLoadProgress({ phase: "instances", loaded: layout.length, total: layout.length, unit: "instances" });
            setSceneReady(true);
          })
          .catch((sceneError) => {
            console.error("Error loading AR scene", sceneError);
            setErrorMessage("La camara inicio, pero la escena 3D no se pudo cargar.");
          });

        clearScene = () => {
          renderer.setAnimationLoop(null);
          setSceneReady(false);
          if (anchoredScene) {
            anchor.group.remove(anchoredScene.root);
            anchoredScene.dispose();
            anchoredScene = null;
            anchoredSceneRef.current = null;
          }
        };
      } catch (error) {
        console.error("Error starting WebAR scene", error);
        setStatus("error");
        const detail = error instanceof Error ? error.message : "Error desconocido";
        setErrorMessage(
          `No se pudo iniciar la camara o WebAR (${detail}). Revisa permisos de camara, HTTPS y evita navegador embebido de redes sociales.`,
        );
      }
    };

    void boot();

    return () => {
      disposed = true;
      try {
        clearScene?.();
      } catch {
        // no-op cleanup
      }
      try {
        mindar?.stop();
      } catch {
        // no-op cleanup
      }
      anchoredSceneRef.current = null;
      cleanupContainer(container);
    };
  }, [hasStarted, reloadToken]);

  useEffect(() => {
    anchoredSceneRef.current?.setOccludersVisible(occludersVisible);
  }, [occludersVisible]);

  return (
    <section className={styles.wrapper}>
      <div className={`${styles.arCanvas} ${!sceneReady ? styles.arCanvasHidden : ""}`.trim()} ref={containerRef} />

      {hasStarted && !sceneReady ? (
        <div className={styles.loadingScreen}>
          <div className={styles.loadingCard}>
            <p className={styles.loadingTitle}>
              {status === "loading"
                ? "Iniciando camara"
                : loadProgress.phase === "models"
                  ? "Cargando modelos base"
                  : "Armando escena"}
            </p>
            <p className={styles.loadingMeta}>
              {loadProgress.total > 0
                ? `${loadProgress.loaded} / ${loadProgress.total} ${loadProgress.unit}`
                : "Preparando escena para AR"}
            </p>
            <div className={styles.progressTrack} aria-hidden="true">
              <div className={styles.progressBar} style={{ width: `${progressPercent}%` }} />
            </div>
            <p className={styles.loadingMeta}>{progressPercent}%</p>
          </div>
        </div>
      ) : null}

      <div className={styles.overlay}>
        {!hasStarted ? (
          <button
            type="button"
            className={styles.retry}
            onClick={() => {
              setStatus("loading");
              setLoadProgress({ phase: "models", loaded: 0, total: 0, unit: "models" });
              setErrorMessage(null);
              setHasStarted(true);
            }}
          >
            Iniciar camara AR
          </button>
        ) : null}

        <p className={styles.badge}>
          Estado:{" "}
          {!hasStarted
            ? "listo para iniciar"
            : status === "loading"
            ? "iniciando camara"
            : status === "running"
              ? !sceneReady
                ? "cargando escena"
                : targetFound
                  ? "target detectado"
                  : "apunta al target"
              : "error"}
        </p>

        <p className={styles.help}>
          Imprime o abre el target en otra pantalla: <code>/assets/images/target-print.png</code>
        </p>

        {status === "error" && errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        {hasStarted && sceneReady ? (
          <button
            type="button"
            className={styles.retry}
            onClick={() => setOccludersVisible((prev) => !prev)}
          >
            {occludersVisible ? "Ocultar oclusores" : "Mostrar oclusores"}
          </button>
        ) : null}

        <button
          type="button"
          className={styles.retry}
          onClick={() => {
            setHasStarted(true);
            setLoadProgress({ phase: "models", loaded: 0, total: 0, unit: "models" });
            setReloadToken((prev) => prev + 1);
          }}
        >
          Reiniciar WebAR
        </button>
      </div>
    </section>
  );
}
