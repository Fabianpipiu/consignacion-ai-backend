// consignacion-ai-backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ✅ QR deps (npm i jimp qrcode-reader)
const QrCode = require("qrcode-reader");

// ✅ FIX JIMP (ESM/CommonJS)
const JimpMod = require("jimp");
// En algunas versiones: require("jimp") trae { default: ... }
// En otras: trae directamente el objeto con read/intToRGBA/MIME_JPEG
const Jimp = JimpMod?.default ?? JimpMod;

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" })); // base64 pesa

// =========================
// Config “duro”
// =========================
const DEFAULT_EXPECTED_TO_ACCOUNTS = (
  process.env.EXPECTED_TO_ACCOUNTS || "3138200803,3132294353"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 🔥 UMBRALES (más estrictos)
const TAMPER_MODERATE = 0.38;
const TAMPER_HIGH = 0.55;
const MIN_CONF_VERIFY = 0.82;

// Reglas duras
const REQUIRE_REFERENCE_FOR_VERIFY = true;
const REQUIRE_DESTINATION_FOR_VERIFY = true;

// ⚠️ Regla clave: si el comprobante trae QR pero NO se puede leer -> NO puede ser verificado
const REQUIRE_QR_DECODE_FOR_VERIFY = true;

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
    if (!parsed)
      return { present: false, decoded: false, text: null, error: "bad_dataurl" };

    const buf = Buffer.from(parsed.b64, "base64");

    const image = await Jimp.read(buf);
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
    return { present: true, decoded: false, text: null, error: String(e?.message || e) };
  }
}

function qrContainsAnyAccount(qrText, expectedAccounts) {
  const t = digitsOnly(qrText);
  if (!t) return false;
  return expectedAccounts.some((acc) => t.includes(digitsOnly(acc)));
}

// =========================
// 🔥 Forense de imagen (ANTI-EDICIÓN)
// =========================
async function readJimpFromDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("bad_dataurl");
  const buf = Buffer.from(parsed.b64, "base64");
  const img = await Jimp.read(buf);
  return img;
}

function sampleGray(img, x, y) {
  const rgba = Jimp.intToRGBA(img.getPixelColor(x, y));
  return (rgba.r * 0.299 + rgba.g * 0.587 + rgba.b * 0.114) / 255;
}

function meanAbsDiff(imgA, imgB, step = 2) {
  const w = Math.min(imgA.bitmap.width, imgB.bitmap.width);
  const h = Math.min(imgA.bitmap.height, imgB.bitmap.height);
  let sum = 0;
  let count = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const a = sampleGray(imgA, x, y);
      const b = sampleGray(imgB, x, y);
      sum += Math.abs(a - b);
      count++;
    }
  }
  return count ? sum / count : 0;
}

async function elaScore(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const small = img.clone();
  const maxSide = 1100;
  if (Math.max(w, h) > maxSide) {
    const scale = maxSide / Math.max(w, h);
    small.resize(
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale))
    );
  }

  const recompressed = small.clone().quality(60);
  const buf = await recompressed.getBufferAsync(Jimp.MIME_JPEG);
  const recompressed2 = await Jimp.read(buf);

  const d = meanAbsDiff(small, recompressed2, 2);
  const score = clamp01((d - 0.012) / 0.06);
  return { score, meanDiff: d };
}

function blockinessScore(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const step = 8;

  let sumEdges = 0;
  let countEdges = 0;

  for (let y = 0; y < h; y += 2) {
    for (let x = step; x < w; x += step) {
      const a = sampleGray(img, x - 1, y);
      const b = sampleGray(img, x, y);
      sumEdges += Math.abs(a - b);
      countEdges++;
    }
  }
  for (let x = 0; x < w; x += 2) {
    for (let y = step; y < h; y += step) {
      const a = sampleGray(img, x, y - 1);
      const b = sampleGray(img, x, y);
      sumEdges += Math.abs(a - b);
      countEdges++;
    }
  }

  const mean = countEdges ? sumEdges / countEdges : 0;
  const score = clamp01((mean - 0.010) / 0.05);
  return { score, mean };
}

function edgeDensityScore(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const x0 = Math.round(w * 0.10);
  const x1 = Math.round(w * 0.90);
  const y0 = Math.round(h * 0.20);
  const y1 = Math.round(h * 0.90);

  let edges = 0;
  let total = 0;

  for (let y = y0 + 1; y < y1 - 1; y += 2) {
    for (let x = x0 + 1; x < x1 - 1; x += 2) {
      const c = sampleGray(img, x, y);
      const gx = Math.abs(sampleGray(img, x + 1, y) - sampleGray(img, x - 1, y));
      const gy = Math.abs(sampleGray(img, x, y + 1) - sampleGray(img, x, y - 1));
      const g = gx + gy;
      if (g > 0.20 && c > 0.05) edges++;
      total++;
    }
  }

  const density = total ? edges / total : 0;
  const score = clamp01((density - 0.055) / 0.10);
  return { score, density };
}

