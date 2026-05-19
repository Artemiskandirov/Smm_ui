// ============================================================
// AdFlow AI — Figma Plugin Main Thread
// - 12 built-in ratios + custom user ratios (clientStorage)
// - Smart Reflow: bg-preserve + role-based layout (4 templates)
// - Simple Resize: adaptive rescale (no semantic needed)
// ============================================================

/// <reference types="@figma/plugin-typings" />

// ---------- Types ----------

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

type GenerateMode = 'smart' | 'simple';

// ---------- Built-in ratio presets (12) ----------

const BUILTIN_RATIOS: RatioPreset[] = [
  // Instagram
  { id: 'ig_post',       name: 'Instagram Post',     group: 'Instagram', width: 1080, height: 1080, builtin: true },
  { id: 'ig_story',      name: 'Instagram Story',    group: 'Instagram', width: 1080, height: 1920, builtin: true },
  { id: 'ig_landscape',  name: 'Instagram Landscape', group: 'Instagram', width: 1080, height: 566, builtin: true },
  // Facebook
  { id: 'fb_feed',       name: 'Facebook Feed',      group: 'Facebook',  width: 1200, height: 628,  builtin: true },
  { id: 'fb_story',      name: 'Facebook Story',     group: 'Facebook',  width: 1080, height: 1920, builtin: true },
  // YouTube
  { id: 'yt_thumb',      name: 'YouTube Thumbnail',  group: 'YouTube',   width: 1280, height: 720,  builtin: true },
  { id: 'yt_shorts',     name: 'YouTube Shorts',     group: 'YouTube',   width: 1080, height: 1920, builtin: true },
  // Twitter / X
  { id: 'twitter_post',  name: 'Twitter / X Post',   group: 'Twitter',   width: 1600, height: 900,  builtin: true },
  // LinkedIn
  { id: 'linkedin_post', name: 'LinkedIn Post',      group: 'LinkedIn',  width: 1200, height: 627,  builtin: true },
  // TikTok
  { id: 'tiktok',        name: 'TikTok',             group: 'TikTok',    width: 1080, height: 1920, builtin: true },
  // Pinterest
  { id: 'pinterest_pin', name: 'Pinterest Pin',      group: 'Pinterest', width: 1000, height: 1500, builtin: true },
  // Email
  { id: 'email_header',  name: 'Email Header',       group: 'Other',     width: 1200, height: 400,  builtin: true },
];

const CUSTOM_RATIOS_KEY = 'adflow.custom-ratios.v1';

// ---------- State ----------

let lastAnalyze: {
  masterFrameId: string;
  byRole: Record<SemanticRole, SemanticEntry[]>;
} | null = null;

// ---------- Boot ----------

figma.showUI(__html__, { width: 460, height: 760, themeColors: true });

