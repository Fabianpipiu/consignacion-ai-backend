// consignacion-ai-backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";
import crypto from "crypto";

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

// Para “verificado”
const MIN_CONF_VERIFY = 0.80;

// Montos: ustedes mandan 45 => 45.000 / 134 => 134.000
const EXPECTED_AMOUNT_IS_THOUSANDS = true;

// Tolerancia monto (COP)
const AMOUNT_MIN_TOLERANCE_COP = 1000; // mínimo 1.000 de tolerancia
const AMOUNT_PCT_TOLERANCE = 0.012; // 1.2%

// Validación “fuerte” por confianza IA (si no llega, no se verifica)
const MIN_FIELD_CONF_AMOUNT = 0.60;
const MIN_FIELD_CONF_DATE = 0.60;

// Si mandas expectedDateTime, validamos la hora si se pudo leer (no bloquea si no hay hora)
const MAX_TIME_DIFF_MINUTES = 240; // 4h

// Validación imagen
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

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
  const buf = Buffer.from(ab);
  const imageBase64 = buf.toString("base64");

  return { imageBase64, imageMime };
}

function extractJson(text) {
  if (!text) return null;

  const raw = String(text).trim();
  const noFences = raw.replace(/```json/gi, "```").replace(/```/g, "").trim();

  const match = noFences.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0].trim() : noFences;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function detectMimeFromMagic(buf) {
  if (!buf || buf.length < 16) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "image/png";

  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";

  return null;
}

// =========================
// Date helpers (más robusto)
// =========================
function isIsoDateYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

// dd/mm/yyyy o dd-mm-yyyy -> yyyy-mm-dd
function tryParseLatamDate(s) {
  const v = normalizeStr(s);
  if (!v) return null;

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

  if (/^\d{2}:\d{2}$/.test(v)) return v;
  if (/^\d{1}:\d{2}$/.test(v)) return `0${v}`;

  return null;
}

function approxSameDate(a, b) {
  const na = normalizeDateYYYYMMDD(a);
  const nb = normalizeDateYYYYMMDD(b);
  return !!(na && nb && na === nb);
}

function parseExpectedDateTime(expectedDateTime) {
  // soporta:
  // - "YYYY-MM-DD HH:mm"
  // - "YYYY-MM-DDTHH:mm"
  // - "YYYY-MM-DDTHH:mm:ss"
  // - "YYYY-MM-DD"
  const s = normalizeStr(expectedDateTime);
  if (!s) return null;

  const m1 = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m1) return { date: m1[1], time: m1[2] };

  const d = normalizeDateYYYYMMDD(s);
  if (d) return { date: d, time: null };

  return null;
}

function minutesDiffHHMM(a, b) {
  const ta = normalizeTimeHHMM(a);
  const tb = normalizeTimeHHMM(b);
  if (!ta || !tb) return null;
  const [ah, am] = ta.split(":").map((x) => Number(x));
  const [bh, bm] = tb.split(":").map((x) => Number(x));
  if ([ah, am, bh, bm].some((n) => Number.isNaN(n))) return null;
  return Math.abs((ah * 60 + am) - (bh * 60 + bm));
}

// =========================
// Money helpers
// =========================
function toNumberMaybe(x) {
  if (x == null) return null;
  if (typeof x === "number" && !Number.isNaN(x)) return x;

  const s = String(x);
  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const digits = cleaned.replace(/[^\d]/g, "");
  if (!digits) return null;

  const n = Number(digits);
  return Number.isNaN(n) ? null : n;
}

function normalizeExpectedAmountCOP(expectedAmount) {
  const n = toNumberMaybe(expectedAmount);
  if (n == null) return null;

  if (EXPECTED_AMOUNT_IS_THOUSANDS && n > 0 && n < 1000) return n * 1000;
  return n;
}

