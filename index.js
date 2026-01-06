// consignacion-ai-backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ✅ QR deps (instalar: npm i jimp qrcode-reader)
const QrCode = require("qrcode-reader");
const Jimp = require("jimp");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" })); // base64 pesa

// =========================
// Config “duro”
/**
 * ✅ Destinos Nequi permitidos:
 * - puedes también meterlos en ENV: EXPECTED_TO_ACCOUNTS="313...,313..."
 */
const DEFAULT_EXPECTED_TO_ACCOUNTS = (
  process.env.EXPECTED_TO_ACCOUNTS || "3138200803,3132294353"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Umbrales (ajústalos si quieres)
const TAMPER_HIGH = 0.65; // señales fuertes de posible edición
const MIN_CONF_VERIFY = 0.70; // confianza final mínima para “verificado” (servidor)
const REQUIRE_REFERENCE_FOR_VERIFY = true; // pide referencia para marcar verificado
const REQUIRE_DESTINATION_FOR_VERIFY = true; // pide destino “Número Nequi” o QR match

// =========================
// Helpers
// =========================
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length < 10) {
    throw new Error("Falta OPENAI_API_KEY en Render Environment Variables");
  }
  return new OpenAI({ apiKey: key });
}

function short(s, n = 220) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) + "..." : s;
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
function asDataUrl(imageMime, imageBase64) {
  return `data:${imageMime};base64,${imageBase64}`;
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

// ---------- Date helpers ----------
function isIsoDateYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function normalizeDateYYYYMMDD(s) {
  const v = normalizeStr(s);
  if (!v) return null;
  if (isIsoDateYYYYMMDD(v)) return v;
  return null;
}
function normalizeTimeHHMM(s) {
  const v = normalizeStr(s);
  if (!v) return null;
  // acepta "19:47" o "07:47"
  if (/^\d{2}:\d{2}$/.test(v)) return v;
  return null;
}
function approxSameDate(a, b) {
  return normalizeDateYYYYMMDD(a) && normalizeDateYYYYMMDD(b) && a === b;
}

// ---------- Money helpers ----------
function toNumberMaybe(x) {
  if (x == null) return null;
  if (typeof x === "number" && !Number.isNaN(x)) return x;
  const s = String(x);
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isNaN(n) ? null : n;
}

// =========================
// QR decode
// =========================
function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

async function decodeQrFromDataUrl(dataUrl) {
  try {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { present: false, decoded: false, text: null, error: "bad_dataurl" };

    const buf = Buffer.from(parsed.b64, "base64");

    // Jimp.read puede fallar si el buffer no es imagen válida
    const image = await Jimp.read(buf);

    // qrcode-reader necesita bitmap
    const qr = new QrCode();

    const qrText = await new Promise((resolve, reject) => {
      qr.callback = (err, value) => {
        if (err) return reject(err);
        const text = value?.result ? String(value.result) : null;
        resolve(text);
      };
      qr.decode(image.bitmap);
    });

    if (!qrText) {
      return { present: true, decoded: false, text: null, error: "no_qr_found" };
    }

    return { present: true, decoded: true, text: qrText, error: null };
  } catch (e) {
    // si no detecta QR, puede lanzar error
    return { present: true, decoded: false, text: null, error: String(e?.message || e) };
  }
}

function qrContainsAnyAccount(qrText, expectedAccounts) {
  const t = digitsOnly(qrText);
  if (!t) return false;
  return expectedAccounts.some((acc) => t.includes(digitsOnly(acc)));
}

// =========================
// IA Extraction schema “duro”
// =========================
function ensureVerifyResult(obj) {
  const out = obj && typeof obj === "object" ? obj : {};

  out.ok = typeof out.ok === "boolean" ? out.ok : false;
  out.confidence = clamp01(out.confidence);

  out.extracted = out.extracted && typeof out.extracted === "object" ? out.extracted : {};
  const ex = out.extracted;

  function normFieldNumber(fieldName) {
    const f = ex[fieldName] && typeof ex[fieldName] === "object" ? ex[fieldName] : {};
    const value = toNumberMaybe(f.value);
    ex[fieldName] = {
      value: value == null ? null : value,
      confidence: clamp01(f.confidence),
      reason: normalizeStr(f.reason),
    };
  }
  function normFieldString(fieldName, opts = {}) {
    const f = ex[fieldName] && typeof ex[fieldName] === "object" ? ex[fieldName] : {};
    let value = normalizeStr(f.value);
    if (!value) value = null;

    if (opts.kind === "date" && value) value = normalizeDateYYYYMMDD(value) || value;
    if (opts.kind === "time" && value) value = normalizeTimeHHMM(value) || value;
    if (opts.kind === "digits" && value) value = digitsOnly(value) || null;

    ex[fieldName] = {
      value,
      confidence: clamp01(f.confidence),
      reason: normalizeStr(f.reason),
    };
  }
  function normFieldBool(fieldName) {
    const f = ex[fieldName] && typeof ex[fieldName] === "object" ? ex[fieldName] : {};
    const value = typeof f.value === "boolean" ? f.value : null;
    ex[fieldName] = {
      value,
      confidence: clamp01(f.confidence),
      reason: normalizeStr(f.reason),
    };
  }

  // fields
  normFieldNumber("amount");
  normFieldString("date", { kind: "date" });
  normFieldString("time", { kind: "time" });
  normFieldString("reference");
  normFieldString("toName");
  normFieldString("toAccount", { kind: "digits" });
  normFieldString("statusLabel");
  normFieldBool("qrPresent");

  // tamper
  out.tamper = out.tamper && typeof out.tamper === "object" ? out.tamper : {};
  out.tamper.suspected = typeof out.tamper.suspected === "boolean" ? out.tamper.suspected : false;
  out.tamper.score = clamp01(out.tamper.score);
  if (!Array.isArray(out.tamper.signals)) out.tamper.signals = [];
  out.tamper.signals = out.tamper.signals.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 8);

  // notes
  if (!Array.isArray(out.notes)) out.notes = [];
  out.notes = out.notes.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 8);

  return out;
}

