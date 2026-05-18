"use strict";
(() => {
  // code.ts
  var RATIO_PRESETS = [
    {
      id: "ig_post_1x1",
      name: "Instagram Post",
      width: 1080,
      height: 1080,
      safeZone: { top: 64, right: 64, bottom: 64, left: 64 },
      template: "centered_hero"
    },
    {
      id: "ig_story_9x16",
      name: "Story / Reels",
      width: 1080,
      height: 1920,
      safeZone: { top: 250, right: 64, bottom: 320, left: 64 },
      template: "story_stack"
    },
    {
      id: "fb_feed_191x1",
      name: "Facebook Feed",
      width: 1200,
      height: 628,
      safeZone: { top: 32, right: 48, bottom: 32, left: 48 },
      template: "split_editorial"
    },
    {
      id: "yt_thumb_16x9",
      name: "YouTube Thumb",
      width: 1280,
      height: 720,
      safeZone: { top: 32, right: 48, bottom: 32, left: 48 },
      template: "split_editorial"
    }
  ];
  var lastAnalyze = null;
  figma.showUI(__html__, { width: 440, height: 720, themeColors: true });
  function sendSelection() {
    const sel = figma.currentPage.selection;
    const first = sel[0];
    const isFrame = first && (first.type === "FRAME" || first.type === "COMPONENT" || first.type === "INSTANCE");
    figma.ui.postMessage({
      type: "selection",
      hasFrame: !!isFrame,
      frameName: isFrame ? first.name : null,
      frameWidth: isFrame ? Math.round(first.width) : null,
      frameHeight: isFrame ? Math.round(first.height) : null
    });
  }
  sendSelection();
  figma.on("selectionchange", sendSelection);
  figma.ui.postMessage({ type: "ratios", presets: RATIO_PRESETS });
  figma.ui.onmessage = async (msg) => {
    try {
      if (msg.type === "analyze") {
        await handleAnalyze();
      } else if (msg.type === "cache-semantic") {
        cacheSemantic(msg.masterFrameId, msg.layers);
      } else if (msg.type === "apply-all-names") {
        await handleApplyAllNames(msg.renames);
      } else if (msg.type === "focus-node") {
        await handleFocusNode(msg.nodeId);
      } else if (msg.type === "generate") {
        await handleGenerate(msg.ratioIds);
      } else if (msg.type === "close") {
        figma.closePlugin();
      }
    } catch (err) {
      console.error(err);
      figma.ui.postMessage({ type: "error", message: (err == null ? void 0 : err.message) || String(err) });
    }
  };
  function rgbToHex(c) {
    const to255 = (v) => Math.round(v * 255);
    const h = (n) => n.toString(16).padStart(2, "0");
    return "#" + h(to255(c.r)) + h(to255(c.g)) + h(to255(c.b));
  }
  function parseNode(node) {
    if (!node.visible)
      return null;
    const base = {
      id: node.id,
      name: node.name,
      type: node.type,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
      visible: node.visible,
      opacity: "opacity" in node ? node.opacity : 1,
      rotation: "rotation" in node ? Math.round(node.rotation) : 0,
      children: []
    };
    if (node.type === "TEXT") {
      const t = node;
      base.text = t.characters;
      if (typeof t.fontSize === "number")
        base.fontSize = t.fontSize;
      base.textAlign = t.textAlignHorizontal;
      if (Array.isArray(t.fills) && t.fills.length > 0 && t.fills[0].type === "SOLID") {
        base.color = rgbToHex(t.fills[0].color);
      }
    }
    if ("fills" in node && Array.isArray(node.fills)) {
      const fills = node.fills;
      base.fills = fills.slice(0, 3).map((f) => ({
        type: f.type,
        color: f.type === "SOLID" ? rgbToHex(f.color) : void 0
      }));
    }
    if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
      base.cornerRadius = node.cornerRadius;
    }
    if ("children" in node) {
      for (const child of node.children) {
        const parsed = parseNode(child);
        if (parsed)
          base.children.push(parsed);
      }
    }
    return base;
  }
  function countNodes(n) {
    return 1 + n.children.reduce((acc, c) => acc + countNodes(c), 0);
  }
  async function handleAnalyze() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      figma.ui.postMessage({ type: "error", message: "\u0412\u044B\u0434\u0435\u043B\u0438\u0442\u0435 frame \u0434\u043B\u044F \u0430\u043D\u0430\u043B\u0438\u0437\u0430." });
      return;
    }
    const target = sel[0];
    if (target.type !== "FRAME" && target.type !== "COMPONENT" && target.type !== "INSTANCE") {
      figma.ui.postMessage({ type: "error", message: "\u0412\u044B\u0434\u0435\u043B\u0438\u0442\u0435 Frame, Component \u0438\u043B\u0438 Instance." });
      return;
    }
    figma.ui.postMessage({ type: "progress", stage: "parsing", message: "\u0420\u0430\u0437\u0431\u0438\u0440\u0430\u044E \u0441\u043B\u043E\u0438\u2026" });
    const layoutJson = parseNode(target);
    if (!layoutJson) {
      figma.ui.postMessage({ type: "error", message: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C frame." });
      return;
    }
    const total = countNodes(layoutJson);
    if (total > 300) {
      figma.ui.postMessage({ type: "error", message: `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0441\u043B\u043E\u0451\u0432: ${total}. \u041B\u0438\u043C\u0438\u0442 300.` });
      return;
    }
    figma.ui.postMessage({ type: "progress", stage: "screenshot", message: "\u0414\u0435\u043B\u0430\u044E \u0441\u043A\u0440\u0438\u043D\u0448\u043E\u0442\u2026" });
    const bytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 1 }
    });
    const base64 = figma.base64Encode(bytes);
    figma.ui.postMessage({ type: "progress", stage: "sending", message: "GPT-5.5 \u0430\u043D\u0430\u043B\u0438\u0437\u0438\u0440\u0443\u0435\u0442\u2026" });
    figma.ui.postMessage({
      type: "analyze-payload",
      masterFrameId: target.id,
      layoutJson,
      screenshotBase64: base64,
      frameWidth: Math.round(target.width),
      frameHeight: Math.round(target.height)
    });
  }
  function cacheSemantic(masterFrameId, layers) {
    const byRole = {
      headline: [],
      subtitle: [],
      body: [],
      cta: [],
      logo: [],
      hero_image: [],
      product: [],
      decorative: [],
      background: [],
      icon: [],
      unknown: []
    };
    for (const l of layers) {
      if (byRole[l.role])
        byRole[l.role].push(l);
    }
    for (const k of Object.keys(byRole)) {
      byRole[k].sort((a, b) => b.importance - a.importance);
    }
    lastAnalyze = { masterFrameId, byRole };
  }
  async function handleApplyAllNames(renames) {
    let count = 0;
    for (const r of renames) {
      const node = await figma.getNodeByIdAsync(r.nodeId);
      if (node && "name" in node) {
        node.name = r.newName;
        count++;
      }
    }
    figma.notify(`\u2713 \u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E \u0441\u043B\u043E\u0451\u0432: ${count}`);
    figma.ui.postMessage({ type: "all-names-applied", count });
  }
  async function handleFocusNode(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
  }
  async function handleGenerate(ratioIds) {
    if (!lastAnalyze) {
      figma.ui.postMessage({ type: "error", message: "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u043F\u0443\u0441\u0442\u0438 Analyze." });
      return;
    }
    const master = await figma.getNodeByIdAsync(lastAnalyze.masterFrameId);
    if (!master || master.type !== "FRAME" && master.type !== "COMPONENT" && master.type !== "INSTANCE") {
      figma.ui.postMessage({ type: "error", message: "Master frame \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D." });
      return;
    }
    const masterFrame = master;
    const ratios = RATIO_PRESETS.filter((r) => ratioIds.includes(r.id));
    if (ratios.length === 0) {
      figma.ui.postMessage({ type: "error", message: "\u0412\u044B\u0431\u0435\u0440\u0438 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u0438\u043D \u0444\u043E\u0440\u043C\u0430\u0442." });
      return;
    }
    figma.ui.postMessage({
      type: "progress",
      stage: "generating",
      message: `\u0413\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E ${ratios.length} \u0432\u0430\u0440\u0438\u0430\u0446\u0438\u0439\u2026`
    });
    await loadAllFontsIn(masterFrame);
    const roleNodes = await resolveRoleNodes();
    let cursorY = masterFrame.y;
    const startX = masterFrame.x + masterFrame.width + 200;
    const createdIds = [];
    for (const ratio of ratios) {
      const created = await generateOneVariation(masterFrame, ratio, roleNodes, startX, cursorY);
      if (created) {
        createdIds.push(created.id);
        cursorY += ratio.height + 80;
      }
    }
    if (createdIds.length > 0) {
      const nodes = await Promise.all(createdIds.map((id) => figma.getNodeByIdAsync(id)));
      const scene = nodes.filter((n) => n && n.type !== "DOCUMENT" && n.type !== "PAGE");
      figma.currentPage.selection = scene;
      figma.viewport.scrollAndZoomIntoView(scene);
      figma.notify(`\u2713 \u0421\u043E\u0437\u0434\u0430\u043D\u043E \u0432\u0430\u0440\u0438\u0430\u0446\u0438\u0439: ${createdIds.length}`);
    }
    figma.ui.postMessage({ type: "generate-done", count: createdIds.length });
  }
  async function resolveRoleNodes() {
    const result = {};
    if (!lastAnalyze)
      return result;
    for (const role of Object.keys(lastAnalyze.byRole)) {
      const entries = lastAnalyze.byRole[role];
      const nodes = [];
      for (const entry of entries) {
        const n = await figma.getNodeByIdAsync(entry.node_id);
        if (n && n.type !== "DOCUMENT" && n.type !== "PAGE") {
          nodes.push(n);
        }
      }
      result[role] = nodes;
    }
    return result;
  }
  async function loadAllFontsIn(node) {
    const fonts = /* @__PURE__ */ new Set();
    function walk(n) {
      if (n.type === "TEXT") {
        const t = n;
        if (typeof t.fontName === "object" && "family" in t.fontName) {
          fonts.add(JSON.stringify(t.fontName));
        }
      }
      if ("children" in n) {
        for (const c of n.children)
          walk(c);
      }
    }
    walk(node);
    await Promise.all(
      Array.from(fonts).map((f) => figma.loadFontAsync(JSON.parse(f)))
    );
  }
  async function generateOneVariation(master, ratio, roleNodes, x, y) {
    const frame = figma.createFrame();
    frame.name = `${master.name} \u2014 ${ratio.name}`;
    frame.resizeWithoutConstraints(ratio.width, ratio.height);
    frame.x = x;
    frame.y = y;
    if (Array.isArray(master.fills) && master.fills.length > 0) {
      frame.fills = JSON.parse(JSON.stringify(master.fills));
    } else {
      frame.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.96, b: 0.97 } }];
    }
    frame.clipsContent = true;
    const hero = roleNodes.hero_image && roleNodes.hero_image[0] || roleNodes.product && roleNodes.product[0] || null;
    const headline = roleNodes.headline && roleNodes.headline[0] || null;
    const subtitle = roleNodes.subtitle && roleNodes.subtitle[0] || null;
    const cta = roleNodes.cta && roleNodes.cta[0] || null;
    const logo = roleNodes.logo && roleNodes.logo[0] || null;
    const bundle = { hero, headline, subtitle, cta, logo };
    switch (ratio.template) {
      case "centered_hero":
        await renderCenteredHero(frame, ratio, bundle);
        break;
      case "story_stack":
        await renderStoryStack(frame, ratio, bundle);
        break;
      case "split_editorial":
        await renderSplitEditorial(frame, ratio, bundle);
        break;
    }
    return frame;
  }
  async function placeClone(target, source, x, y, maxW, maxH, mode = "contain") {
    if (!source)
      return null;
    const cloned = source.clone();
    target.appendChild(cloned);
    const srcW = Math.max(1, source.width);
    const srcH = Math.max(1, source.height);
    let newW = srcW, newH = srcH;
    if (mode === "fit-width") {
      newW = maxW;
      newH = srcH / srcW * maxW;
      if (newH > maxH) {
        newH = maxH;
        newW = srcW / srcH * maxH;
      }
    } else if (mode === "fit-box") {
      newW = maxW;
      newH = maxH;
    } else {
      const scale = Math.min(maxW / srcW, maxH / srcH, 1);
      newW = srcW * scale;
      newH = srcH * scale;
    }
    if (cloned.type === "TEXT") {
      const t = cloned;
      if (typeof t.fontName === "object" && "family" in t.fontName) {
        await figma.loadFontAsync(t.fontName);
      }
      t.textAutoResize = "HEIGHT";
      try {
        t.resize(Math.max(20, newW), t.height);
      } catch (e) {
      }
    } else if ("resize" in cloned) {
      try {
        cloned.resize(Math.max(1, newW), Math.max(1, newH));
      } catch (e) {
      }
    }
    cloned.x = Math.round(x);
    cloned.y = Math.round(y);
    return cloned;
  }
  async function rescaleText(node, targetWidth, minSize = 14, maxSize = 200) {
    if (!node || node.type !== "TEXT")
      return;
    const t = node;
    if (typeof t.fontSize !== "number")
      return;
    const origSize = t.fontSize;
    const origWidth = Math.max(1, t.width);
    const ratio = targetWidth / origWidth;
    const newSize = Math.max(minSize, Math.min(maxSize, Math.round(origSize * ratio)));
    if (typeof t.fontName === "object" && "family" in t.fontName) {
      await figma.loadFontAsync(t.fontName);
    }
    t.fontSize = newSize;
    t.textAutoResize = "HEIGHT";
    try {
      t.resize(targetWidth, t.height);
    } catch (e) {
    }
  }
  async function renderCenteredHero(frame, ratio, b) {
    const sz = ratio.safeZone;
    const cx = sz.left, cy = sz.top;
    const cw = ratio.width - sz.left - sz.right;
    if (b.logo) {
      await placeClone(frame, b.logo, cx, cy, 200, 80, "contain");
    }
    let headlineBottom = cy + 100;
    if (b.headline) {
      const placed = await placeClone(frame, b.headline, cx, cy + 120, cw, 200, "fit-width");
      await rescaleText(placed, cw, 32, 96);
      if (placed)
        headlineBottom = placed.y + placed.height;
    }
    let subtitleBottom = headlineBottom;
    if (b.subtitle) {
      const placed = await placeClone(frame, b.subtitle, cx, headlineBottom + 20, cw, 80, "fit-width");
      await rescaleText(placed, cw * 0.7, 18, 36);
      if (placed)
        subtitleBottom = placed.y + placed.height;
    }
    let ctaTop = ratio.height - sz.bottom;
    if (b.cta) {
      const ctaW = Math.min(420, cw * 0.55);
      const ctaH = 80;
      const ctaX = cx + (cw - ctaW) / 2;
      const ctaY = ratio.height - sz.bottom - ctaH;
      await placeClone(frame, b.cta, ctaX, ctaY, ctaW, ctaH, "fit-box");
      ctaTop = ctaY;
    }
    if (b.hero) {
      const heroTop = subtitleBottom + 40;
      const heroBottom = ctaTop - 40;
      const availH = Math.max(200, heroBottom - heroTop);
      const placed = await placeClone(frame, b.hero, 0, 0, cw, availH, "contain");
      if (placed) {
        placed.x = Math.round(cx + (cw - placed.width) / 2);
        placed.y = Math.round(heroTop + (availH - placed.height) / 2);
      }
    }
  }
  async function renderStoryStack(frame, ratio, b) {
    const sz = ratio.safeZone;
    const cx = sz.left, cy = sz.top;
    const cw = ratio.width - sz.left - sz.right;
    let logoBottom = cy;
    if (b.logo) {
      const placed = await placeClone(frame, b.logo, 0, cy, 240, 100, "contain");
      if (placed) {
        placed.x = Math.round(cx + (cw - placed.width) / 2);
        logoBottom = placed.y + placed.height;
      }
    }
    let ctaTop = ratio.height - sz.bottom;
    if (b.cta) {
      const ctaW = Math.min(560, cw * 0.8);
      const ctaH = 100;
      const ctaX = cx + (cw - ctaW) / 2;
      const ctaY = ratio.height - sz.bottom - ctaH;
      await placeClone(frame, b.cta, ctaX, ctaY, ctaW, ctaH, "fit-box");
      ctaTop = ctaY;
    }
    let subtitleTop = ctaTop - 40;
    if (b.subtitle) {
      const placed = await placeClone(frame, b.subtitle, cx, 0, cw, 100, "fit-width");
      await rescaleText(placed, cw * 0.85, 20, 40);
      if (placed) {
        placed.y = Math.round(ctaTop - 40 - placed.height);
        placed.x = Math.round(cx + (cw - placed.width) / 2);
        subtitleTop = placed.y;
      }
    }
    let headlineTop = subtitleTop - 30;
    if (b.headline) {
      const placed = await placeClone(frame, b.headline, cx, 0, cw, 300, "fit-width");
      await rescaleText(placed, cw, 56, 130);
      if (placed) {
        placed.y = Math.round(subtitleTop - 30 - placed.height);
        placed.x = Math.round(cx + (cw - placed.width) / 2);
        headlineTop = placed.y;
      }
    }
    if (b.hero) {
      const heroTop = logoBottom + 40;
      const heroBottom = headlineTop - 40;
      const availH = Math.max(300, heroBottom - heroTop);
      const placed = await placeClone(frame, b.hero, 0, 0, cw, availH, "contain");
      if (placed) {
        placed.x = Math.round(cx + (cw - placed.width) / 2);
        placed.y = Math.round(heroTop + (availH - placed.height) / 2);
      }
    }
  }
  async function renderSplitEditorial(frame, ratio, b) {
    const sz = ratio.safeZone;
    const cx = sz.left, cy = sz.top;
    const cw = ratio.width - sz.left - sz.right;
    const ch = ratio.height - sz.top - sz.bottom;
    const leftW = Math.round(cw * 0.45);
    const gap = 32;
    const rightW = cw - leftW - gap;
    const rightX = cx + leftW + gap;
    let textTop = cy;
    if (b.logo) {
      const placed = await placeClone(frame, b.logo, cx, cy, 160, 56, "contain");
      if (placed)
        textTop = placed.y + placed.height + 16;
    }
    let headlineBottom = textTop;
    if (b.headline) {
      const placed = await placeClone(frame, b.headline, cx, textTop, leftW, 200, "fit-width");
      await rescaleText(placed, leftW, 28, 64);
      if (placed)
        headlineBottom = placed.y + placed.height;
    }
    if (b.subtitle) {
      const placed = await placeClone(frame, b.subtitle, cx, headlineBottom + 12, leftW, 80, "fit-width");
      await rescaleText(placed, leftW * 0.95, 14, 24);
    }
    if (b.cta) {
      const ctaW = Math.min(220, leftW * 0.7);
      const ctaH = 56;
      const ctaY = ratio.height - sz.bottom - ctaH;
      await placeClone(frame, b.cta, cx, ctaY, ctaW, ctaH, "fit-box");
    }
    if (b.hero) {
      const placed = await placeClone(frame, b.hero, 0, 0, rightW, ch, "contain");
      if (placed) {
        placed.x = Math.round(rightX + (rightW - placed.width) / 2);
        placed.y = Math.round(cy + (ch - placed.height) / 2);
      }
    }
  }
})();
