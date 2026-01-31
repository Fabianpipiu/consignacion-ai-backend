// consignacion-ai-backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// =========================
// Deps
// =========================
// QR (mejorado): jsQR + Jimp (qrcode-reader queda de fallback)
// npm i jimp jsqr qrcode-reader
const Jimp = require("jimp");
const jsQR = require("jsqr");
const QrCode = require("qrcode-reader");

// =========================
// App
// =========================
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));

// =========================
// Config
// =========================
const DEFAULT_EXPECTED_TO_ACCOUNTS = (
  process.env.EXPECTED_TO_ACCOUNTS || "3138200803,3132294353"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Umbrales tamper (ya NO bloquean “verificado” tan fácil)
const TAMPER_MODERATE = 0.45;
const TAMPER_HIGH = 0.65;

// Para “verificado”
const MIN_CONF_VERIFY = 0.80;

// Reglas (más razonables para miles de bancos y físicos)
const REQUIRE_REFERENCE_FOR_VERIFY = false;     // antes true (muy duro para bancos distintos)
const REQUIRE_DESTINATION_FOR_VERIFY = false;   // antes true (muchos comprobantes no traen destino legible)
const REQUIRE_QR_DECODE_FOR_VERIFY = false;     // antes true (si nunca decodifica, no sirve)

// Montos: ustedes mandan 45 => 45.000 / 134 => 134.000
const EXPECTED_AMOUNT_IS_THOUSANDS = true;

// Tolerancia monto (COP)
const AMOUNT_MIN_TOLERANCE_COP = 1000; // mínimo 1.000 de tolerancia
const AMOUNT_PCT_TOLERANCE = 0.012;    // 1.2%

// =========================
// Helpers base
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

async function fetchImageAsBase64(imageUrl) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error(`No se pudo descargar imagen: ${r.status}`);

  const mimeRaw = r.headers.get("content-type") || "image/jpeg";
  const imageMime = mimeRaw.split(";")[0].trim();

  const ab = await r.arrayBuffer();
  const imageBase64 = Buffer.from(ab).toString("base64");

  return { imageBase64, imageMime };
}

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

// =========================
// Date helpers (más robusto)
// =========================
function isIsoDateYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

// Convierte dd/mm/yyyy o dd-mm-yyyy a yyyy-mm-dd
function tryParseLatamDate(s) {
  const v = normalizeStr(s);
  if (!v) return null;

  // dd/mm/yyyy o dd-mm-yyyy
  const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const yyyy = String(m[3]);

  const iso = `${yyyy}-${mm}-${dd}`;
  return isIsoDateYYYYMMDD(iso) ? iso : null;
}

function normalizeDateYYYYMMDD(s) {
  const v = normalizeStr(s);
  if (!v) return null;
  if (isIsoDateYYYYMMDD(v)) return v;
  const latam = tryParseLatamDate(v);
  if (latam) return latam;
  return null;
}

function normalizeTimeHHMM(s) {
  const v = normalizeStr(s);
  if (!v) return null;

  // HH:mm
  if (/^\d{2}:\d{2}$/.test(v)) return v;

  // H:mm
  if (/^\d{1}:\d{2}$/.test(v)) return `0${v}`;

  return null;
}

function approxSameDate(a, b) {
  return normalizeDateYYYYMMDD(a) && normalizeDateYYYYMMDD(b) && normalizeDateYYYYMMDD(a) === normalizeDateYYYYMMDD(b);
}

// =========================
// Money helpers (mejorado)
// =========================
function toNumberMaybe(x) {
  if (x == null) return null;
  if (typeof x === "number" && !Number.isNaN(x)) return x;

  const s = String(x);

  // intenta detectar decimales (poco común en COP, pero por si)
  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  // si viene como "45.000" o "45,000" o "45 000"
  const digits = cleaned.replace(/[^\d]/g, "");
  if (!digits) return null;

  const n = Number(digits);
  return Number.isNaN(n) ? null : n;
}

