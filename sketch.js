/**
 * 四季树生成器 - p5.js L-system 动态生长版
 * 参考 process.pde 的多根渐进生长逻辑，逐帧发射线段并撒叶，保持点击落叶与季节切换。
 */

const SEASON_KEYS = ["spring", "summer", "autumn", "winter"];

const GLOBAL = {
  margin: 60,
  rootCount: 5,
  growPerFrame: 30,
  gridCols: 5,
  topStopMargin: 20,
  alongLeafMin: 2,
  alongLeafMax: 4,
  maxPlaceTries: 8,
  clickRadius: 50,
  leafSize: { min: 3, max: 7 },
};

const ACTIONS = {
  POUR_TEA: "pour tea",
  RISE_GLASS: "rise glass",
  NOTHING: "nothing",
};

const ACTION_THRESHOLD = 0.7; // 最低置信度才认为是倒茶
const PROGRESS_STEP = 0.04; // 每次识别为倒茶时进度增加的幅度
const TM_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js";

const SEASON_CONFIG = {
  spring: {
    branchColor: { r: 101, g: 67, b: 33 },
    leafColorMin: { r: 144, g: 238, b: 144 },
    leafColorMax: { r: 200, g: 255, b: 200 },
    background: { r: 240, g: 248, b: 255 },
    leafCount: 3500,
    minLeafCount: 2500,
    backfillPerFrame: 150,
    alongLeafRadius: 35,
    lsystem: {
      iterations: 3,
      angleDeg: 25,
      baseLen: 85,
      lenFactor: 0.7,
      trunkBoost: 1.6,
      trunkThickBoost: 1.2,
    },
    thickness: { start: 5, decay: 0.98, min: 1 },
    ground: { baseOffset: 6, noiseAmp: 12, noiseScale: 0.01, step: 4, seed: 1337 },
  },
  summer: {
    branchColor: { r: 63, g: 55, b: 54 },
    leafColorMin: { r: 186, g: 73, b: 55 },
    leafColorMax: { r: 229, g: 203, b: 193 },
    background: { r: 245, g: 240, b: 236 },
    leafCount: 4000,
    minLeafCount: 3000,
    backfillPerFrame: 200,
    alongLeafRadius: 40,
    lsystem: {
      iterations: 3,
      angleDeg: 25,
      baseLen: 90,
      lenFactor: 0.7,
      trunkBoost: 1.8,
      trunkThickBoost: 1.5,
    },
    thickness: { start: 6, decay: 0.975, min: 1 },
    ground: { baseOffset: 8, noiseAmp: 10, noiseScale: 0.01, step: 4, seed: 2024 },
  },
  autumn: {
    branchColor: { r: 139, g: 69, b: 19 },
    leafColorMin: { r: 255, g: 140, b: 0 },
    leafColorMax: { r: 255, g: 215, b: 100 },
    background: { r: 255, g: 248, b: 220 },
    leafCount: 4500,
    minLeafCount: 3500,
    backfillPerFrame: 220,
    alongLeafRadius: 45,
    lsystem: {
      iterations: 4,
      angleDeg: 20,
      baseLen: 95,
      lenFactor: 0.72,
      trunkBoost: 2.0,
      trunkThickBoost: 1.5,
    },
    thickness: { start: 5.5, decay: 0.977, min: 0.9 },
    ground: { baseOffset: 5, noiseAmp: 15, noiseScale: 0.012, step: 4, seed: 77 },
  },
  winter: {
    branchColor: { r: 105, g: 105, b: 105 },
    leafColorMin: { r: 240, g: 240, b: 240 },
    leafColorMax: { r: 255, g: 255, b: 255 },
    background: { r: 220, g: 230, b: 240 },
    leafCount: 2000,
    minLeafCount: 1500,
    backfillPerFrame: 80,
    alongLeafRadius: 30,
    lsystem: {
      iterations: 2,
      angleDeg: 28,
      baseLen: 80,
      lenFactor: 0.68,
      trunkBoost: 1.4,
      trunkThickBoost: 1.1,
    },
    thickness: { start: 4, decay: 0.985, min: 0.8 },
    ground: { baseOffset: 10, noiseAmp: 8, noiseScale: 0.009, step: 5, seed: 512 },
  },
};

