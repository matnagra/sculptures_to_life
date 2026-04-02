# WebAR MVP (Next.js + Vercel)

MVP WebAR para abrir desde URL en celular, detectar un target visual y renderizar una escena 3D anclada con animacion y base de oclusion.

## Stack

- `Next.js` (App Router, TypeScript)
- `Three.js` (render, luces, modelos GLB, animacion)
- `MindAR` (image tracking en navegador movil, cargado localmente desde `public/vendor`)

## Arquitectura

- `app/page.tsx`: entrada del MVP.
- `components/ar/WebARScene.tsx`: inicializa camara + MindAR, crea anchor, loop de render y estados de UI.
- `components/ar/createScene.ts`: compone escena 3D anclada (escultura placeholder, personaje animado, oclusor invisible).
- `public/assets/targets/sculpture.mind`: target compilado.
- `public/assets/images/target-print.png`: imagen que corresponde al target.
- `public/assets/models/*.glb`: placeholders de escultura y personaje.

## Requisitos previos

- Node.js 20+
- npm 10+
- Celular con:
  - iPhone Safari reciente o
  - Android Chrome reciente

## Instalacion local

```bash
npm install
```

## Variables de entorno

No hay variables obligatorias para este MVP.

## Desarrollo local

```bash
npm run dev
```

Luego abre `http://localhost:3000`.

Notas:
- En desktop, camara/tracking pueden no representar el comportamiento real movil.
- Para pruebas reales de camara en celular, usa HTTPS (deploy en Vercel recomendado).

## Build de produccion

```bash
npm run build
npm start
```

## Deploy exacto en Vercel

### Opcion A: Dashboard

1. Sube este proyecto a GitHub.
2. Entra a [Vercel](https://vercel.com/).
3. Click en **Add New > Project**.
4. Importa el repo.
5. Framework detectado: **Next.js**.
6. Deja variables de entorno vacias (no requeridas).
7. Click en **Deploy**.
8. Abre la URL HTTPS generada desde tu celular.

### Opcion B: CLI

```bash
npm i -g vercel
vercel login
vercel
vercel --prod
```

## Uso del MVP

1. Abre la URL en el celular.
2. Acepta permiso de camara.
3. Muestra a la camara la imagen `public/assets/images/target-print.png` (impresa o en otra pantalla).
4. Al detectar target, aparece la escena 3D anclada.
5. Muevete alrededor para validar tracking.

## Oclusion (base simple)

En `components/ar/createScene.ts` hay un mesh oclusor invisible con:

- `material.colorWrite = false`
- `material.depthWrite = true`

Esto permite ocultar parcialmente objetos 3D cuando quedan detras del volumen aproximado de la escultura.

## Como reemplazar por tus assets reales

### 1) Reemplazar escultura

- Sustituye `public/assets/models/sculpture-placeholder.glb` por tu modelo real.
- Ajusta transform en `createScene.ts`:
  - `position`
  - `scale`
  - `rotation`

### 2) Reemplazar personaje

- Sustituye `public/assets/models/character-placeholder.glb`.
- Si tu GLB trae animaciones, se usa el primer clip.
- Si no trae animacion, queda fallback de movimiento simple.

### 3) Reemplazar image target

1. Compila tu imagen con la herramienta oficial de MindAR:
   - [MindAR Image Target Compiler](https://hiukim.github.io/mind-ar-js-doc/tools/compile/)
2. Guarda el archivo compilado como `public/assets/targets/sculpture.mind` (o cambia la ruta en `WebARScene.tsx`).
3. Guarda la imagen de referencia en `public/assets/images/target-print.png`.

## Ajustar posicion, escala y rotacion de la escena

En `components/ar/createScene.ts`:

- Transform global del contenido anclado:
  - `root.position.set(...)`
  - `root.rotation.set(...)`
  - `root.scale.setScalar(...)`
- Transform de cada objeto (escultura/personaje):
  - `object.position.set(...)`
  - `object.rotation.set(...)`
  - `object.scale.setScalar(...)`

## Checklist de aceptacion del MVP

- Abrir link en celular
- Dar permiso de camara
- Apuntar al target
- Ver escena 3D anclada
- Ver personaje animado/movimiento
- Moverse alrededor y mantener tracking razonable
- Probar base de oclusion
