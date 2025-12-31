// consignacion-ai-backend/index.js
import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import OpenAI from "openai";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "12mb" }));

/* ======================================================
   Firebase Admin (OPCIONAL)
====================================================== */
function tryInitFirebase() {
  try {
    if (admin.apps.length) return { enabled: true, mode: "already_initialized" };

    const jsonInline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (jsonInline && jsonInline.trim().length > 0) {
      const json = JSON.parse(jsonInline);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("✅ Firebase Admin inicializado (JSON env)");
      return { enabled: true, mode: "json_env" };
    }

    if (p && p.trim().length > 0) {
      const absPath = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      const raw = fs.readFileSync(absPath, "utf8");
      const json = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("✅ Firebase Admin inicializado (PATH)");
      return { enabled: true, mode: "path" };
    }

    console.log("ℹ️ Firebase Admin NO inicializado (no env vars). OK para Render.");
    return { enabled: false, mode: "disabled" };
  } catch (e) {
    console.error("⚠️ Firebase Admin init error:", e?.message || e);
    console.log("ℹ️ Continuamos sin Firebase Admin.");
    return { enabled: false, mode: "error" };
  }
}
const fb = tryInitFirebase();

/* ======================================================
   OpenAI helper
====================================================== */
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length < 10) {
    throw new Error("Falta OPENAI_API_KEY en Render Environment Variables");
  }
  return new OpenAI({ apiKey: key });
}

function short(s, n = 140) {
  if (!s) return "";
  return String(s).length > n ? String(s).slice(0, n) + "..." : String(s);
}

/* ======================================================
   Health
====================================================== */
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "consignacion-ai-backend",
    firebaseAdmin: fb,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || "gpt-4o-mini",
    time: new Date().toISOString(),
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

/* ======================================================
   verify-consignacion
====================================================== */
app.post("/verify-consignacion", async (req, res) => {
  const t0 = Date.now();
  const reqId = Math.random().toString(16).slice(2, 10);

  try {
    const { imageUrl, expectedAmount, expectedDate } = req.body || {};

    console.log(`\n[${reqId}] ---- /verify-consignacion HIT ----`);
    console.log(`[${reqId}] time:`, new Date().toISOString());
    console.log(`[${reqId}] imageUrl:`, short(imageUrl, 120));
    console.log(`[${reqId}] expectedAmount:`, expectedAmount);
    console.log(`[${reqId}] expectedDate:`, expectedDate);

    if (!imageUrl || expectedAmount == null || !expectedDate) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Faltan imageUrl, expectedAmount o expectedDate"],
      });
    }

    const openai = getOpenAI();
    const model = process.env.AI_MODEL || "gpt-4o-mini";

    const system =
      "Eres un verificador de comprobantes de consignación en Colombia. " +
      "Extrae monto, fecha y banco/billetera. " +
      "Compara con lo esperado y responde SOLO JSON válido.";

    const user = `DATOS ESPERADOS:
- expectedAmount: ${expectedAmount}
- expectedDate (YYYY-MM-DD): ${expectedDate}

Devuelve SOLO este JSON (sin texto adicional):
{
  "ok": boolean,
  "confidence": number,
  "suggested_status": "verificado" | "pendiente_revision" | "rechazado",
  "reasons": string[]
}`;

    console.log(`[${reqId}] OpenAI model: ${model}`);

    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: user },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
    });

    const txt = response.output_text || "";
    console.log(`[${reqId}] OpenAI output_text (first 300):`, short(txt, 300));

    let ia;
    try {
      ia = JSON.parse(txt);
    } catch {
      ia = {
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["La IA no devolvió JSON válido."],
        raw: short(txt, 400),
      };
    }

    if (typeof ia.ok !== "boolean") ia.ok = false;
    if (typeof ia.confidence !== "number") ia.confidence = 0;
    if (!ia.suggested_status) ia.suggested_status = "pendiente_revision";
    if (!Array.isArray(ia.reasons)) ia.reasons = [];

    ia.debug = {
      reqId,
      ms: Date.now() - t0,
      model,
      firebaseAdmin: fb,
    };

    console.log(`[${reqId}] ✅ RESP OK in ${Date.now() - t0}ms`);
    return res.json(ia);
  } catch (e) {
    // ✅ Log completo en Render
    const status = e?.status || e?.response?.status;
    const msg = e?.message || String(e);
    const data = e?.response?.data || e?.error?.response?.data;

    console.error(`\n[ERR] /verify-consignacion FAIL`);
    console.error("[ERR] status:", status);
    console.error("[ERR] message:", msg);
    if (data) console.error("[ERR] data:", data);

    // ✅ Respuesta con detalles (debug). Luego lo apagamos.
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
  } finally {
    console.log(`[DONE] /verify-consignacion ms=${Date.now() - t0}`);
  }
});

/* ======================================================
   Start
====================================================== */
const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log("🚀 Server on port", port);
});
