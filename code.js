"use strict";
(() => {
  // code.ts
  var BUILTIN_RATIOS = [
    // Instagram
    { id: "ig_post", name: "Instagram Post", group: "Instagram", width: 1080, height: 1080, builtin: true },
    { id: "ig_story", name: "Instagram Story", group: "Instagram", width: 1080, height: 1920, builtin: true },
    { id: "ig_landscape", name: "Instagram Landscape", group: "Instagram", width: 1080, height: 566, builtin: true },
    // Facebook
    { id: "fb_feed", name: "Facebook Feed", group: "Facebook", width: 1200, height: 628, builtin: true },
    { id: "fb_story", name: "Facebook Story", group: "Facebook", width: 1080, height: 1920, builtin: true },
    // YouTube
    { id: "yt_thumb", name: "YouTube Thumbnail", group: "YouTube", width: 1280, height: 720, builtin: true },
    { id: "yt_shorts", name: "YouTube Shorts", group: "YouTube", width: 1080, height: 1920, builtin: true },
    // Twitter / X
    { id: "twitter_post", name: "Twitter / X Post", group: "Twitter", width: 1600, height: 900, builtin: true },
    // LinkedIn
    { id: "linkedin_post", name: "LinkedIn Post", group: "LinkedIn", width: 1200, height: 627, builtin: true },
    // TikTok
    { id: "tiktok", name: "TikTok", group: "TikTok", width: 1080, height: 1920, builtin: true },
    // Pinterest
    { id: "pinterest_pin", name: "Pinterest Pin", group: "Pinterest", width: 1e3, height: 1500, builtin: true },
    // Email
    { id: "email_header", name: "Email Header", group: "Other", width: 1200, height: 400, builtin: true }
  ];
  var CUSTOM_RATIOS_KEY = "adflow.custom-ratios.v1";
  var lastAnalyze = null;
  figma.showUI(__html__, { width: 460, height: 760, themeColors: true });
  async function bootstrap() {
    sendSelection();
    figma.ui.postMessage({ type: "builtin-ratios", presets: BUILTIN_RATIOS });
    const customs = await loadCustomRatios();
    figma.ui.postMessage({ type: "custom-ratios", presets: customs });
  }
  bootstrap();
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
  figma.on("selectionchange", sendSelection);
  async function loadCustomRatios() {
    try {
      const raw = await figma.clientStorage.getAsync(CUSTOM_RATIOS_KEY);
      if (Array.isArray(raw))
        return raw;
      return [];
    } catch (e) {
      return [];
    }
  }
  async function saveCustomRatios(list) {
    await figma.clientStorage.setAsync(CUSTOM_RATIOS_KEY, list);
  }
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
        await handleGenerate(msg.ratios, msg.mode || "smart");
      } else if (msg.type === "add-custom-ratio") {
        await handleAddCustomRatio(msg.name, msg.width, msg.height);
      } else if (msg.type === "delete-custom-ratio") {
        await handleDeleteCustomRatio(msg.id);
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
  async function handleAddCustomRatio(name, width, height) {
    const list = await loadCustomRatios();
    const id = "custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    list.push({ id, name: name || `${width}\xD7${height}`, width, height, group: "Custom", builtin: false });
    await saveCustomRatios(list);
    figma.ui.postMessage({ type: "custom-ratios", presets: list });
    figma.notify(`\u2713 \u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D \u0444\u043E\u0440\u043C\u0430\u0442: ${name}`);
  }
  async function handleDeleteCustomRatio(id) {
    const list = await loadCustomRatios();
    const filtered = list.filter((r) => r.id !== id);
    await saveCustomRatios(filtered);
    figma.ui.postMessage({ type: "custom-ratios", presets: filtered });
  }
  async function handleGenerate(ratios, mode) {
    if (!lastAnalyze) {
      figma.ui.postMessage({ type: "error", message: "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u043F\u0443\u0441\u0442\u0438 Analyze." });
      return;
    }
    const master = await figma.getNodeByIdAsync(lastAnalyze.masterFrameId);
    if (!master || master.type !== "FRAME" && master.type !== "COMPONENT" && master.type !== "INSTANCE") {
      figma.ui.postMessage({ type: "error", message: "Master frame \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D." });
      return;
    }
    if (ratios.length === 0) {
      figma.ui.postMessage({ type: "error", message: "\u0412\u044B\u0431\u0435\u0440\u0438 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u0438\u043D \u0444\u043E\u0440\u043C\u0430\u0442." });
      return;
    }
    const masterFrame = master;
    figma.ui.postMessage({
      type: "progress",
      stage: "generating",
      message: `\u0413\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E ${ratios.length} \u0432\u0430\u0440\u0438\u0430\u0446\u0438\u0439 (${mode === "smart" ? "smart" : "simple"})\u2026`
    });
    await loadAllFontsIn(masterFrame);
    let cursorY = masterFrame.y;
    const startX = masterFrame.x + masterFrame.width + 200;
    const createdIds = [];
    for (const ratio of ratios) {
      let created = null;
      try {
        if (mode === "smart") {
          created = await generateSmart(masterFrame, ratio, startX, cursorY);
        } else {
          created = await generateSimple(masterFrame, ratio, startX, cursorY);
        }
      } catch (e) {
        console.error("Failed to generate", ratio.name, e);
      }
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
  async function generateSimple(master, ratio, x, y) {
    const frame = createTargetFrame(master, ratio, x, y);
    const padding = 0.92;
    const fitScale = Math.max(0.05, Math.min(ratio.width / master.width, ratio.height / master.height) * padding);
    const scaledW = master.width * fitScale;
    const scaledH = master.height * fitScale;
    const offsetX = (ratio.width - scaledW) / 2;
    const offsetY = (ratio.height - scaledH) / 2;
    for (const child of master.children) {
      let cloned;
      try {
        cloned = child.clone();
      } catch (e) {
        continue;
      }
      const origX = child.x, origY = child.y;
      frame.appendChild(cloned);
      try {
        if ("rescale" in cloned && fitScale >= 0.01 && Math.abs(fitScale - 1) > 1e-3) {
          cloned.rescale(fitScale);
        }
      } catch (e) {
      }
      cloned.x = Math.round(origX * fitScale + offsetX);
      cloned.y = Math.round(origY * fitScale + offsetY);
    }
    return frame;
  }
  function pickTemplate(w, h) {
    const aspect = w / h;
    if (aspect <= 0.7)
      return "portrait_tall";
    if (aspect >= 1.4)
      return "landscape_wide";
    if (aspect >= 1.1)
      return "landscape_close";
    return "square";
  }
  async function generateSmart(master, ratio, x, y) {
    const frame = createTargetFrame(master, ratio, x, y);
    const heroNode = await resolveFirst(["hero_image", "product"]);
    const headlineNode = await resolveFirst(["headline"]);
    const subtitleNode = await resolveFirst(["subtitle"]);
    const ctaNode = await resolveFirst(["cta"]);
    const logoNode = await resolveFirst(["logo"]);
    const hasMeaningfulRoles = [heroNode, headlineNode, ctaNode, logoNode].filter(Boolean).length >= 2;
    const bgPadding = 0.92;
    const bgScale = Math.max(0.05, Math.min(ratio.width / master.width, ratio.height / master.height) * bgPadding);
    const bgChildren = [];
    for (const child of master.children) {
      let cloned;
      try {
        cloned = child.clone();
      } catch (e) {
        continue;
      }
      const origX = child.x, origY = child.y;
      frame.appendChild(cloned);
      try {
        if ("rescale" in cloned && bgScale >= 0.01 && Math.abs(bgScale - 1) > 1e-3) {
          cloned.rescale(bgScale);
        }
      } catch (e) {
      }
      cloned.x = Math.round(origX * bgScale + (ratio.width - master.width * bgScale) / 2);
      cloned.y = Math.round(origY * bgScale + (ratio.height - master.height * bgScale) / 2);
      bgChildren.push({ clone: cloned, origId: child.id });
    }
    if (!hasMeaningfulRoles) {
      return frame;
    }
    const roleNodeIds = /* @__PURE__ */ new Set();
    [heroNode, headlineNode, subtitleNode, ctaNode, logoNode].forEach((n) => {
      if (n)
        roleNodeIds.add(n.id);
    });
    for (const { clone, origId } of bgChildren) {
      const originalChild = master.children.find((c) => c.id === origId);
      if (!originalChild)
        continue;
      removeMatchingNodesInClone(originalChild, clone, roleNodeIds);
    }
    const template = pickTemplate(ratio.width, ratio.height);
    const roles = {
      hero: heroNode,
      headline: headlineNode,
      subtitle: subtitleNode,
      cta: ctaNode,
      logo: logoNode
    };
    switch (template) {
      case "square":
        await applySquareLayout(frame, ratio, roles);
        break;
      case "portrait_tall":
        await applyPortraitLayout(frame, ratio, roles);
        break;
      case "landscape_wide":
        await applyLandscapeWideLayout(frame, ratio, roles);
        break;
      case "landscape_close":
        await applyLandscapeCloseLayout(frame, ratio, roles);
        break;
    }
    return frame;
  }
  async function resolveFirst(roles) {
    if (!lastAnalyze)
      return null;
    for (const role of roles) {
      const entries = lastAnalyze.byRole[role] || [];
      for (const e of entries) {
        const n = await figma.getNodeByIdAsync(e.node_id);
        if (n && n.type !== "DOCUMENT" && n.type !== "PAGE") {
          return n;
        }
      }
    }
    return null;
  }
  function createTargetFrame(master, ratio, x, y) {
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
    return frame;
  }
  function removeMatchingNodesInClone(original, clone, targetIds) {
    if (targetIds.has(original.id)) {
      try {
        clone.remove();
      } catch (e) {
      }
      return;
    }
    if (!("children" in original) || !("children" in clone))
      return;
    const origKids = original.children;
    const cloneKids = clone.children;
    const n = Math.min(origKids.length, cloneKids.length);
    for (let i = n - 1; i >= 0; i--) {
      removeMatchingNodesInClone(origKids[i], cloneKids[i], targetIds);
    }
  }
  async function placeRole(target, source, maxW, maxH) {
    let cloned;
    try {
      cloned = source.clone();
    } catch (e) {
      return null;
    }
    target.appendChild(cloned);
    const srcW = Math.max(1, source.width);
    const srcH = Math.max(1, source.height);
    const scale = Math.min(maxW / srcW, maxH / srcH);
    if (scale >= 0.01 && Math.abs(scale - 1) > 1e-3) {
      try {
        if ("rescale" in cloned)
          cloned.rescale(scale);
      } catch (e) {
      }
    }
    return cloned;
  }
  function positionAt(node, x, y) {
    node.x = Math.round(x);
    node.y = Math.round(y);
  }
  function centerHorizontally(node, frame, y) {
    node.x = Math.round((frame.width - node.width) / 2);
    node.y = Math.round(y);
  }
  async function applySquareLayout(frame, ratio, r) {
    const pad = ratio.width * 0.06;
    const w = ratio.width - pad * 2;
    const h = ratio.height - pad * 2;
    if (r.logo) {
      const node = await placeRole(frame, r.logo, w * 0.22, h * 0.1);
      if (node)
        positionAt(node, pad, pad);
    }
    let headlineBottom = pad + h * 0.1;
    if (r.headline) {
      const node = await placeRole(frame, r.headline, w * 0.88, h * 0.2);
      if (node) {
        centerHorizontally(node, frame, pad + h * 0.16);
        headlineBottom = node.y + node.height;
      }
    }
    let subtitleBottom = headlineBottom;
    if (r.subtitle) {
      const node = await placeRole(frame, r.subtitle, w * 0.78, h * 0.08);
      if (node) {
        centerHorizontally(node, frame, headlineBottom + 16);
        subtitleBottom = node.y + node.height;
      }
    }
    let ctaTop = ratio.height - pad;
    if (r.cta) {
      const node = await placeRole(frame, r.cta, w * 0.55, h * 0.1);
      if (node) {
        const yPos = ratio.height - pad - node.height;
        centerHorizontally(node, frame, yPos);
        ctaTop = yPos;
      }
    }
    if (r.hero) {
      const heroTop = subtitleBottom + h * 0.04;
      const heroBottom = ctaTop - h * 0.04;
      const availH = Math.max(80, heroBottom - heroTop);
      const node = await placeRole(frame, r.hero, w * 0.8, availH);
      if (node) {
        node.x = Math.round((frame.width - node.width) / 2);
        node.y = Math.round(heroTop + (availH - node.height) / 2);
      }
    }
  }
  async function applyPortraitLayout(frame, ratio, r) {
    const pad = ratio.width * 0.06;
    const w = ratio.width - pad * 2;
    let logoBottom = ratio.height * 0.1;
    if (r.logo) {
      const node = await placeRole(frame, r.logo, w * 0.3, ratio.height * 0.06);
      if (node) {
        centerHorizontally(node, frame, ratio.height * 0.06);
        logoBottom = node.y + node.height;
      }
    }
    let ctaTop = ratio.height * 0.9;
    if (r.cta) {
      const node = await placeRole(frame, r.cta, w * 0.8, ratio.height * 0.08);
      if (node) {
        const yPos = ratio.height - ratio.height * 0.08 - node.height;
        centerHorizontally(node, frame, yPos);
        ctaTop = yPos;
      }
    }
    let subtitleTop = ctaTop - 20;
    if (r.subtitle) {
      const node = await placeRole(frame, r.subtitle, w * 0.85, ratio.height * 0.06);
      if (node) {
        const yPos = ctaTop - 24 - node.height;
        centerHorizontally(node, frame, yPos);
        subtitleTop = yPos;
      }
    }
    let headlineTop = subtitleTop - 20;
    if (r.headline) {
      const node = await placeRole(frame, r.headline, w * 0.92, ratio.height * 0.2);
      if (node) {
        const yPos = subtitleTop - 28 - node.height;
        centerHorizontally(node, frame, yPos);
        headlineTop = yPos;
      }
    }
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
  async function applyLandscapeWideLayout(frame, ratio, r) {
    const padX = ratio.width * 0.04;
    const padY = ratio.height * 0.06;
    const gap = ratio.width * 0.03;
    const leftW = (ratio.width - padX * 2 - gap) * 0.48;
    const rightW = (ratio.width - padX * 2 - gap) * 0.52;
    const contentH = ratio.height - padY * 2;
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
      const node = await placeRole(frame, r.cta, leftW * 0.6, contentH * 0.16);
      if (node) {
        positionAt(node, padX, ratio.height - padY - node.height);
      }
    }
    if (r.hero) {
      const node = await placeRole(frame, r.hero, rightW, contentH);
      if (node) {
        const rightX = padX + leftW + gap;
        node.x = Math.round(rightX + (rightW - node.width) / 2);
        node.y = Math.round(padY + (contentH - node.height) / 2);
      }
    }
  }
  async function applyLandscapeCloseLayout(frame, ratio, r) {
    const padX = ratio.width * 0.05;
    const padY = ratio.height * 0.05;
    const w = ratio.width - padX * 2;
    let heroBottom = padY;
    if (r.hero) {
      const heroH = ratio.height * 0.5;
      const node = await placeRole(frame, r.hero, w, heroH);
      if (node) {
        node.x = Math.round((frame.width - node.width) / 2);
        node.y = Math.round(padY + (heroH - node.height) / 2);
        heroBottom = padY + heroH;
      }
    }
    if (r.logo) {
      const node = await placeRole(frame, r.logo, w * 0.18, ratio.height * 0.08);
      if (node)
        positionAt(node, padX, padY);
    }
    let ctaTop = ratio.height - padY;
    if (r.cta) {
      const node = await placeRole(frame, r.cta, w * 0.45, ratio.height * 0.12);
      if (node) {
        const yPos = ratio.height - padY - node.height;
        centerHorizontally(node, frame, yPos);
        ctaTop = yPos;
      }
    }
    const bandTop = heroBottom + ratio.height * 0.03;
    const bandBottom = ctaTop - ratio.height * 0.03;
    const bandH = Math.max(40, bandBottom - bandTop);
    let textY = bandTop;
    if (r.headline) {
      const node = await placeRole(frame, r.headline, w * 0.9, bandH * 0.6);
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
})();
