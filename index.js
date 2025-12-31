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

  const noFences = raw
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();

  const match = noFences.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0].trim() : noFences;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeStatus(s) {
  const v = String(s || "").trim();
  if (v === "verificado" || v === "pendiente_revision" || v === "rechazado") return v;
  return "pendiente_revision";
}

function ensureReasons(ia, expectedAmount, expectedDate) {
  const status = normalizeStatus(ia?.suggested_status);
  let reasons = [];

  if (Array.isArray(ia?.reasons)) {
    reasons = ia.reasons
      .map((x) => (x == null ? "" : String(x).trim()))
      .filter((x) => x.length > 0);
  }

  // ✅ SIEMPRE mínimo 1 razón
  if (reasons.length === 0) {
    if (status === "verificado") {
      reasons = [
        `Monto y fecha coinciden con lo esperado (${expectedAmount} / ${expectedDate}).`,
      ];
    } else if (status === "rechazado") {
      reasons = [
        `No coincide con lo esperado (${expectedAmount} / ${expectedDate}).`,
        "Revisión manual recomendada.",
      ];
    } else {
      reasons = [
        "No se pudo confirmar con certeza el monto o la fecha en la imagen.",
        "Revisión manual recomendada.",
      ];
    }
  }

  ia.reasons = reasons.slice(0, 8);
  ia.suggested_status = status;
  return ia;
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

    // ✅ MÁS ESTRICTO: reasons mín. 1 (inclusive verificado)
    const system =
      "Eres un verificador de comprobantes de consignación en Colombia. " +
      "Tu trabajo: comparar el comprobante con lo esperado. " +
      "Responde SOLO JSON válido, sin markdown, sin ```.\n\n" +
      "REGLAS OBLIGATORIAS:\n" +
      "1) reasons SIEMPRE debe tener al menos 1 elemento (inclusive si es verificado).\n" +
      "2) suggested_status solo puede ser: verificado | pendiente_revision | rechazado.\n" +
      "3) confidence debe estar entre 0 y 1.\n" +
      "4) reasons deben ser frases cortas y claras para humanos (cobradores).\n";

    const user = `DATOS ESPERADOS:
- expectedAmount: ${expectedAmount}
- expectedDate (YYYY-MM-DD): ${expectedDate}

Devuelve SOLO este JSON (sin texto adicional):
{
  "ok": boolean,
  "confidence": number, 
  "suggested_status": "verificado" | "pendiente_revision" | "rechazado",
  "reasons": string[]
}

IMPORTANTE:
- reasons debe contener MINIMO 1 razón, incluso si está verificado.
- Si está verificado: incluye razón tipo "Monto y fecha coinciden".
- Si rechaza: explica qué no coincide (monto o fecha).
- Si queda pendiente: explica por qué no se puede confirmar (borroso, falta info, etc.).`;

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

    // ✅ Parse robusto
    let ia = extractJson(out);

    // fallback si no parsea
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

    // confidence en rango 0..1
    if (typeof ia.confidence !== "number" || Number.isNaN(ia.confidence)) ia.confidence = 0;
    ia.confidence = Math.max(0, Math.min(1, ia.confidence));

    ia.suggested_status = normalizeStatus(ia.suggested_status);

    // ✅ razones reales siempre (post-procesado)
    ia = ensureReasons(ia, expectedAmount, expectedDate);

    ia.debug = { reqId, ms: Date.now() - t0, model };

    console.log(`[${reqId}] ✅ OK in ${Date.now() - t0}ms status=${ia.suggested_status}`);
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