async function bootstrap() {
  sendSelection();
  // Send built-in ratios immediately
  figma.ui.postMessage({ type: 'builtin-ratios', presets: BUILTIN_RATIOS });
  // Load + send custom ratios
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

// ---------- clientStorage helpers ----------

async function loadCustomRatios(): Promise<RatioPreset[]> {
  try {
    const raw = await figma.clientStorage.getAsync(CUSTOM_RATIOS_KEY);
    if (Array.isArray(raw)) return raw;
    return [];
  } catch {
    return [];
  }
}

async function saveCustomRatios(list: RatioPreset[]): Promise<void> {
  await figma.clientStorage.setAsync(CUSTOM_RATIOS_KEY, list);
}

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
      await handleGenerate(msg.ratios, msg.mode || 'smart');
    } else if (msg.type === 'add-custom-ratio') {
      await handleAddCustomRatio(msg.name, msg.width, msg.height);
    } else if (msg.type === 'delete-custom-ratio') {
      await handleDeleteCustomRatio(msg.id);
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
// GENERATION ENTRY POINT
// ============================================================

async function handleGenerate(ratios: RatioPreset[], mode: GenerateMode) {
  if (!lastAnalyze) {
    figma.ui.postMessage({ type: 'error', message: 'Сначала запусти Analyze.' });
    return;
  }
  const master = await figma.getNodeByIdAsync(lastAnalyze.masterFrameId);
  if (!master || (master.type !== 'FRAME' && master.type !== 'COMPONENT' && master.type !== 'INSTANCE')) {
    figma.ui.postMessage({ type: 'error', message: 'Master frame не найден.' });
    return;
  }
  if (ratios.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Выбери хотя бы один формат.' });
    return;
  }
  const masterFrame = master as FrameNode;

  figma.ui.postMessage({
    type: 'progress', stage: 'generating',
    message: `Генерирую ${ratios.length} вариаций (${mode === 'smart' ? 'smart' : 'simple'})…`,
  });

  await loadAllFontsIn(masterFrame);

  // Layout: column to the right of master
  let cursorY = masterFrame.y;
  const startX = masterFrame.x + masterFrame.width + 200;
  const createdIds: string[] = [];

  for (const ratio of ratios) {
    let created: FrameNode | null = null;
    try {
      if (mode === 'smart') {
        created = await generateSmart(masterFrame, ratio, startX, cursorY);
      } else {
        created = await generateSimple(masterFrame, ratio, startX, cursorY);
      }
    } catch (e) {
      console.error('Failed to generate', ratio.name, e);
    }
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

// ============================================================
// SIMPLE RESIZE — adaptive rescale of whole master, centered
// ============================================================

async function generateSimple(
  master: FrameNode,
  ratio: RatioPreset,
  x: number, y: number,
): Promise<FrameNode | null> {
  const frame = createTargetFrame(master, ratio, x, y);

  const padding = 0.92;
  const fitScale = Math.max(0.05, Math.min(ratio.width / master.width, ratio.height / master.height) * padding);
  const scaledW = master.width * fitScale;
  const scaledH = master.height * fitScale;
  const offsetX = (ratio.width - scaledW) / 2;
  const offsetY = (ratio.height - scaledH) / 2;

  for (const child of master.children) {
    let cloned: SceneNode;
    try { cloned = child.clone(); } catch { continue; }
    const origX = child.x, origY = child.y;
    frame.appendChild(cloned);
    try {
      if ('rescale' in cloned && fitScale >= 0.01 && Math.abs(fitScale - 1) > 0.001) {
        (cloned as any).rescale(fitScale);
      }
    } catch {}
    cloned.x = Math.round(origX * fitScale + offsetX);
    cloned.y = Math.round(origY * fitScale + offsetY);
  }
  return frame;
}

// ============================================================
// SMART REFLOW — bg preserved + role-driven layout
// ============================================================

type Template = 'square' | 'portrait_tall' | 'landscape_wide' | 'landscape_close';

function pickTemplate(w: number, h: number): Template {
  const aspect = w / h;
  if (aspect <= 0.7) return 'portrait_tall';   // 9:16, 2:3
  if (aspect >= 1.4) return 'landscape_wide';  // 16:9, 1.91:1
  if (aspect >= 1.1) return 'landscape_close'; // 4:3
  return 'square';                              // ~1:1
}

async function generateSmart(
  master: FrameNode,
  ratio: RatioPreset,
  x: number, y: number,
): Promise<FrameNode | null> {
  const frame = createTargetFrame(master, ratio, x, y);

  // Resolve role nodes from original master
  const heroNode = await resolveFirst(['hero_image', 'product']);
  const headlineNode = await resolveFirst(['headline']);
  const subtitleNode = await resolveFirst(['subtitle']);
  const ctaNode = await resolveFirst(['cta']);
  const logoNode = await resolveFirst(['logo']);

  const hasMeaningfulRoles =
    [heroNode, headlineNode, ctaNode, logoNode].filter(Boolean).length >= 2;

  // Stage 1: clone master as background, adaptive-rescale
  const bgPadding = 0.92;
  const bgScale = Math.max(0.05, Math.min(ratio.width / master.width, ratio.height / master.height) * bgPadding);
  const bgChildren: Array<{ clone: SceneNode; origId: string }> = [];

  for (const child of master.children) {
    let cloned: SceneNode;
    try { cloned = child.clone(); } catch { continue; }
    const origX = child.x, origY = child.y;
    frame.appendChild(cloned);
    try {
      if ('rescale' in cloned && bgScale >= 0.01 && Math.abs(bgScale - 1) > 0.001) {
        (cloned as any).rescale(bgScale);
      }
    } catch {}
    cloned.x = Math.round(origX * bgScale + (ratio.width - master.width * bgScale) / 2);
    cloned.y = Math.round(origY * bgScale + (ratio.height - master.height * bgScale) / 2);
    bgChildren.push({ clone: cloned, origId: child.id });
  }

  if (!hasMeaningfulRoles) {
    // Fall back to pure simple resize — keep the bg layer, nothing to reposition
    return frame;
  }

  // Stage 2: remove role-nodes from bg clones (we'll place them anew)
  const roleNodeIds = new Set<string>();
  [heroNode, headlineNode, subtitleNode, ctaNode, logoNode].forEach(n => {
    if (n) roleNodeIds.add(n.id);
  });

  for (const { clone, origId } of bgChildren) {
    const originalChild = master.children.find(c => c.id === origId);
    if (!originalChild) continue;
    removeMatchingNodesInClone(originalChild, clone, roleNodeIds);
  }

  // Stage 3: apply template-driven placement
  const template = pickTemplate(ratio.width, ratio.height);
  const roles: ResolvedRoles = {
    hero: heroNode, headline: headlineNode, subtitle: subtitleNode,
    cta: ctaNode, logo: logoNode,
  };

  switch (template) {
    case 'square':           await applySquareLayout(frame, ratio, roles); break;
    case 'portrait_tall':    await applyPortraitLayout(frame, ratio, roles); break;
    case 'landscape_wide':   await applyLandscapeWideLayout(frame, ratio, roles); break;
    case 'landscape_close':  await applyLandscapeCloseLayout(frame, ratio, roles); break;
  }

  return frame;
}

type ResolvedRoles = {
  hero: SceneNode | null;
  headline: SceneNode | null;
  subtitle: SceneNode | null;
  cta: SceneNode | null;
  logo: SceneNode | null;
};

async function resolveFirst(roles: SemanticRole[]): Promise<SceneNode | null> {
  if (!lastAnalyze) return null;
  for (const role of roles) {
    const entries = lastAnalyze.byRole[role] || [];
    for (const e of entries) {
      const n = await figma.getNodeByIdAsync(e.node_id);
      if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') {
        return n as SceneNode;
      }
    }
  }
  return null;
}

function createTargetFrame(master: FrameNode, ratio: RatioPreset, x: number, y: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = `${master.name} — ${ratio.name}`;
  frame.resizeWithoutConstraints(ratio.width, ratio.height);
  frame.x = x;
  frame.y = y;
  if (Array.isArray(master.fills) && master.fills.length > 0) {
    frame.fills = JSON.parse(JSON.stringify(master.fills)) as Paint[];
  } else {
    frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.97 } }];
  }
  frame.clipsContent = true;
  return frame;
}

