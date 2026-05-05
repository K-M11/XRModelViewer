import * as THREE from "three";
import JSZip from "jszip";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MMDLoader } from "three-stdlib/loaders/MMDLoader.js";
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
const MODEL_X_OFFSET_METERS = 1;
const VR_UI_PANEL_WIDTH = 0.46;
const PMX_MODEL_SCALE = 0.1;
const PMX_TEXTURE_EXTENSIONS = new Set([
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "tga",
  "webp",
]);

const statusEl = document.querySelector("#status");
const fileInput = document.querySelector("#fileInput");
const vrmaInput = document.querySelector("#vrmaInput");
const urlInput = document.querySelector("#urlInput");
const loadUrlButton = document.querySelector("#loadUrlButton");
const lockPointerButton = document.querySelector("#lockPointerButton");
const playAnimationButton = document.querySelector("#playAnimationButton");
const stopAnimationButton = document.querySelector("#stopAnimationButton");
const modelListEl = document.querySelector("#modelList");
const motionListEl = document.querySelector("#motionList");

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
const modelDragControllerPosition = new THREE.Vector3();
const modelDragStartPosition = new THREE.Vector3();
const modelDragStartControllerPosition = new THREE.Vector3();
const modelDragRaycaster = new THREE.Raycaster();

const loadedModels = [];
const loadedMotions = [];
let currentVrm = null;
let currentModel = null;
let currentObjectUrl = null;
let currentVrmaObjectUrl = null;
let activeModelIndex = -1;
let activeMotionIndex = -1;
let lastXRAxesLogTime = 0;
let vrUi = null;
let wasVRUIToggleButtonPressed = false;
let lastXRButtonsLogTime = 0;
let modelDrag = null;

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

const mmdLoader = new MMDLoader();

const vrmaLoader = new GLTFLoader();
vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

setupWorld();
setupVRUI();
setupXRControllers();
setupEvents();
renderAssetLists();
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
  panel.position.set(-0.36, 0, -VR_UI_PANEL_DISTANCE);

  const background = createVRUIPlane(VR_UI_PANEL_WIDTH, 0.82, "#20242d");
  background.material.opacity = 0.88;
  background.position.z = -0.01;
  panel.add(background);

  const title = createVRUILabel("XR Viewer", 0.39, 0.08, {
    fontSize: 30,
    background: "#2b3340",
    color: "#f5f7fb",
  });
  title.position.set(0, 0.33, 0);
  panel.add(title);

  const stateLabel = createVRUILabel("Model: none\nAnim: none", 0.39, 0.15, {
    fontSize: 28,
    background: "#111827",
    color: "#d9e0ee",
  });
  stateLabel.name = "VRUIStateLabel";
  stateLabel.position.set(0, 0.205, 0);
  panel.add(stateLabel);

  const buttons = [
    ["Next Mdl", selectNextModel],
    ["Next Anim", selectNextMotion],
    ["Play", playAnimation],
    ["Stop", stopAnimation],
    ["Show / Hide", toggleActiveModelVisibility],
    ["Reset Pos", resetActiveModelPosition],
    ["Exit VR", exitVRSession],
  ];

  buttons.forEach(([label, onSelect], index) => {
    const button = createVRUIButton(label, onSelect);
    button.position.set(0, 0.045 - index * 0.09, 0);
    panel.add(button);
    uiIntersectTargets.push(button);
  });

  camera.add(panel);

  panel.visible = false;

  vrUi = {
    panel,
    stateLabel,
    visible: false,
  };

  updateVRUIStateLabel();
}