let currentSeason = "summer";
let leaves = [];
let clickCount = 0;
let segmentQueue = [];
let segmentsByIter = [];
let drawnSegments = [];
let currentIterEmitted = 0;
let rootLenMul = [];
let rootThickMul = [];
let rootIters = [];
let minLeafSpacing = (GLOBAL.leafSize.min + GLOBAL.leafSize.max) * 0.5;
let growthProgress = 0;
let actionPrediction = { label: "模型未就绪", confidence: 0 };
let tmModel = null;
let tmWebcam = null;

function setup() {
  createCanvas(windowWidth, windowHeight);
  angleMode(RADIANS);
  frameRate(60);
  applySeasonConfig("summer");
  initActionRecognition();
}

function draw() {
  const cfg = SEASON_CONFIG[currentSeason];
  background(cfg.background.r, cfg.background.g, cfg.background.b);

  drawGround(cfg);
  drawSeasonHUD();

  syncGrowthWithProgress();
  redrawSegments(cfg);
  processGrowth(cfg);
  updateLeaves(cfg);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  resetScene();
}

function keyPressed() {
  if (["1", "2", "3", "4"].includes(key)) {
    const idx = int(key) - 1;
    applySeasonConfig(SEASON_KEYS[idx]);
  }
}

function mousePressed() {
  clickCount++;
  let hit = false;
  for (const leaf of leaves) {
    if (!leaf.falling && dist(mouseX, mouseY, leaf.pos.x, leaf.pos.y) <= leaf.radius * 3) {
      leaf.startFalling();
      hit = true;
    }
  }
  if (!hit) {
    rippleFall(mouseX, mouseY);
  }
  if (clickCount >= 5) {
    leaves.forEach((leaf) => leaf.startFalling(true));
    clickCount = 0;
  }
}

function rippleFall(x, y) {
  for (const leaf of leaves) {
    if (leaf.falling) continue;
    if (dist(x, y, leaf.pos.x, leaf.pos.y) <= GLOBAL.clickRadius && random() < 0.6) {
      leaf.startFalling();
    }
  }
}

function applySeasonConfig(seasonKey) {
  currentSeason = seasonKey;
  const cfg = SEASON_CONFIG[currentSeason];
  noiseSeed(cfg.ground.seed);
  resetScene();
}

function resetScene() {
  const cfg = SEASON_CONFIG[currentSeason];
  leaves = [];
  segmentQueue = [];
  segmentsByIter = [];
  drawnSegments = [];
  currentIterEmitted = 0;
  growthProgress = 0;

  rootLenMul = new Array(GLOBAL.rootCount).fill(1).map(() => random(0.85, 1.25));
  rootThickMul = new Array(GLOBAL.rootCount).fill(1).map(() => random(0.85, 1.3));
  rootIters = new Array(GLOBAL.rootCount).fill(cfg.lsystem.iterations).map((base) =>
    max(1, base + floor(random(-1, 2)))
  );

  buildAllRoots(cfg);
}

function buildAllRoots(cfg) {
  const cellWidth = width / GLOBAL.gridCols;
  for (let i = 0; i < GLOBAL.rootCount; i++) {
    const col = i % GLOBAL.gridCols;
    const cx = col * cellWidth + cellWidth * 0.5;
    const jitter = cellWidth * 0.2;
    const startX = constrain(cx + random(-jitter, jitter), GLOBAL.margin, width - GLOBAL.margin);
    const startY = random(height - GLOBAL.margin, height - 10);
    buildSegmentsForRoot(startX, startY, -HALF_PI, i, cfg);
  }
}

