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
app.use(express.json({ limit: "8mb" }));

/* ======================================================
   1) Firebase Admin (OPCIONAL)
   - En Render NO lo exigimos
   - Solo se activa si existe:
     FIREBASE_SERVICE_ACCOUNT_JSON  (recomendado)
     o FIREBASE_SERVICE_ACCOUNT_PATH (local)
====================================================== */
function tryInitFirebase() {
  try {
    if (admin.apps.length) return { enabled: true, mode: "already_initialized" };

    const jsonInline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    // ✅ Preferido: JSON por env
    if (jsonInline && jsonInline.trim().length > 0) {
      const json = JSON.parse(jsonInline);
      admin.initializeApp({ credential: admin.credential.cert(json) });
      console.log("✅ Firebase Admin inicializado (JSON env)");
      return { enabled: true, mode: "json_env" };
    }

    // ✅ Alternativa: path a archivo (ideal solo local)
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
    console.error("⚠️ Firebase Admin NO pudo inicializar:", e?.message || e);
    console.log("ℹ️ Continuamos sin Firebase Admin (no es necesario para verify-consignacion).");
    return { enabled: false, mode: "error" };
  }
}

const fb = tryInitFirebase();

/* ======================================================
   2) OpenAI (REQUIRED para IA real)
====================================================== */
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length < 10) {
    throw new Error("Falta OPENAI_API_KEY en Render Environment Variables");
  }
  return new OpenAI({ apiKey: key });
}

/* ======================================================
   3) Health endpoints
====================================================== */
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "consignacion-ai-backend",
    firebaseAdmin: fb,
    time: new Date().toISOString(),
  });
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* ======================================================
   4) verify-consignacion (ALINEADO con Flutter)
   Body: { imageUrl, expectedAmount, expectedDate }
====================================================== */
app.post("/verify-consignacion", async (req, res) => {
  const t0 = Date.now();
  try {
    const { imageUrl, expectedAmount, expectedDate } = req.body || {};

    console.log("---- /verify-consignacion HIT ----");
    console.log("time:", new Date().toISOString());
    console.log("body:", { imageUrl: (imageUrl || "").slice(0, 80), expectedAmount, expectedDate });

    if (!imageUrl || expectedAmount == null || !expectedDate) {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["Faltan imageUrl, expectedAmount o expectedDate"],
      });
    }

    const openai = getOpenAI();

    const system =
      "Eres un verificador de comprobantes de consignación en Colombia. " +
      "Extrae monto, fecha y banco/billetera (Nequi, Daviplata, Bancolombia, etc). " +
      "Compara con lo esperado y responde SOLO JSON válido. " +
      "Si no puedes leer el comprobante, responde pendiente_revision con baja confianza.";

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

    console.log("OpenAI model:", process.env.AI_MODEL || "gpt-4o-mini");

    const response = await openai.responses.create({
      model: process.env.AI_MODEL || "gpt-4o-mini",
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
    console.log("OpenAI raw output_text (first 200):", txt.slice(0, 200));

    let ia;
    try {
      ia = JSON.parse(txt);
    } catch {
      ia = {
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["La IA no devolvió JSON válido."],
      };
    }

    if (typeof ia.ok !== "boolean") ia.ok = false;
    if (typeof ia.confidence !== "number") ia.confidence = 0;
    if (!ia.suggested_status) ia.suggested_status = "pendiente_revision";
    if (!Array.isArray(ia.reasons)) ia.reasons = [];

    ia.debug = {
      ms: Date.now() - t0,
      firebaseAdmin: fb,
    };

    return res.json(ia);
  } catch (e) {
    console.error("ERROR /verify-consignacion:", e);
    return res.status(500).json({
      ok: false,
      confidence: 0,
      suggested_status: "pendiente_revision",
      reasons: ["Error interno backend"],
      error: String(e?.message || e),
    });
  } finally {
    console.log("---- /verify-consignacion END ---- ms:", Date.now() - t0);
  }
});

/* ======================================================
   5) Start
====================================================== */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log("🚀 Server on port", port);
});
