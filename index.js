// consignacion-ai-backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" })); // base64 pesa

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length < 10) {
    throw new Error("Falta OPENAI_API_KEY en Render Environment Variables");
  }
  return new OpenAI({ apiKey: key });
}

function short(s, n = 160) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) + "..." : s;
}

/**
 * ✅ Extrae JSON aunque venga envuelto en ```json ... ```
 * - elimina fences
 * - busca el primer bloque { ... }
 * - intenta JSON.parse
 */
function extractJson(text) {
  if (!text) return null;

  const raw = String(text).trim();

  // 1) quitar fences ```json ... ``` o ``` ... ```
  const noFences = raw
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();

  // 2) tomar primer bloque { ... }
  const match = noFences.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0].trim() : noFences;

  // 3) parsear
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/* =========================
   Health
========================= */
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "consignacion-ai-backend",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || "gpt-4o-mini",
    time: new Date().toISOString(),
  });
});

/* =========================
   verify-consignacion (BASE64)
   Flutter enviará:
   { imageBase64, imageMime, expectedAmount, expectedDate }
========================= */
app.post("/verify-consignacion", async (req, res) => {
  const t0 = Date.now();
  const reqId = Math.random().toString(16).slice(2, 10);

  try {
    const { imageBase64, imageMime, expectedAmount, expectedDate } = req.body || {};

    console.log(`\n[${reqId}] HIT /verify-consignacion`);
    console.log(`[${reqId}] expectedAmount=${expectedAmount} expectedDate=${expectedDate}`);
    console.log(
      `[${reqId}] imageMime=${imageMime} base64Len=${imageBase64 ? String(imageBase64).length : 0}`
    );

    if (!imageBase64 || !imageMime || expectedAmount == null || !expectedDate) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Faltan imageBase64, imageMime, expectedAmount o expectedDate"],
      });
    }

    // construir data URL
    const dataUrl = `data:${imageMime};base64,${imageBase64}`;

    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const system =
      "Eres un verificador de comprobantes de consignación en Colombia. " +
      "Extrae monto, fecha y banco/billetera. " +
      "Compara con lo esperado y responde SOLO JSON válido (sin ``` ni texto extra).";

    const user = `DATOS ESPERADOS:
- expectedAmount: ${expectedAmount}
- expectedDate (YYYY-MM-DD): ${expectedDate}

Devuelve SOLO este JSON (sin texto adicional, sin markdown, sin \`\`\`):
{
  "ok": boolean,
  "confidence": number,
  "suggested_status": "verificado" | "pendiente_revision" | "rechazado",
  "reasons": string[]
}`;

    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: user },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    const out = response.output_text || "";
    console.log(`[${reqId}] OpenAI output_text:`, short(out, 300));

    // ✅ Parse robusto (arregla el problema de ```json ... ```)
    let ia = extractJson(out);

    // fallback si aún no se pudo parsear
    if (!ia || typeof ia !== "object") {
      ia = {
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["La IA no devolvió JSON válido."],
        raw: short(out, 800),
      };
    }

    // normalizar
    if (typeof ia.ok !== "boolean") ia.ok = false;
    if (typeof ia.confidence !== "number") ia.confidence = 0;
    if (!ia.suggested_status) ia.suggested_status = "pendiente_revision";
    if (!Array.isArray(ia.reasons)) ia.reasons = [];

    ia.debug = { reqId, ms: Date.now() - t0, model };

    console.log(`[${reqId}] ✅ OK in ${Date.now() - t0}ms`);
    return res.json(ia);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    const data = e?.response?.data;

    console.error(`\n[ERR] /verify-consignacion FAIL`);
    console.error("[ERR] status:", status);
    console.error("[ERR] message:", msg);
    if (data) console.error("[ERR] data:", data);

    return res.status(500).json({
      ok: false,
      confidence: 0,
      suggested_status: "pendiente_revision",
      reasons: ["Error interno backend"],
      debug_error: {
        status: status ?? null,
        message: msg,
        data: data ?? null,
      },
    });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Server on port", port));
