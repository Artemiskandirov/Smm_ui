// ============================================================
// AdFlow AI — /api/analyze
// Vercel serverless function. Receives layout JSON + screenshot
// from Figma plugin, calls OpenAI Responses API with vision,
// returns structured semantic map.
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  maxDuration: 60,
};

// ---------- Types ----------

type LayoutNode = {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  fills?: Array<{ type: string; color?: string }>;
  children: LayoutNode[];
};

type AnalyzeBody = {
  layoutJson: LayoutNode;
  screenshotBase64: string;
  frameWidth: number;
  frameHeight: number;
};

// ---------- System prompt ----------

const SYSTEM_PROMPT = `Ты — анализатор рекламных макетов. Тебе дано JSON-дерево слоёв Figma и скриншот итогового макета.

Для каждого слоя верни его семантическую роль и confidence. Роли:
- headline: главный заголовок (обычно самый крупный текст)
- subtitle: вспомогательный заголовок
- body: основной текст / описание
- cta: призыв к действию (кнопка)
- logo: логотип бренда
- hero_image: главное изображение / продукт
- product: товар на изображении
- decorative: декоративный элемент
- background: фон
- icon: иконка
- unknown: не удалось определить

Дополнительно для каждого слоя:
- importance: 1-10 (1=можно убрать без потери, 10=критично)
- suggested_name: имя по соглашению (например 'cta-primary', 'headline-main')
- reasoning: 1 предложение на русском, почему именно эта роль

Также верни structural_issues — что не так с макетом перед генерацией вариаций:
- hierarchy_unclear, no_cta, cta_no_emphasis, logo_too_small, text_overflow, low_contrast, overcrowded

Verdict ready_for_generation:
- true: можно генерировать вариации
- false: есть critical structural issues

Имена ролей и типов проблем — английскими константами как указано выше.
Поля reasoning / fix_suggestion / summary — только на русском.

ВАЖНО: верни роль ДЛЯ КАЖДОГО слоя из дерева (включая вложенные), используя его node_id.`;

// ---------- JSON Schema ----------

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layers', 'structural_issues', 'overall_assessment'],
  properties: {
    layers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'semantic_role', 'confidence', 'importance', 'suggested_name', 'reasoning'],
        properties: {
          node_id: { type: 'string' },
          semantic_role: {
            type: 'string',
            enum: ['headline', 'subtitle', 'body', 'cta', 'logo', 'hero_image', 'product', 'decorative', 'background', 'icon', 'unknown'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          importance: { type: 'integer', minimum: 1, maximum: 10 },
          suggested_name: { type: 'string' },
          reasoning: { type: 'string' },
        },
      },
    },
    structural_issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'affected_node_ids', 'severity', 'fix_suggestion'],
        properties: {
          type: {
            type: 'string',
            enum: ['hierarchy_unclear', 'no_cta', 'cta_no_emphasis', 'logo_too_small', 'text_overflow', 'low_contrast', 'overcrowded'],
          },
          affected_node_ids: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
          fix_suggestion: { type: 'string' },
        },
      },
    },
    overall_assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['ready_for_generation', 'blockers', 'summary'],
      properties: {
        ready_for_generation: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
    },
  },
};

// ---------- Helpers ----------

function setCors(res: VercelResponse, origin: string | undefined) {
  // Figma plugin iframe origin is "null" — we accept that plus any explicit allow-list.
  const allowed = (process.env.ALLOWED_ORIGINS || 'null,https://www.figma.com,https://figma.com')
    .split(',').map(s => s.trim());
  const ok = origin && allowed.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', ok ? origin! : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Trim layout JSON to keep prompt size sane.
// We keep tree structure but drop verbose fields on leaves.
function compactLayout(node: LayoutNode): any {
  const out: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
  };
  if (node.text !== undefined) {
    // Truncate very long text to save tokens
    out.text = node.text.length > 120 ? node.text.slice(0, 120) + '…' : node.text;
  }
  if (node.fontSize) out.fontSize = node.fontSize;
  if (node.fontWeight) out.fontWeight = node.fontWeight;
  if (node.color) out.color = node.color;
  if (node.fills && node.fills.length) {
    const f = node.fills[0];
    if (f.color) out.fill = f.color;
  }
  if (node.children && node.children.length) {
    out.children = node.children.map(compactLayout);
  }
  return out;
}

// ---------- Handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string | undefined;
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on Vercel.' });
  }

  let body: AnalyzeBody;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!body?.layoutJson || !body?.screenshotBase64) {
    return res.status(400).json({ error: 'Missing layoutJson or screenshotBase64' });
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.5-2026-04-23';
  // reasoning-серия (gpt-5, o1, o3, o4) принимает поле `reasoning.effort`,
  // обычные модели (gpt-4o, gpt-4.1) — нет, иначе 400.
  const isReasoningModel = /^(gpt-5|o1|o3|o4)/i.test(model);
  const compactedLayout = compactLayout(body.layoutJson);

  const userText =
    `Frame: ${body.frameWidth}×${body.frameHeight} px.\n\n` +
    `Дерево слоёв (JSON):\n` +
    '```json\n' +
    JSON.stringify(compactedLayout) +
    '\n```\n\n' +
    `Скриншот макета — на изображении ниже. Проанализируй и верни семантическую карту по схеме.`;

  const requestBody: any = {
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: SYSTEM_PROMPT }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: userText },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${body.screenshotBase64}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'ad_semantic_map',
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  };

  // Reasoning параметр поддерживают только gpt-5 / o1 / o3 / o4.
  if (isReasoningModel) {
    requestBody.reasoning = { effort: 'medium' };
  }

  try {
    const ai = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!ai.ok) {
      const errText = await ai.text();
      console.error('OpenAI error:', ai.status, errText);
      return res.status(502).json({
        error: 'OpenAI API error',
        status: ai.status,
        detail: errText.slice(0, 500),
      });
    }

    const data = await ai.json();

    // The Responses API returns either `output_text` directly or
    // an array `output[].content[].text`. Try both.
    let raw: string | null = null;
    if (typeof data.output_text === 'string' && data.output_text.length) {
      raw = data.output_text;
    } else if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
              raw = c.text;
              break;
            }
          }
        }
        if (raw) break;
      }
    }

    if (!raw) {
      return res.status(502).json({
        error: 'No text output from model',
        sample: JSON.stringify(data).slice(0, 600),
      });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      return res.status(502).json({
        error: 'Model returned non-JSON',
        raw: raw.slice(0, 600),
      });
    }

    // Cache for 5 minutes (CDN)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err?.message || 'Unknown error' });
  }
}
