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
/* =========================
   HELPER: distanza in metri tra due coordinate (haversine)
========================= */
/* =========================
   HELPER: distanza in metri tra due coordinate (haversine)
========================= */
function distanzaMetri(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =========================
   SEND ORDER (APPBASE → DEMAS)
========================= */
app.post("/send-order", async (req, res) => {
  try {

    const { token } = req.body;

    if (!token) {
      return res.status(401).json({
        error: "Utente non autenticato"
      });
    }

    const decoded = await appbaseApp
      .auth()
      .verifyIdToken(token);


    const userDoc = await appbaseDb
  .collection("users")
  .doc(decoded.uid)
  .get();

const userData = userDoc.data() || {};

    const {
      localeId,
      tavolo,
      prodotti,
      totale,
      metodoPagamento,
      timestamp,
      tableId,
      sessionToken,
      guestName,
      lat,
      lng,
    } = req.body;

    if (!localeId) {
      return res.status(400).json({
        error: "localeId mancante"
      });
    }

    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({
        error: "prodotti mancanti"
      });
    }

    /* =========================
       Risoluzione tavolo + verifica sessione + geofence
       - token non valido/scaduto/inesistente → caso "duro": spam, non ambiguo
       - solo geofence fuori raggio (token valido) → caso ambiguo: daVerificare
    ========================= */
    let tavoloRisolto = tavolo || "";
    let noteCliente = null;
    let daVerificare = false;
    let spam = false;

    if (tableId != null) {
      noteCliente = tavolo || null;

      try {
        const sessioneSnap = await demasDb
          .collection("bars").doc(localeId)
          .collection("sessioniTavolo").doc(String(tableId))
          .get();

        let sessioneValida = false;
        if (sessioneSnap.exists) {
          const sessione = sessioneSnap.data();
          const ora = Date.now();
          sessioneValida =
            sessione.attivo === true &&
            sessione.token === sessionToken &&
            (sessione.scadeAt == null || sessione.scadeAt > ora);
        }

        if (!sessioneValida) {
          spam = true;
        } else {
          const localeSnap = await demasDb
            .collection("bars").doc(localeId)
            .collection("meta").doc("locale")
            .get();

          if (localeSnap.exists) {
            const localeData = localeSnap.data();
            if (
              typeof localeData.lat === "number" &&
              typeof localeData.lng === "number" &&
              typeof lat === "number" &&
              typeof lng === "number"
            ) {
              const raggio = localeData.raggioMetri || 150;
              const distanza = distanzaMetri(lat, lng, localeData.lat, localeData.lng);
              if (distanza > raggio) daVerificare = true;
            }
          }
        }

        const tavoloSnap = await demasDb
          .collection("bars").doc(localeId)
          .collection("tavoli").doc(String(tableId))
          .get();
        if (tavoloSnap.exists) {
          tavoloRisolto = tavoloSnap.data().nome || `Tavolo ${tableId}`;
        }
      } catch (err) {
        console.error("Errore validazione sessione tavolo:", err);
        daVerificare = true; // in dubbio, verifica manuale, non spam
      }
    }

const now = new Date();

const formatter = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const parts = formatter.formatToParts(now);

const get = (type) =>
  parts.find(p => p.type === type)?.value || "00";

const giorno = get("day");
const mese = get("month");
const ora = get("hour");
const minuti = get("minute");

const emailSafe = String(decoded.email || "utente")
  .replace(/[@.]/g, "-")
  .slice(0, 40);

const randomId = Math.random()
  .toString(36)
  .substring(2, 8)
  .toUpperCase();

const ordineId =
  `${giorno}-${mese}_${ora}-${minuti}_${emailSafe}_${randomId}`;

await demasDb
  .collection("bars")
  .doc(localeId)
.collection("ordini")
.doc(ordineId)
.set({
cliente: {
  uid: decoded.uid,
  email: String(decoded.email || "").slice(0, 120),
  nome: String(guestName || userData.ownerName || "").slice(0, 80),
  telefono: String(userData.phone || "").slice(0, 30),
},

    tavolo: tavoloRisolto,
    note: noteCliente,
    tableId: tableId ?? null,
    daVerificare,
    spam,
    prodotti,
    totale,
    metodoPagamento,

    timestamp: timestamp || Date.now(),

    createdAt: admin.firestore.FieldValue.serverTimestamp(),

    status: "nuovo",
    source: "appbase"
  });

    if (spam) {
      return res.status(409).json({
        error: "sessione_non_valida",
        scollega: true
      });
    }

    res.json({ success: true });

  } catch (err) {

    console.error(err);
return res.status(403).json({
  error: "token non valido"
});
  }
});
{/* prev: *app.post("/send-order", async (req, res) => {
  try {

    const { token } = req.body;

    if (!token) {
      return res.status(401).json({
        error: "Utente non autenticato"
      });
    }

    const decoded = await appbaseApp
      .auth()
      .verifyIdToken(token);


    const userDoc = await appbaseDb
  .collection("users")
  .doc(decoded.uid)
  .get();

const userData = userDoc.data() || {};

    const {
      localeId,
      tavolo,
      prodotti,
      totale,
      metodoPagamento,
      timestamp
    } = req.body;

    if (!localeId) {
      return res.status(400).json({
        error: "localeId mancante"
      });
    }

    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({
        error: "prodotti mancanti"
      });
    }

const now = new Date();

const formatter = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const parts = formatter.formatToParts(now);

const get = (type) =>
  parts.find(p => p.type === type)?.value || "00";

const giorno = get("day");
const mese = get("month");
const ora = get("hour");
const minuti = get("minute");

const emailSafe = String(decoded.email || "utente")
  .replace(/[@.]/g, "-")
  .slice(0, 40);

const randomId = Math.random()
  .toString(36)
  .substring(2, 8)
  .toUpperCase();

const ordineId =
  `${giorno}-${mese}_${ora}-${minuti}_${emailSafe}_${randomId}`;

await demasDb
  .collection("bars")
  .doc(localeId)
.collection("ordini")
.doc(ordineId)
.set({
cliente: {
  uid: decoded.uid,
  email: String(decoded.email || "").slice(0, 120),
  nome: String(userData.ownerName || "").slice(0, 80),
  telefono: String(userData.phone || "").slice(0, 30),
},

    tavolo,
    prodotti,
    totale,
    metodoPagamento,

    timestamp: timestamp || Date.now(),

    createdAt: admin.firestore.FieldValue.serverTimestamp(),

    status: "nuovo",
    source: "appbase"
  });

    res.json({ success: true });

  } catch (err) {

    console.error(err);
return res.status(403).json({
  error: "token non valido"
});
  }
}); */}

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server avviato sulla porta ${PORT}`);
});