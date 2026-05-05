import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";

const DESKTOP_MOVE_SPEED = 2.5;
const XR_MOVE_SPEED = 1.8;
const XR_TURN_SPEED = 0.5 * Math.PI;
const XR_STICK_DEADZONE = 0.18;
const VR_UI_PANEL_DISTANCE = 1.25;
const VR_UI_RAY_LENGTH = 4;
const VR_UI_TEXTURE_PIXELS_PER_METER = 1400;
const VR_UI_TOGGLE_BUTTON_INDEX = 4;

const statusEl = document.querySelector("#status");
const fileInput = document.querySelector("#fileInput");
const vrmaInput = document.querySelector("#vrmaInput");
const urlInput = document.querySelector("#urlInput");
const loadUrlButton = document.querySelector("#loadUrlButton");
const lockPointerButton = document.querySelector("#lockPointerButton");
const playAnimationButton = document.querySelector("#playAnimationButton");
const stopAnimationButton = document.querySelector("#stopAnimationButton");

const clock = new THREE.Clock();
const moveState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};
const xrControllers = {
  left: null,
  right: null,
};
const xrInputSources = {
  left: null,
  right: null,
};
const xrForward = new THREE.Vector3();
const xrRight = new THREE.Vector3();
const xrMove = new THREE.Vector3();
const xrHeadPosition = new THREE.Vector3();
const xrRigOffset = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const uiRaycaster = new THREE.Raycaster();
const uiRayOrigin = new THREE.Vector3();
const uiRayDirection = new THREE.Vector3();
const uiControllerMatrix = new THREE.Matrix4();
const uiIntersectTargets = [];

const loadedModels = [];
const loadedMotions = [];
let currentVrm = null;
let currentModel = null;
let currentObjectUrl = null;
let currentVrmaObjectUrl = null;
let animationMixer = null;
let animationAction = null;
let activeModelIndex = -1;
let activeMotionIndex = -1;
let lastXRAxesLogTime = 0;
let vrUi = null;
let wasVRUIToggleButtonPressed = false;
let lastXRButtonsLogTime = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1f232b);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  100,
);
camera.position.set(0, 1.45, 3);

const xrRig = new THREE.Group();
xrRig.name = "XRRig";
scene.add(xrRig);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const controls = new PointerLockControls(camera, renderer.domElement);
xrRig.add(controls.object);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const vrmaLoader = new GLTFLoader();
vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

setupWorld();
setupVRUI();
setupXRControllers();
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

function setupVRUI() {
  const panel = new THREE.Group();
  panel.name = "VRUIPanel";
  panel.position.set(0, -0.28, -VR_UI_PANEL_DISTANCE);

  const background = createVRUIPlane(0.92, 0.82, "#20242d");
  background.material.opacity = 0.88;
  background.position.z = -0.01;
  panel.add(background);

  const title = createVRUILabel("XR Model Viewer", 0.78, 0.08, {
    fontSize: 34,
    background: "#2b3340",
    color: "#f5f7fb",
  });
  title.position.set(0, 0.33, 0);
  panel.add(title);

  const buttons = [
    ["Next Model", selectNextModel],
    ["Next Motion", selectNextMotion],
    ["Play Motion", playAnimation],
    ["Stop Motion", stopAnimation],
    ["Show / Hide", toggleActiveModelVisibility],
    ["Reset Pos", resetActiveModelPosition],
    ["Hide Panel", toggleVRUIPanel],
  ];

  buttons.forEach(([label, onSelect], index) => {
    const button = createVRUIButton(label, onSelect);
    button.position.set(0, 0.13 - index * 0.09, 0);
    panel.add(button);
    uiIntersectTargets.push(button);
  });

  const toggle = createVRUIButton("UI", toggleVRUIPanel, {
    width: 0.22,
    height: 0.1,
    fontSize: 34,
  });
  toggle.name = "VRUIToggle";
  toggle.position.set(0.43, -0.28, -VR_UI_PANEL_DISTANCE);
  toggle.visible = false;
  uiIntersectTargets.push(toggle);

  camera.add(panel);
  camera.add(toggle);

  vrUi = {
    panel,
    toggle,
    visible: true,
  };
}

