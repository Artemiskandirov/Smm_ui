// ============================================================
// AdFlow AI — Figma Plugin Main Thread
// Runs in Figma sandbox. Handles: frame parsing, screenshot,
// communication with UI iframe, applying names back to nodes.
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

// ---------- Boot ----------

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

// Tell UI about current selection immediately and on every change
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

// ---------- Message handler ----------

figma.ui.onmessage = async (msg: { type: string; [key: string]: any }) => {
  try {
    if (msg.type === 'analyze') {
      await handleAnalyze();
    } else if (msg.type === 'apply-name') {
      await handleApplyName(msg.nodeId, msg.newName);
    } else if (msg.type === 'apply-all-names') {
      await handleApplyAllNames(msg.renames);
    } else if (msg.type === 'focus-node') {
      await handleFocusNode(msg.nodeId);
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (err: any) {
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
    id: node.id,
    name: node.name,
    type: node.type,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    visible: node.visible,
    opacity: 'opacity' in node ? (node as any).opacity : 1,
    rotation: 'rotation' in node ? Math.round((node as any).rotation) : 0,
    children: [],
  };

  // TEXT
  if (node.type === 'TEXT') {
    const t = node as TextNode;
    base.text = t.characters;
    if (typeof t.fontSize === 'number') base.fontSize = t.fontSize;
    if (typeof t.fontName === 'object' && 'style' in t.fontName) {
      const style = (t.fontName as FontName).style.toLowerCase();
      if (style.includes('thin')) base.fontWeight = 100;
      else if (style.includes('extralight') || style.includes('ultralight')) base.fontWeight = 200;
      else if (style.includes('light')) base.fontWeight = 300;
      else if (style.includes('medium')) base.fontWeight = 500;
      else if (style.includes('semibold') || style.includes('demibold')) base.fontWeight = 600;
      else if (style.includes('extrabold') || style.includes('ultrabold')) base.fontWeight = 800;
      else if (style.includes('black') || style.includes('heavy')) base.fontWeight = 900;
      else if (style.includes('bold')) base.fontWeight = 700;
      else base.fontWeight = 400;
    }
    base.textAlign = t.textAlignHorizontal;

    // text color from first fill
    if (Array.isArray(t.fills) && t.fills.length > 0) {
      const f = t.fills[0];
      if (f.type === 'SOLID') {
        base.color = rgbToHex((f as SolidPaint).color);
      }
    }
  }

  // Fills for shapes/frames
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

  // Recurse into children
  if ('children' in node) {
    const kids = (node as ChildrenMixin).children;
    for (const child of kids) {
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
    figma.ui.postMessage({ type: 'error', message: 'Не удалось разобрать выделенный frame.' });
    return;
  }

  const total = countNodes(layoutJson);
  if (total > 300) {
    figma.ui.postMessage({
      type: 'error',
      message: `Слишком много слоёв: ${total}. Лимит 300 для MVP.`,
    });
    return;
  }

  figma.ui.postMessage({ type: 'progress', stage: 'screenshot', message: 'Делаю скриншот макета…' });

  const bytes = await (target as FrameNode).exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: 1 },
  });
  const base64 = figma.base64Encode(bytes);

  figma.ui.postMessage({ type: 'progress', stage: 'sending', message: 'Отправляю GPT-5.5…' });

  // Forward everything to UI; UI will hit our Vercel backend (CORS-free from iframe).
  figma.ui.postMessage({
    type: 'analyze-payload',
    layoutJson,
    screenshotBase64: base64,
    frameWidth: Math.round(target.width),
    frameHeight: Math.round(target.height),
    totalNodes: total,
  });
}

// ---------- Apply renames ----------

async function handleApplyName(nodeId: string, newName: string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node && 'name' in node) {
    (node as BaseNode & { name: string }).name = newName;
    figma.ui.postMessage({ type: 'name-applied', nodeId, newName });
  }
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