// Normaliza expectedAmount según tu regla: 45 => 45000
function normalizeExpectedAmountCOP(expectedAmount) {
  const n = toNumberMaybe(expectedAmount);
  if (n == null) return null;

  // si ustedes mandan 45/134 para representar miles
  if (EXPECTED_AMOUNT_IS_THOUSANDS && n > 0 && n < 1000) return n * 1000;

  return n;
}

// Compara monto leído vs esperado con escalas por si IA leyó “45” en vez de “45000”
function compareAmountsCOP(readAmountRaw, expectedAmountRaw) {
  const exp = normalizeExpectedAmountCOP(expectedAmountRaw);
  const read = toNumberMaybe(readAmountRaw);

  if (exp == null || read == null) {
    return { ok: false, exp: exp ?? null, read: read ?? null, bestRead: null, bestScale: null, diff: null, tol: null };
  }

  const scales = [1, 10, 100, 1000];
  let best = null;

  for (const sc of scales) {
    const candidate = read * sc;

    const tol = Math.max(AMOUNT_MIN_TOLERANCE_COP, Math.round(exp * AMOUNT_PCT_TOLERANCE));
    const diff = Math.abs(candidate - exp);

    const ok = diff <= tol;

    // score: prefer exact-ish, prefer smaller scale when tie
    const score = diff + (sc > 1 ? 0.5 : 0); // pequeñísima penalización por escalar

    if (!best || score < best.score) {
      best = { ok, exp, read, bestRead: candidate, bestScale: sc, diff, tol, score };
    }
  }

  // Caso: esperado es 45000 y leído 45000 (sc=1) => ok
  // Caso: esperado 45000 y leído 45 (sc=1000) => ok
  return { ok: best.ok, exp: best.exp, read: best.read, bestRead: best.bestRead, bestScale: best.bestScale, diff: best.diff, tol: best.tol };
}

// =========================
// DataURL parse
// =========================
function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

async function readJimpFromDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("bad_dataurl");
  const buf = Buffer.from(parsed.b64, "base64");
  return await Jimp.read(buf);
}

// =========================
// QR decode (MUCHO mejorado)
// - Intenta varias pre-procesos y rotaciones
// - Usa jsQR (mejor en imágenes reales) y fallback qrcode-reader
// =========================
function jimpToRGBAUint8(img) {
  // Jimp bitmap.data ya es un Buffer RGBA (Uint8)
  // jsQR espera Uint8ClampedArray
  const { data, width, height } = img.bitmap;
  const clamped = new Uint8ClampedArray(data);
  return { data: clamped, width, height };
}

function makeQrVariants(img) {
  const variants = [];

  // base
  variants.push(img.clone());

  // grayscale + normalize
  variants.push(img.clone().greyscale().normalize());

  // grayscale + high contrast
  variants.push(img.clone().greyscale().contrast(0.6).normalize());

  // invert (a veces QR impreso raro)
  variants.push(img.clone().greyscale().contrast(0.6).normalize().invert());

  // resize up (si viene pequeño)
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  if (Math.max(w, h) < 900) {
    variants.push(img.clone().resize(w * 2, h * 2).greyscale().normalize().contrast(0.5));
  }

  // sharpen leve (ayuda a bordes)
  variants.push(img.clone().greyscale().normalize().contrast(0.5).convolute([
    [0, -1, 0],
    [-1, 5, -1],
    [0, -1, 0],
  ]));

  return variants;
}

function rotateVariants(img) {
  const out = [img];
  out.push(img.clone().rotate(90, false));
  out.push(img.clone().rotate(180, false));
  out.push(img.clone().rotate(270, false));
  return out;
}

async function decodeQrWithJsQR(img) {
  const { data, width, height } = jimpToRGBAUint8(img);
  const code = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return code?.data ? String(code.data) : null;
}

async function decodeQrWithQrcodeReader(img) {
  const qr = new QrCode();
  const qrText = await new Promise((resolve) => {
    qr.callback = (_err, value) => {
      const text = value?.result ? String(value.result) : null;
      resolve(text);
    };
    qr.decode(img.bitmap);
  });
  return qrText ? String(qrText) : null;
}