function compareAmountsCOP(readAmountRaw, expectedAmountRaw) {
  const exp = normalizeExpectedAmountCOP(expectedAmountRaw);
  const read = toNumberMaybe(readAmountRaw);

  if (exp == null || read == null) {
    return {
      ok: false,
      exp: exp ?? null,
      read: read ?? null,
      bestRead: null,
      bestScale: null,
      diff: null,
      tol: null,
    };
  }

  const scales = [1, 10, 100, 1000];
  let best = null;

  for (const sc of scales) {
    const candidate = read * sc;

    const tol = Math.max(
      AMOUNT_MIN_TOLERANCE_COP,
      Math.round(exp * AMOUNT_PCT_TOLERANCE)
    );
    const diff = Math.abs(candidate - exp);
    const ok = diff <= tol;

    const score = diff + (sc > 1 ? 0.5 : 0);

    if (!best || score < best.score) {
      best = { ok, exp, read, bestRead: candidate, bestScale: sc, diff, tol, score };
    }
  }

  return {
    ok: best.ok,
    exp: best.exp,
    read: best.read,
    bestRead: best.bestRead,
    bestScale: best.bestScale,
    diff: best.diff,
    tol: best.tol,
  };
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

  // Campos principales
  normFieldNumber("amount");
  normFieldString("date", { kind: "date" });
  normFieldString("time", { kind: "time" });
  normFieldString("reference");
  normFieldString("toName");
  normFieldString("toAccount", { kind: "digits" });
  normFieldString("statusLabel");
  normFieldString("channel"); // Bancolombia/Nequi/PSE/Wompi/etc
  normFieldString("transactionId"); // id/autorización si existe
  normFieldString("fromAccount", { kind: "digits" }); // si aparece (tel/cuenta)

  // Señales “suaves” (no forense, no QR): solo lo que la IA observe del contenido
  out.integrity = out.integrity && typeof out.integrity === "object" ? out.integrity : {};
  out.integrity.suspected = typeof out.integrity.suspected === "boolean" ? out.integrity.suspected : false;
  out.integrity.score = clamp01(out.integrity.score);
  if (!Array.isArray(out.integrity.signals)) out.integrity.signals = [];
  out.integrity.signals = out.integrity.signals.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 12);

  if (!Array.isArray(out.notes)) out.notes = [];
  out.notes = out.notes.map((x) => normalizeStr(x)).filter(Boolean).slice(0, 12);

  return out;
}

function normalizeStatus(s) {
  const v = String(s || "").trim();
  if (v === "verificado" || v === "pendiente_revision" || v === "rechazado") return v;
  return "pendiente_revision";
}

function labelLooksSuccessful(label) {
  const s = normalizeStr(label).toLowerCase();
  if (!s) return false;
  // palabras típicas de “ok”
  return /(aprob|exitos|exitosa|complet|confirm|realizad|pagad|recibid|procesad|ok)/i.test(s);
}

