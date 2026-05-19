// ============================================================
// AdFlow AI — Figma Plugin Main Thread
// - 12 built-in ratios + custom user ratios (clientStorage)
// - Generate: AI returns precise layout plan per ratio (designer mode)
// ============================================================

/// <reference types="@figma/plugin-typings" />

type LayoutNode = {
  id: string;
  name: string;
  type: string;
  x: number; y: number;
  width: number; height: number;
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
  group?: string;
  width: number;
  height: number;
  builtin?: boolean;
};

type RoleElementDescriptor = {
  node_id: string;
  role: SemanticRole;
  text?: string;
  current_w: number;
  current_h: number;
  aspect_ratio: number;
};

type Placement = {
  node_id: string;
  visible: boolean;
  target_x: number;
  target_y: number;
  target_w: number;
  target_h: number;
  z_order: number;
  scale_strategy: 'fit' | 'fill' | 'stretch';
};

type LayoutPlan = {
  placements: Placement[];
  background_strategy: 'extend_master' | 'solid_color' | 'gradient' | 'crop_master_bg';
  background_color?: string | null;
  background_gradient?: string[] | null;
  reasoning: string;
  design_score: number;
};

const BUILTIN_RATIOS: RatioPreset[] = [
  { id: 'ig_post',       name: 'Instagram Post',     group: 'Instagram', width: 1080, height: 1080, builtin: true },
  { id: 'ig_story',      name: 'Instagram Story',    group: 'Instagram', width: 1080, height: 1920, builtin: true },
  { id: 'ig_landscape',  name: 'Instagram Landscape', group: 'Instagram', width: 1080, height: 566, builtin: true },
  { id: 'fb_feed',       name: 'Facebook Feed',      group: 'Facebook',  width: 1200, height: 628,  builtin: true },
  { id: 'fb_story',      name: 'Facebook Story',     group: 'Facebook',  width: 1080, height: 1920, builtin: true },
  { id: 'yt_thumb',      name: 'YouTube Thumbnail',  group: 'YouTube',   width: 1280, height: 720,  builtin: true },
  { id: 'yt_shorts',     name: 'YouTube Shorts',     group: 'YouTube',   width: 1080, height: 1920, builtin: true },
  { id: 'twitter_post',  name: 'Twitter / X Post',   group: 'Twitter',   width: 1600, height: 900,  builtin: true },
  { id: 'linkedin_post', name: 'LinkedIn Post',      group: 'LinkedIn',  width: 1200, height: 627,  builtin: true },
  { id: 'tiktok',        name: 'TikTok',             group: 'TikTok',    width: 1080, height: 1920, builtin: true },
  { id: 'pinterest_pin', name: 'Pinterest Pin',      group: 'Pinterest', width: 1000, height: 1500, builtin: true },
  { id: 'email_header',  name: 'Email Header',       group: 'Other',     width: 1200, height: 400,  builtin: true },
];

const CUSTOM_RATIOS_KEY = 'adflow.custom-ratios.v1';

// ---------- State ----------

let lastAnalyze: {
  masterFrameId: string;
  byRole: Record<SemanticRole, SemanticEntry[]>;
  screenshotBase64: string;
  sourceWidth: number;
  sourceHeight: number;
} | null = null;

// ---------- Boot ----------

figma.showUI(__html__, { width: 460, height: 760, themeColors: true });

async function bootstrap() {
  sendSelection();
  figma.ui.postMessage({ type: 'builtin-ratios', presets: BUILTIN_RATIOS });
  const customs = await loadCustomRatios();
  figma.ui.postMessage({ type: 'custom-ratios', presets: customs });
}
bootstrap();

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
figma.on('selectionchange', sendSelection);

async function loadCustomRatios(): Promise<RatioPreset[]> {
  try {
    const raw = await figma.clientStorage.getAsync(CUSTOM_RATIOS_KEY);
    if (Array.isArray(raw)) return raw;
    return [];
  } catch { return []; }
}
async function saveCustomRatios(list: RatioPreset[]): Promise<void> {
  await figma.clientStorage.setAsync(CUSTOM_RATIOS_KEY, list);
}

// ---------- Message router ----------

