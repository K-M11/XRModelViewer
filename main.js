import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const statusEl = document.querySelector("#status");
const fileInput = document.querySelector("#fileInput");
const urlInput = document.querySelector("#urlInput");
const loadUrlButton = document.querySelector("#loadUrlButton");
const lockPointerButton = document.querySelector("#lockPointerButton");

const clock = new THREE.Clock();
const moveState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

let currentVrm = null;
let currentObjectUrl = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1f232b);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  100,
);
camera.position.set(0, 1.45, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.object);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

setupWorld();
setupEvents();
renderer.setAnimationLoop(render);

function setupWorld() {
  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 2.4);
  directional.position.set(2.5, 4, 3);
  scene.add(directional);

  const fill = new THREE.DirectionalLight(0x9fc5ff, 0.7);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const grid = new THREE.GridHelper(10, 20, 0x526071, 0x303844);
  scene.add(grid);
}

function setupEvents() {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }

    currentObjectUrl = URL.createObjectURL(file);
    loadVrm(currentObjectUrl, file.name);
  });

  loadUrlButton.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus("Enter a VRM URL first.");
      return;
    }

    loadVrm(url, url);
  });

  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      loadUrlButton.click();
    }
  });

  lockPointerButton.addEventListener("click", () => {
    controls.lock();
  });

  controls.addEventListener("lock", () => {
    setStatus("Mouse look enabled. Use WASD or arrow keys to move.");
  });

  controls.addEventListener("unlock", () => {
    setStatus("Mouse look released.");
  });

  window.addEventListener("keydown", (event) => updateMoveState(event, true));
  window.addEventListener("keyup", (event) => updateMoveState(event, false));
  window.addEventListener("resize", resize);
  window.addEventListener("error", (event) => {
    setStatus(`JavaScript error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.message ?? String(event.reason);
    setStatus(`JavaScript error: ${reason}`);
  });
}

async function loadVrm(url, label) {
  setStatus(`Loading ${label}...`);

  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;

    if (!vrm) {
      throw new Error("The loaded file did not contain VRM data.");
    }

    clearCurrentVrm();

    // VRM 0.x faces backward in three-vrm's normalized coordinate system.
    // VRM 1.0 should not be rotated here.
    VRMUtils.rotateVRM0(vrm);

    // These optimizations are useful but optional. Keep them guarded so a
    // library-version mismatch cannot prevent the model from appearing.
    VRMUtils.removeUnnecessaryVertices?.(vrm.scene);
    VRMUtils.removeUnnecessaryJoints?.(vrm.scene);

    vrm.scene.name = "LoadedVRM";
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.rotation.set(0, 0, 0);
    vrm.scene.scale.setScalar(1);

    scene.add(vrm.scene);
    currentVrm = vrm;

    frameModel(vrm.scene);
    setStatus(`Loaded ${label}. Enter VR with the VR button when using HTTPS.`);

    // Future VRMA hook:
    // loadVrmAnimation(vrm, "path/to/animation.vrma") can be added here once
    // @pixiv/three-vrm-animation is wired into the import map and update loop.
  } catch (error) {
    console.error(error);
    setStatus(`Could not load VRM: ${error.message}`);
  }
}

function clearCurrentVrm() {
  if (!currentVrm) return;

  scene.remove(currentVrm.scene);
  currentVrm.scene.traverse((object) => {
    if (!object.isMesh) return;

    object.geometry?.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    for (const material of materials) {
      disposeMaterial(material);
    }
  });

  currentVrm = null;
}

function disposeMaterial(material) {
  if (!material) return;

  for (const value of Object.values(material)) {
    if (value?.isTexture) {
      value.dispose();
    }
  }

  material.dispose();
}

function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  if (!Number.isFinite(size.length()) || size.length() === 0) {
    camera.position.set(0, 1.45, 3);
    camera.lookAt(0, 1.2, 0);
    return;
  }

  const height = Math.max(size.y, 1);
  const distance = Math.max(height * 1.5, 2.2);

  controls.object.position.set(center.x, center.y + height * 0.35, distance);
  camera.lookAt(center.x, center.y + height * 0.45, center.z);
}

function updateMoveState(event, pressed) {
  switch (event.code) {
    case "KeyW":
    case "ArrowUp":
      moveState.forward = pressed;
      break;
    case "KeyS":
    case "ArrowDown":
      moveState.backward = pressed;
      break;
    case "KeyA":
    case "ArrowLeft":
      moveState.left = pressed;
      break;
    case "KeyD":
    case "ArrowRight":
      moveState.right = pressed;
      break;
    default:
      return;
  }

  event.preventDefault();
}

function updateMovement(delta) {
  if (renderer.xr.isPresenting) return;

  const speed = 2.5 * delta;

  if (moveState.forward) controls.moveForward(speed);
  if (moveState.backward) controls.moveForward(-speed);
  if (moveState.left) controls.moveRight(-speed);
  if (moveState.right) controls.moveRight(speed);
}

function render() {
  const delta = clock.getDelta();

  updateMovement(delta);

  if (currentVrm) {
    currentVrm.update(delta);
  }

  // Future VRMA animation mixer updates should live here, next to VRM updates.
  renderer.render(scene, camera);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function setStatus(message) {
  statusEl.textContent = message;
}