function buildSegmentsForRoot(startX, startY, startAngle, rootIdx, cfg) {
  const iterations = rootIters[rootIdx];
  const sentence = buildLSystemSentence(iterations);
  const maxLayers = max(segmentsByIter.length, iterations);
  while (segmentsByIter.length < maxLayers) {
    segmentsByIter.push([]);
  }

  let segLen = cfg.lsystem.baseLen * rootLenMul[rootIdx];
  for (let i = 0; i < iterations; i++) {
    segLen *= cfg.lsystem.lenFactor;
  }

  let cx = startX;
  let cy = startY;
  let angle = startAngle;
  let thickness = cfg.thickness.start * rootThickMul[rootIdx];
  const angleStep = radians(cfg.lsystem.angleDeg);
  const stack = [];
  let layer = 0;

  for (const ch of sentence) {
    if (ch === "F") {
      const isTrunk = stack.length === 0;
      const stepLen = isTrunk ? segLen * cfg.lsystem.trunkBoost : segLen;
      const wLocal = isTrunk ? thickness * cfg.lsystem.trunkThickBoost : thickness;
      const nx = cx + cos(angle) * stepLen;
      const ny = cy + sin(angle) * stepLen;
      if (ny <= GLOBAL.topStopMargin) break;
      segmentsByIter[layer].push({
        x1: cx,
        y1: cy,
        x2: nx,
        y2: ny,
        thickness: max(cfg.thickness.min, wLocal),
        length: stepLen,
      });
      thickness = max(cfg.thickness.min, thickness * cfg.thickness.decay);
      cx = nx;
      cy = ny;
    } else if (ch === "+") {
      angle += angleStep;
    } else if (ch === "-") {
      angle -= angleStep;
    } else if (ch === "[") {
      stack.push({ cx, cy, angle, thickness, layer });
      layer = min(layer + 1, iterations - 1);
    } else if (ch === "]") {
      const state = stack.pop();
      if (state) {
        ({ cx, cy, angle, thickness, layer } = state);
      }
    }
  }
}

function buildLSystemSentence(iterations) {
  const RULES = {
    F: "FF-[-F+F+F]+[+F-F-F]",
  };
  let current = "F";
  for (let i = 0; i < iterations; i++) {
    let next = "";
    for (const ch of current) {
      next += RULES[ch] || ch;
    }
    current = next;
  }
  return current;
}

function syncGrowthWithProgress() {
  if (segmentsByIter.length === 0) return;
  const clamped = constrain(growthProgress, 0, 1);
  const targetLayers = floor(clamped * segmentsByIter.length);
  while (currentIterEmitted < targetLayers && currentIterEmitted < segmentsByIter.length) {
    emitNextLayer();
  }
}

function emitNextLayer() {
  if (currentIterEmitted >= segmentsByIter.length) return;
  const nextLayer = segmentsByIter[currentIterEmitted];
  segmentQueue.push(...nextLayer);
  currentIterEmitted++;
}

function processGrowth(cfg) {
  for (let i = 0; i < GLOBAL.growPerFrame && segmentQueue.length > 0; i++) {
    const seg = segmentQueue.shift();
    drawnSegments.push(seg);
    renderSegment(seg, cfg);
    sprinkleLeavesAlongSegment(seg, cfg);
  }
}

function redrawSegments(cfg) {
  for (const seg of drawnSegments) {
    renderSegment(seg, cfg);
  }
}

function renderSegment(seg, cfg) {
  stroke(cfg.branchColor.r, cfg.branchColor.g, cfg.branchColor.b);
  strokeWeight(seg.thickness);
  strokeCap(ROUND);
  line(seg.x1, seg.y1, seg.x2, seg.y2);
}

function sprinkleLeavesAlongSegment(seg, cfg) {
  if (leaves.length >= cfg.leafCount) return;
  const extra = map(seg.length, 0, 180, 0, 3, true);
  const count = floor(random(GLOBAL.alongLeafMin, GLOBAL.alongLeafMax + extra + 1));
  for (let i = 0; i < count; i++) {
    const t = random(0.15, 0.85);
    const px = lerp(seg.x1, seg.x2, t) + random(-cfg.alongLeafRadius, cfg.alongLeafRadius);
    const py = lerp(seg.y1, seg.y2, t) + random(-cfg.alongLeafRadius, cfg.alongLeafRadius);
    tryPlaceLeaf(px, py, cfg);
  }
}

