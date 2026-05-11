const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.BRIDGE_SECRET;

/* =========================
   🔥 FIREBASE APPBASE (GIÀ ESISTENTE SU RENDER)
========================= */
const appbaseServiceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
};

/* =========================
   🔥 FIREBASE DEMAS (NUOVO SU RENDER)
========================= */
const demasServiceAccount = {
  project_id: process.env.DEMAS_FIREBASE_PROJECT_ID,
  client_email: process.env.DEMAS_FIREBASE_CLIENT_EMAIL,
  private_key: process.env.DEMAS_FIREBASE_PRIVATE_KEY
    ? process.env.DEMAS_FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
};

/* =========================
   INIT FIREBASES
========================= */
const appbaseApp = admin.initializeApp(
  { credential: admin.credential.cert(appbaseServiceAccount) },
  "appbase"
);

const demasApp = admin.initializeApp(
  { credential: admin.credential.cert(demasServiceAccount) },
  "demas"
);

const appbaseDb = appbaseApp.firestore();
const demasDb = demasApp.firestore();

/* =========================
   TEST
========================= */
app.get("/", (req, res) => {
  res.send("✅ Bridge backend online");
});

/* =========================
   SYNC MENU (DEMAS → APPBASE)
========================= */
app.post("/sync-menu", async (req, res) => {
  try {
    if (req.body.secret !== API_KEY) {
      return res.status(403).json({ error: "unauthorized" });
    }

    const {
      localeId,
      companyName,
      categorie = [],
      sottocategorie = [],
      prodotti = []
    } = req.body;

    await appbaseDb.collection("publicMenus").doc(localeId).set({
      companyName: companyName || "Senza Nome",
      categorie,
      sottocategorie,
      prodotti,
      updatedAt: Date.now(),
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

/* =========================
   SEND ORDER (APPBASE → DEMAS)
========================= */
app.post("/send-order", async (req, res) => {
  try {
    if (req.body.secret !== API_KEY) {
      return res.status(403).json({ error: "unauthorized" });
    }

    const {
      localeId,
      tavolo,
      prodotti,
      totale,
      metodoPagamento,
      timestamp
    } = req.body;
    if (!localeId) {
  return res.status(400).json({ error: "localeId mancante" });
}

if (!Array.isArray(prodotti) || prodotti.length === 0) {
  return res.status(400).json({ error: "prodotti mancanti" });
}

    await demasDb
      .collection("bars")
      .doc(localeId)
      .collection("ordini")
      .add({
        tavolo,
        prodotti,
        totale,
        metodoPagamento,
        timestamp: timestamp || Date.now(),
        status: "nuovo",
        source: "appbase"
      });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server avviato sulla porta ${PORT}`);
});