function createVRUIButton(label, onSelect, options = {}) {
  const button = createVRUILabel(label, options.width ?? 0.36, options.height ?? 0.09, {
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
  mesh.userData.canvas = canvas;
  mesh.userData.texture = texture;
  mesh.userData.labelOptions = options;
  drawVRUILabel(mesh, label);
  return mesh;
}

function drawVRUILabel(mesh, label) {
  const canvas = mesh.userData.canvas;
  const context = canvas.getContext("2d");
  const options = mesh.userData.labelOptions ?? {};
  const background = options.background ?? "#ffffff";
  const color = options.color ?? "#000000";
  const fontSize = Math.round(options.fontSize ?? canvas.height * 0.36);
  const radius = Math.max(16, Math.round(canvas.height * 0.22));

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = background;
  roundRect(context, 0, 0, canvas.width, canvas.height, radius);
  context.fill();

  context.fillStyle = color;
  context.font = `700 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const lines = String(label).split("\n");
  const lineHeight = fontSize * 1.2;
  const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;

  lines.forEach((line, index) => {
    context.fillText(line, canvas.width / 2, startY + index * lineHeight);
  });

  mesh.userData.label = label;
  mesh.userData.texture.needsUpdate = true;
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
      startModelDrag(controller);
    });

    controller.addEventListener("squeezeend", () => {
      endModelDrag(controller);
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
    currentObjectUrl = null;
  }

  if (isZipFile(file.name)) {
    loadPmxZip(file);
    return;
  }

  currentObjectUrl = URL.createObjectURL(file);

  if (isPmxFile(file.name)) {
    loadPmx(currentObjectUrl, file.name, { modelExtension: "pmx" });
    return;
  }

  loadVrm(currentObjectUrl, file.name);
}

function loadMotionFile(file) {
  if (currentVrmaObjectUrl) {
    URL.revokeObjectURL(currentVrmaObjectUrl);
  }

  currentVrmaObjectUrl = URL.createObjectURL(file);
  loadVrma(currentVrmaObjectUrl, file.name);
}

function renderAssetLists() {
  renderModelList();
  renderMotionList();
  updateVRUIStateLabel();
}

function updateVRUIStateLabel() {
  if (!vrUi?.stateLabel) return;

  const modelName = currentModel?.name ?? "none";
  const motionName = currentModel?.currentMotion?.name ?? "none";
  drawVRUILabel(vrUi.stateLabel, `Model: ${shortLabel(modelName)}\nAnim: ${shortLabel(motionName)}`);
}

function shortLabel(label) {
  return label.length > 11 ? `${label.slice(0, 10)}...` : label;
}

function renderModelList() {
  modelListEl.textContent = "";

  if (loadedModels.length === 0) {
    modelListEl.append(createAssetListEmpty("No models"));
    return;
  }

  loadedModels.forEach((model, index) => {
    const item = createAssetListButton({
      label: `${index + 1}. ${model.name}`,
      detail: getModelListDetail(model),
      active: index === activeModelIndex,
      onClick: () => setActiveModel(index),
    });
    modelListEl.append(item);
  });
}

function getModelListDetail(model) {
  if (model.type === "vrm") {
    return model.currentMotion?.name ?? "VRM / No motion";
  }

  if (model.type === "pmx") {
    return "PMX / Static";
  }

  return model.type.toUpperCase();
}

function renderMotionList() {
  motionListEl.textContent = "";

  if (loadedMotions.length === 0) {
    motionListEl.append(createAssetListEmpty("No motions"));
    return;
  }

  loadedMotions.forEach((motion, index) => {
    const item = createAssetListButton({
      label: `${index + 1}. ${motion.name}`,
      detail: motion.type.toUpperCase(),
      active: index === activeMotionIndex,
      onClick: () => setActiveMotion(index),
    });
    motionListEl.append(item);
  });
}

function createAssetListButton({ label, detail, active, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `asset-item${active ? " active" : ""}`;
  button.title = `${label} - ${detail}`;
  button.textContent = `${label} / ${detail}`;
  button.addEventListener("click", onClick);
  return button;
}

function createAssetListEmpty(label) {
  const item = document.createElement("p");
  item.className = "hint";
  item.textContent = label;
  return item;
}

function selectNextModel() {
  if (loadedModels.length === 0) {
    setStatus("No models loaded. Load a VRM or PMX zip before entering VR.");
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
  renderAssetLists();
  setStatus(`${currentModel.name} ${currentModel.visible ? "shown" : "hidden"}.`);
}

function resetActiveModelPosition() {
  if (!currentModel) {
    setStatus("No active model.");
    return;
  }

  currentModel.object.position.set(0, 0, 0);
  currentModel.object.position.x = activeModelIndex * MODEL_X_OFFSET_METERS;
  currentModel.object.rotation.set(0, 0, 0);
  currentModel.object.scale.setScalar(getModelDefaultScale(currentModel));

  if (!renderer.xr.isPresenting) {
    frameModel(currentModel.object);
  }

  setStatus(`${currentModel.name} position reset.`);
}

function startModelDrag(controller) {
  if (!currentModel?.object) {
    setStatus("No active model to move.");
    return;
  }

  const hitActiveModel = getActiveModelIntersection(controller);
  if (!hitActiveModel) {
    setStatus(`Moving active model: ${currentModel.name}`);
  }

  controller.getWorldPosition(modelDragStartControllerPosition);
  modelDragStartPosition.copy(currentModel.object.position);

  modelDrag = {
    controller,
    model: currentModel,
  };
}

function updateModelDrag() {
  if (!modelDrag) return;

  modelDrag.controller.getWorldPosition(modelDragControllerPosition);
  modelDrag.model.object.position
    .copy(modelDragStartPosition)
    .add(modelDragControllerPosition)
    .sub(modelDragStartControllerPosition);
}

function endModelDrag(controller) {
  if (!modelDrag || modelDrag.controller !== controller) return;

  setStatus(`${modelDrag.model.name} moved.`);
  modelDrag = null;
  renderAssetLists();
}

function getActiveModelIntersection(controller) {
  if (!currentModel?.object) return null;

  setControllerRay(controller, uiRayOrigin, uiRayDirection);
  modelDragRaycaster.set(uiRayOrigin, uiRayDirection);
  modelDragRaycaster.far = VR_UI_RAY_LENGTH;

  return modelDragRaycaster.intersectObject(currentModel.object, true)[0] ?? null;
}

function handleVRUISelect(controller) {
  const hit = getVRUIIntersection(controller);
  if (!hit) return;

  hit.object.userData.onSelect?.();
}

function getVRUIIntersection(controller) {
  setControllerRay(controller, uiRayOrigin, uiRayDirection);

  uiRaycaster.set(uiRayOrigin, uiRayDirection);
  uiRaycaster.far = VR_UI_RAY_LENGTH;

  const hits = uiRaycaster.intersectObjects(getVisibleUIIntersectTargets(), false);
  return hits[0] ?? null;
}

function setControllerRay(controller, origin, direction) {
  uiControllerMatrix.identity().extractRotation(controller.matrixWorld);
  origin.setFromMatrixPosition(controller.matrixWorld);
  direction.set(0, 0, -1).applyMatrix4(uiControllerMatrix);
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
  setStatus(vrUi.visible ? "VR UI panel shown." : "VR UI panel hidden.");
}

function exitVRSession() {
  const session = renderer.xr.getSession();

  if (!session) {
    setStatus("Not currently in VR.");
    return;
  }

  session.end();
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
    vrm.scene.position.set(loadedModels.length * MODEL_X_OFFSET_METERS, 0, 0);
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
    renderAssetLists();

    setStatus(`Loaded ${label}. Enter VR with the VR button when using HTTPS.`);

  } catch (error) {
    console.error(error);
    setStatus(`Could not load VRM: ${error.message}`);
  }
}

async function loadPmx(url, label, options = {}) {
  setStatus(`Loading PMX ${label}...`);

  try {
    const loaderToUse = options.loader ?? mmdLoader;
    const mesh = options.modelExtension
      ? await loadMmdModelWithExtension(loaderToUse, url, options.modelExtension, options.resourcePath)
      : await loaderToUse.loadAsync(url);

    mesh.name = "LoadedPMX";
    mesh.position.set(loadedModels.length * MODEL_X_OFFSET_METERS, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.setScalar(PMX_MODEL_SCALE);
    preparePmxMaterials(mesh, label);

    const model = createModelRecord({
      type: "pmx",
      name: label,
      object: mesh,
      runtime: mesh,
      resourceUrls: options.resourceUrls,
    });

    loadedModels.push(model);
    scene.add(model.object);
    setActiveModel(loadedModels.length - 1);
    renderAssetLists();

    setStatus(`Loaded PMX ${label}. VMD playback is not enabled yet.`);
  } catch (error) {
    console.error(error);
    revokeObjectUrls(options.resourceUrls);
    setStatus(`Could not load PMX: ${error.message}`);
  }
}

async function loadPmxZip(file) {
  setStatus(`Loading PMX zip ${file.name}...`);

  let zipFileNames = [];

  try {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    zipFileNames = entries.map((entry) => entry.name);

    const pmxEntries = entries.filter((entry) => isPmxFile(entry.name));

    if (pmxEntries.length === 0) {
      console.group(`[PMX zip] No PMX found in ${file.name}`);
      console.table(zipFileNames);
      console.groupEnd();
      throw new Error("No .pmx file was found in the zip.");
    }

    if (pmxEntries.length > 1) {
      console.warn(
        `[PMX zip] Multiple PMX files found in ${file.name}; using the first one.`,
        pmxEntries.map((entry) => entry.name),
      );
    }

    const pmxEntry = pmxEntries[0];
    const zipResources = await createZipResourceUrls(entries);
    const pmxUrl = zipResources.byName.get(normalizeZipPath(pmxEntry.name));
    if (!pmxUrl) {
      throw new Error(`Could not create a Blob URL for ${pmxEntry.name}.`);
    }

    const manager = createPmxZipLoadingManager(zipResources, getZipDirectory(pmxEntry.name));
    const zipMmdLoader = new MMDLoader(manager);
    zipMmdLoader.setResourcePath("/");

    await loadPmx(pmxUrl, `${file.name} / ${getZipBaseName(pmxEntry.name)}`, {
      loader: zipMmdLoader,
      modelExtension: "pmx",
      resourcePath: "/",
      resourceUrls: zipResources.urls,
    });
  } catch (error) {
    console.error(error);
    if (zipFileNames.length > 0) {
      console.group(`[PMX zip] Files in ${file.name}`);
      console.table(zipFileNames);
      console.groupEnd();
    }
    setStatus(`Could not load PMX zip: ${error.message}`);
  }
}

function loadMmdModelWithExtension(loaderToUse, url, extension, resourcePath) {
  return new Promise((resolve, reject) => {
    const normalizedExtension = extension.toLowerCase();
    const loadMethod = normalizedExtension === "pmd" ? "loadPMD" : "loadPMX";
    const builder = loaderToUse.meshBuilder.setCrossOrigin(loaderToUse.crossOrigin);

    loaderToUse[loadMethod](
      url,
      (data) => {
        try {
          resolve(builder.build(data, resourcePath ?? loaderToUse.resourcePath ?? "", undefined, reject));
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      reject,
    );
  });
}

function preparePmxMaterials(object, label) {
  const materialRows = [];

  object.traverse((child) => {
    if (!child.isMesh) return;

    child.castShadow = true;
    child.receiveShadow = true;

    const materials = Array.isArray(child.material) ? child.material : [child.material];

    materials.forEach((material, index) => {
      if (!material) return;

      configurePmxMaterial(material);

      materialRows.push({
        mesh: child.name || child.type,
        slot: index,
        material: material.name || "(unnamed)",
        type: material.type,
        map: getTextureDebugName(material.map),
        emissiveMap: getTextureDebugName(material.emissiveMap),
        aoMap: getTextureDebugName(material.aoMap),
        lightMap: getTextureDebugName(material.lightMap),
        envMap: getTextureDebugName(material.envMap),
        color: material.color?.getHexString?.() ?? "",
        emissive: material.emissive?.getHexString?.() ?? "",
        opacity: material.opacity,
        transparent: material.transparent,
        side: material.side,
      });
    });
  });

  console.group(`[PMX] Materials for ${label}`);
  console.log("renderer.outputColorSpace", renderer.outputColorSpace);
  console.table(materialRows);
  console.groupEnd();
}

function configurePmxMaterial(material) {
  setTextureColorSpace(material.map, THREE.SRGBColorSpace);
  setTextureColorSpace(material.emissiveMap, THREE.SRGBColorSpace);
  setTextureColorSpace(material.lightMap, THREE.SRGBColorSpace);
  setTextureColorSpace(material.aoMap, THREE.NoColorSpace);
  setTextureColorSpace(material.normalMap, THREE.NoColorSpace);
  setTextureColorSpace(material.bumpMap, THREE.NoColorSpace);
  setTextureColorSpace(material.alphaMap, THREE.NoColorSpace);

  if (material.envMap) {
    setTextureColorSpace(material.envMap, THREE.SRGBColorSpace);
    material.envMapIntensity = Math.min(material.envMapIntensity ?? 1, 0.35);
  }

  if (material.color) {
    material.color.multiplyScalar(0.92);
  }

  if (material.emissive) {
    material.emissive.multiplyScalar(0.35);
  }

  material.toneMapped = true;
  material.needsUpdate = true;
}

function setTextureColorSpace(texture, colorSpace) {
  if (!texture) return;

  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
}

function getTextureDebugName(texture) {
  if (!texture) return "";

  return texture.name || texture.source?.data?.src || texture.image?.src || "(loaded)";
}

async function createZipResourceUrls(entries) {
  const byName = new Map();
  const byBaseName = new Map();
  const duplicateBaseNames = new Set();
  const urls = [];

  for (const entry of entries) {
    const blob = await entry.async("blob");
    const url = URL.createObjectURL(blob);
    const normalizedName = normalizeZipPath(entry.name);
    const normalizedBaseName = normalizeZipPath(getZipBaseName(entry.name));

    byName.set(normalizedName, url);
    urls.push(url);

    if (byBaseName.has(normalizedBaseName)) {
      duplicateBaseNames.add(normalizedBaseName);
    } else {
      byBaseName.set(normalizedBaseName, url);
    }
  }

  for (const duplicate of duplicateBaseNames) {
    byBaseName.delete(duplicate);
  }

  return {
    byName,
    byBaseName,
    urls,
  };
}

function createPmxZipLoadingManager(zipResources, pmxDirectory) {
  const manager = new THREE.LoadingManager();

  manager.setURLModifier((url) => {
    const resolvedUrl = resolveZipResourceUrl(url, zipResources, pmxDirectory);

    if (!resolvedUrl && isTexturePath(url)) {
      console.warn(`[PMX zip] Texture not found in zip: ${url}`);
    }

    return resolvedUrl ?? url;
  });

  return manager;
}

function resolveZipResourceUrl(url, zipResources, pmxDirectory) {
  if (url.startsWith("blob:")) return url;

  const normalizedUrl = normalizeZipPath(url);
  const pmxRelativeUrl = normalizeZipPath(`${pmxDirectory}/${normalizedUrl}`);

  return (
    zipResources.byName.get(normalizedUrl) ??
    zipResources.byName.get(pmxRelativeUrl) ??
    zipResources.byBaseName.get(normalizeZipPath(getZipBaseName(normalizedUrl))) ??
    null
  );
}

function normalizeZipPath(path) {
  let normalized = String(path);

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original path if it is not URI-encoded.
  }

  return normalized
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase()
    .split("/")
    .reduce((parts, part) => {
      if (!part || part === ".") return parts;
      if (part === "..") {
        parts.pop();
        return parts;
      }
      parts.push(part);
      return parts;
    }, [])
    .join("/");
}

function getZipDirectory(path) {
  const normalized = normalizeZipPath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? "" : normalized.slice(0, slashIndex);
}

function getZipBaseName(path) {
  return String(path).replace(/\\/g, "/").split("/").pop() ?? "";
}

function createModelRecord({ type, name, object, runtime, resourceUrls = [] }) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${type}-${Date.now()}-${loadedModels.length}`,
    type,
    name,
    object,
    vrm: type === "vrm" ? runtime : null,
    pmx: type === "pmx" ? runtime : null,
    currentMotion: null,
    animationMixer: null,
    animationAction: null,
    resourceUrls,
    visible: true,
  };
}

function getModelDefaultScale(model) {
  return isPmxModel(model) ? PMX_MODEL_SCALE : 1;
}

function setActiveModel(index) {
  if (index < 0 || index >= loadedModels.length) return;

  activeModelIndex = index;
  currentModel = loadedModels[activeModelIndex];
  currentVrm = currentModel.vrm;

  loadedModels.forEach((model) => {
    model.object.visible = model.visible;
  });

  if (!renderer.xr.isPresenting) {
    frameModel(currentModel.object);
  }

  if (currentModel.currentMotion && !currentModel.animationAction) {
    applyMotionToModel(currentModel, currentModel.currentMotion);
  }

  renderAssetLists();
  setStatus(`Active model: ${currentModel.name}`);
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
    renderAssetLists();

    if (isPmxModel(currentModel)) {
      setStatus(`Loaded motion ${label}. PMX VMD playback is not enabled yet.`);
      return;
    }

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

  if (isVrmModel(currentModel)) {
    currentModel.currentMotion = motion;
    applyMotionToModel(currentModel, motion);
  }

  renderAssetLists();

  if (currentModel?.animationAction) {
    playAnimation();
  } else if (isPmxModel(currentModel)) {
    setStatus(`Active motion: ${motion.name}. PMX VMD playback is not enabled yet.`);
  } else {
    setStatus(`Active motion: ${motion.name}`);
  }
}

function applyMotionToModel(model, motion) {
  clearModelAnimation(model);

  if (!model?.vrm || !motion) return;

  model.currentMotion = motion;
  model.vrm.humanoid?.resetNormalizedPose?.();
  model.vrm.lookAt?.reset?.();
  if (model.vrm.lookAt) {
    model.vrm.lookAt.autoUpdate = motion.runtime.lookAtTrack != null;
  }

  const clip = createVRMAnimationClip(motion.runtime, model.vrm);
  model.animationMixer = new THREE.AnimationMixer(model.object);
  model.animationAction = model.animationMixer.clipAction(clip);
  model.animationAction.setLoop(THREE.LoopRepeat);
  model.animationAction.clampWhenFinished = false;
}

function playAnimation() {
  if (!currentModel?.animationAction) {
    if (isPmxModel(currentModel)) {
      setStatus("PMX VMD playback is not enabled yet.");
      return;
    }

    setStatus("Select a VRM model and apply a VRMA motion first.");
    return;
  }

  currentModel.animationAction.paused = false;
  currentModel.animationAction.play();
  setStatus(`Animation playing: ${currentModel.name}.`);
}

function stopAnimation() {
  if (!currentModel?.animationAction) {
    setStatus("No animation is loaded for the active model.");
    return;
  }

  currentModel.animationAction.stop();
  currentModel.vrm?.humanoid?.resetNormalizedPose?.();
  currentModel.vrm?.expressionManager?.resetValues?.();
  setStatus(`Animation stopped: ${currentModel.name}.`);
}

function clearModelAnimation(model) {
  if (!model?.animationMixer) return;

  model.animationMixer.stopAllAction();

  if (model.object) {
    model.animationMixer.uncacheRoot(model.object);
  }

  model.animationMixer = null;
  model.animationAction = null;
}

function revokeObjectUrls(urls = []) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}

function isVrmModel(model) {
  return model?.type === "vrm";
}

function isPmxModel(model) {
  return model?.type === "pmx";
}

function isPmxFile(fileName) {
  return fileName.toLowerCase().endsWith(".pmx");
}

function isZipFile(fileName) {
  return fileName.toLowerCase().endsWith(".zip");
}

function isTexturePath(path) {
  const extension = normalizeZipPath(path).split(".").pop();
  return PMX_TEXTURE_EXTENSIONS.has(extension);
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
  updateModelDrag();

  for (const model of loadedModels) {
    model.animationMixer?.update(delta);
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
