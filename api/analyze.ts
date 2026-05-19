// ============================================================
// AdFlow AI — /api/analyze
// Bulletproof version: no external type imports, wrapped in
// global try/catch, returns detailed errors instead of crashing.
// ============================================================

export const config = {
  maxDuration: 60,
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
- importance: 1-10
- suggested_name: имя по соглашению (например 'cta-primary')
- reasoning: 1 предложение на русском

Также верни structural_issues:
- hierarchy_unclear, no_cta, cta_no_emphasis, logo_too_small, text_overflow, low_contrast, overcrowded

ВАЖНО: верни роль ДЛЯ КАЖДОГО слоя из дерева, используя его node_id.`;

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

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function compactLayout(node: any): any {
  if (!node) return node;
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
    out.text = String(node.text).length > 120 ? String(node.text).slice(0, 120) + '…' : node.text;
  }
  if (node.fontSize) out.fontSize = node.fontSize;
  if (node.fontWeight) out.fontWeight = node.fontWeight;
  if (node.color) out.color = node.color;
  if (node.fills && node.fills.length) {
    const f = node.fills[0];
    if (f && f.color) out.fill = f.color;
  }
  if (node.children && node.children.length) {
    out.children = node.children.map(compactLayout);
  }
  return out;
}

// ---------- Handler ----------

export default async function handler(req: any, res: any) {
  // Global error trap: ANY exception below returns JSON instead of crashing.
  try {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed', method: req.method });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: 'OPENAI_API_KEY is not configured on Vercel.',
        hint: 'Add it in Project Settings → Environment Variables, then Redeploy.',
      });
      return;
    }

    // Parse body safely
    let body: any;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e: any) {
      res.status(400).json({ error: 'Invalid JSON in request body', detail: String(e?.message || e) });
      return;
    }
    if (!body) {
      res.status(400).json({ error: 'Empty request body' });
      return;
    }
    if (!body.layoutJson || !body.screenshotBase64) {
      res.status(400).json({
        error: 'Missing layoutJson or screenshotBase64',
        got_keys: Object.keys(body || {}),
      });
      return;
    }

    const model = process.env.OPENAI_MODEL || 'gpt-5.5-2026-04-23';
    const isReasoningModel = /^(gpt-5|o1|o3|o4)/i.test(model);
    const compactedLayout = compactLayout(body.layoutJson);

    const userText =
      `Frame: ${body.frameWidth}×${body.frameHeight} px.\n\n` +
      `Дерево слоёв (JSON):\n` +
      '```json\n' +
      JSON.stringify(compactedLayout) +
      '\n```\n\n' +
      `Скриншот макета — на изображении ниже.`;

    const requestBody: any = {
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_image', image_url: `data:image/png;base64,${body.screenshotBase64}` },
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
    if (isReasoningModel) {
      requestBody.reasoning = { effort: 'medium' };
    }

    let ai: Response;
    try {
      ai = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (e: any) {
      res.status(502).json({
        error: 'Network error calling OpenAI',
        detail: String(e?.message || e),
      });
      return;
    }

    if (!ai.ok) {
      const errText = await ai.text().catch(() => '');
      console.error('OpenAI error:', ai.status, errText);
      res.status(502).json({
        error: 'OpenAI API error',
        status: ai.status,
        model,
        detail: errText.slice(0, 600),
      });
      return;
    }

    const data: any = await ai.json();
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
      res.status(502).json({
        error: 'No text output from model',
        sample: JSON.stringify(data).slice(0, 600),
      });
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.status(502).json({ error: 'Model returned non-JSON', raw: raw.slice(0, 600) });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(parsed);
  } catch (err: any) {
    // Last-resort catch-all so we never crash the function
    console.error('Unhandled error:', err);
    try {
      res.status(500).json({
        error: 'Unhandled server error',
        detail: String(err?.message || err),
        stack: String(err?.stack || '').slice(0, 800),
      });
    } catch {
      // If even sending JSON fails, give up silently — Vercel will log the trace.
    }
  }
}