/**
 * Walk original tree + clone tree in lock-step.
 * When original node id is in targetIds, remove the corresponding clone.
 */
function removeMatchingNodesInClone(
  original: SceneNode,
  clone: SceneNode,
  targetIds: Set<string>,
): void {
  if (targetIds.has(original.id)) {
    try { clone.remove(); } catch {}
    return;
  }
  if (!('children' in original) || !('children' in clone)) return;
  const origKids = (original as any).children as SceneNode[];
  const cloneKids = (clone as any).children as SceneNode[];
  const n = Math.min(origKids.length, cloneKids.length);
  // Walk in reverse so removals don't shift indices we still need
  for (let i = n - 1; i >= 0; i--) {
    removeMatchingNodesInClone(origKids[i], cloneKids[i], targetIds);
  }
}

// ---------- Placement helpers ----------

/**
 * Clone a node, append to target, scale uniformly so it fits within (maxW, maxH).
 * Returns the cloned node ready for positioning.
 */
async function placeRole(
  target: FrameNode,
  source: SceneNode,
  maxW: number, maxH: number,
): Promise<SceneNode | null> {
  let cloned: SceneNode;
  try { cloned = source.clone(); } catch { return null; }
  target.appendChild(cloned);

  const srcW = Math.max(1, source.width);
  const srcH = Math.max(1, source.height);
  const scale = Math.min(maxW / srcW, maxH / srcH);

  if (scale >= 0.01 && Math.abs(scale - 1) > 0.001) {
    try {
      if ('rescale' in cloned) (cloned as any).rescale(scale);
    } catch {}
  }
  return cloned;
}