function normalizeStatus(s) {
  const v = String(s || "").trim();
  if (v === "verificado" || v === "pendiente_revision" || v === "rechazado") return v;
  return "pendiente_revision";
}

function buildReasonsAndDecide({
  expectedAmount,
  expectedDate,
  expectedToAccounts,
  expectedDateTime,
  iaExtract,
  qrInfo,
}) {
  const reasons = [];

  const ex = iaExtract?.extracted || {};
  const tamper = iaExtract?.tamper || {};

  const readAmount = ex?.amount?.value;
  const readDate = ex?.date?.value;
  const readTime = ex?.time?.value;
  const readRef = ex?.reference?.value ? String(ex.reference.value) : null;
  const readToAcc = ex?.toAccount?.value ? String(ex.toAccount.value) : null;
  const readStatus = ex?.statusLabel?.value ? String(ex.statusLabel.value) : null;

  const expAmt = toNumberMaybe(expectedAmount);
  const expDate = normalizeDateYYYYMMDD(expectedDate);
  const expectedAccs = Array.isArray(expectedToAccounts) && expectedToAccounts.length
    ? expectedToAccounts.map(digitsOnly).filter(Boolean)
    : DEFAULT_EXPECTED_TO_ACCOUNTS.map(digitsOnly).filter(Boolean);

  // ---------- monto ----------
  let okAmount = false;
  if (readAmount != null && expAmt != null) {
    okAmount = Number(readAmount) === Number(expAmt);
    reasons.push(okAmount ? `✅ Monto coincide: ${readAmount}.` : `❌ Monto NO coincide. Esperado ${expAmt}, leído ${readAmount}.`);
  } else {
    reasons.push("⚠️ No se pudo leer el monto con claridad.");
  }

  // ---------- fecha ----------
  let okDate = false;
  if (readDate && expDate) {
    okDate = approxSameDate(String(readDate), expDate);
    reasons.push(okDate ? `✅ Fecha coincide: ${expDate}.` : `❌ Fecha NO coincide. Esperado ${expDate}, leído ${readDate}.`);
  } else {
    reasons.push("⚠️ No se pudo leer la fecha con claridad.");
  }

  // ---------- hora (no siempre la controlas) ----------
  if (readTime) {
    reasons.push(`ℹ️ Hora leída: ${readTime}.`);
  } else {
    reasons.push("⚠️ No se pudo leer la hora (o no aparece).");
  }

  // ---------- referencia ----------
  const hasRef = !!(readRef && readRef.length >= 5);
  reasons.push(hasRef ? `✅ Referencia detectada: ${readRef}.` : "⚠️ No se detectó referencia (riesgo de edición).");

  // ---------- estado (Envío Realizado) ----------
  if (readStatus) {
    reasons.push(`✅ Estado detectado: ${readStatus}.`);
  } else {
    reasons.push("⚠️ No se detectó el estado (Envío Realizado / etc.).");
  }

  // ---------- destino (Número Nequi) ----------
  let okDest = false;
  if (readToAcc) {
    okDest = expectedAccs.some((acc) => String(readToAcc).includes(acc) || acc.includes(String(readToAcc)));
    reasons.push(okDest ? `✅ Número Nequi destino coincide: ${readToAcc}.` : `❌ Número Nequi destino NO es válido: ${readToAcc}.`);
  } else {
    reasons.push("⚠️ No se pudo leer el Número Nequi destino.");
  }

  // ---------- QR ----------
  const qrReasons = [];
  let qrMismatch = false;
  let qrStrongOk = false;

  if (qrInfo?.present) {
    if (qrInfo.decoded) {
      qrReasons.push("✅ QR presente y decodificado.");
      const qrOk = qrContainsAnyAccount(qrInfo.text, expectedAccs);
      if (qrOk) {
        qrStrongOk = true;
        qrReasons.push("✅ QR contiene un destino permitido.");
      } else {
        qrMismatch = true;
        qrReasons.push("❌ QR NO contiene ninguno de los destinos permitidos (posible comprobante ajeno/editado).");
      }
    } else {
      qrReasons.push("⚠️ QR presente pero NO se pudo decodificar (imagen borrosa/recortada).");
    }
  } else {
    qrReasons.push("⚠️ No se detectó QR en la imagen.");
  }
  reasons.push(...qrReasons);

  // ---------- tamper ----------
  const tScore = clamp01(tamper?.score);
  if (tScore >= TAMPER_HIGH) {
    reasons.push("⚠️ Señales fuertes de posible edición en la imagen.");
    if (Array.isArray(tamper?.signals) && tamper.signals.length) {
      reasons.push(`ℹ️ Señales: ${tamper.signals.slice(0, 4).join(", ")}.`);
    }
  } else if (tScore > 0.35) {
    reasons.push("⚠️ Señales moderadas de posible edición (revisión sugerida).");
  } else {
    reasons.push("✅ No se detectan señales fuertes de edición (aun así se validan reglas).");
  }

  // =========================
  // Decisión final (reglas duras)
  // =========================
  // Rechazo inmediato si:
  // - monto/fecha no coinciden
  // - destino inválido (si se leyó) o QR mismatch
  if (qrMismatch) {
    return { suggested_status: "rechazado", confidence: 0.85, reasons: reasons.slice(0, 12) };
  }

  if (readToAcc && !okDest) {
    return { suggested_status: "rechazado", confidence: 0.85, reasons: reasons.slice(0, 12) };
  }

  if (readAmount != null && expAmt != null && !okAmount) {
    return { suggested_status: "rechazado", confidence: 0.85, reasons: reasons.slice(0, 12) };
  }

  if (readDate && expDate && !okDate) {
    return { suggested_status: "rechazado", confidence: 0.85, reasons: reasons.slice(0, 12) };
  }

  // Para verificar, pedimos “fuerte”:
  // - okAmount + okDate
  // - destino válido (leído) O QR válido (decodificado y contiene destino)
  // - referencia (si está habilitado)
  // - tamper bajo
  const destStrong = (okDest && !!readToAcc) || qrStrongOk;
  const refStrong = REQUIRE_REFERENCE_FOR_VERIFY ? hasRef : true;

  if (okAmount && okDate && destStrong && refStrong && tScore < TAMPER_HIGH) {
    const conf = Math.max(MIN_CONF_VERIFY, 0.80);
    return { suggested_status: "verificado", confidence: conf, reasons: reasons.slice(0, 12) };
  }

  // Si llegó aquí: no hay contradicción fuerte, pero falta info → pendiente
  return { suggested_status: "pendiente_revision", confidence: 0.62, reasons: reasons.slice(0, 12) };
}