function tryPlaceLeaf(px, py, cfg) {
  for (let attempt = 0; attempt < GLOBAL.maxPlaceTries; attempt++) {
    const tx = constrain(px + random(-2, 2), 0, width);
    const ty = constrain(py + random(-2, 2), 0, height);
    let ok = true;
    for (const other of leaves) {
      if (sq(tx - other.pos.x) + sq(ty - other.pos.y) < sq(minLeafSpacing)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      leaves.push(new Leaf(tx, ty, cfg));
      return;
    }
    px += random(-minLeafSpacing, minLeafSpacing);
    py += random(-minLeafSpacing, minLeafSpacing);
  }
  leaves.push(new Leaf(constrain(px, 0, width), constrain(py, 0, height), cfg));
}

function updateLeaves(cfg) {
  if (
    segmentQueue.length === 0 &&
    currentIterEmitted >= segmentsByIter.length &&
    leaves.length < cfg.minLeafCount
  ) {
    const need = min(cfg.minLeafCount - leaves.length, cfg.backfillPerFrame);
    for (let i = 0; i < need; i++) {
      if (leaves.length > 0) {
        const base = random(leaves);
        tryPlaceLeaf(
          constrain(base.pos.x + random(-30, 30), GLOBAL.margin, width - GLOBAL.margin),
          constrain(base.pos.y + random(-20, 20), GLOBAL.margin, height - GLOBAL.margin),
          cfg
        );
      } else {
        tryPlaceLeaf(random(GLOBAL.margin, width - GLOBAL.margin), random(height * 0.2, height * 0.9), cfg);
      }
    }
  }

  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i];
    leaf.update(cfg);
    leaf.show();
  }
}

class Leaf {
  constructor(x, y, cfg) {
    this.pos = createVector(x + random(-5, 5), y + random(-5, 5));
    this.radius = random(GLOBAL.leafSize.min, GLOBAL.leafSize.max);
    this.color = randomLeafColor(cfg);
    this.falling = false;
    this.velocity = createVector(random(-0.2, 0.2), random(-0.1, 0.1));
    this.angle = random(TWO_PI);
    this.spin = random(-0.02, 0.02);
    this.windSeed = random(1000);
  }

  startFalling(force = false) {
    if (this.falling && !force) return;
    this.falling = true;
    this.velocity.x += random(-0.5, 0.5);
    this.velocity.y += random(0.5, 1.2);
  }

  update(cfg) {
    if (!this.falling) return;
    const wind = sin((frameCount + this.windSeed) * 0.05) * 0.3;
    this.velocity.x = (this.velocity.x + wind) * 0.98;
    this.velocity.y = (this.velocity.y + 0.12) * 0.99;
    this.pos.add(this.velocity);
    this.angle += this.spin;

    const gy = groundY(this.pos.x, cfg);
    if (this.pos.y >= gy) {
      this.pos.y = gy;
      this.falling = false;
      this.velocity.mult(0);
    }
  }

  show() {
    push();
    translate(this.pos.x, this.pos.y);
    rotate(this.angle);
    noStroke();
    fill(this.color.r, this.color.g, this.color.b, 230);
    ellipse(0, 0, this.radius * 2, this.radius * 1.2);
    pop();
  }
}

function randomLeafColor(cfg) {
  const amt = random();
  return {
    r: lerp(cfg.leafColorMin.r, cfg.leafColorMax.r, amt),
    g: lerp(cfg.leafColorMin.g, cfg.leafColorMax.g, amt),
    b: lerp(cfg.leafColorMin.b, cfg.leafColorMax.b, amt),
  };
}

function drawGround(cfg) {
  push();
  noStroke();
  fill(cfg.branchColor.r * 0.4, cfg.branchColor.g * 0.4, cfg.branchColor.b * 0.4, 200);
  beginShape();
  const baseY = height - cfg.ground.baseOffset;
  vertex(0, height);
  for (let x = 0; x <= width; x += cfg.ground.step) {
    const y = baseY - noise((x + cfg.ground.seed) * cfg.ground.noiseScale) * cfg.ground.noiseAmp;
    vertex(x, y);
  }
  vertex(width, height);
  endShape(CLOSE);
  pop();
}