function createVRUIButton(label, onSelect, options = {}) {
  const button = createVRUILabel(label, options.width ?? 0.72, options.height ?? 0.09, {
    fontSize: options.fontSize ?? 28,
    background: options.background ?? "#7dd3fc",
    color: options.color ?? "#09111a",
  });
  button.name = `VRUIButton:${label}`;
  button.userData.onSelect = onSelect;
  button.userData.baseColor = button.material.color.clone();
  return button;
}

function createVRUILabel(label, width, height, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * VR_UI_TEXTURE_PIXELS_PER_METER);
  canvas.height = Math.ceil(height * VR_UI_TEXTURE_PIXELS_PER_METER);

  const context = canvas.getContext("2d");
  const background = options.background ?? "#ffffff";
  const color = options.color ?? "#000000";
  const fontSize = Math.round(options.fontSize ?? canvas.height * 0.36);
  const radius = Math.max(16, Math.round(canvas.height * 0.22));

  context.fillStyle = background;
  roundRect(context, 0, 0, canvas.width, canvas.height, radius);
  context.fill();

  context.fillStyle = color;
  context.font = `700 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.userData.label = label;
  return mesh;
}

function createVRUIPlane(width, height, color) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function createControllerRay() {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -VR_UI_RAY_LENGTH),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: 0x7dd3fc,
    transparent: true,
    opacity: 0.75,
  });
  return new THREE.Line(geometry, material);
}

function setupXRControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    const ray = createControllerRay();
    controller.add(ray);

    controller.addEventListener("connected", (event) => {
      const handedness = event.data.handedness;
      if (handedness === "left" || handedness === "right") {
        xrControllers[handedness] = controller;
        xrInputSources[handedness] = event.data;
      }
    });

    controller.addEventListener("selectstart", () => {
      handleVRUISelect(controller);
    });

    controller.addEventListener("squeezestart", () => {
      toggleVRUIPanel();
    });

    controller.addEventListener("disconnected", () => {
      if (xrControllers.left === controller) xrControllers.left = null;
      if (xrControllers.right === controller) xrControllers.right = null;
      syncXRInputSources();
    });

    xrRig.add(controller);
  }
}

function setupEvents() {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    loadModelFile(file);
  });

  vrmaInput.addEventListener("change", () => {
    const file = vrmaInput.files?.[0];
    if (!file) return;

    loadMotionFile(file);
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

  playAnimationButton.addEventListener("click", () => {
    playAnimation();
  });

  stopAnimationButton.addEventListener("click", () => {
    stopAnimation();
  });

  controls.addEventListener("lock", () => {
    setStatus("Mouse look enabled. Use WASD or arrow keys to move.");
  });

  controls.addEventListener("unlock", () => {
    setStatus("Mouse look released.");
  });

  window.addEventListener("keydown", (event) => updateMoveState(event, true));
  window.addEventListener("keyup", (event) => updateMoveState(event, false));
  window.addEventListener("keydown", (event) => {
    if (event.code === "KeyU") {
      toggleVRUIPanel();
    }
  });
  window.addEventListener("resize", resize);
  window.addEventListener("error", (event) => {
    setStatus(`JavaScript error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.message ?? String(event.reason);
    setStatus(`JavaScript error: ${reason}`);
  });
}

function loadModelFile(file) {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }

  currentObjectUrl = URL.createObjectURL(file);
  loadVrm(currentObjectUrl, file.name);
}

function loadMotionFile(file) {
  if (currentVrmaObjectUrl) {
    URL.revokeObjectURL(currentVrmaObjectUrl);
  }

  currentVrmaObjectUrl = URL.createObjectURL(file);
  loadVrma(currentVrmaObjectUrl, file.name);
}

function selectNextModel() {
  if (loadedModels.length === 0) {
    setStatus("No models loaded. Load VRM before entering VR.");
    return;
  }

  setActiveModel((activeModelIndex + 1) % loadedModels.length);
}

function selectNextMotion() {
  if (loadedMotions.length === 0) {
    setStatus("No motions loaded. Load VRMA before entering VR.");
    return;
  }

  setActiveMotion((activeMotionIndex + 1) % loadedMotions.length);
}

function toggleActiveModelVisibility() {
  if (!currentModel) {
    setStatus("No active model.");
    return;
  }

  currentModel.visible = !currentModel.visible;
  currentModel.object.visible = currentModel.visible;
  setStatus(`${currentModel.name} ${currentModel.visible ? "shown" : "hidden"}.`);
}