figma.ui.onmessage = async (msg: { type: string;[key: string]: any }) => {
  try {
    if (msg.type === 'analyze')                await handleAnalyze();
    else if (msg.type === 'cache-semantic')    cacheSemantic(msg.masterFrameId, msg.layers, msg.screenshotBase64, msg.sourceWidth, msg.sourceHeight);
    else if (msg.type === 'apply-all-names')   await handleApplyAllNames(msg.renames);
    else if (msg.type === 'focus-node')        await handleFocusNode(msg.nodeId);
    else if (msg.type === 'generate-from-plans') await handleGenerateFromPlans(msg.plans);
    else if (msg.type === 'request-layout-data') await sendLayoutData(msg.ratios);
    else if (msg.type === 'add-custom-ratio')  await handleAddCustomRatio(msg.name, msg.width, msg.height);
    else if (msg.type === 'delete-custom-ratio') await handleDeleteCustomRatio(msg.id);
    else if (msg.type === 'close')             figma.closePlugin();
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

// ---------- Analyze ----------

async function handleAnalyze() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) { figma.ui.postMessage({ type: 'error', message: 'Выделите frame.' }); return; }
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

function cacheSemantic(masterFrameId: string, layers: SemanticEntry[], screenshotBase64: string, sourceWidth: number, sourceHeight: number) {
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
  lastAnalyze = { masterFrameId, byRole, screenshotBase64, sourceWidth, sourceHeight };
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

// ---------- Custom ratio CRUD ----------

async function handleAddCustomRatio(name: string, width: number, height: number) {
  const list = await loadCustomRatios();
  const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  list.push({ id, name: name || `${width}×${height}`, width, height, group: 'Custom', builtin: false });
  await saveCustomRatios(list);
  figma.ui.postMessage({ type: 'custom-ratios', presets: list });
  figma.notify(`✓ Добавлен формат: ${name}`);
}
async function handleDeleteCustomRatio(id: string) {
  const list = await loadCustomRatios();
  const filtered = list.filter(r => r.id !== id);
  await saveCustomRatios(filtered);
  figma.ui.postMessage({ type: 'custom-ratios', presets: filtered });
}

// ============================================================
// GENERATION — AI-driven layout
// ============================================================

/**
 * Step 1: UI selects ratios → asks plugin for layout data.
 * Plugin sends back: screenshot, source size, role elements with dimensions.
 * UI then makes parallel calls to /api/layout for each ratio.
 */
async function sendLayoutData(ratios: RatioPreset[]) {
  if (!lastAnalyze) {
    figma.ui.postMessage({ type: 'error', message: 'Сначала запусти Analyze.' });
    return;
  }

  // Collect role elements with current dimensions
  const roleElements: RoleElementDescriptor[] = [];
  const importantRoles: SemanticRole[] = ['headline', 'subtitle', 'body', 'cta', 'logo', 'hero_image', 'product'];

  for (const role of importantRoles) {
    const entries = lastAnalyze.byRole[role] || [];
    for (const entry of entries) {
      const node = await figma.getNodeByIdAsync(entry.node_id);
      if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') continue;
      const sceneNode = node as SceneNode;
      const descriptor: RoleElementDescriptor = {
        node_id: entry.node_id,
        role,
        current_w: Math.round(sceneNode.width),
        current_h: Math.round(sceneNode.height),
        aspect_ratio: sceneNode.width / Math.max(1, sceneNode.height),
      };
      if (sceneNode.type === 'TEXT') {
        descriptor.text = (sceneNode as TextNode).characters.slice(0, 100);
      }
      roleElements.push(descriptor);
    }
  }

  figma.ui.postMessage({
    type: 'layout-data',
    screenshotBase64: lastAnalyze.screenshotBase64,
    sourceWidth: lastAnalyze.sourceWidth,
    sourceHeight: lastAnalyze.sourceHeight,
    roleElements,
    ratios,
  });
}

/**
 * Step 2: After UI got all AI layout plans, plugin applies them to actual nodes.
 */
async function handleGenerateFromPlans(plans: Array<{ ratio: RatioPreset; plan: LayoutPlan }>) {
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

  figma.ui.postMessage({
    type: 'progress', stage: 'applying',
    message: `Создаю фреймы и применяю планы…`,
  });

  await loadAllFontsIn(masterFrame);

  let cursorY = masterFrame.y;
  const startX = masterFrame.x + masterFrame.width + 200;
  const createdIds: string[] = [];

  for (const { ratio, plan } of plans) {
    try {
      const frame = await applyLayoutPlan(masterFrame, ratio, plan, startX, cursorY);
      if (frame) {
        createdIds.push(frame.id);
        cursorY += ratio.height + 80;
      }
    } catch (e) {
      console.error('Failed to apply plan for', ratio.name, e);
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

// ---------- Apply AI plan ----------

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6 && clean.length !== 3) return null;
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

async function applyLayoutPlan(
  master: FrameNode,
  ratio: RatioPreset,
  plan: LayoutPlan,
  x: number, y: number,
): Promise<FrameNode | null> {
  // Create target frame
  const frame = figma.createFrame();
  frame.name = `${master.name} — ${ratio.name}`;
  frame.resizeWithoutConstraints(ratio.width, ratio.height);
  frame.x = x;
  frame.y = y;
  frame.clipsContent = true;

  // ---- Apply background ----
  applyBackground(frame, master, plan);

  // ---- Sort placements by z_order so we append in correct stacking ----
  const visible = plan.placements
    .filter(p => p.visible && p.target_w > 0 && p.target_h > 0)
    .sort((a, b) => a.z_order - b.z_order);

  // ---- Place each element ----
  for (const placement of visible) {
    const sourceNode = await figma.getNodeByIdAsync(placement.node_id);
    if (!sourceNode || sourceNode.type === 'DOCUMENT' || sourceNode.type === 'PAGE') continue;

    let cloned: SceneNode;
    try {
      cloned = (sourceNode as SceneNode).clone();
    } catch (e) {
      console.warn('Could not clone', sourceNode.id, e);
      continue;
    }
    frame.appendChild(cloned);

    // Scale node to target dimensions
    await scaleNodeTo(cloned, placement.target_w, placement.target_h, placement.scale_strategy);

    // Position (clamped to frame bounds, allow small overshoot up to 4px)
    const finalX = Math.max(0, Math.min(ratio.width - cloned.width, placement.target_x));
    const finalY = Math.max(0, Math.min(ratio.height - cloned.height, placement.target_y));
    cloned.x = Math.round(finalX);
    cloned.y = Math.round(finalY);
  }

  return frame;
}

function applyBackground(frame: FrameNode, master: FrameNode, plan: LayoutPlan) {
  try {
    switch (plan.background_strategy) {
      case 'solid_color': {
        const rgb = plan.background_color ? hexToRgb(plan.background_color) : null;
        if (rgb) {
          frame.fills = [{ type: 'SOLID', color: rgb }];
          return;
        }
        break;
      }
      case 'gradient': {
        const colors = plan.background_gradient || [];
        if (colors.length >= 2) {
          const c1 = hexToRgb(colors[0]);
          const c2 = hexToRgb(colors[1]);
          if (c1 && c2) {
            frame.fills = [{
              type: 'GRADIENT_LINEAR',
              gradientTransform: [[1, 0, 0], [0, 1, 0]],
              gradientStops: [
                { position: 0, color: { ...c1, a: 1 } },
                { position: 1, color: { ...c2, a: 1 } },
              ],
            } as GradientPaint];
            return;
          }
        }
        break;
      }
      case 'extend_master':
      case 'crop_master_bg': {
        // Inherit master fills
        if (Array.isArray(master.fills) && master.fills.length > 0) {
          frame.fills = JSON.parse(JSON.stringify(master.fills)) as Paint[];
          return;
        }
        break;
      }
    }
  } catch (e) {
    console.warn('Background apply failed, using master fills', e);
  }
  // Fallback
  if (Array.isArray(master.fills) && master.fills.length > 0) {
    frame.fills = JSON.parse(JSON.stringify(master.fills)) as Paint[];
  } else {
    frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.97 } }];
  }
}

/**
 * Scale a node to fit target_w x target_h according to strategy.
 * For text: scale fontSize proportionally and use auto-resize for height.
 * For other nodes: use rescale() which is recursive and preserves children.
 */
async function scaleNodeTo(
  node: SceneNode,
  targetW: number, targetH: number,
  strategy: 'fit' | 'fill' | 'stretch',
): Promise<void> {
  const srcW = Math.max(1, node.width);
  const srcH = Math.max(1, node.height);

  // Text — special handling
  if (node.type === 'TEXT') {
    const t = node as TextNode;
    if (typeof t.fontName === 'object' && 'family' in t.fontName) {
      try { await figma.loadFontAsync(t.fontName as FontName); } catch {}
    }
    // Scale fontSize proportionally to fit target width
    if (typeof t.fontSize === 'number') {
      const widthRatio = targetW / srcW;
      const heightRatio = targetH / srcH;
      const scaleFactor = strategy === 'stretch'
        ? Math.min(widthRatio, heightRatio)
        : Math.min(widthRatio, heightRatio);
      const newSize = Math.max(8, Math.min(400, Math.round(t.fontSize * scaleFactor)));
      try { t.fontSize = newSize; } catch {}
    }
    t.textAutoResize = 'HEIGHT';
    try { t.resize(Math.max(20, targetW), t.height); } catch {}
    return;
  }

  // For non-text: pick scale factor
  let scale: number;
  if (strategy === 'fill') {
    scale = Math.max(targetW / srcW, targetH / srcH);
  } else if (strategy === 'stretch') {
    // Non-uniform — figma rescale doesn't support this, fall back to resize
    if ('resize' in node) {
      try { (node as LayoutMixin).resize(Math.max(1, targetW), Math.max(1, targetH)); } catch {}
    }
    return;
  } else {
    // fit
    scale = Math.min(targetW / srcW, targetH / srcH);
  }

  if (scale >= 0.01 && Math.abs(scale - 1) > 0.001) {
    try {
      if ('rescale' in node) (node as any).rescale(scale);
    } catch {
      // Fallback to plain resize if rescale fails
      if ('resize' in node) {
        try { (node as LayoutMixin).resize(srcW * scale, srcH * scale); } catch {}
      }
    }
  }
}
