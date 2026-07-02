const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
app.use(cors());
app.use(express.json());

// Stripe inizializzato con chiave segreta da env
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const API_KEY = process.env.BRIDGE_SECRET;

/* =========================
   🔥 FIREBASE APPBASE
========================= */
const appbaseServiceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
};

/* =========================
   🔥 FIREBASE DEMAS
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
      prodotti = [],
        publicMenus = null,  
    } = req.body;

    await appbaseDb.collection("publicMenus").doc(localeId).set({
      companyName: companyName || "Senza Nome",
      categorie,
      sottocategorie,
      prodotti,

       orari: publicMenus?.orari || {},
  chiusure: publicMenus?.chiusure || [],
  offerte: publicMenus?.offerte || [],
  menuPubblicoAttivo: publicMenus?.menuPubblicoAttivo || false,
  
      updatedAt: Date.now(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

/* =========================
   HELPER: distanza in metri (haversine)
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
   HELPER: verifica prodotti contro il menu reale, ricalcola prezzi/totale
   server-side — non ci si fida mai dei prezzi inviati dal client
========================= */
async function verificaEcorreggiProdotti(localeId, prodottiClient) {
  const menuSnap = await appbaseDb.collection("publicMenus").doc(localeId).get();
  if (!menuSnap.exists) return null;

  const menuProdotti = menuSnap.data().prodotti || [];
  const mappaPrezzi = new Map();
  menuProdotti.forEach((p) => {
    if (p && p.nome) mappaPrezzi.set(String(p.nome).trim().toLowerCase(), Number(p.prezzo) || 0);
  });

  const prodottiCorretti = [];
  for (const item of prodottiClient) {
    const chiave = String(item?.nome || "").trim().toLowerCase();
    const prezzoReale = mappaPrezzi.get(chiave);
    if (prezzoReale == null) return null; // prodotto non in menu: sospetto, rifiuta
    prodottiCorretti.push({ ...item, prezzo: prezzoReale });
  }

  const totale = Math.round(prodottiCorretti.reduce((s, p) => s + p.prezzo, 0) * 100) / 100;
  return { prodotti: prodottiCorretti, totale };
}
/* =========================
   CREATE PAYMENT INTENT (Stripe)
   POST /create-payment-intent
   Body: { token, totale, localeId }
   Returns: { clientSecret }
========================= */
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { token, prodotti, localeId } = req.body;

    if (!token) {
      return res.status(401).json({ error: "Utente non autenticato" });
    }

    const decoded = await appbaseApp.auth().verifyIdToken(token);

    if (!localeId) {
      return res.status(400).json({ error: "localeId mancante" });
    }
    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({ error: "prodotti mancanti" });
    }

    const verificato = await verificaEcorreggiProdotti(localeId, prodotti);
    if (!verificato) {
      return res.status(400).json({ error: "Prodotti non riconosciuti nel menu" });
    }

    const importoCentesimi = Math.round(verificato.totale * 100);
    if (!importoCentesimi || importoCentesimi < 50) {
      return res.status(400).json({ error: "Importo non valido (minimo 0.50€)" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: importoCentesimi,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
      metadata: { localeId, uid: decoded.uid, email: decoded.email || "" },
    });

    res.json({ clientSecret: paymentIntent.client_secret, totaleVerificato: verificato.totale });
  } catch (err) {
    console.error("❌ Stripe error:", err);
    res.status(500).json({ error: "Errore creazione pagamento" });
  }
});