function resetActiveModelPosition() {
  if (!currentModel) {
    setStatus("No active model.");
    return;
  }

  currentModel.object.position.set(0, 0, 0);
  currentModel.object.rotation.set(0, 0, 0);
  currentModel.object.scale.setScalar(1);

  if (!renderer.xr.isPresenting) {
    frameModel(currentModel.object);
  }

  setStatus(`${currentModel.name} position reset.`);
}

function handleVRUISelect(controller) {
  const hit = getVRUIIntersection(controller);
  if (!hit) return;

  hit.object.userData.onSelect?.();
}

function getVRUIIntersection(controller) {
  uiControllerMatrix.identity().extractRotation(controller.matrixWorld);
  uiRayOrigin.setFromMatrixPosition(controller.matrixWorld);
  uiRayDirection.set(0, 0, -1).applyMatrix4(uiControllerMatrix);

  uiRaycaster.set(uiRayOrigin, uiRayDirection);
  uiRaycaster.far = VR_UI_RAY_LENGTH;

  const hits = uiRaycaster.intersectObjects(getVisibleUIIntersectTargets(), false);
  return hits[0] ?? null;
}

function getVisibleUIIntersectTargets() {
  return uiIntersectTargets.filter((target) => {
    let object = target;

    while (object) {
      if (!object.visible) return false;
      object = object.parent;
    }

    return true;
  });
}

function toggleVRUIPanel() {
  if (!vrUi) return;

  vrUi.visible = !vrUi.visible;
  vrUi.panel.visible = vrUi.visible;
  vrUi.toggle.visible = !vrUi.visible;
  setStatus(vrUi.visible ? "VR UI panel shown." : "VR UI panel hidden.");
}

function updateVRUIHover() {
  for (const target of uiIntersectTargets) {
    target.material.color.copy(target.userData.baseColor);
  }

  if (!renderer.xr.isPresenting) return;

  for (const controller of Object.values(xrControllers)) {
    if (!controller) continue;

    const hit = getVRUIIntersection(controller);
    if (hit) {
      hit.object.material.color.set(0xcffafe);
    }
  }
}

async function loadVrm(url, label) {
  setStatus(`Loading ${label}...`);

  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;

    if (!vrm) {
      throw new Error("The loaded file did not contain VRM data.");
    }

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

    setupLookAtProxy(vrm);

    const model = createModelRecord({
      type: "vrm",
      name: label,
      object: vrm.scene,
      runtime: vrm,
    });

    loadedModels.push(model);
    scene.add(model.object);
    setActiveModel(loadedModels.length - 1);
    if (activeMotionIndex !== -1) {
      setActiveMotion(activeMotionIndex);
    }

    setStatus(`Loaded ${label}. Enter VR with the VR button when using HTTPS.`);

  } catch (error) {
    console.error(error);
    setStatus(`Could not load VRM: ${error.message}`);
  }
}

function createModelRecord({ type, name, object, runtime }) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${type}-${Date.now()}-${loadedModels.length}`,
    type,
    name,
    object,
    vrm: type === "vrm" ? runtime : null,
    pmx: type === "pmx" ? runtime : null,
    currentMotion: null,
    visible: true,
  };
}

function setActiveModel(index) {
  if (index < 0 || index >= loadedModels.length) return;

  clearAnimation();
  activeModelIndex = index;
  currentModel = loadedModels[activeModelIndex];
  currentVrm = currentModel.vrm;

  loadedModels.forEach((model) => {
    model.object.visible = model.visible;
  });

  if (!renderer.xr.isPresenting) {
    frameModel(currentModel.object);
  }

  applyCurrentAnimation();

  if (animationAction) {
    playAnimation();
  } else {
    setStatus(`Active model: ${currentModel.name}`);
  }
}

async function loadVrma(url, label) {
  setStatus(`Loading animation ${label}...`);

  try {
    const gltf = await vrmaLoader.loadAsync(url);
    const vrmAnimation = gltf.userData.vrmAnimations?.[0];

    if (!vrmAnimation) {
      throw new Error("The loaded file did not contain VRMA animation data.");
    }

    const motion = createMotionRecord({
      type: "vrma",
      name: label,
      runtime: vrmAnimation,
    });
    loadedMotions.push(motion);
    setActiveMotion(loadedMotions.length - 1);

    if (!currentVrm) {
      setStatus(`Loaded motion ${label}. Select a VRM model to apply it.`);
      return;
    }

    setStatus(`Applied motion ${label} to ${currentModel.name}.`);
  } catch (error) {
    console.error(error);
    setStatus(`Could not load VRMA: ${error.message}`);
  }
}

function createMotionRecord({ type, name, runtime }) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${type}-${Date.now()}-${loadedMotions.length}`,
    type,
    name,
    runtime,
  };
}