function smoothPatchScore(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const x0 = Math.round(w * 0.08);
  const x1 = Math.round(w * 0.92);
  const y0 = Math.round(h * 0.45);
  const y1 = Math.round(h * 0.85);

  let sumVar = 0;
  let count = 0;

  for (let y = y0 + 2; y < y1 - 2; y += 4) {
    for (let x = x0 + 2; x < x1 - 2; x += 4) {
      let mean = 0;
      let vcount = 0;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          mean += sampleGray(img, x + xx, y + yy);
          vcount++;
        }
      }
      mean /= vcount;

      let vari = 0;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          const d = sampleGray(img, x + xx, y + yy) - mean;
          vari += d * d;
        }
      }
      vari /= vcount;
      sumVar += vari;
      count++;
    }
  }

  const meanVar = count ? sumVar / count : 0;
  const score = clamp01((0.0035 - meanVar) / 0.0035);
  return { score, meanVar };
}

async function forensicTamper(dataUrl) {
  try {
    const img = await readJimpFromDataUrl(dataUrl);
    const gray = img.clone().greyscale();

    const ela = await elaScore(gray);
    const blk = blockinessScore(gray);
    const edg = edgeDensityScore(gray);
    const smt = smoothPatchScore(gray);

    const score = clamp01(
      0.45 * ela.score +
        0.22 * blk.score +
        0.18 * smt.score +
        0.15 * edg.score
    );

    const signals = [];
    if (ela.score > 0.45) signals.push("ela_inconsistente");
    if (blk.score > 0.45) signals.push("macroblocking_anomalo");
    if (smt.score > 0.45) signals.push("zona_lisa_sospechosa");
    if (edg.score > 0.55) signals.push("bordes_raros_texto_posible");

    return {
      ok: true,
      score,
      signals,
      details: {
        ela: { score: ela.score, meanDiff: ela.meanDiff },
        blockiness: { score: blk.score, mean: blk.mean },
        smooth: { score: smt.score, meanVar: smt.meanVar },
        edges: { score: edg.score, density: edg.density },
      },
    };
  } catch (e) {
    return {
      ok: false,
      score: 0,
      signals: ["forensic_error"],
      details: { error: String(e?.message || e) },
    };
  }
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

  normFieldNumber("amount");
  normFieldString("date", { kind: "date" });
  normFieldString("time", { kind: "time" });
  normFieldString("reference");
  normFieldString("toName");
  normFieldString("toAccount", { kind: "digits" });
  normFieldString("statusLabel");
  normFieldBool("qrPresent");

  out.tamper = out.tamper && typeof out.tamper === "object" ? out.tamper : {};
  out.tamper.suspected = typeof out.tamper.suspected === "boolean" ? out.tamper.suspected : false;
  out.tamper.score = clamp01(out.tamper.score);
  if (!Array.isArray(out.tamper.signals)) out.tamper.signals = [];
  out.tamper.signals = out.tamper.signals.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 12);

  if (!Array.isArray(out.notes)) out.notes = [];
  out.notes = out.notes.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 12);

  return out;
}

function normalizeStatus(s) {
  const v = String(s || "").trim();
  if (v === "verificado" || v === "pendiente_revision" || v === "rechazado") return v;
  return "pendiente_revision";
}