// =========================
// Logs (para Render)
// =========================
app.use((req, _res, next) => {
  const id = Math.random().toString(16).slice(2, 10);
  req._reqId = id;
  console.log(`\n[${id}] ${req.method} ${req.path}`);
  next();
});

// =========================
// Health
// =========================
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "consignacion-ai-backend",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || "gpt-4o-mini",
    expectedToAccounts: DEFAULT_EXPECTED_TO_ACCOUNTS,
    time: new Date().toISOString(),
  });
});

// =========================================================
// ✅ verify-consignacion (BASE64) — POTENTE
// Flutter envía:
// {
//   imageBase64, imageMime,
//   expectedAmount,
//   expectedDate (YYYY-MM-DD),
//   expectedDateTime (ISO, opcional),
//   expectedToAccounts (opcional),
//   imageUrl?
// }
// =========================================================
app.post("/verify-consignacion", async (req, res) => {
  const t0 = Date.now();
  const reqId = req._reqId || Math.random().toString(16).slice(2, 10);

  try {
    const {
      imageBase64,
      imageMime,
      expectedAmount,
      expectedDate,
      expectedDateTime,
      expectedToAccounts,
    } = req.body || {};

    console.log(`[${reqId}] HIT /verify-consignacion`);
    console.log(`[${reqId}] expectedAmount=${expectedAmount} expectedDate=${expectedDate} expectedDateTime=${expectedDateTime}`);
    console.log(`[${reqId}] expectedToAccounts=${Array.isArray(expectedToAccounts) ? expectedToAccounts.join(",") : "(none)"}`);
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

    const dataUrl = asDataUrl(imageMime, imageBase64);

    // ======================
    // 1) QR decode (sin IA)
    // ======================
    const qrInfo = await decodeQrFromDataUrl(dataUrl);
    if (qrInfo?.decoded) {
      console.log(`[${reqId}] QR decoded:`, short(qrInfo.text, 260));
    } else {
      console.log(`[${reqId}] QR decode: present=${qrInfo.present} decoded=${qrInfo.decoded} err=${qrInfo.error}`);
    }

    // ======================
    // 2) IA: extracción + tamper
    // ======================
    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const system =
      "Eres un extractor y analista de comprobantes Nequi en Colombia. " +
      "NO debes decidir 'verificado' por intuición. " +
      "Debes EXTRAER campos (monto, fecha, hora, referencia, destino, estado) " +
      "y estimar señales de posible edición (tamper). " +
      "Responde SOLO JSON válido, sin markdown, sin ```.\n\n" +
      "REGLAS:\n" +
      "1) Devuelve SOLO el JSON solicitado.\n" +
      "2) confidence 0..1.\n" +
      "3) extracted.campo.confidence 0..1.\n" +
      "4) Si no puedes leer un campo: value=null y reason corto.\n" +
      "5) tamper.score 0..1 (alto = posible edición).";

    const expectedAccs = Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts
      : DEFAULT_EXPECTED_TO_ACCOUNTS;

    const user =
      `DATOS ESPERADOS:\n` +
      `- expectedAmount: ${expectedAmount}\n` +
      `- expectedDate (YYYY-MM-DD): ${expectedDate}\n` +
      `- expectedDateTime (ISO, opcional): ${expectedDateTime || ""}\n` +
      `- expectedToAccounts (Número Nequi destino permitido): ${expectedAccs.join(", ")}\n\n` +
      `EXTRAE del comprobante (si aparece):\n` +
      `- amount (COP)\n` +
      `- date (YYYY-MM-DD)\n` +
      `- time (HH:mm 24h si puedes)\n` +
      `- reference (ej M########)\n` +
      `- toName (Para ...)\n` +
      `- toAccount (Número Nequi ... SOLO dígitos)\n` +
      `- statusLabel (ej "Envío Realizado")\n` +
      `- qrPresent (true/false)\n\n` +
      `Y evalúa tamper:\n` +
      `- tamper.suspected (true/false)\n` +
      `- tamper.score (0..1)\n` +
      `- tamper.signals (lista corta: "texto_con_bordes_raros", "zonas_borrosas", "inconsistencia_tipografia", "bloques_pixelados", etc)\n\n` +
      `Devuelve SOLO este JSON:\n` +
      `{\n` +
      `  "ok": boolean,\n` +
      `  "confidence": number,\n` +
      `  "extracted": {\n` +
      `    "amount": {"value": number|null, "confidence": number, "reason": string},\n` +
      `    "date": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "time": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "reference": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "toName": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "toAccount": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "statusLabel": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "qrPresent": {"value": boolean|null, "confidence": number, "reason": string}\n` +
      `  },\n` +
      `  "tamper": {"suspected": boolean, "score": number, "signals": string[]},\n` +
      `  "notes": string[]\n` +
      `}\n`;

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
    console.log(`[${reqId}] OpenAI output_text:`, short(out, 320));

    let ia = extractJson(out);

    if (!ia || typeof ia !== "object") {
      ia = {
        ok: false,
        confidence: 0,
        extracted: {},
        tamper: { suspected: false, score: 0, signals: ["json_invalido"] },
        notes: ["La IA no devolvió JSON válido."],
        raw: short(out, 900),
      };
    }

    ia = ensureVerifyResult(ia);

    // ======================
    // 3) Reglas duras (servidor decide)
    // ======================
    const decision = buildReasonsAndDecide({
      expectedAmount,
      expectedDate,
      expectedToAccounts: expectedAccs,
      expectedDateTime,
      iaExtract: ia,
      qrInfo,
    });

    const result = {
      ok: true,
      suggested_status: normalizeStatus(decision.suggested_status),
      confidence: clamp01(decision.confidence),
      reasons: (decision.reasons || []).slice(0, 12),

      // ✅ extra info para auditoría
      extracted: ia.extracted,
      tamper: ia.tamper,
      qr: {
        present: !!qrInfo?.present,
        decoded: !!qrInfo?.decoded,
        // NO guardes el texto completo si no quieres; aquí lo mandamos corto para debug
        textShort: qrInfo?.decoded ? short(qrInfo.text, 220) : null,
        error: qrInfo?.decoded ? null : (qrInfo?.error || null),
      },

      debug: { reqId, ms: Date.now() - t0, model },
    };

    console.log(`[${reqId}] ✅ DONE ${result.suggested_status} in ${Date.now() - t0}ms`);
    return res.json(result);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    const data = e?.response?.data;

    console.error(`\n[${reqId}] [ERR] /verify-consignacion FAIL`);
    console.error(`[${reqId}] status:`, status);
    console.error(`[${reqId}] message:`, msg);
    if (data) console.error(`[${reqId}] data:`, data);
    if (e?.stack) console.error(`[${reqId}] stack:`, e.stack);

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

// =========================================================
// ✅ extraer datos desde CÉDULA (frente + reverso)  (IGUAL)
// =========================================================
function ensureClienteResult(obj) {
  const out = obj && typeof obj === "object" ? obj : {};
  out.ok = typeof out.ok === "boolean" ? out.ok : false;

  out.fields = out.fields && typeof out.fields === "object" ? out.fields : {};
  const f = out.fields;

  f.cedula = digitsOnly(f.cedula);
  f.nombre = normalizeStr(f.nombre);
  f.apellido = normalizeStr(f.apellido);
  f.telefono = digitsOnly(f.telefono);
  f.ocupacion = normalizeStr(f.ocupacion);
  f.direccion = normalizeStr(f.direccion);
  f.barrio = normalizeStr(f.barrio);
  f.observaciones = normalizeStr(f.observaciones);

  out.meta = out.meta && typeof out.meta === "object" ? out.meta : {};
  for (const k of [
    "cedula",
    "nombre",
    "apellido",
    "telefono",
    "ocupacion",
    "direccion",
    "barrio",
    "observaciones",
  ]) {
    const m = out.meta[k] && typeof out.meta[k] === "object" ? out.meta[k] : {};
    out.meta[k] = {
      confidence: clamp01(m.confidence),
      reason: normalizeStr(m.reason),
      source: normalizeStr(m.source),
    };
  }

  out.confidence = clamp01(out.confidence);

  if (!Array.isArray(out.reasons)) out.reasons = [];
  out.reasons = out.reasons
    .map((x) => normalizeStr(x))
    .filter((x) => x.length > 0)
    .slice(0, 10);

  const anyFilled = Object.values(f).some((v) => normalizeStr(v).length > 0);
  if (!anyFilled && out.reasons.length === 0) {
    out.reasons = ["No se pudo extraer información suficiente."];
  }

  return out;
}

app.post("/extract-cliente-cedula", async (req, res) => {
  const t0 = Date.now();
  const reqId = req._reqId || Math.random().toString(16).slice(2, 10);

  try {
    const { frontBase64, frontMime, backBase64, backMime } = req.body || {};

    console.log(`[${reqId}] HIT /extract-cliente-cedula`);
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

    console.error(`\n[${reqId}] [ERR] /extract-cliente-cedula FAIL`);
    console.error(`[${reqId}] status:`, status);
    console.error(`[${reqId}] message:`, msg);
    if (data) console.error(`[${reqId}] data:`, data);
    if (e?.stack) console.error(`[${reqId}] stack:`, e.stack);

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

// =========================================================
// ✅ extraer datos desde TEXTO WhatsApp  (IGUAL)
// =========================================================
app.post("/extract-cliente-text", async (req, res) => {
  const t0 = Date.now();
  const reqId = req._reqId || Math.random().toString(16).slice(2, 10);

  try {
    const { text } = req.body || {};
    console.log(`[${reqId}] HIT /extract-cliente-text textLen=${text ? String(text).length : 0}`);

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

    console.error(`\n[${reqId}] [ERR] /extract-cliente-text FAIL`);
    console.error(`[${reqId}] status:`, status);
    console.error(`[${reqId}] message:`, msg);
    if (data) console.error(`[${reqId}] data:`, data);
    if (e?.stack) console.error(`[${reqId}] stack:`, e.stack);

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

// =========================
// Server
// =========================
const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Server on port", port));
