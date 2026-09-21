const STORAGE_KEY = "cutting-layout-v1";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const grainLabel = {
  vertical: "顺纹",
  horizontal: "横纹",
  any: "不限"
};

const edgeLabels = {
  edgeN: "上",
  edgeE: "右",
  edgeS: "下",
  edgeW: "左"
};

let state = null;
let toastTimer = null;

function uid(prefix) {
  state.seq += 1;
  return `${prefix}${Date.now().toString(36)}${state.seq}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectArea(rect) {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function distanceRects(a, b) {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX <= 0 && gapY <= 0) return { overlap: true, gap: 0 };
  if (gapX <= 0) return { overlap: false, gap: Math.max(0, gapY) };
  if (gapY <= 0) return { overlap: false, gap: Math.max(0, gapX) };
  return { overlap: false, gap: Math.min(gapX, gapY) };
}

function batchColor(batch) {
  let hash = 0;
  for (const char of batch) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 42% 88%)`;
}

function formatArea(area) {
  return (area / 1_000_000).toFixed(2) + "㎡";
}

function getVersion() {
  return state.versions.find(version => version.id === state.activeVersionId) || state.versions[0];
}

function getPart(partId) {
  return state.parts.find(part => part.id === partId);
}

function getSheet(sheetId) {
  return state.sheets.find(sheet => sheet.id === sheetId);
}

function placementRect(part, placement) {
  const rotated = placement.r === 90;
  return {
    x: placement.x,
    y: placement.y,
    w: rotated ? part.h : part.w,
    h: rotated ? part.w : part.h
  };
}

function canRotate(part) {
  return part.grain === "any";
}

function isAvailableInOrder(sheet, orderNo = state.settings.orderNo) {
  return !sheet.originOrderNo || sheet.originOrderNo !== orderNo;
}

function placementOnSheet(version, sheetId) {
  return Object.entries(version.placements)
    .filter(([, placement]) => placement.sheetId === sheetId)
    .map(([partId, placement]) => {
      const part = getPart(partId);
      return part ? { part, placement, rect: placementRect(part, placement) } : null;
    })
    .filter(Boolean);
}

function isSheetLocked(version, sheetId) {
  return Boolean(version.lockedSheets[sheetId]);
}

function usedSheetIds(version) {
  const ids = new Set(Object.values(version.placements).map(placement => placement.sheetId));
  Object.keys(version.lockedSheets).forEach(sheetId => {
    if (getSheet(sheetId) && placementOnSheet(version, sheetId).length > 0) ids.add(sheetId);
  });
  return Array.from(ids).filter(Boolean);
}

function pruneFreeRects(rects) {
  const valid = rects
    .filter(rect => rect.w > 0 && rect.h > 0)
    .map(rect => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h)
    }));
  const result = [];
  for (const rect of valid) {
    const containedByOther = valid.some(other =>
      other !== rect &&
      other.x <= rect.x &&
      other.y <= rect.y &&
      other.x + other.w >= rect.x + rect.w &&
      other.y + other.h >= rect.y + rect.h &&
      !(other.x === rect.x && other.y === rect.y && other.w === rect.w && other.h === rect.h)
    );
    const duplicate = result.some(other =>
      other.x === rect.x && other.y === rect.y && other.w === rect.w && other.h === rect.h
    );
    if (!containedByOther && !duplicate) result.push(rect);
  }
  return result;
}

function subtractRect(freeRect, occupied) {
  const x1 = Math.max(freeRect.x, occupied.x);
  const y1 = Math.max(freeRect.y, occupied.y);
  const x2 = Math.min(freeRect.x + freeRect.w, occupied.x + occupied.w);
  const y2 = Math.min(freeRect.y + freeRect.h, occupied.y + occupied.h);
  if (x1 >= x2 || y1 >= y2) return [freeRect];

  const pieces = [];
  if (x1 > freeRect.x) {
    pieces.push({ x: freeRect.x, y: freeRect.y, w: x1 - freeRect.x, h: freeRect.h });
  }
  if (x2 < freeRect.x + freeRect.w) {
    pieces.push({ x: x2, y: freeRect.y, w: freeRect.x + freeRect.w - x2, h: freeRect.h });
  }
  if (y1 > freeRect.y) {
    pieces.push({ x: freeRect.x, y: freeRect.y, w: freeRect.w, h: y1 - freeRect.y });
  }
  if (y2 < freeRect.y + freeRect.h) {
    pieces.push({ x: freeRect.x, y: y2, w: freeRect.w, h: freeRect.y + freeRect.h - y2 });
  }
  return pieces;
}

function reserveRectFor(rect, sheet, kerf) {
  const x = Math.max(0, rect.x - kerf);
  const y = Math.max(0, rect.y - kerf);
  const right = Math.min(sheet.w, rect.x + rect.w + kerf);
  const bottom = Math.min(sheet.h, rect.y + rect.h + kerf);
  return { x, y, w: right - x, h: bottom - y };
}

function buildFreeRects(sheet, items, kerf) {
  let freeRects = [{ x: 0, y: 0, w: sheet.w, h: sheet.h }];
  for (const item of items) {
    const reserve = reserveRectFor(item.rect, sheet, kerf);
    freeRects = pruneFreeRects(freeRects.flatMap(rect => subtractRect(rect, reserve)));
  }
  return freeRects;
}

function disjointFreeRects(sheet, items, kerf) {
  const candidates = buildFreeRects(sheet, items, kerf)
    .filter(rect => rect.w >= state.settings.minRemW && rect.h >= state.settings.minRemH)
    .sort((a, b) => rectArea(b) - rectArea(a));
  const accepted = [];
  for (const rect of candidates) {
    if (!accepted.some(other => rectsOverlap(rect, other))) accepted.push(rect);
  }
  return accepted;
}

function createSampleState() {
  const sample = {
    seq: 0,
    settings: {
      orderNo: "ORD-20260921-001",
      kerf: 4,
      snap: 5,
      minRemW: 120,
      minRemH: 80,
      showRemnants: true,
      scale: 0.2
    },
    parts: [],
    sheets: [],
    versions: [],
    activeVersionId: "",
    selection: null,
    strategy: "compact"
  };

  function addPart(name, w, h, grain, batch, edge = {}) {
    sample.seq += 1;
    sample.parts.push({ id: `p${sample.seq}`, name, w, h, grain, batch, edge });
  }

  function addSheet(name, w, h, batch, kind = "full") {
    sample.seq += 1;
    sample.sheets.push({ id: `s${sample.seq}`, name, w, h, batch, kind, originVersionId: null });
    return `s${sample.seq}`;
  }

  const walnut = "胡桃木-A批";
  const oak = "白橡木-B批";
  addSheet("胡桃木整板 1", 2440, 1220, walnut);
  addSheet("胡桃木整板 2", 2440, 1220, walnut);
  addSheet("白橡木整板 1", 2440, 1220, oak);
  const rem1 = addSheet("胡桃木余料", 980, 620, walnut, "remnant");
  const rem2 = addSheet("白橡木余料", 760, 480, oak, "remnant");
  sample.sheets.find(sheet => sheet.id === rem1).name = "胡桃木余料 980×620";
  sample.sheets.find(sheet => sheet.id === rem2).name = "白橡木余料 760×480";

  addPart("胡桃木柜门 A", 520, 760, "vertical", walnut, { edgeN: true, edgeE: true, edgeW: true });
  addPart("胡桃木柜门 B", 520, 760, "vertical", walnut, { edgeN: true, edgeE: true, edgeW: true });
  addPart("胡桃木侧板", 380, 880, "vertical", walnut, { edgeE: true, edgeS: true });
  addPart("胡桃木顶板", 1200, 320, "horizontal", walnut, { edgeN: true, edgeE: true, edgeS: true });
  addPart("胡桃木活动层板", 760, 260, "horizontal", walnut);
  addPart("胡桃木背板条", 640, 140, "any", walnut);
  addPart("白橡木柜门 A", 480, 700, "vertical", oak, { edgeN: true, edgeE: true, edgeS: true });
  addPart("白橡木柜门 B", 480, 700, "vertical", oak, { edgeN: true, edgeE: true, edgeS: true });
  addPart("白橡木抽屉面", 620, 240, "horizontal", oak, { edgeN: true, edgeE: true, edgeS: true, edgeW: true });
  addPart("白橡木层板", 700, 220, "horizontal", oak);
  addPart("白橡木小垫板", 360, 180, "any", oak);

  sample.versions = [
    { id: "v1", name: "方案A：整板集中", strategy: "compact", placements: {}, lockedSheets: {} },
    { id: "v2", name: "方案B：优先余料", strategy: "remnant", placements: {}, lockedSheets: {} }
  ];
  sample.activeVersionId = "v1";
  autoPack(sample.versions[0], "compact", sample);
  autoPack(sample.versions[1], "remnant", sample);
  return sample;
}