// =========================
// Decisión final (más dura)
// =========================
function buildReasonsAndDecide({
  expectedAmount,
  expectedDate,
  expectedToAccounts,
  expectedDateTime,
  iaExtract,
  qrInfo,
  forensic,
}) {
  const reasons = [];

  const ex = iaExtract?.extracted || {};
  const tamperAI = iaExtract?.tamper || {};

  const readAmount = ex?.amount?.value;
  const readDate = ex?.date?.value;
  const readTime = ex?.time?.value;
  const readRef = ex?.reference?.value ? String(ex.reference.value) : null;
  const readToAcc = ex?.toAccount?.value ? String(ex.toAccount.value) : null;
  const readStatus = ex?.statusLabel?.value ? String(ex.statusLabel.value) : null;

  const expAmt = toNumberMaybe(expectedAmount);
  const expDate = normalizeDateYYYYMMDD(expectedDate);

  const expectedAccs =
    Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts.map(digitsOnly).filter(Boolean)
      : DEFAULT_EXPECTED_TO_ACCOUNTS.map(digitsOnly).filter(Boolean);

  let okAmount = false;
  if (readAmount != null && expAmt != null) {
    okAmount = Number(readAmount) === Number(expAmt);
    reasons.push(
      okAmount
        ? `✅ Monto coincide: ${readAmount}.`
        : `❌ Monto NO coincide. Esperado ${expAmt}, leído ${readAmount}.`
    );
  } else {
    reasons.push("⚠️ No se pudo leer el monto con claridad.");
  }

  let okDate = false;
  if (readDate && expDate) {
    okDate = approxSameDate(String(readDate), expDate);
    reasons.push(okDate ? `✅ Fecha coincide: ${expDate}.` : `❌ Fecha NO coincide. Esperado ${expDate}, leído ${readDate}.`);
  } else {
    reasons.push("⚠️ No se pudo leer la fecha con claridad.");
  }

  if (readTime) reasons.push(`ℹ️ Hora leída: ${readTime}.`);
  else reasons.push("⚠️ No se pudo leer la hora (o no aparece).");

  const hasRef = !!(readRef && readRef.length >= 5);
  reasons.push(hasRef ? `✅ Referencia detectada: ${readRef}.` : "⚠️ No se detectó referencia (riesgo de edición).");

  if (readStatus) reasons.push(`✅ Estado detectado: ${readStatus}.`);
  else reasons.push("⚠️ No se detectó el estado (Envío Realizado / etc.).");

  let okDest = false;
  if (readToAcc) {
    okDest = expectedAccs.some((acc) => String(readToAcc).includes(acc) || acc.includes(String(readToAcc)));
    reasons.push(okDest ? `✅ Número Nequi destino coincide: ${readToAcc}.` : `❌ Número Nequi destino NO es válido: ${readToAcc}.`);
  } else {
    reasons.push("⚠️ No se pudo leer el Número Nequi destino.");
  }

  let qrMismatch = false;
  let qrStrongOk = false;

  if (qrInfo?.present) {
    if (qrInfo.decoded) {
      reasons.push("✅ QR presente y decodificado.");
      const qrOk = qrContainsAnyAccount(qrInfo.text, expectedAccs);
      if (qrOk) {
        qrStrongOk = true;
        reasons.push("✅ QR contiene un destino permitido.");
      } else {
        qrMismatch = true;
        reasons.push("❌ QR NO contiene destinos permitidos (posible comprobante ajeno/editado).");
      }
    } else {
      reasons.push("⚠️ QR presente pero NO se pudo decodificar (recortado/borroso).");
    }
  } else {
    reasons.push("⚠️ No se detectó QR en la imagen.");
  }

  const aiScore = clamp01(tamperAI?.score);
  const forScore = clamp01(forensic?.score);
  const tScore = Math.max(aiScore, forScore);

  if (forensic?.ok) {
    if (forScore >= TAMPER_HIGH) {
      reasons.push("⚠️ Forense: señales fuertes de edición (ELA/compresión/bordes).");
      if (Array.isArray(forensic?.signals) && forensic.signals.length) {
        reasons.push(`ℹ️ Forense señales: ${forensic.signals.slice(0, 4).join(", ")}.`);
      }
    } else if (forScore >= TAMPER_MODERATE) {
      reasons.push("⚠️ Forense: señales moderadas de edición (revisión sugerida).");
    } else {
      reasons.push("✅ Forense: no se ven señales fuertes de edición.");
    }
  } else {
    reasons.push("⚠️ Forense no pudo analizar la imagen (se usa IA + reglas).");
  }

  if (aiScore >= TAMPER_HIGH) {
    reasons.push("⚠️ IA: señales fuertes de posible edición.");
    if (Array.isArray(tamperAI?.signals) && tamperAI.signals.length) {
      reasons.push(`ℹ️ IA señales: ${tamperAI.signals.slice(0, 4).join(", ")}.`);
    }
  } else if (aiScore >= TAMPER_MODERATE) {
    reasons.push("⚠️ IA: señales moderadas de posible edición.");
  } else {
    reasons.push("✅ IA: no ve señales fuertes de edición.");
  }

  if (qrMismatch) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }
  if (readToAcc && !okDest) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }
  if (readAmount != null && expAmt != null && !okAmount) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }
  if (readDate && expDate && !okDate) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  if (REQUIRE_QR_DECODE_FOR_VERIFY && qrInfo?.present && !qrInfo?.decoded) {
    return { suggested_status: "pendiente_revision", confidence: 0.65, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  const destStrong = qrStrongOk || (REQUIRE_DESTINATION_FOR_VERIFY ? (okDest && !!readToAcc) : true);
  const refStrong = REQUIRE_REFERENCE_FOR_VERIFY ? hasRef : true;
  const tamperOkForVerify = tScore < TAMPER_MODERATE;

  if (okAmount && okDate && destStrong && refStrong && tamperOkForVerify) {
    const conf = Math.max(MIN_CONF_VERIFY, 0.86);
    return { suggested_status: "verificado", confidence: conf, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  const baseConf = tScore >= TAMPER_HIGH ? 0.58 : 0.66;
  return { suggested_status: "pendiente_revision", confidence: baseConf, reasons: reasons.slice(0, 14), tamperFinal: tScore };
}

// =========================
// Logs
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
// ✅ verify-consignacion (BASE64) — MÁS DURO + FORENSE
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

    // 1) QR decode
    const qrInfo = await decodeQrFromDataUrl(dataUrl);
    if (qrInfo?.decoded) {
      console.log(`[${reqId}] QR decoded:`, short(qrInfo.text, 260));
    } else {
      console.log(`[${reqId}] QR decode: present=${qrInfo.present} decoded=${qrInfo.decoded} err=${qrInfo.error}`);
    }

    // 2) Forense
    const forensic = await forensicTamper(dataUrl);
    console.log(`[${reqId}] Forensic: ok=${forensic.ok} score=${forensic.score.toFixed(3)} signals=${(forensic.signals || []).join(",")}`);

    // 3) IA: extracción
    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const expectedAccs = Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts
      : DEFAULT_EXPECTED_TO_ACCOUNTS;

    const system =
      "Eres un extractor y analista de comprobantes de pagos en Colombia (Nequi/Daviplata/Bancolombia/Wompi pueden aparecer). " +
      "NO debes decidir 'verificado' por intuición. " +
      "Debes EXTRAER campos (monto, fecha, hora, referencia, destino, estado) y estimar señales de edición (tamper). " +
      "Responde SOLO JSON válido, sin markdown, sin ```.\n\n" +
      "REGLAS:\n" +
      "1) Devuelve SOLO el JSON solicitado.\n" +
      "2) confidence 0..1.\n" +
      "3) extracted.campo.confidence 0..1.\n" +
      "4) Si no puedes leer un campo: value=null y reason corto.\n" +
      "5) tamper.score 0..1 (alto = posible edición). " +
      "6) Se MUY estricto: si ves texto pegado, bordes raros, tipografía diferente, pixeles de bloque o zonas borrosas parciales, sube tamper.\n";

    const user =
      `DATOS ESPERADOS:\n` +
      `- expectedAmount: ${expectedAmount}\n` +
      `- expectedDate (YYYY-MM-DD): ${expectedDate}\n` +
      `- expectedDateTime (ISO, opcional): ${expectedDateTime || ""}\n` +
      `- expectedToAccounts (destinos permitidos): ${expectedAccs.join(", ")}\n\n` +
      `EXTRAE del comprobante (si aparece):\n` +
      `- amount (COP)\n` +
      `- date (YYYY-MM-DD)\n` +
      `- time (HH:mm 24h si puedes)\n` +
      `- reference (ej M########)\n` +
      `- toName (Para ...)\n` +
      `- toAccount (Número destino SOLO dígitos)\n` +
      `- statusLabel (ej "Envío Realizado")\n` +
      `- qrPresent (true/false)\n\n` +
      `Y evalúa tamper:\n` +
      `- tamper.suspected (true/false)\n` +
      `- tamper.score (0..1)\n` +
      `- tamper.signals (lista corta, específica)\n\n` +
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

    // 4) Reglas duras
    const decision = buildReasonsAndDecide({
      expectedAmount,
      expectedDate,
      expectedToAccounts: expectedAccs,
      expectedDateTime,
      iaExtract: ia,
      qrInfo,
      forensic,
    });

    const tamperFinal = clamp01(
      decision?.tamperFinal ??
        Math.max(clamp01(ia?.tamper?.score), clamp01(forensic?.score))
    );

    const result = {
      ok: true,
      suggested_status: normalizeStatus(decision.suggested_status),
      confidence: clamp01(decision.confidence),
      reasons: (decision.reasons || []).slice(0, 14),

      extracted: ia.extracted,

      tamper: {
        ai: ia.tamper,
        forensic: {
          ok: forensic.ok,
          score: clamp01(forensic.score),
          signals: (forensic.signals || []).slice(0, 12),
          details: forensic.details || null,
        },
        finalScore: tamperFinal,
        finalLevel:
          tamperFinal >= TAMPER_HIGH
            ? "high"
            : tamperFinal >= TAMPER_MODERATE
            ? "moderate"
            : "low",
      },

      qr: {
        present: !!qrInfo?.present,
        decoded: !!qrInfo?.decoded,
        textShort: qrInfo?.decoded ? short(qrInfo.text, 220) : null,
        error: qrInfo?.decoded ? null : (qrInfo?.error || null),
      },

      debug: { reqId, ms: Date.now() - t0, model },
    };

    console.log(
      `[${reqId}] ✅ DONE ${result.suggested_status} in ${
        Date.now() - t0
      }ms tamperFinal=${result.tamper.finalScore.toFixed(3)}`
    );
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

// =========================
// (Tus endpoints de cédula / whatsapp se quedan igual)
// =========================

// =========================
// Server
// =========================
const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log("🚀 Server on port", port));
