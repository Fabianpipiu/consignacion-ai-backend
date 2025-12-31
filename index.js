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

function normalizeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function digitsOnly(x) {
  return normalizeStr(x).replace(/[^\d]/g, "");
}

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Estructura estándar de “campos extraídos”
 */
function ensureClienteResult(obj) {
  const out = obj && typeof obj === "object" ? obj : {};
  out.ok = typeof out.ok === "boolean" ? out.ok : false;

  // fields
  out.fields = out.fields && typeof out.fields === "object" ? out.fields : {};
  const f = out.fields;

  // Solo lo que tu formulario tiene (y algunos extra por si sirven)
  f.cedula = digitsOnly(f.cedula);
  f.nombre = normalizeStr(f.nombre);
  f.apellido = normalizeStr(f.apellido);
  f.telefono = digitsOnly(f.telefono);
  f.ocupacion = normalizeStr(f.ocupacion);
  f.direccion = normalizeStr(f.direccion);
  f.barrio = normalizeStr(f.barrio);
  f.observaciones = normalizeStr(f.observaciones);

  // meta por campo
  out.meta = out.meta && typeof out.meta === "object" ? out.meta : {};
  for (const k of ["cedula","nombre","apellido","telefono","ocupacion","direccion","barrio","observaciones"]) {
    const m = out.meta[k] && typeof out.meta[k] === "object" ? out.meta[k] : {};
    out.meta[k] = {
      confidence: clamp01(m.confidence),
      reason: normalizeStr(m.reason),
      source: normalizeStr(m.source), // "cedula_frente", "cedula_reverso", "whatsapp"
    };
  }

  // confidence global
  out.confidence = clamp01(out.confidence);

  // razones generales
  if (!Array.isArray(out.reasons)) out.reasons = [];
  out.reasons = out.reasons.map((x) => normalizeStr(x)).filter((x) => x.length > 0).slice(0, 10);

  // mínimos: si no pudo, deja razón
  const anyFilled = Object.values(f).some((v) => normalizeStr(v).length > 0);
  if (!anyFilled && out.reasons.length === 0) {
    out.reasons = ["No se pudo extraer información suficiente."];
  }

  return out;
}

function asDataUrl(imageMime, imageBase64) {
  return `data:${imageMime};base64,${imageBase64}`;
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

/* =========================================================
   ✅ NUEVO: extraer datos desde CÉDULA (frente + reverso)
   body:
   {
     frontBase64, frontMime,
     backBase64,  backMime
   }
========================================================= */
app.post("/extract-cliente-cedula", async (req, res) => {
  const t0 = Date.now();
  const reqId = Math.random().toString(16).slice(2, 10);

  try {
    const { frontBase64, frontMime, backBase64, backMime } = req.body || {};

    console.log(`\n[${reqId}] HIT /extract-cliente-cedula`);
    console.log(
      `[${reqId}] frontMime=${frontMime} frontLen=${frontBase64 ? String(frontBase64).length : 0}`
    );
    console.log(
      `[${reqId}] backMime=${backMime} backLen=${backBase64 ? String(backBase64).length : 0}`
    );

    if (!frontBase64 || !frontMime) {
      return res.status(400).json(
        ensureClienteResult({
          ok: false,
          confidence: 0,
          reasons: ["Falta frontBase64/frontMime (foto del frente de la cédula)."],
        })
      );
    }

    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const system =
      "Eres un extractor de datos para registro de clientes en Colombia. " +
      "Te enviaré fotos de una cédula (frente y a veces reverso). " +
      "Extrae SOLO los campos que puedas leer con claridad. " +
      "Responde SOLO JSON válido, sin markdown.\n\n" +
      "REGLAS:\n" +
      "1) Devuelve fields con: cedula, nombre, apellido (y si aparece teléfono u otro dato, inclúyelo).\n" +
      "2) Para cada campo devuelve meta.campo: {confidence 0..1, reason, source}.\n" +
      "3) Si NO puedes leer un campo: déjalo vacío '' y pon reason corto (ej: 'No visible', 'Borroso').\n" +
      "4) cedula y telefono SOLO dígitos.\n";

    const user =
      "Devuelve SOLO este JSON:\n" +
      "{\n" +
      '  "ok": boolean,\n' +
      '  "confidence": number,\n' +
      '  "fields": {\n' +
      '    "cedula": string,\n' +
      '    "nombre": string,\n' +
      '    "apellido": string,\n' +
      '    "telefono": string,\n' +
      '    "ocupacion": string,\n' +
      '    "direccion": string,\n' +
      '    "barrio": string,\n' +
      '    "observaciones": string\n' +
      "  },\n" +
      '  "meta": {\n' +
      '    "cedula": { "confidence": number, "reason": string, "source": string },\n' +
      '    "nombre": { "confidence": number, "reason": string, "source": string },\n' +
      '    "apellido": { "confidence": number, "reason": string, "source": string },\n' +
      '    "telefono": { "confidence": number, "reason": string, "source": string },\n' +
      '    "ocupacion": { "confidence": number, "reason": string, "source": string },\n' +
      '    "direccion": { "confidence": number, "reason": string, "source": string },\n' +
      '    "barrio": { "confidence": number, "reason": string, "source": string },\n' +
      '    "observaciones": { "confidence": number, "reason": string, "source": string }\n' +
      "  },\n" +
      '  "reasons": string[]\n' +
      "}\n" +
      "source debe ser: 'cedula_frente' o 'cedula_reverso'.";

    const content = [
      { type: "input_text", text: user },
      { type: "input_image", image_url: asDataUrl(frontMime, frontBase64) },
    ];

    if (backBase64 && backMime) {
      content.push({ type: "input_image", image_url: asDataUrl(backMime, backBase64) });
    }

    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    });

    const out = response.output_text || "";
    console.log(`[${reqId}] OpenAI output_text:`, short(out, 350));

    let obj = extractJson(out);
    if (!obj || typeof obj !== "object") {
      obj = {
        ok: false,
        confidence: 0,
        reasons: ["La IA no devolvió JSON válido."],
        fields: {},
        meta: {},
        raw: short(out, 900),
      };
    }

    obj = ensureClienteResult(obj);
    obj.debug = { reqId, ms: Date.now() - t0, model };
    console.log(`[${reqId}] ✅ OK in ${Date.now() - t0}ms`);

    return res.json(obj);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    const data = e?.response?.data;

    console.error(`\n[ERR] /extract-cliente-cedula FAIL`);
    console.error("[ERR] status:", status);
    console.error("[ERR] message:", msg);
    if (data) console.error("[ERR] data:", data);

    return res.status(500).json(
      ensureClienteResult({
        ok: false,
        confidence: 0,
        reasons: ["Error interno backend"],
        debug_error: { status: status ?? null, message: msg, data: data ?? null },
      })
    );
  }
});

