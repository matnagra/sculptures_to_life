"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createAnchoredScene } from "@/components/ar/createScene";
import styles from "@/components/ar/ScenePreview.module.css";

export default function ScenePreview() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let animationFrame = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let clearScene: (() => void) | null = null;

    const boot = async () => {
      try {
        setStatus("loading");
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f172a);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        camera.position.set(1.35, 1.05, 1.45);
        camera.lookAt(0, 0.2, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        mount.innerHTML = "";
        mount.appendChild(renderer.domElement);

        const resize = () => {
          if (!renderer || !mount) return;
          const width = mount.clientWidth;
          const height = mount.clientHeight;
          renderer.setSize(width, height, false);
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
        };
        resize();
        window.addEventListener("resize", resize);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0.12, 0);
        controls.minDistance = 0.35;
        controls.maxDistance = 6;
        controls.maxPolarAngle = Math.PI * 0.49;
        controls.update();

        const ground = new THREE.Mesh(
          new THREE.CircleGeometry(1.8, 96),
          new THREE.MeshStandardMaterial({ color: 0x182235, roughness: 1 }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.002;
        scene.add(ground);

        const targetTexture = await new THREE.TextureLoader().loadAsync("/assets/images/target-print.png");
        const targetMaterial = new THREE.MeshBasicMaterial({
          map: targetTexture,
          transparent: true,
          side: THREE.DoubleSide,
        });
        const target = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.9), targetMaterial);
        target.rotation.x = -Math.PI / 2;
        target.position.set(0, 0.0015, 0);

        // Simulate AR anchor: target and content share the same origin.
        const anchorPreview = new THREE.Group();
        anchorPreview.position.set(0, 0, 0);
        anchorPreview.rotation.y = Math.PI / 2;
        anchorPreview.add(target);
        const anchored = await createAnchoredScene();
        anchorPreview.add(anchored.root);
        scene.add(anchorPreview);

        const clock = new THREE.Clock();
        let t = 0;

        const tick = () => {
          if (disposed || !renderer) return;
          const delta = clock.getDelta();
          anchored.update(delta);
          t += delta;
          target.material.opacity = 0.9 + Math.sin(t * 1.5) * 0.05;
          controls.update();
          renderer.render(scene, camera);
          animationFrame = window.requestAnimationFrame(tick);
        };

        clearScene = () => {
          window.removeEventListener("resize", resize);
          if (animationFrame) window.cancelAnimationFrame(animationFrame);
          controls.dispose();
          anchored.dispose();
          ground.geometry.dispose();
          (ground.material as THREE.MeshStandardMaterial).dispose();
          target.geometry.dispose();
          targetMaterial.dispose();
          targetTexture.dispose();
          renderer?.dispose();
          if (renderer && mount.contains(renderer.domElement)) {
            mount.removeChild(renderer.domElement);
          }
        };

        if (disposed) {
          clearScene();
          return;
        }

        setStatus("ready");
        tick();
      } catch {
        setStatus("error");
      }
    };

    void boot();

    return () => {
      disposed = true;
      clearScene?.();
    };
  }, []);

  return (
    <section className={styles.wrapper}>
      <div className={styles.canvas} ref={mountRef} />
      <div className={styles.hud}>
        <p className={styles.badge}>
          Estado: {status === "loading" ? "cargando escena" : status === "ready" ? "listo" : "error"}
        </p>
        <p className={styles.tip}>
          Mover: click izquierdo orbitar, rueda zoom, click derecho pan. Ejes: X ancho, Y largo, Z vertical.
        </p>
      </div>
    </section>
  );
}