function groundY(x, cfg) {
  const nx = (x + cfg.ground.seed) * cfg.ground.noiseScale;
  const offset = cfg.ground.baseOffset + noise(nx) * cfg.ground.noiseAmp;
  const stepped = floor(offset / cfg.ground.step) * cfg.ground.step;
  return height - stepped;
}

function drawSeasonHUD() {
  push();
  fill(0, 140);
  noStroke();
  rect(16, 16, 200, 110, 12);
  fill(255);
  textAlign(LEFT, TOP);
  textSize(18);
  text(getSeasonLabel(currentSeason), 24, 22);
  textSize(12);
  text("按 1-4 切换季节", 24, 44);
  text("点击叶子飘落", 24, 58);
  const actionLabel = translateActionLabel(actionPrediction.label);
  text(`识别: ${actionLabel}`, 24, 74);
  text(`进度: ${(growthProgress * 100).toFixed(0)}%`, 24, 88);
  pop();
}

function getSeasonLabel(key) {
  switch (key) {
    case "spring":
      return "春天";
    case "summer":
      return "夏天";
    case "autumn":
      return "秋天";
    case "winter":
      return "冬天";
    default:
      return key;
  }
}

function translateActionLabel(label) {
  switch (label?.toLowerCase()) {
    case ACTIONS.POUR_TEA:
      return "倒茶";
    case ACTIONS.RISE_GLASS:
      return "举杯";
    case ACTIONS.NOTHING:
      return "无动作";
    default:
      return label || "未识别";
  }
}

function setActionStatus(text) {
  const el = document.getElementById("tm-status");
  if (el) el.textContent = text;
}

function updateProgressBar() {
  const bar = document.getElementById("tm-progress");
  if (bar) bar.style.width = `${(growthProgress * 100).toFixed(1)}%`;
}

async function initActionRecognition() {
  try {
    await ensureTeachableMachineReady();
    setActionStatus("加载模型...");
    updateProgressBar();
    const modelURL = "model/model.json";
    const metadataURL = "model/metadata.json";
    tmModel = await tmImage.load(modelURL, metadataURL);
    tmWebcam = new tmImage.Webcam(200, 200, true);
    await tmWebcam.setup();
    await tmWebcam.play();
    attachWebcamCanvas();
    setActionStatus("摄像头就绪，等待动作...");
    window.requestAnimationFrame(predictActionLoop);
  } catch (error) {
    console.error(error);
    setActionStatus("手势识别初始化失败");
  }
}

function attachWebcamCanvas() {
  const container = document.getElementById("tm-video");
  if (container && tmWebcam?.canvas) {
    container.innerHTML = "";
    container.appendChild(tmWebcam.canvas);
  }
}

async function predictActionLoop() {
  if (!tmModel || !tmWebcam) return;
  tmWebcam.update();
  try {
    const predictions = await tmModel.predict(tmWebcam.canvas);
    const best = predictions.reduce((prev, curr) =>
      curr.probability > prev.probability ? curr : prev
    );
    actionPrediction = { label: best.className, confidence: best.probability };
    const isPourTea =
      best.className.toLowerCase() === ACTIONS.POUR_TEA && best.probability >= ACTION_THRESHOLD;
    handleGrowthProgress(isPourTea);
    const readable = translateActionLabel(best.className);
    setActionStatus(`动作：${readable} (${(best.probability * 100).toFixed(0)}%)`);
  } catch (error) {
    console.error(error);
    setActionStatus("预测失败，重试中...");
  }
  updateProgressBar();
  window.requestAnimationFrame(predictActionLoop);
}

function handleGrowthProgress(isPourTea) {
  if (isPourTea) {
    growthProgress = constrain(growthProgress + PROGRESS_STEP, 0, 1);
  } else {
    growthProgress = 0;
  }
}

async function ensureTeachableMachineReady() {
  if (typeof tmImage !== "undefined") return;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TM_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("tmImage 脚本加载失败")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = TM_SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("tmImage 脚本加载失败"));
    document.head.appendChild(script);
  });
  if (typeof tmImage === "undefined") {
    throw new Error("tmImage 未定义");
  }
}