function orientationsFor(part) {
  if (part.grain === "any") {
    return part.w === part.h
      ? [{ r: 0, w: part.w, h: part.h }]
      : [
          { r: 0, w: part.w, h: part.h },
          { r: 90, w: part.h, h: part.w }
        ];
  }
  return [{ r: 0, w: part.w, h: part.h }];
}

function placementKeysForPart(part) {
  return part.grain === "any" ? ["vertical", "horizontal", "any"] : [part.grain];
}

function autoPack(version, strategy = version.strategy, sourceState = state) {
  const previousPlacements = version.placements;
  const placements = {};
  const lockedPartIds = new Set();

  Object.entries(previousPlacements).forEach(([partId, placement]) => {
    if (version.lockedSheets[placement.sheetId]) {
      placements[partId] = { ...placement };
      lockedPartIds.add(partId);
    }
  });

  const availableSheets = sourceState.sheets
    .filter(sheet => !version.lockedSheets[sheet.id])
    .filter(sheet => isAvailableInOrder(sheet, sourceState.settings.orderNo));
  const pools = new Map(availableSheets.map(sheet => [sheet.id, {
    sheet,
    freeRects: [{ x: 0, y: 0, w: sheet.w, h: sheet.h }],
    grainKeys: new Set(),
    usedArea: 0
  }]));

  const pendingParts = sourceState.parts.filter(part => !lockedPartIds.has(part.id));
  const groups = new Map();
  pendingParts.forEach(part => {
    const key = `${part.batch}__${part.grain}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  });

  const groupOrder = Array.from(groups.entries()).sort((a, b) => {
    const grainRank = grain => grain === "any" ? 2 : 1;
    const areaSum = list => list.reduce((sum, part) => sum + part.w * part.h, 0);
    const rankDiff = grainRank(a[0].split("__")[1]) - grainRank(b[0].split("__")[1]);
    return rankDiff || areaSum(b[1]) - areaSum(a[1]);
  });

  for (const [groupKey, groupParts] of groupOrder) {
    const [batch, grain] = groupKey.split("__");
    const sortedParts = groupParts.slice().sort((a, b) => b.w * b.h - a.w * a.h);
    for (const part of sortedParts) {
      let best = null;
      const sameBatchPools = Array.from(pools.values()).filter(pool => pool.sheet.batch === batch);

      for (const orientation of orientationsFor(part)) {
        for (const pool of sameBatchPools) {
          for (const [rectIndex, rect] of pool.freeRects.entries()) {
            if (orientation.w > rect.w || orientation.h > rect.h) continue;
            let score = 0;
            const used = pool.usedArea > 0;
            score += used ? -25_000_000 : 0;
            score += pool.grainKeys.has(grain) ? -20_000_000 : 0;
            if (grain !== "any" && pool.grainKeys.size && !pool.grainKeys.has(grain)) {
              score += 8_000_000;
            }
            if (grain === "any" && Array.from(pool.grainKeys).some(key => key !== "any")) {
              score += 3_000_000;
            }
            if (strategy === "remnant") {
              score += pool.sheet.kind === "remnant" ? -60_000_000 : 0;
              score += pool.sheet.w * pool.sheet.h / 100_000_000;
            } else {
              score += pool.sheet.kind === "full" ? -45_000_000 : 10_000_000;
              score += pool.sheet.w * pool.sheet.h / 200_000_000;
            }
            score += (rect.w - orientation.w) * 10 + (rect.h - orientation.h) * 10;
            score += rect.x + rect.y;
            score += orientation.r === 90 ? 2 : 0;
            if (!best || score < best.score) {
              best = { score, pool, rectIndex, rect, orientation };
            }
          }
        }
      }

      if (!best) continue;
      const { pool, rect, orientation } = best;
      const placement = { sheetId: pool.sheet.id, x: rect.x, y: rect.y, r: orientation.r };
      placements[part.id] = placement;
      const occupied = reserveRectFor(
        { x: rect.x, y: rect.y, w: orientation.w, h: orientation.h },
        pool.sheet,
        sourceState.settings.kerf
      );
      pool.freeRects = pruneFreeRects(pool.freeRects.flatMap(freeRect => subtractRect(freeRect, occupied)));
      pool.grainKeys.add(grain);
      pool.usedArea += part.w * part.h;
    }
  }

  const nextLockedSheets = {};
  Object.keys(version.lockedSheets).forEach(sheetId => {
    if (Object.values(placements).some(placement => placement.sheetId === sheetId)) {
      nextLockedSheets[sheetId] = true;
    }
  });
  version.placements = placements;
  version.lockedSheets = nextLockedSheets;
  version.strategy = strategy;
  return placements;
}

function sheetStats(version, sheetId) {
  const sheet = getSheet(sheetId);
  if (!sheet) return null;
  const items = placementOnSheet(version, sheetId);
  const usedArea = items.reduce((sum, item) => sum + item.part.w * item.part.h, 0);
  const placedIds = new Set(items.map(item => item.part.id));
  const invalidCount = new Set();
  const warningCount = new Set();
  let overlapCount = 0;
  let outCount = 0;

  items.forEach(item => {
    const { part, rect, placement } = item;
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > sheet.w || rect.y + rect.h > sheet.h) {
      invalidCount.add(part.id);
      outCount += 1;
    }
    if (part.batch !== sheet.batch) invalidCount.add(part.id);
    if (placement.r === 90 && part.grain !== "any") invalidCount.add(part.id);
  });

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const gapInfo = distanceRects(items[i].rect, items[j].rect);
      if (gapInfo.overlap) {
        invalidCount.add(items[i].part.id);
        invalidCount.add(items[j].part.id);
        overlapCount += 1;
      } else if (gapInfo.gap > 0 && gapInfo.gap < state.settings.kerf) {
        warningCount.add(items[i].part.id);
        warningCount.add(items[j].part.id);
      }
    }
  }

  const remnants = outCount === 0 && items.length > 0
    ? disjointFreeRects(sheet, items, state.settings.kerf)
    : [];
  const remnantArea = remnants.reduce((sum, rect) => sum + rectArea(rect), 0);
  return {
    sheet,
    items,
    placedIds,
    usedArea,
    sheetArea: sheet.w * sheet.h,
    utilization: sheet.w * sheet.h ? usedArea / (sheet.w * sheet.h) : 0,
    remnants,
    remnantArea,
    invalidParts: invalidCount,
    warningParts: warningCount,
    overlapCount,
    outCount,
    locked: isSheetLocked(version, sheetId)
  };
}

function allVersionStats(version) {
  const stats = new Map();
  usedSheetIds(version).forEach(sheetId => {
    stats.set(sheetId, sheetStats(version, sheetId));
  });
  const placedIds = new Set(Object.keys(version.placements));
  const unplaced = state.parts.filter(part => !placedIds.has(part.id));
  const usedSheets = Array.from(stats.values());
  state.sheets.forEach(sheet => {
    if (!stats.has(sheet.id)) stats.set(sheet.id, sheetStats(version, sheet.id));
  });
  const usedArea = state.parts
    .filter(part => placedIds.has(part.id))
    .reduce((sum, part) => sum + part.w * part.h, 0);
  const sheetArea = usedSheets.reduce((sum, item) => sum + item.sheet.w * item.sheet.h, 0);
  const remnantArea = usedSheets.reduce((sum, item) => sum + item.remnantArea, 0);
  const errorCount = usedSheets.reduce((sum, item) =>
    sum + item.invalidParts.size, 0) + unplaced.length;
  const warningCount = usedSheets.reduce((sum, item) => sum + item.warningParts.size, 0);
  return {
    stats,
    usedSheets,
    unplaced,
    usedArea,
    sheetArea,
    remnantArea,
    utilization: sheetArea ? usedArea / sheetArea : 0,
    errorCount,
    warningCount
  };
}

function validateCurrent() {
  const version = getVersion();
  const summary = allVersionStats(version);
  const issues = [];

  summary.stats.forEach(stat => {
    stat.items.forEach(({ part, placement, rect }) => {
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > stat.sheet.w || rect.y + rect.h > stat.sheet.h) {
        issues.push({ level: "error", partId: part.id, sheetId: stat.sheet.id, message: `${part.name} 超出 ${stat.sheet.name} 边界` });
      }
      if (part.batch !== stat.sheet.batch) {
        issues.push({ level: "error", partId: part.id, sheetId: stat.sheet.id, message: `批次不一致：${part.batch} 不能放到 ${stat.sheet.batch}` });
      }
      if (placement.r === 90 && part.grain !== "any") {
        issues.push({ level: "error", partId: part.id, sheetId: stat.sheet.id, message: `${part.name} 的${grainLabel[part.grain]}不能旋转` });
      }
    });

    for (let i = 0; i < stat.items.length; i += 1) {
      for (let j = i + 1; j < stat.items.length; j += 1) {
        const a = stat.items[i];
        const b = stat.items[j];
        const gapInfo = distanceRects(a.rect, b.rect);
        if (gapInfo.overlap) {
          issues.push({ level: "error", partId: a.part.id, sheetId: stat.sheet.id, message: `${a.part.name} 与 ${b.part.name} 重叠` });
        } else if (gapInfo.gap > 0 && gapInfo.gap < state.settings.kerf) {
          issues.push({ level: "warning", partId: a.part.id, sheetId: stat.sheet.id, message: `${a.part.name} 与 ${b.part.name} 间距 ${gapInfo.gap}mm，小于锯缝 ${state.settings.kerf}mm` });
        }
      }
    }
  });

  summary.unplaced.forEach(part => {
    issues.push({ level: "error", partId: part.id, sheetId: null, message: `${part.name} 尚未排入板材` });
  });

  return { issues, summary };
}

function recommendRemnant(part) {
  const version = getVersion();
  const recommendations = [];
  state.sheets
    .filter(sheet => sheet.kind === "remnant" && sheet.batch === part.batch)
    .filter(sheet => isAvailableInOrder(sheet))
    .forEach(sheet => {
      const occupied = placementOnSheet(version, sheet.id);
      const freeRects = buildFreeRects(sheet, occupied, state.settings.kerf);
      orientationsFor(part).forEach(orientation => {
        const fitRect = freeRects.find(rect => orientation.w <= rect.w && orientation.h <= rect.h);
        if (fitRect) {
          recommendations.push({
            sheet,
            waste: sheet.w * sheet.h - part.w * part.h,
            x: fitRect.x,
            y: fitRect.y,
            r: orientation.r
          });
        }
      });
  });
  return recommendations.sort((a, b) => a.waste - b.waste)[0] || null;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function hydrateState(saved) {
  const base = createSampleState();
  state = {
    ...base,
    ...saved,
    settings: { ...base.settings, ...(saved.settings || {}) }
  };
  state.versions = saved.versions?.length ? saved.versions : base.versions;
  if (!state.versions.some(version => version.id === state.activeVersionId)) {
    state.activeVersionId = state.versions[0].id;
  }
  if (!state.strategy) state.strategy = "compact";
}

function edgeText(edge = {}) {
  const names = Object.keys(edgeLabels).filter(key => edge[key]).map(key => edgeLabels[key]);
  return names.length ? names.join("、") : "无";
}

function renderBatchList() {
  const batches = Array.from(new Set([
    ...state.parts.map(part => part.batch),
    ...state.sheets.map(sheet => sheet.batch)
  ]));
  $("#batchList").innerHTML = batches.map(batch => `<option value="${batch}"></option>`).join("");
}

function renderPartsList() {
  const version = getVersion();
  $("#partsList").innerHTML = state.parts.map(part => {
    const placement = version.placements[part.id];
    const sheet = placement ? getSheet(placement.sheetId) : null;
    const locked = placement && version.lockedSheets[placement.sheetId];
    const recommendation = !placement ? recommendRemnant(part) : null;
    return `
      <article class="record-card ${locked ? "locked" : ""}">
        <div class="record-title">
          <span>${part.name}</span>
          <span class="badge ${placement ? "" : "danger"}">${placement ? "已排" : "待排"}</span>
        </div>
        <div class="record-meta">${part.w}×${part.h}mm · ${grainLabel[part.grain]} · ${part.batch}</div>
        <div class="record-meta">封边：${edgeText(part.edge)} · ${sheet ? sheet.name : "未上板"}${locked ? " · 已锁定" : ""}</div>
        ${recommendation ? `<div class="record-meta">余料建议：${recommendation.sheet.name}</div>` : ""}
        <div class="record-actions">
          <button class="button tiny" data-action="editPart" data-id="${part.id}" type="button">编辑</button>
          <button class="button tiny" data-action="useRemnant" data-id="${part.id}" type="button" ${recommendation ? "" : "disabled"}>放入建议余料</button>
          <button class="button tiny danger" data-action="deletePart" data-id="${part.id}" type="button">删除</button>
        </div>
      </article>
    `;
  }).join("") || `<p class="muted">还没有板件，先在上方添加。</p>`;
}

function renderSheetsList() {
  const version = getVersion();
  $("#sheetsList").innerHTML = state.sheets.map(sheet => {
    const stat = sheetStats(version, sheet.id);
    const locked = Boolean(version.lockedSheets[sheet.id]);
    const used = version.placements && Object.values(version.placements).some(placement => placement.sheetId === sheet.id);
    return `
      <article class="record-card ${sheet.kind === "remnant" ? "is-remnant" : ""} ${locked ? "locked" : ""}">
        <div class="record-title">
          <span>${sheet.name}</span>
          <span class="badge ${sheet.kind === "remnant" ? "info" : ""}">${sheet.kind === "remnant" ? "余料" : "整板"}</span>
        </div>
        <div class="record-meta">${sheet.w}×${sheet.h}mm · ${sheet.batch}</div>
        <div class="record-meta">${used ? `利用率 ${(stat.utilization * 100).toFixed(1)}%` : "本方案未使用"}${locked ? " · 已锁定" : ""}</div>
        ${stat?.remnants.length ? `<div class="record-meta">余料：${stat.remnants.map(rect => `${rect.w}×${rect.h}`).join("、")}</div>` : ""}
        <div class="record-actions">
          <button class="button tiny" data-action="editSheet" data-id="${sheet.id}" type="button">编辑</button>
          <button class="button tiny danger" data-action="deleteSheet" data-id="${sheet.id}" type="button">删除</button>
        </div>
      </article>
    `;
  }).join("") || `<p class="muted">还没有板材。</p>`;
}

function renderVersionManager() {
  $("#versionManager").innerHTML = state.versions.map(version => {
    const summary = allVersionStats(version);
    return `
      <div class="version-manager-row ${version.id === state.activeVersionId ? "active" : ""}">
        <div class="line">
          <span>${version.name}</span>
          <span class="badge">${(summary.utilization * 100).toFixed(1)}%</span>
        </div>
        <div class="meta">用板 ${summary.usedSheets.length} 张 · 待排 ${summary.unplaced.length} 件 · 问题 ${summary.errorCount}</div>
        <div class="version-manager-actions">
          <button class="button tiny" data-action="switchVersion" data-id="${version.id}" type="button">查看</button>
          <button class="button tiny" data-action="rerunVersion" data-id="${version.id}" type="button">重排</button>
          <button class="button tiny" data-action="duplicateVersion" data-id="${version.id}" type="button">复制</button>
          <button class="button tiny danger" data-action="deleteVersion" data-id="${version.id}" type="button">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function edgeClasses(edge = {}) {
  return Object.keys(edgeLabels).filter(key => edge[key]).join(" ").toLowerCase();
}

function renderBoardCard(stat, validation) {
  const version = getVersion();
  const { sheet } = stat;
  const scale = Number(state.settings.scale);
  const surfaceWidth = sheet.w * scale;
  const surfaceHeight = sheet.h * scale;
  const selected = state.selection?.type === "sheet" && state.selection.sheetId === sheet.id;
  const remnantRects = state.settings.showRemnants
    ? stat.remnants.map(rect => `
      <div class="offcut-rect" style="left:${rect.x * scale}px;top:${rect.y * scale}px;width:${rect.w * scale}px;height:${rect.h * scale}px">
        <span>${rect.w}×${rect.h}</span>
      </div>
    `).join("")
    : "";

  const partsHtml = stat.items.map(item => {
    const { part, placement, rect } = item;
    const partSelected = state.selection?.type === "part" && state.selection.partId === part.id;
    const hasError = stat.invalidParts.has(part.id);
    const hasWarning = stat.warningParts.has(part.id);
    const classes = [
      "placed-part",
      `grain-${part.grain}`,
      edgeClasses(part.edge),
      hasError ? "has-error" : "",
      hasWarning ? "has-warning" : "",
      stat.locked ? "locked-part" : "",
      partSelected ? "selected" : ""
    ].filter(Boolean).join(" ");
    const grainClass = part.grain === "any"
      ? (placement.r === 90 ? "grain-horizontal" : "grain-vertical")
      : `grain-${part.grain}`;
    const labelSize = rect.w * scale < 70 || rect.h * scale < 34 ? "9px" : "10px";
    return `
      <div
        class="${classes}"
        data-part-id="${part.id}"
        data-sheet-id="${sheet.id}"
        style="left:${rect.x * scale}px;top:${rect.y * scale}px;width:${rect.w * scale}px;height:${rect.h * scale}px"
      >
        <div class="grain-mark ${grainClass}"></div>
        <div class="part-label" style="font-size:${labelSize}">
          ${part.name}<br>${part.w}×${part.h}
        </div>
      </div>
    `;
  }).join("");

  return `
    <article class="board-card ${stat.items.length ? "" : "empty-sheet"} ${selected ? "selected" : ""}">
      <header class="board-head">
        <div>
          <div class="board-title">${sheet.name} ${stat.locked ? '<span class="badge">已锁定</span>' : ""}</div>
          <div class="board-meta">${sheet.w}×${sheet.h}mm · ${sheet.batch} · ${sheet.kind === "remnant" ? "余料" : "整板"}</div>
          <div class="board-meta">利用率 ${(stat.utilization * 100).toFixed(1)}% · 已用 ${formatArea(stat.usedArea)}</div>
          <div class="board-meta">余料 ${stat.remnants.map(rect => `${rect.w}×${rect.h}`).join(" / ") || "无符合尺寸余料"}</div>
        </div>
        <div class="board-actions">
          <button class="button tiny" data-action="toggleLockSheet" data-id="${sheet.id}" type="button">${stat.locked ? "解锁" : "锁定"}</button>
          <button class="button tiny" data-action="stockRemnants" data-id="${sheet.id}" type="button" ${stat.remnants.length ? "" : "disabled"}>余料入库</button>
          <button class="button tiny" data-action="selectSheet" data-id="${sheet.id}" type="button">详情</button>
        </div>
      </header>
      <div class="board-surface-wrap">
        <div
          class="board-surface ${stat.locked ? "locked" : ""}"
          data-sheet-id="${sheet.id}"
          style="width:${surfaceWidth}px;height:${surfaceHeight}px"
        >
          ${remnantRects}
          ${partsHtml}
        </div>
      </div>
    </article>
  `;
}

function renderTray(summary) {
  const unplacedHtml = summary.unplaced.map(part => {
    const recommendation = recommendRemnant(part);
    return `
      <div class="tray-item grain-${part.grain}" data-part-id="${part.id}">
        <div class="tray-item-title">${part.name}</div>
        <div class="tray-item-meta">${part.w}×${part.h}mm</div>
        <div class="tray-item-meta">${grainLabel[part.grain]} · ${part.batch}</div>
        ${recommendation ? `<div class="tray-item-meta">建议：${recommendation.sheet.name}</div>` : `<div class="tray-item-meta">封边：${edgeText(part.edge)}</div>`}
      </div>
    `;
  }).join("");
  $("#tray").innerHTML = `
    <h2>待排板件（${summary.unplaced.length}）</h2>
    <div class="tray-items">
      ${unplacedHtml || `<p class="empty-hint">所有板件均已排入当前方案。从板件上拖回此处可撤下。</p>`}
    </div>
  `;
}

function renderBoards() {
  const validation = validateCurrent();
  const version = getVersion();
  const usedIds = usedSheetIds(version);
  const orderedSheets = state.sheets
    .filter(sheet => usedIds.includes(sheet.id) || isAvailableInOrder(sheet))
    .sort((a, b) => {
      const kindRank = sheet => sheet.kind === "remnant" ? 1 : 0;
      return a.batch.localeCompare(b.batch, "zh") ||
        kindRank(a) - kindRank(b) ||
        b.w * b.h - a.w * a.h ||
        a.name.localeCompare(b.name, "zh");
    });
  $("#boards").innerHTML = orderedSheets
    .map(sheet => renderBoardCard(validation.summary.stats.get(sheet.id), validation))
    .join("") || `<p class="empty-hint">当前方案还没有板。点击“自动排版”，或把板件拖到板材上。</p>`;
  renderTray(validation.summary);
  renderIssues(validation);
  renderSelection(validation.summary);
  renderCompare();
  renderVersionBar(validation.summary);
}

function renderVersionBar(summary) {
  const strategyLabel = getVersion().strategy === "remnant" ? "优先余料" : "整板集中";
  $("#versionBar").innerHTML = `
    ${state.versions.map(version => {
      const versionSummary = allVersionStats(version);
      return `
        <button class="version-pill ${version.id === state.activeVersionId ? "active" : ""}" data-action="switchVersion" data-id="${version.id}" type="button">
          <strong>${version.name}</strong>
          <span class="mini">${(versionSummary.utilization * 100).toFixed(1)}% · ${versionSummary.usedSheets.length}板</span>
        </button>
      `;
    }).join("")}
    <span class="badge info">当前策略：${strategyLabel}</span>
    <button class="button tiny" data-action="rerunVersion" data-id="${state.activeVersionId}" type="button">按此策略重排未锁定板</button>
  `;
}

function renderIssues(validation) {
  const { issues, summary } = validation;
  const errorCount = issues.filter(issue => issue.level === "error").length;
  const warningCount = issues.filter(issue => issue.level === "warning").length;
  $("#issueBanner").innerHTML = `
    <span class="banner-chip ${errorCount ? "bad" : "good"}">${errorCount ? `${errorCount} 个必须处理` : "几何与批次检查通过"}</span>
    <span class="banner-chip ${warningCount ? "warn" : "good"}">${warningCount ? `${warningCount} 个锯缝提示` : "锯缝间距正常"}</span>
    <span class="banner-chip">用板 ${summary.usedSheets.length} 张</span>
    <span class="banner-chip">平均利用率 ${(summary.utilization * 100).toFixed(1)}%</span>
    <span class="banner-chip">可留余料 ${formatArea(summary.remnantArea)}</span>
  `;
  $("#issueList").innerHTML = issues.map(issue => `
    <div class="issue-item ${issue.level}">
      <span class="issue-title">${issue.level === "error" ? "错误" : "提示"}</span>
      <span>${issue.message}</span>
    </div>
  `).join("") || `<p class="muted">当前没有发现超界、重叠、纹路或批次问题。</p>`;
}

function renderPartInspector(partId, summary) {
  const version = getVersion();
  const part = getPart(partId);
  if (!part) return `<p class="muted">板件已不存在。</p>`;
  const placement = version.placements[partId];
  const sheet = placement ? getSheet(placement.sheetId) : null;
  const locked = placement && version.lockedSheets[placement.sheetId];
  const recommendation = !placement ? recommendRemnant(part) : null;
  const issues = validateCurrent().issues.filter(issue => issue.partId === partId);
  return `
    <dl class="kv-list">
      <dt>名称</dt><dd>${part.name}</dd>
      <dt>尺寸</dt><dd>${part.w}×${part.h}mm</dd>
      <dt>纹路</dt><dd>${grainLabel[part.grain]}</dd>
      <dt>批次</dt><dd>${part.batch}</dd>
      <dt>封边</dt><dd>${edgeText(part.edge)}</dd>
      <dt>位置</dt><dd>${sheet ? `${sheet.name} / X${placement.x} Y${placement.y}${placement.r ? ` / 旋转${placement.r}°` : ""}` : "待排"}</dd>
    </dl>
    ${issues.length ? `<div class="record-meta" style="color:var(--danger);margin-top:8px">${issues.map(issue => issue.message).join("；")}</div>` : ""}
    ${recommendation ? `<div class="record-meta" style="color:var(--info);margin-top:8px">优先余料：${recommendation.sheet.name}</div>` : ""}
    <div class="inspector-actions">
      <button class="button" data-action="editPart" data-id="${part.id}" type="button">编辑尺寸/纹路/批次</button>
      ${recommendation ? `<button class="button" data-action="useRemnant" data-id="${part.id}" type="button">放入建议余料</button>` : ""}
      ${placement && canRotate(part) && !locked ? `<button class="button" data-action="rotatePart" data-id="${part.id}" type="button">旋转 90°</button>` : ""}
      ${placement ? `<button class="button" data-action="removePlacement" data-id="${part.id}" type="button" ${locked ? "disabled" : ""}>撤到待排区</button>` : ""}
    </div>
  `;
}

function renderSheetInspector(sheetId) {
  const version = getVersion();
  const stat = sheetStats(version, sheetId);
  if (!stat) return `<p class="muted">板材已不存在。</p>`;
  return `
    <dl class="kv-list">
      <dt>名称</dt><dd>${stat.sheet.name}</dd>
      <dt>尺寸</dt><dd>${stat.sheet.w}×${stat.sheet.h}mm</dd>
      <dt>批次</dt><dd>${stat.sheet.batch}</dd>
      <dt>类型</dt><dd>${stat.sheet.kind === "remnant" ? "余料" : "整板"}</dd>
      <dt>利用率</dt><dd>${(stat.utilization * 100).toFixed(1)}%</dd>
      <dt>已用面积</dt><dd>${formatArea(stat.usedArea)}</dd>
      <dt>余料</dt><dd>${stat.remnants.map(rect => `${rect.w}×${rect.h}mm / ${formatArea(rectArea(rect))}`).join("<br>") || "无"}</dd>
      <dt>状态</dt><dd>${stat.locked ? "已锁定，后续重排不会移动" : "未锁定，可参与重排"}</dd>
    </dl>
    <div class="inspector-actions">
      <button class="button primary" data-action="toggleLockSheet" data-id="${sheetId}" type="button">${stat.locked ? "解锁这张板" : "锁定这张板"}</button>
      <button class="button" data-action="stockRemnants" data-id="${sheetId}" type="button" ${stat.remnants.length ? "" : "disabled"}>将余料入库</button>
      <button class="button" data-action="editSheet" data-id="${sheetId}" type="button">编辑板材</button>
    </div>
  `;
}

function renderSelection(summary) {
  const selection = state.selection;
  if (!selection) {
    $("#selectionPanel").innerHTML = `<p class="muted">点击或拖拽板件、点击“详情”查看一张板。</p>`;
    return;
  }
  if (selection.type === "part") {
    $("#selectionPanel").innerHTML = renderPartInspector(selection.partId, summary);
  } else if (selection.type === "sheet") {
    $("#selectionPanel").innerHTML = renderSheetInspector(selection.sheetId);
  }
}

function renderCompare() {
  if (state.versions.length < 2) {
    $("#comparePanel").innerHTML = `<p class="muted">复制或保留两个方案后，可同时比较用料和余料。</p>`;
    return;
  }
  const [a, b] = state.versions.slice(0, 2).map(version => ({ version, summary: allVersionStats(version) }));
  const bestUsed = a.summary.sheetArea <= b.summary.sheetArea ? "a" : "b";
  const bestRemnant = a.summary.remnantArea >= b.summary.remnantArea ? "a" : "b";
  const card = (item, key, label) => `
    <div class="compare-card ${bestUsed === key || bestRemnant === key ? "best" : ""}">
      <h3>${item.version.name}</h3>
      <div class="compare-line"><span>${label}用板</span><b>${item.summary.usedSheets.length} 张</b></div>
      <div class="compare-line"><span>板材面积</span><b>${formatArea(item.summary.sheetArea)}</b></div>
      <div class="compare-line"><span>平均利用率</span><b>${(item.summary.utilization * 100).toFixed(1)}%</b></div>
      <div class="compare-line"><span>可留余料</span><b>${formatArea(item.summary.remnantArea)}</b></div>
      <div class="compare-line"><span>待排/问题</span><b>${item.summary.unplaced.length} / ${item.summary.errorCount}</b></div>
      <div class="record-meta">省料：${bestUsed === key ? "更优" : ""} 余料：${bestRemnant === key ? "更整" : ""}</div>
    </div>
  `;
  $("#comparePanel").innerHTML = `
    <p class="muted">“省料”比较占用板材面积；“余料更整”比较可入库余料面积。</p>
    <div class="compare-row">${card(a, "a", "A")}${card(b, "b", "B")}</div>
  `;
}

function syncSettingsForm() {
  $("#orderNoInput").value = state.settings.orderNo;
  $("#kerfInput").value = state.settings.kerf;
  $("#snapInput").value = state.settings.snap;
  $("#remnantWInput").value = state.settings.minRemW;
  $("#remnantHInput").value = state.settings.minRemH;
  $("#showRemnantsInput").checked = state.settings.showRemnants;
  $("#scaleInput").value = state.settings.scale;
}

function resetPartForm() {
  const form = $("#partForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.qty.value = "1";
  form.elements.grain.value = "vertical";
  $("#partSubmitBtn").textContent = "添加板件";
}

function resetSheetForm() {
  const form = $("#sheetForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.w.value = 2440;
  form.elements.h.value = 1220;
  form.elements.kind.value = "full";
  $("#sheetSubmitBtn").textContent = "添加板材";
}

function fillPartForm(part) {
  const form = $("#partForm");
  form.elements.id.value = part.id;
  form.elements.name.value = part.name;
  form.elements.w.value = part.w;
  form.elements.h.value = part.h;
  form.elements.qty.value = 1;
  form.elements.grain.value = part.grain;
  form.elements.batch.value = part.batch;
  form.elements.edgeN.checked = Boolean(part.edge?.edgeN);
  form.elements.edgeE.checked = Boolean(part.edge?.edgeE);
  form.elements.edgeS.checked = Boolean(part.edge?.edgeS);
  form.elements.edgeW.checked = Boolean(part.edge?.edgeW);
  $("#partSubmitBtn").textContent = "保存板件并重算";
  $$(".tab[data-tab='parts']").forEach(tab => tab.click());
}

function fillSheetForm(sheet) {
  const form = $("#sheetForm");
  form.elements.id.value = sheet.id;
  form.elements.name.value = sheet.name;
  form.elements.w.value = sheet.w;
  form.elements.h.value = sheet.h;
  form.elements.batch.value = sheet.batch;
  form.elements.kind.value = sheet.kind;
  $("#sheetSubmitBtn").textContent = "保存板材并重算";
  $$(".tab[data-tab='sheets']").forEach(tab => tab.click());
}

function repackAllUnlocked() {
  state.versions.forEach(version => autoPack(version, version.strategy, state));
}

function renderAll() {
  renderBatchList();
  renderPartsList();
  renderSheetsList();
  renderVersionManager();
  syncSettingsForm();
  renderBoards();
  saveState();
}

function toast(message, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function uniqueBatchName(base, excludeId = null) {
  let name = base;
  let index = 2;
  while (state.sheets.some(sheet => sheet.name === name && sheet.id !== excludeId)) {
    name = `${base} ${index}`;
    index += 1;
  }
  return name;
}

function stockRemnants(sheetId) {
  const version = getVersion();
  const stat = sheetStats(version, sheetId);
  if (!stat?.remnants.length) return;
  const added = [];
  stat.remnants.forEach((rect, index) => {
    const exists = state.sheets.some(sheet =>
      sheet.kind === "remnant" &&
      sheet.originVersionId === version.id &&
      sheet.originSheetId === sheetId &&
      sheet.originIndex === index
    );
    if (exists) return;
    const id = uid("s");
    state.sheets.push({
      id,
      name: uniqueBatchName(`${stat.sheet.batch}余料 ${rect.w}×${rect.h}`),
      w: rect.w,
      h: rect.h,
      batch: stat.sheet.batch,
      kind: "remnant",
      originOrderNo: state.settings.orderNo,
      originVersionId: version.id,
      originSheetId: sheetId,
      originIndex: index
    });
    added.push(id);
  });
  toast(added.length ? `已入库 ${added.length} 块余料，可用于后续订单` : "这些余料已在库中", "success");
}

const drag = {
  active: false,
  moved: false,
  partId: null,
  sourceSheetId: null,
  startX: 0,
  startY: 0,
  ghost: null,
  dropTarget: null
};

function createDragGhost(part) {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost tray-item";
  ghost.innerHTML = `
    <div class="tray-item-title">${part.name}</div>
    <div class="tray-item-meta">${part.w}×${part.h}mm · ${grainLabel[part.grain]}</div>
    <div class="tray-item-meta">${part.batch}</div>
  `;
  ghost.style.width = "140px";
  document.body.appendChild(ghost);
  return ghost;
}

function clearDropTarget() {
  $$(".drop-valid,.drop-invalid").forEach(el => el.classList.remove("drop-valid", "drop-invalid"));
  drag.dropTarget = null;
}

function updateDropTarget(event) {
  drag.ghost.hidden = true;
  const under = document.elementFromPoint(event.clientX, event.clientY);
  drag.ghost.hidden = false;
  clearDropTarget();
  if (!under) return;

  const tray = under.closest("#tray");
  const surface = under.closest(".board-surface");
  const part = getPart(drag.partId);

  if (tray) {
    drag.dropTarget = { type: "tray", el: tray };
    tray.classList.add("drop-valid");
    return;
  }
  if (surface) {
    const sheet = getSheet(surface.dataset.sheetId);
    const version = getVersion();
    const locked = Boolean(version.lockedSheets[sheet.id]);
    const batchMismatch = sheet.batch !== part.batch;
    const invalid = locked || batchMismatch;
    drag.dropTarget = { type: "sheet", el: surface, sheetId: sheet.id, invalid };
    surface.classList.add(invalid ? "drop-invalid" : "drop-valid");
  }
}

function snapValue(value) {
  const snap = Math.max(1, Number(state.settings.snap) || 1);
  return Math.round(value / snap) * snap;
}

function finishDrag(event) {
  if (!drag.active) return;
  const partId = drag.partId;
  const part = getPart(partId);
  const version = getVersion();
  const oldPlacement = version.placements[partId] ? { ...version.placements[partId] } : null;

  if (drag.moved) updateDropTarget(event);

  if (drag.moved && drag.dropTarget?.type === "tray") {
    if (drag.sourceSheetId && version.lockedSheets[drag.sourceSheetId]) {
      toast("已锁定板上的板件不能撤下", "error");
    } else {
      delete version.placements[partId];
      state.selection = { type: "part", partId };
      toast("已撤到待排区");
    }
  } else if (drag.moved && drag.dropTarget?.type === "sheet") {
    const target = drag.dropTarget;
    if (drag.sourceSheetId && version.lockedSheets[drag.sourceSheetId]) {
      toast("板件在已锁定板上，不能移动", "error");
      drag.ghost?.remove();
      clearDropTarget();
      Object.assign(drag, { active: false, moved: false, partId: null, sourceSheetId: null, ghost: null });
      renderAll();
      return;
    }
    if (target.invalid) {
      const sheet = getSheet(target.sheetId);
      if (version.lockedSheets[target.sheetId]) toast(`${sheet.name} 已锁定`, "error");
      if (sheet.batch !== part.batch) toast("颜色批次不同，不能混用", "error");
    } else {
      const sheet = getSheet(target.sheetId);
      const rect = target.el.getBoundingClientRect();
      const scale = Number(state.settings.scale);
      const placed = placementRect(part, oldPlacement || { r: 0 });
      const x = snapValue((event.clientX - rect.left) / scale - placed.w / 2);
      const y = snapValue((event.clientY - rect.top) / scale - placed.h / 2);
      version.placements[partId] = {
        sheetId: target.sheetId,
        x,
        y,
        r: oldPlacement?.r || 0
      };
      state.selection = { type: "part", partId };
      if (x < 0 || y < 0 || x + placed.w > sheet.w || y + placed.h > sheet.h) {
        toast("已摆放，但该板件超出板材边界", "error");
      } else {
        toast("已移动，排布和统计已重算", "success");
      }
    }
  } else {
    state.selection = { type: "part", partId };
  }

  document.body.classList.remove("dragging");
  drag.ghost?.remove();
  clearDropTarget();
  Object.assign(drag, { active: false, moved: false, partId: null, sourceSheetId: null, ghost: null });
  renderAll();
}

document.addEventListener("pointerdown", event => {
  const dragEl = event.target.closest("[data-part-id]");
  if (!dragEl) return;
  const partId = dragEl.dataset.partId;
  const part = getPart(partId);
  if (!part) return;
  const sourceSheetId = dragEl.closest(".board-surface")?.dataset.sheetId || null;
  const version = getVersion();

  drag.active = true;
  drag.moved = false;
  drag.partId = partId;
  drag.sourceSheetId = sourceSheetId;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.ghost = createDragGhost(part);
  drag.ghost.style.left = `${event.clientX}px`;
  drag.ghost.style.top = `${event.clientY}px`;

  if (sourceSheetId && version.lockedSheets[sourceSheetId]) {
    state.selection = { type: "part", partId };
  }
});

document.addEventListener("pointermove", event => {
  if (!drag.active) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.moved && distance < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    document.body.classList.add("dragging");
  }
  event.preventDefault();
  drag.ghost.style.left = `${event.clientX}px`;
  drag.ghost.style.top = `${event.clientY}px`;
  updateDropTarget(event);
});

document.addEventListener("pointerup", finishDrag);
document.addEventListener("pointercancel", finishDrag);

function rotatePart(partId) {
  const part = getPart(partId);
  const version = getVersion();
  const placement = version.placements[partId];
  if (!part || !placement || !canRotate(part) || version.lockedSheets[placement.sheetId]) return;
  placement.r = placement.r === 90 ? 0 : 90;
  toast("已旋转，纹路不限方向", "success");
}

function placeInRecommendedRemnant(partId) {
  const part = getPart(partId);
  const recommendation = part && recommendRemnant(part);
  const version = getVersion();
  if (!recommendation) {
    toast("当前没有匹配批次且放得下的余料", "error");
    return;
  }
  const current = version.placements[partId];
  if (current && version.lockedSheets[current.sheetId]) {
    toast("板件在已锁定板上，不能移动", "error");
    return;
  }
  version.placements[partId] = {
    sheetId: recommendation.sheet.id,
    x: recommendation.x,
    y: recommendation.y,
    r: recommendation.r
  };
  state.selection = { type: "part", partId };
  toast(`已放入余料：${recommendation.sheet.name}`, "success");
}

function toggleLockSheet(sheetId) {
  const version = getVersion();
  const hasParts = Object.values(version.placements).some(placement => placement.sheetId === sheetId);
  if (!hasParts && !version.lockedSheets[sheetId]) {
    toast("空板无需锁定", "error");
    return;
  }
  if (version.lockedSheets[sheetId]) delete version.lockedSheets[sheetId];
  else version.lockedSheets[sheetId] = true;
  state.selection = { type: "sheet", sheetId };
  toast(version.lockedSheets[sheetId] ? "已锁定，后续重排不会移动这张板" : "已解锁，可参与重排");
}

function deletePart(partId) {
  const part = getPart(partId);
  if (!part || !window.confirm(`确认删除板件“${part.name}”？所有方案中的排布会同步移除。`)) return;
  state.parts = state.parts.filter(item => item.id !== partId);
  state.versions.forEach(version => delete version.placements[partId]);
  state.selection = null;
  repackAllUnlocked();
  toast("板件已删除，方案已重算");
}

function deleteSheet(sheetId) {
  const sheet = getSheet(sheetId);
  if (!sheet || !window.confirm(`确认删除板材“${sheet.name}”？放不下的板件会回到待排区。`)) return;
  state.sheets = state.sheets.filter(item => item.id !== sheetId);
  state.versions.forEach(version => {
    Object.entries(version.placements).forEach(([partId, placement]) => {
      if (placement.sheetId === sheetId) delete version.placements[partId];
    });
    delete version.lockedSheets[sheetId];
  });
  state.selection = null;
  repackAllUnlocked();
  toast("板材已删除，方案已重算");
}

function switchVersion(versionId) {
  if (!state.versions.some(version => version.id === versionId)) return;
  state.activeVersionId = versionId;
  state.selection = null;
}

function duplicateVersion(versionId) {
  const source = state.versions.find(version => version.id === versionId);
  if (!source) return;
  const id = uid("v");
  state.versions.push({
    id,
    name: `${source.name} 副本`,
    strategy: source.strategy,
    placements: JSON.parse(JSON.stringify(source.placements)),
    lockedSheets: { ...source.lockedSheets }
  });
  state.activeVersionId = id;
  toast("已复制一版，可单独拖拽调整后对比", "success");
}

function deleteVersion(versionId) {
  if (state.versions.length <= 1) {
    toast("至少保留一个方案", "error");
    return;
  }
  const version = state.versions.find(item => item.id === versionId);
  if (!version || !window.confirm(`确认删除方案“${version.name}”？`)) return;
  state.versions = state.versions.filter(item => item.id !== versionId);
  if (state.activeVersionId === versionId) state.activeVersionId = state.versions[0].id;
  state.selection = null;
}

function exportCsv() {
  const header = ["方案", "订单号", "板件", "宽", "高", "纹路", "颜色批次", "封边", "板材", "板材类型", "X", "Y", "旋转", "实际宽", "实际高", "锁定"];
  const rows = [header];
  state.versions.forEach(version => {
    state.parts.forEach(part => {
      const placement = version.placements[part.id];
      const sheet = placement ? getSheet(placement.sheetId) : null;
      const rect = placement && sheet ? placementRect(part, placement) : null;
      rows.push([
        version.name,
        state.settings.orderNo,
        part.name,
        part.w,
        part.h,
        grainLabel[part.grain],
        part.batch,
        edgeText(part.edge),
        sheet?.name || "未排",
        sheet ? (sheet.kind === "remnant" ? "余料" : "整板") : "",
        placement?.x ?? "",
        placement?.y ?? "",
        placement?.r ?? "",
        rect?.w ?? "",
        rect?.h ?? "",
        placement && version.lockedSheets[placement.sheetId] ? "是" : "否"
      ]);
    });
  });
  const csv = "\ufeff" + rows.map(row => row.map(value => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.settings.orderNo || "开料单"}-开料单.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("已导出 CSV 开料单", "success");
}

function readEdgeData(form) {
  return {
    edgeN: form.elements.edgeN.checked,
    edgeE: form.elements.edgeE.checked,
    edgeS: form.elements.edgeS.checked,
    edgeW: form.elements.edgeW.checked
  };
}

function handlePartSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const qty = Math.max(1, parseInt(form.elements.qty.value, 10) || 1);
  const basePart = {
    name: form.elements.name.value.trim(),
    w: Math.round(Number(form.elements.w.value)),
    h: Math.round(Number(form.elements.h.value)),
    grain: form.elements.grain.value,
    batch: form.elements.batch.value.trim(),
    edge: readEdgeData(form)
  };
  if (!basePart.name || !basePart.batch || basePart.w < 1 || basePart.h < 1) {
    toast("请填写有效的板件信息", "error");
    return;
  }

  if (id) {
    const old = getPart(id);
    if (!old) return;
    Object.assign(old, basePart);
    state.versions.forEach(version => {
      const placement = version.placements[id];
    });
    repackAllUnlocked();
    toast("板件已修改，未锁定排布已重算", "success");
  } else {
    Array.from({ length: qty }, (_, index) => {
      const partId = uid("p");
      state.parts.push({
        id: partId,
        name: qty > 1 ? `${basePart.name} ${index + 1}` : basePart.name,
        ...basePart
      });
    });
    repackAllUnlocked();
    toast(`已添加 ${qty} 个板件并重算`, "success");
  }
  resetPartForm();
  renderAll();
}

function handleSheetSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const data = {
    name: form.elements.name.value.trim(),
    w: Math.round(Number(form.elements.w.value)),
    h: Math.round(Number(form.elements.h.value)),
    batch: form.elements.batch.value.trim(),
    kind: form.elements.kind.value
  };
  if (!data.name || !data.batch || data.w < 1 || data.h < 1) {
    toast("请填写有效的板材信息", "error");
    return;
  }

  if (id) {
    const old = getSheet(id);
    if (!old) return;
    Object.assign(old, data);
    repackAllUnlocked();
    toast("板材已修改，未锁定排布已重算", "success");
  } else {
    state.sheets.push({ id: uid("s"), ...data, originVersionId: null });
    repackAllUnlocked();
    toast("板材已添加，方案已重算", "success");
  }
  resetSheetForm();
  renderAll();
}

function bindEvents() {
  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach(item => item.classList.toggle("active", item === tab));
      $$(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab);
      });
    });
  });

  $("#partForm").addEventListener("submit", handlePartSubmit);
  $("#sheetForm").addEventListener("submit", handleSheetSubmit);

  document.addEventListener("click", event => {
    const actionEl = event.target.closest("[data-action]");
    if (actionEl) {
      const { action, id } = actionEl.dataset;
      const actionMap = {
        editPart: () => fillPartForm(getPart(id)),
        deletePart: () => deletePart(id),
        useRemnant: () => { placeInRecommendedRemnant(id); renderAll(); },
        rotatePart: () => { rotatePart(id); renderAll(); },
        removePlacement: () => {
          const version = getVersion();
          const placement = version.placements[id];
          if (placement && !version.lockedSheets[placement.sheetId]) {
            delete version.placements[id];
            state.selection = { type: "part", partId: id };
            renderAll();
          }
        },
        editSheet: () => fillSheetForm(getSheet(id)),
        deleteSheet: () => deleteSheet(id),
        selectSheet: () => {
          state.selection = { type: "sheet", sheetId: id };
          renderAll();
        },
        toggleLockSheet: () => { toggleLockSheet(id); renderAll(); },
        stockRemnants: () => { stockRemnants(id); renderAll(); },
        switchVersion: () => { switchVersion(id); renderAll(); },
        rerunVersion: () => {
          const version = state.versions.find(item => item.id === id) || getVersion();
          switchVersion(version.id);
          autoPack(version, version.strategy, state);
          toast("未锁定板件已按该方案策略重排", "success");
          renderAll();
        },
        duplicateVersion: () => { duplicateVersion(id); renderAll(); },
        deleteVersion: () => { deleteVersion(id); renderAll(); },
        cancelPartEdit: resetPartForm,
        cancelSheetEdit: resetSheetForm
      };
      if (actionMap[action]) actionMap[action]();
      return;
    }

    const partEl = event.target.closest(".placed-part, .tray-item");
    if (partEl && !drag.active) {
      state.selection = { type: "part", partId: partEl.dataset.partId };
      renderSelection(validateCurrent().summary);
    }
  });

  $("#autoLayoutBtn").addEventListener("click", () => {
    const version = getVersion();
    autoPack(version, version.strategy, state);
    toast(`已按“${version.strategy === "remnant" ? "优先余料" : "整板集中"}”重排未锁定板件`, "success");
    renderAll();
  });
  $("#exportBtn").addEventListener("click", exportCsv);
  $("#resetBtn").addEventListener("click", () => {
    if (!window.confirm("确认重置为内置样例数据？当前浏览器中的修改会被覆盖。")) return;
    state = createSampleState();
    resetPartForm();
    resetSheetForm();
    renderAll();
    toast("已恢复样例", "success");
  });
  $("#clearBtn").addEventListener("click", () => {
    if (!window.confirm("确认清空全部板件、板材和方案？")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = createSampleState();
    state.parts = [];
    state.sheets = [];
    state.versions = [{ id: "v-empty", name: "方案A", strategy: "compact", placements: {}, lockedSheets: {} }];
    state.activeVersionId = "v-empty";
    state.selection = null;
    renderAll();
  });

  const settingsBindings = [
    ["orderNoInput", "orderNo", "string"],
    ["kerfInput", "kerf", "number"],
    ["snapInput", "snap", "number"],
    ["remnantWInput", "minRemW", "number"],
    ["remnantHInput", "minRemH", "number"]
  ];
  settingsBindings.forEach(([elementId, key]) => {
    $("#" + elementId).addEventListener("change", event => {
      state.settings[key] = Number(event.target.value);
      renderAll();
    });
  });
  $("#showRemnantsInput").addEventListener("change", event => {
    state.settings.showRemnants = event.target.checked;
    renderBoards();
    saveState();
  });
  $("#scaleInput").addEventListener("input", event => {
    state.settings.scale = Number(event.target.value);
    renderBoards();
    saveState();
  });
}

function init() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      hydrateState(JSON.parse(saved));
    } catch (error) {
      console.warn("无法读取本地排版数据，已恢复样例", error);
      state = createSampleState();
    }
  } else {
    state = createSampleState();
  }
  bindEvents();
  renderAll();
}

init();