// =========================
// Decisión final (sin QR, sin forense)
// =========================
function buildReasonsAndDecide({
  expectedAmount,
  expectedDate,
  expectedToAccounts,
  expectedDateTime,
  iaExtract,
}) {
  const reasons = [];
  const ex = iaExtract?.extracted || {};
  const integrity = iaExtract?.integrity || {};

  const readAmount = ex?.amount?.value;
  const readAmountConf = clamp01(ex?.amount?.confidence);

  const readDate = ex?.date?.value;
  const readDateConf = clamp01(ex?.date?.confidence);

  const readTime = ex?.time?.value;
  const readTimeConf = clamp01(ex?.time?.confidence);

  const readRef = ex?.reference?.value ? String(ex.reference.value) : null;
  const readToAcc = ex?.toAccount?.value ? String(ex.toAccount.value) : null;
  const readStatus = ex?.statusLabel?.value ? String(ex.statusLabel.value) : null;

  const readChannel = ex?.channel?.value ? String(ex.channel.value) : null;
  const readTxnId = ex?.transactionId?.value ? String(ex.transactionId.value) : null;

  const expAmt = normalizeExpectedAmountCOP(expectedAmount);
  const expDate = normalizeDateYYYYMMDD(expectedDate);

  const expectedAccs =
    Array.isArray(expectedToAccounts) && expectedToAccounts.length
      ? expectedToAccounts.map(digitsOnly).filter(Boolean)
      : DEFAULT_EXPECTED_TO_ACCOUNTS.map(digitsOnly).filter(Boolean);

  const checkDestinations = Array.isArray(expectedToAccounts) && expectedToAccounts.length > 0;

  // ---------- validación amount ----------
  const amountCmp = compareAmountsCOP(readAmount, expectedAmount);
  const scaleNote = amountCmp.bestScale && amountCmp.bestScale !== 1 ? ` (escala x${amountCmp.bestScale})` : "";

  let okAmount = false;
  if (amountCmp.exp != null && amountCmp.read != null) {
    okAmount = amountCmp.ok;
    if (okAmount) {
      reasons.push(`✅ Monto coincide: esperado ${amountCmp.exp}, leído ${amountCmp.bestRead}${scaleNote}.`);
    } else {
      // ✅ pedido: QUITAMOS diff/tol del texto
      reasons.push(`❌ Monto NO coincide. Esperado ${amountCmp.exp}, leído ${amountCmp.bestRead}${scaleNote}.`);
    }
  } else {
    reasons.push("⚠️ No se pudo leer el monto con claridad.");
  }

  // ---------- validación date ----------
  let okDate = false;
  if (readDate && expDate) {
    okDate = approxSameDate(String(readDate), expDate);
    reasons.push(okDate ? `✅ Fecha coincide: ${expDate}.` : `❌ Fecha NO coincide. Esperado ${expDate}, leído ${readDate}.`);
  } else {
    reasons.push("⚠️ No se pudo leer la fecha con claridad.");
  }

  // ---------- validación expectedDateTime (si aplica) ----------
  const expDT = parseExpectedDateTime(expectedDateTime);
  if (expDT?.date) {
    // si date esperado tiene, y readDate existe, ya lo validamos arriba.
    if (expDT.time && readTime) {
      const md = minutesDiffHHMM(expDT.time, readTime);
      if (md == null) {
        reasons.push("ℹ️ Hora detectada pero no se pudo comparar.");
      } else if (md <= MAX_TIME_DIFF_MINUTES) {
        reasons.push(`✅ Hora razonable vs expectedDateTime (±${MAX_TIME_DIFF_MINUTES / 60}h).`);
      } else {
        reasons.push(`⚠️ Hora fuera de rango vs expectedDateTime (diferencia ~${md} min).`);
      }
    } else if (expDT.time && !readTime) {
      reasons.push("ℹ️ expectedDateTime trae hora, pero el comprobante no mostró hora legible (no bloquea).");
    }
  }

  // ---------- confianza mínima (extra verificación) ----------
  if (readAmount != null && readAmountConf < MIN_FIELD_CONF_AMOUNT) {
    reasons.push(`⚠️ Monto leído con baja confianza (${readAmountConf.toFixed(2)}).`);
  }
  if (readDate && readDateConf < MIN_FIELD_CONF_DATE) {
    reasons.push(`⚠️ Fecha leída con baja confianza (${readDateConf.toFixed(2)}).`);
  }

  // ---------- destino (solo si expectedToAccounts viene) ----------
  let okDest = false;
  if (readToAcc) {
    okDest = expectedAccs.some((acc) => String(readToAcc).includes(acc) || acc.includes(String(readToAcc)));
    if (checkDestinations) {
      reasons.push(okDest ? `✅ Destino coincide: ${readToAcc}.` : `❌ Destino NO coincide: ${readToAcc}.`);
    } else {
      reasons.push(`ℹ️ Destino leído: ${readToAcc} (no se valida porque no mandaste expectedToAccounts).`);
    }
  } else {
    reasons.push("ℹ️ Destino no detectado (común en capturas/formatos).");
  }

  // ---------- referencia/transactionId (verificación adicional, no obligatoria) ----------
  const hasRef = !!(readRef && readRef.length >= 5);
  if (hasRef) reasons.push(`✅ Referencia detectada: ${readRef}.`);
  else reasons.push("ℹ️ Referencia no detectada.");

  if (readTxnId && readTxnId.length >= 5) reasons.push(`ℹ️ ID transacción detectado: ${readTxnId}.`);

  // ---------- canal (banco/app) ----------
  if (readChannel) reasons.push(`ℹ️ Canal detectado: ${readChannel}.`);

  // ---------- estado (señal extra) ----------
  const statusOkSignal = labelLooksSuccessful(readStatus);
  if (readStatus) {
    reasons.push(`ℹ️ Estado detectado: ${readStatus}.`);
    if (!statusOkSignal) reasons.push("⚠️ El estado no suena claramente a pago exitoso (señal suave).");
  } else {
    reasons.push("ℹ️ Estado no detectado.");
  }

  // ---------- integridad (solo señales de contenido) ----------
  const iScore = clamp01(integrity?.score);
  if (integrity?.signals?.length) {
    reasons.push(`⚠️ Señales de posible inconsistencia: ${integrity.signals.slice(0, 3).join(", ")}.`);
  } else {
    reasons.push("✅ Sin señales fuertes de inconsistencia en el contenido.");
  }

  // =========================
  // Reglas de decisión
  // =========================

  // 1) Si monto o fecha contradicen -> rechazo
  if (amountCmp.exp != null && amountCmp.read != null && !okAmount) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), integrityFinal: iScore };
  }
  if (readDate && expDate && !okDate) {
    return { suggested_status: "rechazado", confidence: 0.90, reasons: reasons.slice(0, 14), integrityFinal: iScore };
  }

  // 2) Si mandaste expectedToAccounts y logramos leer destino y NO coincide -> rechazo
  if (checkDestinations && readToAcc && !okDest) {
    return { suggested_status: "rechazado", confidence: 0.88, reasons: reasons.slice(0, 14), integrityFinal: iScore };
  }

  // 3) Para “verificado”: monto+fecha OK + confianza mínima en campos
  //    (si confianza baja => pendiente)
  const confBlocksVerify =
    (readAmount != null && readAmountConf < MIN_FIELD_CONF_AMOUNT) ||
    (readDate != null && readDateConf < MIN_FIELD_CONF_DATE);

  if (okAmount && okDate && !confBlocksVerify) {
    let conf = 0.86;

    if (hasRef) conf += 0.03;
    if (checkDestinations && okDest) conf += 0.03;
    if (statusOkSignal) conf += 0.02;

    // si integrity score está alto, bajamos
    if (iScore >= 0.70) conf -= 0.10;
    else if (iScore >= 0.45) conf -= 0.05;

    conf = Math.max(MIN_CONF_VERIFY, Math.min(0.95, conf));

    // si el estado NO suena exitoso, mejor lo dejamos pendiente (a menos que el usuario quiera ignorar estado)
    if (readStatus && !statusOkSignal) {
      return { suggested_status: "pendiente_revision", confidence: 0.70, reasons: reasons.slice(0, 14), integrityFinal: iScore };
    }

    return { suggested_status: "verificado", confidence: conf, reasons: reasons.slice(0, 14), integrityFinal: iScore };
  }

  // 4) Si está todo bien pero con baja confianza => pendiente
  if (okAmount && okDate && confBlocksVerify) {
    return { suggested_status: "pendiente_revision", confidence: 0.68, reasons: reasons.slice(0, 14), integrityFinal: iScore };
  }

  // 5) Si falta algo (monto o fecha no legible) => pendiente
  return { suggested_status: "pendiente_revision", confidence: 0.66, reasons: reasons.slice(0, 14), integrityFinal: iScore };
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
    validations: {
      minFieldConfAmount: MIN_FIELD_CONF_AMOUNT,
      minFieldConfDate: MIN_FIELD_CONF_DATE,
      maxImageBytes: MAX_IMAGE_BYTES,
      allowedMimes: Array.from(ALLOWED_MIMES),
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

    // 0) Validaciones input (extra)
    if (expectedAmount == null || normalizeStr(expectedAmount) === "") {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Falta expectedAmount"],
      });
    }

    const expDateNorm = normalizeDateYYYYMMDD(expectedDate);
    if (!expectedDate || !expDateNorm) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Falta expectedDate o no tiene formato válido (usa YYYY-MM-DD o DD/MM/YYYY)"],
      });
    }
    expectedDate = expDateNorm;

    // imageUrl -> base64
    if ((!imageBase64 || !imageMime) && imageUrl) {
      const got = await fetchImageAsBase64(imageUrl);
      imageBase64 = got.imageBase64;
      imageMime = got.imageMime;
    }

    if (!imageBase64 || !imageMime) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Faltan imageBase64+imageMime (o imageUrl)"],
      });
    }

    imageMime = String(imageMime).split(";")[0].trim().toLowerCase();

    if (!ALLOWED_MIMES.has(imageMime)) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: [`imageMime no permitido: ${imageMime}`],
      });
    }

    // Base64 -> buffer + tamaño + magic bytes
    let buf;
    try {
      buf = Buffer.from(String(imageBase64), "base64");
    } catch {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["imageBase64 inválido (no se pudo decodificar)"],
      });
    }

    if (!buf || buf.length < 2000) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Imagen muy pequeña o corrupta"],
      });
    }

    if (buf.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: [`Imagen excede el límite de ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB`],
      });
    }

    const magicMime = detectMimeFromMagic(buf);
    if (!magicMime) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["No se pudo reconocer el tipo real de imagen (magic bytes)"],
      });
    }

    if (magicMime !== imageMime) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: [`imageMime (${imageMime}) no coincide con el tipo real (${magicMime})`],
      });
    }

    const imgHash = sha256Hex(buf);
    const dataUrl = asDataUrl(imageMime, imageBase64);

    // expectedToAccounts normalizado
    const expectedAccs =
      Array.isArray(expectedToAccounts) && expectedToAccounts.length
        ? expectedToAccounts
        : DEFAULT_EXPECTED_TO_ACCOUNTS;

    // expectedAmount normalizado + sanity
    const expAmtNormalized = normalizeExpectedAmountCOP(expectedAmount);
    if (expAmtNormalized == null || expAmtNormalized <= 0) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["expectedAmount inválido (no se pudo normalizar)"],
      });
    }
    // opcional: evita montos absurdos por error de input
    if (expAmtNormalized > 200_000_000) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["expectedAmount demasiado alto (revisa el input)"],
      });
    }

    // ======================
    // IA: extracción (sin QR, sin forense)
    // ======================
    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    console.log(`[${reqId}] OpenAI model=${model} imgHash=${imgHash.slice(0, 12)}... size=${buf.length}`);

    const system =
      "Eres un extractor estricto de comprobantes de pago en Colombia (Nequi, Daviplata, Bancolombia, PSE, Wompi, corresponsales, comprobantes físicos). " +
      "Tu trabajo NO es decidir 'verificado'. Tu trabajo es EXTRAER campos con alta precisión.\n\n" +
      "REGLAS IMPORTANTES:\n" +
      "1) NO inventes. Si no es legible: value=null.\n" +
      "2) Para monto COP: devuelve entero sin separadores (45.000 => 45000).\n" +
      "3) Fecha: ideal YYYY-MM-DD; si ves DD/MM/YYYY también sirve.\n" +
      "4) Si ves inconsistencias (texto raro, cortes, sobreposiciones, partes repetidas), llena integrity.\n\n" +
      "FORMATO:\n" +
      "- Devuelve SOLO JSON válido (sin markdown).\n" +
      "- confidence 0..1.\n" +
      "- Cada campo: value + confidence + reason.\n";

    const user =
      `DATOS ESPERADOS:\n` +
      `- expectedAmount (input): ${expectedAmount}\n` +
      `- expectedAmountNormalizedCOP: ${expAmtNormalized}\n` +
      `- expectedDate: ${expectedDate}\n` +
      `- expectedDateTime (opcional): ${expectedDateTime || ""}\n` +
      `- expectedToAccounts (opcional): ${expectedAccs.join(", ")}\n\n` +
      `EXTRAE del comprobante (si aparece):\n` +
      `- amount (COP entero)\n` +
      `- date\n` +
      `- time (HH:mm)\n` +
      `- reference\n` +
      `- transactionId (id/autoriza/comprobante si existe)\n` +
      `- channel (banco/app/pasarela: Nequi/Bancolombia/PSE/etc)\n` +
      `- toName\n` +
      `- toAccount (solo dígitos si aparece)\n` +
      `- fromAccount (solo dígitos si aparece: tel/cuenta)\n` +
      `- statusLabel\n\n` +
      `Devuelve SOLO este JSON:\n` +
      `{\n` +
      `  "ok": boolean,\n` +
      `  "confidence": number,\n` +
      `  "extracted": {\n` +
      `    "amount": {"value": number|null, "confidence": number, "reason": string},\n` +
      `    "date": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "time": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "reference": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "transactionId": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "channel": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "toName": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "toAccount": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "fromAccount": {"value": string|null, "confidence": number, "reason": string},\n` +
      `    "statusLabel": {"value": string|null, "confidence": number, "reason": string}\n` +
      `  },\n` +
      `  "integrity": {"suspected": boolean, "score": number, "signals": string[]},\n` +
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
        integrity: { suspected: false, score: 0, signals: ["json_invalido"] },
        notes: ["La IA no devolvió JSON válido."],
        raw: short(out, 900),
      };
    }
    ia = ensureVerifyResult(ia);

    // ======================
    // Reglas servidor (más verificaciones)
    // ======================
    const decision = buildReasonsAndDecide({
      expectedAmount,
      expectedDate,
      expectedToAccounts: expectedAccs,
      expectedDateTime,
      iaExtract: ia,
    });

    const result = {
      ok: true,
      suggested_status: normalizeStatus(decision.suggested_status),
      confidence: clamp01(decision.confidence),
      reasons: (decision.reasons || []).slice(0, 14),

      extracted: ia.extracted,

      integrity: {
        ai: ia.integrity,
        finalScore: clamp01(ia?.integrity?.score),
        finalLevel:
          clamp01(ia?.integrity?.score) >= 0.70
            ? "high"
            : clamp01(ia?.integrity?.score) >= 0.45
            ? "moderate"
            : "low",
      },

      debug: {
        reqId,
        ms: Date.now() - t0,
        model,
        imgHash: imgHash.slice(0, 24),
        imgBytes: buf.length,
      },
    };

    console.log(
      `[${reqId}] ✅ DONE ${result.suggested_status} in ${result.debug.ms}ms integrity=${result.integrity.finalScore.toFixed(3)}`
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
  npm i express cors openai node-fetch dotenv

CAMBIOS:
- Eliminado QR y forense completamente.
- Más verificaciones:
  - mime permitido
  - tamaño máximo
  - magic bytes vs imageMime
  - normalización estricta expectedDate
  - sanity expectedAmount
  - umbral mínimo de confianza para amount/date
  - validación suave de statusLabel (si no suena exitoso => pendiente)
  - validación opcional de expectedDateTime (si hay hora y se detecta)
- Quitado el texto: (diff ..., tol ...).
*/
