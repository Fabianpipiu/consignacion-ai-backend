// consignacion-ai-backend/index.js
import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import OpenAI from "openai";

/* =========================
   1) Express app
========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

/* =========================
   2) Firebase Admin
========================= */
function initFirebase() {
  if (admin.apps.length) return;

  const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!p) throw new Error("Falta FIREBASE_SERVICE_ACCOUNT_PATH en .env");

  const absPath = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  const raw = fs.readFileSync(absPath, "utf8");
  const json = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(json),
  });

  console.log("✅ Firebase Admin inicializado");
}

initFirebase(); // (lo dejamos por si luego quieres usar Firestore desde el backend)

/* =========================
   3) OpenAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   4) Health
========================= */
app.get("/", (_, res) => {
  res.send("OK consignacion-ai-backend");
});

/* =========================
   5) IA verify (ALINEADO con tu Flutter NUEVO)
   Flutter envía:
   { imageUrl, expectedAmount, expectedDate }
========================= */
app.post("/verify-consignacion", async (req, res) => {
  try {
    const { imageUrl, expectedAmount, expectedDate } = req.body || {};

    if (!imageUrl || expectedAmount == null || !expectedDate) {
      return res.status(400).json({
        error: "Faltan imageUrl, expectedAmount o expectedDate",
      });
    }

    // Prompt claro y corto (primero que funcione; luego lo afinamos)
    const system =
      "Eres un verificador de comprobantes de consignación en Colombia. " +
      "Extrae monto, fecha y banco/billetera (Nequi, Daviplata, Bancolombia, etc). " +
      "Compara con lo esperado y responde SOLO JSON.";

    const user = `
DATOS ESPERADOS:
- expectedAmount: ${expectedAmount}
- expectedDate (YYYY-MM-DD): ${expectedDate}

Devuelve SOLO este JSON (sin texto adicional):
{
  "ok": boolean,
  "confidence": number,
  "suggested_status": "verificado" | "pendiente_revision" | "rechazado",
  "reasons": string[]
}
`;

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

    // Intentar parsear JSON
    let ia;
    try {
      ia = JSON.parse(response.output_text || "{}");
    } catch {
      ia = {
        ok: false,
        confidence: 0,
        suggested_status: "pendiente_revision",
        reasons: ["La IA no devolvió JSON válido."],
      };
    }

    // Asegurar campos mínimos
    if (typeof ia.ok !== "boolean") ia.ok = false;
    if (typeof ia.confidence !== "number") ia.confidence = 0;
    if (!ia.suggested_status) ia.suggested_status = "pendiente_revision";
    if (!Array.isArray(ia.reasons)) ia.reasons = [];

    return res.json(ia);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/* =========================
   6) Start server
========================= */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log("🚀 Server on port", port);
});