function positionAt(node: SceneNode, x: number, y: number) {
  node.x = Math.round(x);
  node.y = Math.round(y);
}

function centerHorizontally(node: SceneNode, frame: FrameNode, y: number) {
  node.x = Math.round((frame.width - node.width) / 2);
  node.y = Math.round(y);
}

// ============================================================
// TEMPLATE LAYOUTS
// ============================================================

// --- SQUARE (~1:1) ---
async function applySquareLayout(frame: FrameNode, ratio: RatioPreset, r: ResolvedRoles) {
  const pad = ratio.width * 0.06;
  const w = ratio.width - pad * 2;
  const h = ratio.height - pad * 2;

  // Logo top-left
  if (r.logo) {
    const node = await placeRole(frame, r.logo, w * 0.22, h * 0.10);
    if (node) positionAt(node, pad, pad);
  }

  // Headline — width 88%, top ~18-32% area
  let headlineBottom = pad + h * 0.10;
  if (r.headline) {
    const node = await placeRole(frame, r.headline, w * 0.88, h * 0.20);
    if (node) {
      centerHorizontally(node, frame, pad + h * 0.16);
      headlineBottom = node.y + node.height;
    }
  }

  // Subtitle right after
  let subtitleBottom = headlineBottom;
  if (r.subtitle) {
    const node = await placeRole(frame, r.subtitle, w * 0.78, h * 0.08);
    if (node) {
      centerHorizontally(node, frame, headlineBottom + 16);
      subtitleBottom = node.y + node.height;
    }
  }

  // CTA bottom-center
  let ctaTop = ratio.height - pad;
  if (r.cta) {
    const node = await placeRole(frame, r.cta, w * 0.55, h * 0.10);
    if (node) {
      const yPos = ratio.height - pad - node.height;
      centerHorizontally(node, frame, yPos);
      ctaTop = yPos;
    }
  }

  // Hero — fills space between subtitle and cta
  if (r.hero) {
    const heroTop = subtitleBottom + h * 0.04;
    const heroBottom = ctaTop - h * 0.04;
    const availH = Math.max(80, heroBottom - heroTop);
    const node = await placeRole(frame, r.hero, w * 0.80, availH);
    if (node) {
      node.x = Math.round((frame.width - node.width) / 2);
      node.y = Math.round(heroTop + (availH - node.height) / 2);
    }
  }
}

// --- PORTRAIT TALL (9:16) ---
async function applyPortraitLayout(frame: FrameNode, ratio: RatioPreset, r: ResolvedRoles) {
  const pad = ratio.width * 0.06;
  const w = ratio.width - pad * 2;

  // Logo top-center
  let logoBottom = ratio.height * 0.10;
  if (r.logo) {
    const node = await placeRole(frame, r.logo, w * 0.30, ratio.height * 0.06);
    if (node) {
      centerHorizontally(node, frame, ratio.height * 0.06);
      logoBottom = node.y + node.height;
    }
  }

  // CTA bottom (anchored)
  let ctaTop = ratio.height * 0.90;
  if (r.cta) {
    const node = await placeRole(frame, r.cta, w * 0.80, ratio.height * 0.08);
    if (node) {
      const yPos = ratio.height - ratio.height * 0.08 - node.height;
      centerHorizontally(node, frame, yPos);
      ctaTop = yPos;
    }
  }

  // Subtitle above CTA
  let subtitleTop = ctaTop - 20;
  if (r.subtitle) {
    const node = await placeRole(frame, r.subtitle, w * 0.85, ratio.height * 0.06);
    if (node) {
      const yPos = ctaTop - 24 - node.height;
      centerHorizontally(node, frame, yPos);
      subtitleTop = yPos;
    }
  }

  // Headline above subtitle, BIG (60% of free space)
  let headlineTop = subtitleTop - 20;
  if (r.headline) {
    const node = await placeRole(frame, r.headline, w * 0.92, ratio.height * 0.20);
    if (node) {
      const yPos = subtitleTop - 28 - node.height;
      centerHorizontally(node, frame, yPos);
      headlineTop = yPos;
    }
  }

  // Hero — between logo and headline
  if (r.hero) {
    const heroTop = logoBottom + ratio.height * 0.04;
    const heroBottom = headlineTop - ratio.height * 0.03;
    const availH = Math.max(100, heroBottom - heroTop);
    const node = await placeRole(frame, r.hero, w * 0.95, availH);
    if (node) {
      node.x = Math.round((frame.width - node.width) / 2);
      node.y = Math.round(heroTop + (availH - node.height) / 2);
    }
  }
}

