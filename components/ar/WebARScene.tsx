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
        const mindarModule = await import("mind-ar/dist/mindar-image-three.prod.js");
        const MindARThree = mindarModule.MindARThree as new (options: {
          container: HTMLElement;
          imageTargetSrc: string;
          uiLoading?: boolean;
          uiScanning?: boolean;
          uiError?: boolean;
        }) => MindARThreeInstance;

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