function setActiveMotion(index) {
  if (index < 0 || index >= loadedMotions.length) return;

  activeMotionIndex = index;
  const motion = loadedMotions[activeMotionIndex];

  if (currentModel?.type === "vrm") {
    currentModel.currentMotion = motion;
  }

  applyCurrentAnimation();

  if (animationAction) {
    playAnimation();
  } else {
    setStatus(`Active motion: ${motion.name}`);
  }
}

function applyCurrentAnimation() {
  clearAnimation();

  const motion = currentModel?.currentMotion;

  if (!currentVrm || !motion) return;

  if (currentModel) {
    currentModel.currentMotion = motion;
  }

  currentVrm.humanoid?.resetNormalizedPose?.();
  currentVrm.lookAt?.reset?.();
  if (currentVrm.lookAt) {
    currentVrm.lookAt.autoUpdate = motion.runtime.lookAtTrack != null;
  }

  const clip = createVRMAnimationClip(motion.runtime, currentVrm);
  animationMixer = new THREE.AnimationMixer(currentVrm.scene);
  animationAction = animationMixer.clipAction(clip);
  animationAction.setLoop(THREE.LoopRepeat);
  animationAction.clampWhenFinished = false;
}

function playAnimation() {
  if (!animationAction) {
    setStatus("Load both a VRM model and a VRMA animation first.");
    return;
  }

  animationAction.paused = false;
  animationAction.play();
  setStatus("Animation playing.");
}

function stopAnimation() {
  if (!animationAction) {
    setStatus("No animation is loaded.");
    return;
  }

  animationAction.stop();
  currentVrm?.humanoid?.resetNormalizedPose?.();
  currentVrm?.expressionManager?.resetValues?.();
  setStatus("Animation stopped.");
}

function clearAnimation() {
  if (!animationMixer) return;

  animationMixer.stopAllAction();

  if (currentVrm) {
    animationMixer.uncacheRoot(currentVrm.scene);
  }

  animationMixer = null;
  animationAction = null;
}

function setupLookAtProxy(vrm) {
  if (!vrm.lookAt) return;

  const proxyName = "lookAtQuaternionProxy";
  if (vrm.scene.getObjectByName(proxyName)) return;

  const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
  lookAtProxy.name = proxyName;
  vrm.scene.add(lookAtProxy);
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
    xrRig.position.set(0, 0, 0);
    xrRig.rotation.set(0, 0, 0);
    camera.position.set(0, 1.45, 3);
    camera.lookAt(0, 1.2, 0);
    return;
  }

  const height = Math.max(size.y, 1);
  const distance = Math.max(height * 1.5, 2.2);

  xrRig.position.set(0, 0, 0);
  xrRig.rotation.set(0, 0, 0);
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
  if (renderer.xr.isPresenting) {
    updateXRMovement(delta);
    return;
  }

  const speed = DESKTOP_MOVE_SPEED * delta;

  if (moveState.forward) controls.moveForward(speed);
  if (moveState.backward) controls.moveForward(-speed);
  if (moveState.left) controls.moveRight(-speed);
  if (moveState.right) controls.moveRight(speed);
}

function updateXRMovement(delta) {
  syncXRInputSources();
  updateVRUIToggleButton();

  const leftStick = getInputSourceStick(xrInputSources.left);
  const rightStick = getInputSourceStick(xrInputSources.right);

  logXRInputDebug(leftStick, rightStick);

  if (rightStick.x !== 0) {
    rotateXRRigAroundHead(-rightStick.x * XR_TURN_SPEED * delta);
  }

  if (leftStick.x === 0 && leftStick.y === 0) return;

  camera.getWorldDirection(xrForward);
  xrForward.y = 0;

  if (xrForward.lengthSq() === 0) return;

  xrForward.normalize();
  xrRight.copy(xrForward).cross(worldUp).normalize();

  xrMove
    .copy(xrForward)
    .multiplyScalar(-leftStick.y)
    .addScaledVector(xrRight, leftStick.x);

  if (xrMove.lengthSq() > 1) {
    xrMove.normalize();
  }

  xrRig.position.addScaledVector(xrMove, XR_MOVE_SPEED * delta);
}