async function decodeQrFromDataUrl(dataUrl) {
  try {
    const img0 = await readJimpFromDataUrl(dataUrl);

    // intentamos recortes típicos (QR suele estar en parte baja o esquinas)
    const crops = [];
    const w = img0.bitmap.width;
    const h = img0.bitmap.height;

    crops.push(img0.clone()); // full

    // bottom half
    crops.push(img0.clone().crop(0, Math.floor(h * 0.45), w, Math.floor(h * 0.55)));

    // bottom-right quadrant
    crops.push(img0.clone().crop(Math.floor(w * 0.45), Math.floor(h * 0.45), Math.floor(w * 0.55), Math.floor(h * 0.55)));

    // bottom-left quadrant
    crops.push(img0.clone().crop(0, Math.floor(h * 0.45), Math.floor(w * 0.55), Math.floor(h * 0.55)));

    // intenta con variantes
    for (const crop of crops) {
      const variants = makeQrVariants(crop);

      for (const v of variants) {
        // a veces conviene limitar tamaño (jsQR no ama imágenes gigantes)
        const vv = v.clone();
        const maxSide = 1400;
        if (Math.max(vv.bitmap.width, vv.bitmap.height) > maxSide) {
          const scale = maxSide / Math.max(vv.bitmap.width, vv.bitmap.height);
          vv.resize(
            Math.max(1, Math.round(vv.bitmap.width * scale)),
            Math.max(1, Math.round(vv.bitmap.height * scale))
          );
        }

        const rots = rotateVariants(vv);
        for (const r of rots) {
          // 1) jsQR
          const js = await decodeQrWithJsQR(r);
          if (js) {
            return { present: true, decoded: true, text: js, error: null, method: "jsqr" };
          }

          // 2) fallback qrcode-reader
          const qrr = await decodeQrWithQrcodeReader(r);
          if (qrr) {
            return { present: true, decoded: true, text: qrr, error: null, method: "qrcode-reader" };
          }
        }
      }
    }

    // No decodificó. “present” no lo podemos asegurar sin detector real.
    return { present: false, decoded: false, text: null, error: "no_qr_decoded", method: null };
  } catch (e) {
    return { present: false, decoded: false, text: null, error: String(e?.message || e), method: null };
  }
}

function qrContainsAnyAccount(qrText, expectedAccounts) {
  const t = digitsOnly(qrText);
  if (!t) return false;
  return expectedAccounts.some((acc) => t.includes(digitsOnly(acc)));
}

// =========================
// Forense (lo dejamos SOLO informativo, no bloquea)
// =========================
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
    small.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  }

  const recompressed = small.clone().quality(60);
  const buf = await recompressed.getBufferAsync(Jimp.MIME_JPEG);
  const recompressed2 = await Jimp.read(buf);

  const d = meanAbsDiff(small, recompressed2, 2);

  // normalización menos “agresiva”
  const score = clamp01((d - 0.010) / 0.08);
  return { score, meanDiff: d };
}

