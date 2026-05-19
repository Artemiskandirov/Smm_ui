// ============================================================
// AdFlow AI — Figma Plugin Main Thread
// Analyze: parse frame → screenshot → send to backend
// Generate: take semantic map → build variations in N ratios
// ============================================================

/// <reference types="@figma/plugin-typings" />

// ---------- Types ----------

type LayoutNode = {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  opacity: number;
  rotation: number;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: string;
  color?: string;
  fills?: Array<{ type: string; color?: string }>;
  cornerRadius?: number;
  children: LayoutNode[];
};

type SemanticRole =
  | 'headline' | 'subtitle' | 'body' | 'cta' | 'logo'
  | 'hero_image' | 'product' | 'decorative' | 'background' | 'icon' | 'unknown';

type SemanticEntry = { node_id: string; role: SemanticRole; importance: number };

type RatioPreset = {
  id: string;
  name: string;
  width: number;
  height: number;
  safeZone: { top: number; right: number; bottom: number; left: number };
  template: 'centered_hero' | 'story_stack' | 'split_editorial';
};

// ---------- Ratio presets ----------

const RATIO_PRESETS: RatioPreset[] = [
  {
    id: 'ig_post_1x1', name: 'Instagram Post', width: 1080, height: 1080,
    safeZone: { top: 64, right: 64, bottom: 64, left: 64 },
    template: 'centered_hero',
  },
  {
    id: 'ig_story_9x16', name: 'Story / Reels', width: 1080, height: 1920,
    safeZone: { top: 250, right: 64, bottom: 320, left: 64 },
    template: 'story_stack',
  },
  {
    id: 'fb_feed_191x1', name: 'Facebook Feed', width: 1200, height: 628,
    safeZone: { top: 32, right: 48, bottom: 32, left: 48 },
    template: 'split_editorial',
  },
  {
    id: 'yt_thumb_16x9', name: 'YouTube Thumb', width: 1280, height: 720,
    safeZone: { top: 32, right: 48, bottom: 32, left: 48 },
    template: 'split_editorial',
  },
];

// ---------- State ----------

let lastAnalyze: {
  masterFrameId: string;
  byRole: Record<SemanticRole, SemanticEntry[]>;
} | null = null;

// ---------- Boot ----------

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });

function sendSelection() {
  const sel = figma.currentPage.selection;
  const first = sel[0];
  const isFrame = first && (first.type === 'FRAME' || first.type === 'COMPONENT' || first.type === 'INSTANCE');
  figma.ui.postMessage({
    type: 'selection',
    hasFrame: !!isFrame,
    frameName: isFrame ? first.name : null,
    frameWidth: isFrame ? Math.round(first.width) : null,
    frameHeight: isFrame ? Math.round(first.height) : null,
  });
}
sendSelection();
figma.on('selectionchange', sendSelection);

figma.ui.postMessage({ type: 'ratios', presets: RATIO_PRESETS });

// ---------- Message router ----------

figma.ui.onmessage = async (msg: { type: string;[key: string]: any }) => {
  try {
    if (msg.type === 'analyze') {
      await handleAnalyze();
    } else if (msg.type === 'cache-semantic') {
      cacheSemantic(msg.masterFrameId, msg.layers);
    } else if (msg.type === 'apply-all-names') {
      await handleApplyAllNames(msg.renames);
    } else if (msg.type === 'focus-node') {
      await handleFocusNode(msg.nodeId);
    } else if (msg.type === 'generate') {
      await handleGenerate(msg.ratioIds);
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (err: any) {
    console.error(err);
    figma.ui.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};

// ---------- Frame parser ----------

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const to255 = (v: number) => Math.round(v * 255);
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + h(to255(c.r)) + h(to255(c.g)) + h(to255(c.b));
}

function parseNode(node: SceneNode): LayoutNode | null {
  if (!node.visible) return null;
  const base: LayoutNode = {
    id: node.id, name: node.name, type: node.type,
    x: Math.round(node.x), y: Math.round(node.y),
    width: Math.round(node.width), height: Math.round(node.height),
    visible: node.visible,
    opacity: 'opacity' in node ? (node as any).opacity : 1,
    rotation: 'rotation' in node ? Math.round((node as any).rotation) : 0,
    children: [],
  };
  if (node.type === 'TEXT') {
    const t = node as TextNode;
    base.text = t.characters;
    if (typeof t.fontSize === 'number') base.fontSize = t.fontSize;
    base.textAlign = t.textAlignHorizontal;
    if (Array.isArray(t.fills) && t.fills.length > 0 && t.fills[0].type === 'SOLID') {
      base.color = rgbToHex((t.fills[0] as SolidPaint).color);
    }
  }
  if ('fills' in node && Array.isArray((node as any).fills)) {
    const fills = (node as any).fills as Paint[];
    base.fills = fills.slice(0, 3).map(f => ({
      type: f.type,
      color: f.type === 'SOLID' ? rgbToHex((f as SolidPaint).color) : undefined,
    }));
  }
  if ('cornerRadius' in node && typeof (node as any).cornerRadius === 'number') {
    base.cornerRadius = (node as any).cornerRadius;
  }
  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) {
      const parsed = parseNode(child);
      if (parsed) base.children.push(parsed);
    }
  }
  return base;
}

