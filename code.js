"use strict";
(() => {
  // code.ts
  figma.showUI(__html__, { width: 420, height: 640, themeColors: true });
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
  figma.ui.onmessage = async (msg) => {
    try {
      if (msg.type === "analyze") {
        await handleAnalyze();
      } else if (msg.type === "apply-name") {
        await handleApplyName(msg.nodeId, msg.newName);
      } else if (msg.type === "apply-all-names") {
        await handleApplyAllNames(msg.renames);
      } else if (msg.type === "focus-node") {
        await handleFocusNode(msg.nodeId);
      } else if (msg.type === "close") {
        figma.closePlugin();
      }
    } catch (err) {
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
      if (typeof t.fontName === "object" && "style" in t.fontName) {
        const style = t.fontName.style.toLowerCase();
        if (style.includes("thin"))
          base.fontWeight = 100;
        else if (style.includes("extralight") || style.includes("ultralight"))
          base.fontWeight = 200;
        else if (style.includes("light"))
          base.fontWeight = 300;
        else if (style.includes("medium"))
          base.fontWeight = 500;
        else if (style.includes("semibold") || style.includes("demibold"))
          base.fontWeight = 600;
        else if (style.includes("extrabold") || style.includes("ultrabold"))
          base.fontWeight = 800;
        else if (style.includes("black") || style.includes("heavy"))
          base.fontWeight = 900;
        else if (style.includes("bold"))
          base.fontWeight = 700;
        else
          base.fontWeight = 400;
      }
      base.textAlign = t.textAlignHorizontal;
      if (Array.isArray(t.fills) && t.fills.length > 0) {
        const f = t.fills[0];
        if (f.type === "SOLID") {
          base.color = rgbToHex(f.color);
        }
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
      const kids = node.children;
      for (const child of kids) {
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
      figma.ui.postMessage({ type: "error", message: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u044B\u0439 frame." });
      return;
    }
    const total = countNodes(layoutJson);
    if (total > 300) {
      figma.ui.postMessage({
        type: "error",
        message: `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0441\u043B\u043E\u0451\u0432: ${total}. \u041B\u0438\u043C\u0438\u0442 300 \u0434\u043B\u044F MVP.`
      });
      return;
    }
    figma.ui.postMessage({ type: "progress", stage: "screenshot", message: "\u0414\u0435\u043B\u0430\u044E \u0441\u043A\u0440\u0438\u043D\u0448\u043E\u0442 \u043C\u0430\u043A\u0435\u0442\u0430\u2026" });
    const bytes = await target.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 1 }
    });
    const base64 = figma.base64Encode(bytes);
    figma.ui.postMessage({ type: "progress", stage: "sending", message: "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E GPT-5.5\u2026" });
    figma.ui.postMessage({
      type: "analyze-payload",
      layoutJson,
      screenshotBase64: base64,
      frameWidth: Math.round(target.width),
      frameHeight: Math.round(target.height),
      totalNodes: total
    });
  }
  async function handleApplyName(nodeId, newName) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && "name" in node) {
      node.name = newName;
      figma.ui.postMessage({ type: "name-applied", nodeId, newName });
    }
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
})();