async function forensicTamper(dataUrl) {
  try {
    const img = await readJimpFromDataUrl(dataUrl);
    const gray = img.clone().greyscale();

    const ela = await elaScore(gray);

    // Forense simplificado (en producción suele fallar mucho con screenshots/compress)
    // Lo dejamos como señal suave.
    const score = clamp01(ela.score);

    const signals = [];
    if (score > 0.65) signals.push("ela_inconsistente");

    return { ok: true, score, signals, details: { ela } };
  } catch (e) {
    return { ok: false, score: 0, signals: ["forensic_error"], details: { error: String(e?.message || e) } };
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
// Decisión final (más razonable)
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

  const expAmt = normalizeExpectedAmountCOP(expectedAmount);
  const expDate = normalizeDateYYYYMMDD(expectedDate);

  const expectedAccs =
    Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts.map(digitsOnly).filter(Boolean)
      : DEFAULT_EXPECTED_TO_ACCOUNTS.map(digitsOnly).filter(Boolean);

  const checkDestinations = Array.isArray(expectedToAccounts) && expectedToAccounts.length > 0;

  // ---------- monto (con escalas) ----------
  let okAmount = false;
  const amountCmp = compareAmountsCOP(readAmount, expectedAmount);

  if (amountCmp.exp != null && amountCmp.read != null) {
    okAmount = amountCmp.ok;
    const scaleNote = amountCmp.bestScale && amountCmp.bestScale !== 1 ? ` (escala x${amountCmp.bestScale})` : "";
    reasons.push(
      okAmount
        ? `✅ Monto coincide: esperado ${amountCmp.exp}, leído ${amountCmp.bestRead}${scaleNote}.`
        : `❌ Monto NO coincide. Esperado ${amountCmp.exp}, leído ${amountCmp.bestRead}${scaleNote} (diff ${amountCmp.diff}, tol ${amountCmp.tol}).`
    );
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

  // ---------- hora (informativo) ----------
  if (readTime) reasons.push(`ℹ️ Hora leída: ${readTime}.`);
  else reasons.push("ℹ️ Hora no detectada (ok en muchos comprobantes).");

  // ---------- referencia (ya NO dura) ----------
  const hasRef = !!(readRef && readRef.length >= 5);
  if (hasRef) reasons.push(`✅ Referencia detectada: ${readRef}.`);
  else reasons.push("ℹ️ Referencia no detectada (ok en algunos bancos/formatos).");

  // ---------- estado (informativo) ----------
  if (readStatus) reasons.push(`ℹ️ Estado detectado: ${readStatus}.`);
  else reasons.push("ℹ️ Estado no detectado.");

  // ---------- destino (opcional / solo si expectedToAccounts viene) ----------
  let okDest = false;
  if (readToAcc) {
    okDest = expectedAccs.some((acc) => String(readToAcc).includes(acc) || acc.includes(String(readToAcc)));
    if (checkDestinations) {
      reasons.push(okDest ? `✅ Destino coincide: ${readToAcc}.` : `❌ Destino NO coincide: ${readToAcc}.`);
    } else {
      reasons.push(`ℹ️ Destino leído: ${readToAcc} (no se valida porque no mandaste expectedToAccounts).`);
    }
  } else {
    reasons.push("ℹ️ Destino no detectado (muy común en comprobantes físicos o capturas).");
  }

  // ---------- QR (solo aporta si decodifica) ----------
  let qrMismatch = false;
  let qrStrongOk = false;

  if (qrInfo?.decoded) {
    reasons.push(`✅ QR decodificado (${qrInfo.method || "?"}).`);
    const qrOk = qrContainsAnyAccount(qrInfo.text, expectedAccs);
    if (checkDestinations) {
      if (qrOk) {
        qrStrongOk = true;
        reasons.push("✅ QR contiene un destino permitido.");
      } else {
        qrMismatch = true;
        reasons.push("❌ QR no contiene destinos permitidos.");
      }
    } else {
      reasons.push("ℹ️ QR decodificado, pero no se valida destino (no mandaste expectedToAccounts).");
    }
  } else {
    reasons.push("ℹ️ QR no decodificado (no bloquea verificación).");
  }

  // ---------- tamper (NO bloquea fuerte; solo baja confianza si alto) ----------
  const aiScore = clamp01(tamperAI?.score);
  const forScore = clamp01(forensic?.score);

  // FinalScore: damos más peso a IA (forense real falla mucho en screenshots)
  const tScore = clamp01(Math.max(aiScore, 0.6 * forScore));

  if (forensic?.ok) {
    if (forScore >= TAMPER_HIGH) reasons.push("⚠️ Forense: posible edición (señal fuerte).");
    else if (forScore >= TAMPER_MODERATE) reasons.push("⚠️ Forense: posible edición (señal moderada).");
    else reasons.push("✅ Forense: sin señales fuertes.");
  } else {
    reasons.push("ℹ️ Forense no disponible.");
  }

  if (aiScore >= TAMPER_HIGH) reasons.push("⚠️ IA: posible edición (señal fuerte).");
  else if (aiScore >= TAMPER_MODERATE) reasons.push("⚠️ IA: posible edición (señal moderada).");
  else reasons.push("✅ IA: sin señales fuertes.");

  // =========================
  // Reglas de decisión
  // =========================

  // 1) Si fecha o monto contradicen -> rechazo (esto sí es crítico)
  if (amountCmp.exp != null && amountCmp.read != null && !okAmount) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }
  if (readDate && expDate && !okDate) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  // 2) Si el usuario mandó expectedToAccounts y logramos leer destino y NO coincide -> rechazo
  //    (pero NO rechazamos si no pudimos leer destino)
  if (checkDestinations && readToAcc && !okDest) {
    // si QR decodificó y además contradice, más fuerte
    const conf = qrMismatch ? 0.92 : 0.88;
    return { suggested_status: "rechazado", confidence: conf, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  // 3) Verificado: monto+fecha OK. Destino/ref no obligatorios (por variedad de bancos)
  //    Si tamper alto, bajamos a pendiente.
  const tamperBlocksVerify = tScore >= TAMPER_HIGH;

  if (okAmount && okDate && !tamperBlocksVerify) {
    // sube confianza si hay señales extra
    let conf = 0.86;
    if (hasRef) conf += 0.03;
    if (qrStrongOk) conf += 0.03;
    if (checkDestinations && okDest) conf += 0.03;

    conf = Math.max(MIN_CONF_VERIFY, Math.min(0.95, conf));

    return { suggested_status: "verificado", confidence: conf, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  // 4) Si está todo bien pero tamper alto => pendiente
  if (okAmount && okDate && tamperBlocksVerify) {
    return { suggested_status: "pendiente_revision", confidence: 0.68, reasons: reasons.slice(0, 14), tamperFinal: tScore };
  }

  // 5) Si falta algo (monto o fecha no legible) => pendiente
  return { suggested_status: "pendiente_revision", confidence: 0.66, reasons: reasons.slice(0, 14), tamperFinal: tScore };
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
    expectedAmountIsThousands: EXPECTED_AMOUNT_IS_THOUSANDS,
    rules: {
      REQUIRE_REFERENCE_FOR_VERIFY,
      REQUIRE_DESTINATION_FOR_VERIFY,
      REQUIRE_QR_DECODE_FOR_VERIFY,
    },
    time: new Date().toISOString(),
  });
});

// =========================================================
// ✅ verify-consignacion (BASE64 o imageUrl)
// =========================================================
app.post("/verify-consignacion", async (req, res) => {
  const t0 = Date.now();
  const reqId = req._reqId || Math.random().toString(16).slice(2, 10);

  try {
    let {
      imageBase64,
      imageMime,
      imageUrl,
      expectedAmount,
      expectedDate,
      expectedDateTime,
      expectedToAccounts,
    } = req.body || {};

    // imageUrl -> base64
    if ((!imageBase64 || !imageMime) && imageUrl) {
      const got = await fetchImageAsBase64(imageUrl);
      imageBase64 = got.imageBase64;
      imageMime = got.imageMime;
    }

    if ((!imageBase64 || !imageMime) || expectedAmount == null || !expectedDate) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Faltan imageBase64+imageMime (o imageUrl), expectedAmount o expectedDate"],
      });
    }

    const dataUrl = asDataUrl(imageMime, imageBase64);

    // ======================
    // 1) QR decode (mejorado)
    // ======================
    const qrInfo = await decodeQrFromDataUrl(dataUrl);
    console.log(
      `[${reqId}] QR: decoded=${qrInfo.decoded} present=${qrInfo.present} method=${qrInfo.method || "-"} err=${qrInfo.error || "-"}`
    );
    if (qrInfo.decoded) console.log(`[${reqId}] QR text:`, short(qrInfo.text, 260));

    // ======================
    // 2) Forense (suave)
    // ======================
    const forensic = await forensicTamper(dataUrl);
    console.log(`[${reqId}] Forensic: ok=${forensic.ok} score=${forensic.score?.toFixed?.(3) ?? forensic.score}`);

    // ======================
    // 3) IA: extracción (mejor prompt para montos)
    // ======================
    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model}`);

    const expectedAccs = Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts
      : DEFAULT_EXPECTED_TO_ACCOUNTS;

    const expAmtNormalized = normalizeExpectedAmountCOP(expectedAmount);

    const system =
      "Eres un extractor estricto de comprobantes de pago en Colombia (Nequi, Daviplata, Bancolombia, Wompi, PSE, corresponsales, comprobantes físicos). " +
      "Tu trabajo NO es decidir 'verificado'. Tu trabajo es EXTRAER campos con alta precisión.\n\n" +
      "REGLAS IMPORTANTES PARA MONTO (COP):\n" +
      "1) Si ves '45.000' debes devolver 45000 (sin separadores).\n" +
      "2) Si ves '134.000' devuelve 134000.\n" +
      "3) Si el texto muestra separadores de miles pero tú solo alcanzas a leer '45', intenta inferir si realmente es 45000 y explica en reason.\n" +
      "4) No inventes montos. Si no es legible: value=null.\n\n" +
      "FORMATO:\n" +
      "- Devuelve SOLO JSON válido (sin markdown).\n" +
      "- confidence 0..1.\n" +
      "- Cada campo: value + confidence + reason.\n" +
      "- tamper.score 0..1 (alto = posible edición). Si dudas, sube score un poco.\n";

    const user =
      `DATOS ESPERADOS:\n` +
      `- expectedAmount (input): ${expectedAmount}\n` +
      `- expectedAmountNormalizedCOP: ${expAmtNormalized}\n` +
      `- expectedDate: ${expectedDate}\n` +
      `- expectedDateTime (opcional): ${expectedDateTime || ""}\n` +
      `- expectedToAccounts (opcional): ${expectedAccs.join(", ")}\n\n` +
      `EXTRAE del comprobante (si aparece):\n` +
      `- amount (COP como número entero: 45000)\n` +
      `- date (YYYY-MM-DD o DD/MM/YYYY)\n` +
      `- time (HH:mm si puedes)\n` +
      `- reference / comprobante / autorización\n` +
      `- toName (si aparece)\n` +
      `- toAccount (solo dígitos si aparece)\n` +
      `- statusLabel (ej "Aprobado", "Pago exitoso", "Envío realizado")\n` +
      `- qrPresent (true/false si ves un QR en la imagen)\n\n` +
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
    // 4) Reglas servidor
    // ======================
    const decision = buildReasonsAndDecide({
      expectedAmount,
      expectedDate,
      expectedToAccounts: expectedAccs,
      expectedDateTime,
      iaExtract: ia,
      qrInfo,
      forensic,
    });

    const aiScore = clamp01(ia?.tamper?.score);
    const forScore = clamp01(forensic?.score);
    const tamperFinal = clamp01(Math.max(aiScore, 0.6 * forScore));

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
        finalLevel: tamperFinal >= TAMPER_HIGH ? "high" : tamperFinal >= TAMPER_MODERATE ? "moderate" : "low",
      },

      qr: {
        present: !!qrInfo?.present,
        decoded: !!qrInfo?.decoded,
        method: qrInfo?.method || null,
        textShort: qrInfo?.decoded ? short(qrInfo.text, 220) : null,
        error: qrInfo?.decoded ? null : (qrInfo?.error || null),
      },

      debug: { reqId, ms: Date.now() - t0, model },
    };

    console.log(`[${reqId}] ✅ DONE ${result.suggested_status} in ${result.debug.ms}ms tamperFinal=${result.tamper.finalScore.toFixed(3)}`);
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
// ✅ extraer datos desde CÉDULA (igual que antes)
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
    console.log(`[${reqId}] frontMime=${frontMime} frontLen=${frontBase64 ? String(frontBase64).length : 0}`);
    console.log(`[${reqId}] backMime=${backMime} backLen=${backBase64 ? String(backBase64).length : 0}`);

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
// ✅ extraer datos desde TEXTO WhatsApp (igual)
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

/*
INSTALACIÓN:
  npm i express cors openai node-fetch jimp jsqr qrcode-reader dotenv

NOTAS:
- expectedAmount: puedes seguir mandando 45 o 134 (se interpreta como 45000 / 134000).
- QR: ahora se intenta decodificar con varios preprocesos/recortes/rotaciones.
- Forense: queda informativo y ya no “rompe” verificaciones (porque en screenshots suele fallar).
- Verificado: depende fuerte de monto+fecha. Destino/referencia ayudan pero no bloquean.
*/