function countNodes(n: LayoutNode): number {
  return 1 + n.children.reduce((acc, c) => acc + countNodes(c), 0);
}

// ---------- Analyze flow ----------

async function handleAnalyze() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Выделите frame для анализа.' });
    return;
  }
  const target = sel[0];
  if (target.type !== 'FRAME' && target.type !== 'COMPONENT' && target.type !== 'INSTANCE') {
    figma.ui.postMessage({ type: 'error', message: 'Выделите Frame, Component или Instance.' });
    return;
  }

  figma.ui.postMessage({ type: 'progress', stage: 'parsing', message: 'Разбираю слои…' });
  const layoutJson = parseNode(target as SceneNode);
  if (!layoutJson) {
    figma.ui.postMessage({ type: 'error', message: 'Не удалось разобрать frame.' });
    return;
  }
  const total = countNodes(layoutJson);
  if (total > 300) {
    figma.ui.postMessage({ type: 'error', message: `Слишком много слоёв: ${total}. Лимит 300.` });
    return;
  }

  figma.ui.postMessage({ type: 'progress', stage: 'screenshot', message: 'Делаю скриншот…' });
  const bytes = await (target as FrameNode).exportAsync({
    format: 'PNG', constraint: { type: 'SCALE', value: 1 },
  });
  const base64 = figma.base64Encode(bytes);

  figma.ui.postMessage({ type: 'progress', stage: 'sending', message: 'GPT-5.5 анализирует…' });
  figma.ui.postMessage({
    type: 'analyze-payload',
    masterFrameId: target.id,
    layoutJson,
    screenshotBase64: base64,
    frameWidth: Math.round(target.width),
    frameHeight: Math.round(target.height),
  });
}

function cacheSemantic(masterFrameId: string, layers: SemanticEntry[]) {
  const byRole: Record<SemanticRole, SemanticEntry[]> = {
    headline: [], subtitle: [], body: [], cta: [], logo: [],
    hero_image: [], product: [], decorative: [], background: [], icon: [], unknown: [],
  };
  for (const l of layers) {
    if (byRole[l.role]) byRole[l.role].push(l);
  }
  for (const k of Object.keys(byRole) as SemanticRole[]) {
    byRole[k].sort((a, b) => b.importance - a.importance);
  }
  lastAnalyze = { masterFrameId, byRole };
}

async function handleApplyAllNames(renames: Array<{ nodeId: string; newName: string }>) {
  let count = 0;
  for (const r of renames) {
    const node = await figma.getNodeByIdAsync(r.nodeId);
    if (node && 'name' in node) {
      (node as BaseNode & { name: string }).name = r.newName;
      count++;
    }
  }
  figma.notify(`✓ Переименовано слоёв: ${count}`);
  figma.ui.postMessage({ type: 'all-names-applied', count });
}

async function handleFocusNode(nodeId: string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
    figma.currentPage.selection = [node as SceneNode];
    figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  }
}

// ============================================================
// GENERATION
// ============================================================