// --- LANDSCAPE WIDE (16:9, 1.91:1) ---
async function applyLandscapeWideLayout(frame: FrameNode, ratio: RatioPreset, r: ResolvedRoles) {
  const padX = ratio.width * 0.04;
  const padY = ratio.height * 0.06;
  const gap = ratio.width * 0.03;
  const leftW = (ratio.width - padX * 2 - gap) * 0.48;
  const rightW = (ratio.width - padX * 2 - gap) * 0.52;
  const contentH = ratio.height - padY * 2;

  // Left column
  let leftCursor = padY;
  if (r.logo) {
    const node = await placeRole(frame, r.logo, leftW * 0.42, contentH * 0.14);
    if (node) {
      positionAt(node, padX, padY);
      leftCursor = padY + node.height + contentH * 0.04;
    }
  }
  if (r.headline) {
    const node = await placeRole(frame, r.headline, leftW, contentH * 0.36);
    if (node) {
      positionAt(node, padX, leftCursor);
      leftCursor = node.y + node.height + contentH * 0.03;
    }
  }
  if (r.subtitle) {
    const node = await placeRole(frame, r.subtitle, leftW * 0.92, contentH * 0.16);
    if (node) {
      positionAt(node, padX, leftCursor);
      leftCursor = node.y + node.height;
    }
  }
  if (r.cta) {
    const node = await placeRole(frame, r.cta, leftW * 0.60, contentH * 0.16);
    if (node) {
      positionAt(node, padX, ratio.height - padY - node.height);
    }
  }

  // Right column: hero
  if (r.hero) {
    const node = await placeRole(frame, r.hero, rightW, contentH);
    if (node) {
      const rightX = padX + leftW + gap;
      node.x = Math.round(rightX + (rightW - node.width) / 2);
      node.y = Math.round(padY + (contentH - node.height) / 2);
    }
  }
}

// --- LANDSCAPE CLOSE (4:3) ---
async function applyLandscapeCloseLayout(frame: FrameNode, ratio: RatioPreset, r: ResolvedRoles) {
  const padX = ratio.width * 0.05;
  const padY = ratio.height * 0.05;
  const w = ratio.width - padX * 2;

  // Hero top half
  let heroBottom = padY;
  if (r.hero) {
    const heroH = ratio.height * 0.50;
    const node = await placeRole(frame, r.hero, w, heroH);
    if (node) {
      node.x = Math.round((frame.width - node.width) / 2);
      node.y = Math.round(padY + (heroH - node.height) / 2);
      heroBottom = padY + heroH;
    }
  }

  // Logo top-left absolute (over hero)
  if (r.logo) {
    const node = await placeRole(frame, r.logo, w * 0.18, ratio.height * 0.08);
    if (node) positionAt(node, padX, padY);
  }

  // CTA bottom-center
  let ctaTop = ratio.height - padY;
  if (r.cta) {
    const node = await placeRole(frame, r.cta, w * 0.45, ratio.height * 0.12);
    if (node) {
      const yPos = ratio.height - padY - node.height;
      centerHorizontally(node, frame, yPos);
      ctaTop = yPos;
    }
  }

  // Headline + subtitle in band between hero and cta
  const bandTop = heroBottom + ratio.height * 0.03;
  const bandBottom = ctaTop - ratio.height * 0.03;
  const bandH = Math.max(40, bandBottom - bandTop);
  let textY = bandTop;
  if (r.headline) {
    const node = await placeRole(frame, r.headline, w * 0.90, bandH * 0.6);
    if (node) {
      centerHorizontally(node, frame, textY);
      textY = node.y + node.height + 6;
    }
  }
  if (r.subtitle) {
    const node = await placeRole(frame, r.subtitle, w * 0.78, bandH * 0.35);
    if (node) {
      centerHorizontally(node, frame, textY);
    }
  }
}