/* =========================
   SEND ORDER (APPBASE → DEMAS)
========================= */
app.post("/send-order", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(401).json({ error: "Utente non autenticato" });
    }

    const decoded = await appbaseApp.auth().verifyIdToken(token);

    const userDoc = await appbaseDb.collection("users").doc(decoded.uid).get();
    const userData = userDoc.data() || {};

    const {
      localeId, tavolo, prodotti, metodoPagamento, timestamp,
      tableId, sessionToken, guestName, lat, lng, stripePaymentIntentId,
      note, 
    } = req.body;

    if (!localeId) {
      return res.status(400).json({ error: "localeId mancante" });
    }
    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({ error: "prodotti mancanti" });
    }

    // Non ci fidiamo mai di prezzi/totale dal client: ricalcoliamo dal menu reale
    const verificato = await verificaEcorreggiProdotti(localeId, prodotti);
    if (!verificato) {
      return res.status(400).json({ error: "Prodotti non riconosciuti nel menu" });
    }
    const prodottiVerificati = verificato.prodotti;
    const totaleVerificato = verificato.totale;

    let pagamentoVerificato = false;
    if (metodoPagamento === "Paga con carta") {
      if (!stripePaymentIntentId) {
        console.error("❌ carta: stripePaymentIntentId mancante nel body");
        return res.status(400).json({ error: "Pagamento non completato" });
      }
      try {
        const intent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
        if (intent.status !== "succeeded") {
          console.error("⚠️ PaymentIntent non succeeded:", stripePaymentIntentId, "status:", intent.status);
          return res.status(402).json({ error: "Pagamento non confermato da Stripe", status: intent.status });
        }
        const importoAtteso = Math.round(totaleVerificato * 100);
        if (intent.amount !== importoAtteso) {
          console.error("⚠️ Importo Stripe non corrisponde:", intent.amount, "atteso:", importoAtteso);
          return res.status(402).json({ error: "Importo pagamento non corrispondente" });
        }
        pagamentoVerificato = true;
      } catch (stripeErr) {
        console.error("❌ Errore verifica Stripe:", stripeErr.message, "id ricevuto:", stripePaymentIntentId);
        return res.status(402).json({ error: "Errore verifica pagamento Stripe" });
      }
    }

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
        daVerificare = true;
      }
    }

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    const ordineId = `${get("day")}-${get("month")}_${get("hour")}-${get("minute")}_${
      String(decoded.email || "utente").replace(/[@.]/g, "-").slice(0, 40)
    }_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    await demasDb
      .collection("bars").doc(localeId)
      .collection("ordini").doc(ordineId)
      .set({
        cliente: {
          uid: decoded.uid,
          email: String(decoded.email || "").slice(0, 120),
          nome: String(guestName || userData.ownerName || "").slice(0, 80),
          telefono: String(userData.phone || "").slice(0, 30),
        },
        tavolo: tavoloRisolto,
       note: note || noteCliente || null,
        tableId: tableId ?? null,
        daVerificare,
        spam,
        prodotti: prodottiVerificati,
        totale: totaleVerificato,
        metodoPagamento,
        pagamentoVerificato,
        stripePaymentIntentId: stripePaymentIntentId || null,
        timestamp: timestamp || Date.now(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "nuovo",
        source: "appbase",
      });

    if (spam) {
      return res.status(409).json({ error: "sessione_non_valida", scollega: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(403).json({ error: "token non valido" });
  }
});

{/* app.post("/send-order", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(401).json({ error: "Utente non autenticato" });
    }

    const decoded = await appbaseApp.auth().verifyIdToken(token);

    const userDoc = await appbaseDb.collection("users").doc(decoded.uid).get();
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
      stripePaymentIntentId, // opzionale: passato dal frontend dopo pagamento confermato
    } = req.body;

    if (!localeId) {
      return res.status(400).json({ error: "localeId mancante" });
    }

    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({ error: "prodotti mancanti" });
    }

    // Se il metodo è "carta" verifica che il PaymentIntent sia confermato
  // Se il metodo è "carta" verifica che il PaymentIntent sia confermato
    if (metodoPagamento === "Paga con carta") {
      if (!stripePaymentIntentId) {
        console.error("❌ carta: stripePaymentIntentId mancante nel body");
        return res.status(400).json({ error: "Pagamento non completato" });
      }
      try {
        const intent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
        if (intent.status !== "succeeded") {
          console.error("⚠️ PaymentIntent non succeeded:", stripePaymentIntentId, "status:", intent.status);
          return res.status(402).json({ error: "Pagamento non confermato da Stripe", status: intent.status });
        }
      } catch (stripeErr) {
        console.error("❌ Errore verifica Stripe:", stripeErr.message, "id ricevuto:", stripePaymentIntentId);
        return res.status(402).json({ error: "Errore verifica pagamento Stripe" });
      }
    }

    // ── Risoluzione tavolo + verifica sessione + geofence ── 
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
        daVerificare = true;
      }
    }

    // ── Genera ordineId ── 
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome",
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    const ordineId = `${get("day")}-${get("month")}_${get("hour")}-${get("minute")}_${
      String(decoded.email || "utente").replace(/[@.]/g, "-").slice(0, 40)
    }_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    await demasDb
      .collection("bars").doc(localeId)
      .collection("ordini").doc(ordineId)
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
        // traccia il pagamento Stripe se presente
        stripePaymentIntentId: stripePaymentIntentId || null,
        timestamp: timestamp || Date.now(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "nuovo",
        source: "appbase",
      });

    if (spam) {
      return res.status(409).json({ error: "sessione_non_valida", scollega: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(403).json({ error: "token non valido" });
  }
}); */}



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