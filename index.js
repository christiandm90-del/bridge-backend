const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// 🔐 Firebase APPBASE service account
const serviceAccount = require("./serviceAccountKey.json");

// 🔥 Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🚀 App setup
const app = express();

app.use(cors());
app.use(express.json());

// ✔️ TEST SERVER
app.get("/", (req, res) => {
  res.send("✅ Bridge backend online");
});

// 🔥 SYNC MENU (core endpoint)
app.post("/sync-menu", async (req, res) => {
  try {
    console.log("📩 REQUEST ARRIVATA /sync-menu");
    console.log("BODY:", req.body);

const {
  localeId,
  companyName,
  categorie = [],
  sottocategorie = [],
  prodotti = []
} = req.body;

    if (!localeId) {
      return res.status(400).json({
        error: "localeId mancante"
      });
    }

    // 🔥 Salvataggio su APPBASE Firebase
await db
  .collection("publicMenus")
  .doc(localeId)
  .set({
    companyName: companyName || "Senza Nome",
    categorie,
    sottocategorie,
    prodotti,
    updatedAt: Date.now(),
  });
    console.log("✅ Menu sincronizzato su APPBASE:", localeId);

    return res.json({
      success: true
    });

  } catch (err) {
    console.error("❌ Errore sync-menu:", err);

    return res.status(500).json({
      error: "Errore server"
    });
  }
});

// 🚀 START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server avviato sulla porta ${PORT}`);
});