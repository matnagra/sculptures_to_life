"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createAnchoredScene } from "@/components/ar/createScene";
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
const MINDAR_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js";

const loadMindARScript = async (): Promise<void> => {
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
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("MindAR script failed to load"));
    document.head.appendChild(script);
  });
};

export default function WebARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ARStatus>("loading");
  const [targetFound, setTargetFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let mindar: MindARThreeInstance | null = null;
    let clearScene: (() => void) | null = null;

    const boot = async () => {
      if (!containerRef.current) return;

      setStatus("loading");
      setTargetFound(false);
      setErrorMessage(null);

      try {
        await loadMindARScript();
        const MindARThree = (window as MindARWindow).MINDAR?.IMAGE?.MindARThree;
        if (!MindARThree) {
          throw new Error("MindAR global is unavailable");
        }

        mindar = new MindARThree({
          container: containerRef.current,
          imageTargetSrc: "/assets/targets/sculpture.mind",
          uiLoading: false,
          uiScanning: false,
          uiError: false,
        });

        const { renderer, scene, camera } = mindar;
        renderer.setClearColor(0x000000, 0);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        const anchor = mindar.addAnchor(0);
        const anchoredScene = await createAnchoredScene();
        anchor.group.add(anchoredScene.root);

        anchor.onTargetFound = () => {
          setTargetFound(true);
        };
        anchor.onTargetLost = () => {
          setTargetFound(false);
        };

        const clock = new THREE.Clock();

        await mindar.start();
        if (disposed) return;

        setStatus("running");
        renderer.setAnimationLoop(() => {
          const delta = clock.getDelta();
          anchoredScene.update(delta);
          renderer.render(scene, camera);
        });

        clearScene = () => {
          renderer.setAnimationLoop(null);
          anchoredScene.dispose();
        };
      } catch (error) {
        console.error("Error starting WebAR scene", error);
        setStatus("error");
        setErrorMessage(
          "No se pudo iniciar la camara o WebAR. Revisa permisos de camara y prueba en HTTPS desde celular.",
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
    };
  }, [reloadToken]);

  return (
    <section className={styles.wrapper}>
      <div className={styles.arCanvas} ref={containerRef} />

      <div className={styles.overlay}>
        <p className={styles.badge}>
          Estado:{" "}
          {status === "loading"
            ? "iniciando camara"
            : status === "running"
              ? targetFound
                ? "target detectado"
                : "apunta al target"
              : "error"}
        </p>

        <p className={styles.help}>
          Imprime o abre el target en otra pantalla: <code>/assets/images/target-print.png</code>
        </p>

        {status === "error" && errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        <button type="button" className={styles.retry} onClick={() => setReloadToken((prev) => prev + 1)}>
          Reiniciar WebAR
        </button>
      </div>
    </section>
  );
}