function updateVRUIToggleButton() {
  logXRButtonDebug();

  const button =
    xrInputSources.right?.gamepad?.buttons?.[VR_UI_TOGGLE_BUTTON_INDEX] ??
    xrInputSources.left?.gamepad?.buttons?.[VR_UI_TOGGLE_BUTTON_INDEX];

  const pressed = button?.pressed ?? false;

  if (pressed && !wasVRUIToggleButtonPressed) {
    toggleVRUIPanel();
  }

  wasVRUIToggleButtonPressed = pressed;
}

function logXRButtonDebug() {
  const now = performance.now();
  if (now - lastXRButtonsLogTime < 1000) return;

  const rightButtons = getPressedButtonIndexes(xrInputSources.right);
  const leftButtons = getPressedButtonIndexes(xrInputSources.left);
  if (rightButtons.length === 0 && leftButtons.length === 0) return;

  lastXRButtonsLogTime = now;
  console.log("[WebXR] pressed buttons", { leftButtons, rightButtons });
}

function getPressedButtonIndexes(inputSource) {
  const buttons = inputSource?.gamepad?.buttons ?? [];
  return buttons
    .map((button, index) => (button.pressed ? index : -1))
    .filter((index) => index !== -1);
}

function rotateXRRigAroundHead(yawDelta) {
  camera.getWorldPosition(xrHeadPosition);
  xrRigOffset.copy(xrRig.position).sub(xrHeadPosition);
  xrRigOffset.applyAxisAngle(worldUp, yawDelta);
  xrRig.position.copy(xrHeadPosition).add(xrRigOffset);
  xrRig.rotation.y += yawDelta;
}

function syncXRInputSources() {
  xrInputSources.left = null;
  xrInputSources.right = null;

  const session = renderer.xr.getSession();
  if (!session) return;

  const unassignedSources = [];

  for (const inputSource of session.inputSources) {
    if (!inputSource.gamepad) continue;

    if (inputSource.handedness === "left" || inputSource.handedness === "right") {
      xrInputSources[inputSource.handedness] = inputSource;
    } else {
      unassignedSources.push(inputSource);
    }
  }

  // Fallback for runtimes that omit handedness but still expose gamepad axes.
  xrInputSources.left ??= unassignedSources[0] ?? null;
  xrInputSources.right ??= unassignedSources[1] ?? null;
}

function getInputSourceStick(inputSource) {
  const axes = inputSource?.gamepad?.axes;
  if (!axes || axes.length < 2) {
    return { x: 0, y: 0 };
  }

  const primary = readAxesPair(axes, 2);
  const fallback = readAxesPair(axes, 0);
  const stick = primary.active ? primary : fallback;

  return {
    x: applyDeadzone(stick.x),
    y: applyDeadzone(stick.y),
  };
}

function readAxesPair(axes, startIndex) {
  const x = axes[startIndex] ?? 0;
  const y = axes[startIndex + 1] ?? 0;

  return {
    x,
    y,
    active: Math.abs(x) >= XR_STICK_DEADZONE || Math.abs(y) >= XR_STICK_DEADZONE,
  };
}

function applyDeadzone(value) {
  return Math.abs(value) < XR_STICK_DEADZONE ? 0 : value;
}

function logXRInputDebug(leftStick, rightStick) {
  const now = performance.now();
  if (now - lastXRAxesLogTime < 500) return;

  lastXRAxesLogTime = now;

  const leftAxes = Array.from(xrInputSources.left?.gamepad?.axes ?? []);
  const rightAxes = Array.from(xrInputSources.right?.gamepad?.axes ?? []);

  if (!xrInputSources.left && !xrInputSources.right) {
    console.log("[WebXR] No controller gamepad input detected.");
    return;
  }

  console.log("[WebXR] controller axes", {
    leftAxes,
    rightAxes,
    leftStick,
    rightStick,
  });
}

function render() {
  const delta = clock.getDelta();

  updateMovement(delta);
  updateVRUIHover();

  if (animationMixer) {
    animationMixer.update(delta);
  }

  for (const model of loadedModels) {
    model.vrm?.update(delta);
  }

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