/* =========================================================
   ✅ NUEVO: extraer datos desde TEXTO WhatsApp
   body: { text }
========================================================= */
app.post("/extract-cliente-text", async (req, res) => {
  const t0 = Date.now();
  const reqId = Math.random().toString(16).slice(2, 10);

  try {
    const { text } = req.body || {};
    console.log(`\n[${reqId}] HIT /extract-cliente-text textLen=${text ? String(text).length : 0}`);

    if (!text || String(text).trim().length < 3) {
      return res.status(400).json(
        ensureClienteResult({
          ok: false,
          confidence: 0,
          reasons: ["Falta text (pega el mensaje de WhatsApp)."],
        })
      );
    }

    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const system =
      "Eres un extractor de datos para registro de clientes (Colombia) basado en texto de WhatsApp. " +
      "Extrae datos como teléfono, dirección, barrio, ocupación, nombre/apellido o cédula si aparecen. " +
      "Responde SOLO JSON válido, sin markdown.\n\n" +
      "REGLAS:\n" +
      "1) SOLO llena lo que esté explícito o altamente claro.\n" +
      "2) Si un campo no está: deja '' y coloca meta.reason corto (ej: 'No viene en el mensaje').\n" +
      "3) cedula y telefono SOLO dígitos.\n" +
      "4) source debe ser 'whatsapp'.\n";

    const user =
      "TEXTO WHATSAPP:\n" +
      String(text) +
      "\n\nDevuelve SOLO este JSON:\n" +
      "{\n" +
      '  "ok": boolean,\n' +
      '  "confidence": number,\n' +
      '  "fields": {\n' +
      '    "cedula": string,\n' +
      '    "nombre": string,\n' +
      '    "apellido": string,\n' +
      '    "telefono": string,\n' +
      '    "ocupacion": string,\n' +
      '    "direccion": string,\n' +
      '    "barrio": string,\n' +
      '    "observaciones": string\n' +
      "  },\n" +
      '  "meta": {\n' +
      '    "cedula": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "nombre": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "apellido": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "telefono": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "ocupacion": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "direccion": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "barrio": { "confidence": number, "reason": string, "source": "whatsapp" },\n' +
      '    "observaciones": { "confidence": number, "reason": string, "source": "whatsapp" }\n' +
      "  },\n" +
      '  "reasons": string[]\n' +
      "}\n";

    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const out = response.output_text || "";
    console.log(`[${reqId}] OpenAI output_text:`, short(out, 350));

    let obj = extractJson(out);
    if (!obj || typeof obj !== "object") {
      obj = {
        ok: false,
        confidence: 0,
        reasons: ["La IA no devolvió JSON válido."],
        fields: {},
        meta: {},
        raw: short(out, 900),
      };
    }

    obj = ensureClienteResult(obj);
    obj.debug = { reqId, ms: Date.now() - t0, model };
    console.log(`[${reqId}] ✅ OK in ${Date.now() - t0}ms`);

    return res.json(obj);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    const data = e?.response?.data;

    console.error(`\n[ERR] /extract-cliente-text FAIL`);
    console.error("[ERR] status:", status);
    console.error("[ERR] message:", msg);
    if (data) console.error("[ERR] data:", data);

    return res.status(500).json(
      ensureClienteResult({
        ok: false,
        confidence: 0,
        reasons: ["Error interno backend"],
        debug_error: { status: status ?? null, message: msg, data: data ?? null },
      })
    );
  }
});

/* =========================
   ✅ TU ENDPOINT EXISTENTE verify-consignacion
   (lo dejas tal cual lo tienes)
========================= */
// ... TU /verify-consignacion aquí (igualito a lo que ya tienes) ...

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Server on port", port));