async function handleGenerate(ratioIds: string[]) {
  if (!lastAnalyze) {
    figma.ui.postMessage({ type: 'error', message: 'Сначала запусти Analyze.' });
    return;
  }
  const master = await figma.getNodeByIdAsync(lastAnalyze.masterFrameId);
  if (!master || (master.type !== 'FRAME' && master.type !== 'COMPONENT' && master.type !== 'INSTANCE')) {
    figma.ui.postMessage({ type: 'error', message: 'Master frame не найден.' });
    return;
  }
  const masterFrame = master as FrameNode;
  const ratios = RATIO_PRESETS.filter(r => ratioIds.includes(r.id));
  if (ratios.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Выбери хотя бы один формат.' });
    return;
  }

  figma.ui.postMessage({
    type: 'progress', stage: 'generating',
    message: `Генерирую ${ratios.length} вариаций…`,
  });

  await loadAllFontsIn(masterFrame);
  const roleNodes = await resolveRoleNodes();

  let cursorY = masterFrame.y;
  const startX = masterFrame.x + masterFrame.width + 200;
  const createdIds: string[] = [];

  for (const ratio of ratios) {
    const created = await generateOneVariation(masterFrame, ratio, roleNodes, startX, cursorY);
    if (created) {
      createdIds.push(created.id);
      cursorY += ratio.height + 80;
    }
  }

  if (createdIds.length > 0) {
    const nodes = await Promise.all(createdIds.map(id => figma.getNodeByIdAsync(id)));
    const scene = nodes.filter(n => n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') as SceneNode[];
    figma.currentPage.selection = scene;
    figma.viewport.scrollAndZoomIntoView(scene);
    figma.notify(`✓ Создано вариаций: ${createdIds.length}`);
  }

  figma.ui.postMessage({ type: 'generate-done', count: createdIds.length });
}

async function resolveRoleNodes(): Promise<Partial<Record<SemanticRole, SceneNode[]>>> {
  const result: Partial<Record<SemanticRole, SceneNode[]>> = {};
  if (!lastAnalyze) return result;
  for (const role of Object.keys(lastAnalyze.byRole) as SemanticRole[]) {
    const entries = lastAnalyze.byRole[role];
    const nodes: SceneNode[] = [];
    for (const entry of entries) {
      const n = await figma.getNodeByIdAsync(entry.node_id);
      if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') {
        nodes.push(n as SceneNode);
      }
    }
    result[role] = nodes;
  }
  return result;
}

async function loadAllFontsIn(node: SceneNode): Promise<void> {
  const fonts = new Set<string>();
  function walk(n: SceneNode) {
    if (n.type === 'TEXT') {
      const t = n as TextNode;
      if (typeof t.fontName === 'object' && 'family' in t.fontName) {
        fonts.add(JSON.stringify(t.fontName));
      }
    }
    if ('children' in n) {
      for (const c of (n as ChildrenMixin).children) walk(c as SceneNode);
    }
  }
  walk(node);
  await Promise.all(
    Array.from(fonts).map(f => figma.loadFontAsync(JSON.parse(f) as FontName))
  );
}

async function generateOneVariation(
  master: FrameNode,
  ratio: RatioPreset,
  _roleNodes: Partial<Record<SemanticRole, SceneNode[]>>,
  x: number,
  y: number,
): Promise<FrameNode | null> {
  // Target frame in the new ratio
  const frame = figma.createFrame();
  frame.name = `${master.name} — ${ratio.name}`;
  frame.resizeWithoutConstraints(ratio.width, ratio.height);
  frame.x = x;
  frame.y = y;

  // Inherit background from master
  if (Array.isArray(master.fills) && master.fills.length > 0) {
    frame.fills = JSON.parse(JSON.stringify(master.fills)) as Paint[];
  } else {
    frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.97 } }];
  }
  frame.clipsContent = true;

  // ---- Adaptive Rescale strategy ----
  // We clone EVERY top-level child of master and rescale the whole thing
  // proportionally so it fits inside the new ratio with a small padding.
  // This guarantees nothing is lost — text, vectors, groups, images all
  // scale together thanks to node.rescale() being recursive.

  const padding = 0.92; // 8% breathing room
  const scaleX = ratio.width / Math.max(1, master.width);
  const scaleY = ratio.height / Math.max(1, master.height);
  const fitScale = Math.max(0.05, Math.min(scaleX, scaleY) * padding);

  const scaledW = master.width * fitScale;
  const scaledH = master.height * fitScale;
  const offsetX = (ratio.width - scaledW) / 2;
  const offsetY = (ratio.height - scaledH) / 2;

  // Clone every direct child of master into the target frame
  for (const child of master.children) {
    let cloned: SceneNode;
    try {
      cloned = child.clone();
    } catch (e) {
      console.warn('Skip child (clone failed):', child.name, e);
      continue;
    }

    // Capture original-relative coords BEFORE moving/rescaling
    const origX = child.x;
    const origY = child.y;

    frame.appendChild(cloned);

    // rescale() is recursive: scales node, descendants, and text font sizes
    try {
      if ('rescale' in cloned && typeof (cloned as any).rescale === 'function') {
        // rescale requires scale >= 0.01
        if (fitScale >= 0.01 && Math.abs(fitScale - 1) > 0.001) {
          (cloned as any).rescale(fitScale);
        }
      }
    } catch (e) {
      console.warn('Rescale failed for', child.name, e);
    }

    // Reposition: scale the original coords, then offset to center the whole thing
    try {
      cloned.x = Math.round(origX * fitScale + offsetX);
      cloned.y = Math.round(origY * fitScale + offsetY);
    } catch (e) {
      console.warn('Reposition failed for', child.name, e);
    }
  }

  return frame;
}
