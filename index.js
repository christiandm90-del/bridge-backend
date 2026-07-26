const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
app.use(cors());
/* =========================
   BILLING — WEBHOOK STRIPE
   Deve stare PRIMA di express.json(): serve il body raw per la firma
========================= */
app.post(
  "/billing/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Firma webhook non valida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotenza: se l'evento è già stato processato, rispondi e basta
    const eventRef = demasDb.collection("stripeEventsProcessed").doc(event.id);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      switch (event.type) {
       case "checkout.session.completed": {
          const session = event.data.object;
          const { barId, planId, ciclo } = session.metadata || {};
          // Con metodi di pagamento ritardati (es. SEPA) il checkout può
          // risultare "completato" prima che il pagamento sia confermato:
          // in quel caso aspettiamo async_payment_succeeded.
          if (barId && planId && session.payment_status === "paid") {
            const aggiornamento = { stripeSubscriptionId: session.subscription || null };
           if (session.subscription) {
              const sub = await stripe.subscriptions.retrieve(session.subscription);
              const periodEnd = getCurrentPeriodEnd(sub);
              if (periodEnd) aggiornamento["piano.rinnovoIl"] = admin.firestore.Timestamp.fromMillis(periodEnd * 1000);
            }
            await demasDb.collection("bars").doc(barId).collection("meta").doc("info").update(aggiornamento);
            await applyPlanToBar(barId, planId, "stripe-webhook", ciclo || "mensile");
          }
          break;
        }

        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object;
          const { barId, planId, ciclo } = session.metadata || {};
          if (barId && planId) {
            const aggiornamento = { stripeSubscriptionId: session.subscription || null };
            if (session.subscription) {
              const sub = await stripe.subscriptions.retrieve(session.subscription);
              const periodEnd = getCurrentPeriodEnd(sub);
              if (periodEnd) aggiornamento["piano.rinnovoIl"] = admin.firestore.Timestamp.fromMillis(periodEnd * 1000);
            }
            await demasDb.collection("bars").doc(barId).collection("meta").doc("info").update(aggiornamento);
            await applyPlanToBar(barId, planId, "stripe-webhook", ciclo || "mensile");
          }
          break;
        }

        case "checkout.session.async_payment_failed": {
          const session = event.data.object;
          const { barId } = session.metadata || {};
          if (barId) {
            console.log(`⚠️ Pagamento asincrono fallito per locale ${barId}`);
          }
          break;
        }

      case "customer.subscription.updated": {
          const subscription = event.data.object;
          const priceId = subscription.items?.data?.[0]?.price?.id;
          const customerId = subscription.customer;

          const barsSnap = await demasDb
            .collectionGroup("meta")
            .where("stripeCustomerId", "==", customerId)
            .limit(1)
            .get();

          if (!barsSnap.empty) {
            const barId = barsSnap.docs[0].ref.parent.parent.id;

       const periodEnd = getCurrentPeriodEnd(subscription);
            await demasDb.collection("bars").doc(barId).collection("meta").doc("info").update({
              "piano.cancellazionePendente": subscription.cancel_at_period_end === true,
              "piano.cancellaIl": subscription.cancel_at
                ? admin.firestore.Timestamp.fromMillis(subscription.cancel_at * 1000)
                : null,
              "piano.rinnovoIl": periodEnd
                ? admin.firestore.Timestamp.fromMillis(periodEnd * 1000)
                : null,
            });

           if (subscription.status === "active" && priceId) {
              const trovato = await findPlanByStripePriceId(priceId);
              if (trovato) await applyPlanToBar(barId, trovato.planId, "stripe-webhook", trovato.ciclo);
            }
            // status "past_due" ecc: nessuna azione automatica sui limiti per ora
          }
          break;
        }

      case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const customerId = subscription.customer;

          const barsSnap = await demasDb
            .collectionGroup("meta")
            .where("stripeCustomerId", "==", customerId)
            .limit(1)
            .get();

          if (!barsSnap.empty) {
            const barId = barsSnap.docs[0].ref.parent.parent.id;
            await applyPlanToBar(barId, "free", "stripe-webhook-cancellation");
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          console.log(`⚠️ Fattura non pagata — customer ${invoice.customer}, invoice ${invoice.id}`);
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          console.log(`✅ Fattura pagata — customer ${invoice.customer}, invoice ${invoice.id}`);
          break;
        }

        default:
          break;
      }

      await eventRef.set({
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        type: event.type,
      });
      res.json({ received: true });
    } catch (err) {
      console.error("❌ Errore elaborazione webhook:", err);
      // 500 → Stripe ritenta (utile per errori transitori tipo Firestore irraggiungibile)
      res.status(500).json({ error: "Errore elaborazione webhook" });
    }
  }
);
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


{/**app.post("/sync-menu", async (req, res) => {
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

// sostituisci il blocco set() in /sync-menu
const updateData = {
  companyName: companyName || "Senza Nome",
  categorie,
  sottocategorie,
  prodotti,
  updatedAt: Date.now(),
};

if (publicMenus) {
  updateData.orari = publicMenus.orari || {};
  updateData.chiusure = publicMenus.chiusure || [];
  updateData.chiusurePeriodo = publicMenus.chiusurePeriodo || null;
  updateData.offerte = publicMenus.offerte || [];
  updateData.menuPubblicoAttivo = publicMenus.menuPubblicoAttivo || false;
}

await appbaseDb.collection("publicMenus").doc(localeId).set(updateData, { merge: true });


{/** await appbaseDb.collection("publicMenus").doc(localeId).set({
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
 */}
   
  //  res.json({ success: true });
  //} catch (err) {
   // console.error(err);
   // res.status(500).json({ error: "server error" });
 // }
//}); 
//*/}
/* =========================
   SYNC MENU (DEMAS → APPBASE)
========================= prev versione^ */
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

    if (!localeId) {
      return res.status(400).json({ error: "localeId mancante" });
    }

    const updateData = {
      companyName: companyName || "Senza Nome",
      categorie,
      sottocategorie,
      prodotti,
      updatedAt: Date.now(),
    };

    if (publicMenus) {
      updateData.orari = publicMenus.orari || {};
      updateData.chiusure = publicMenus.chiusure || [];
      updateData.chiusurePeriodo = publicMenus.chiusurePeriodo || null;
      updateData.offerte = publicMenus.offerte || [];
      updateData.menuPubblicoAttivo = publicMenus.menuPubblicoAttivo || false;
      updateData.pagamentoLocaleAttivo = publicMenus.pagamentoLocaleAttivo !== false;

      // Salvataggio delivery completa
      if (publicMenus.delivery) {
        updateData.delivery = {
          ...publicMenus.delivery,
          lastUpdated: Date.now(),
        };
      }
    }

    await appbaseDb.collection("publicMenus").doc(localeId).set(updateData, { merge: true });

    res.json({ success: true, message: "Menu sincronizzato correttamente" });
  } catch (err) {
    console.error("Errore sync-menu:", err);
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

  const menuData = menuSnap.data();
  const menuProdotti = menuData.prodotti || [];
  const mappaPrezzi = new Map();
  menuProdotti.forEach((p) => {
    if (p && p.nome) mappaPrezzi.set(String(p.nome).trim().toLowerCase(), Number(p.prezzo) || 0);
  });

  const prodottiCorretti = [];
  for (const item of prodottiClient) {
    const chiave = String(item?.nome || "").trim().toLowerCase();
    const prezzoReale = mappaPrezzi.get(chiave);
    if (prezzoReale == null) return null;
    prodottiCorretti.push({ ...item, prezzo: prezzoReale });
  }

  const totale = Math.round(prodottiCorretti.reduce((s, p) => s + p.prezzo, 0) * 100) / 100;
  return {
    prodotti: prodottiCorretti,
    totale,
    settings: {
      pagamentoLocaleAttivo: menuData.pagamentoLocaleAttivo !== false, // default true
    },
  };
}
/* =========================
   CREATE PAYMENT INTENT (Stripe)
   POST /create-payment-intent
   Body: { token, totale, localeId }
   Returns: { clientSecret }
========================= */

{/*prev...
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
  
  */}

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { token, prodotti, localeId, tableId, sessionToken } = req.body;

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

    // Sessione tavolo → blocca PRIMA di autorizzare qualunque addebito
    if (tableId != null) {
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
          return res.status(409).json({ error: "sessione_non_valida", scollega: true });
        }
      } catch (err) {
        console.error("Errore validazione sessione tavolo (payment-intent):", err);
        return res.status(409).json({ error: "sessione_non_valida", scollega: true });
      }
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
    if (metodoPagamento === "locale" && !verificato.settings.pagamentoLocaleAttivo) {
  return res.status(403).json({ error: "pagamento_locale_non_disponibile" });
}

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

    // ⛔ Sessione non valida → blocca PRIMA di scrivere l'ordine
    if (spam) {
      return res.status(409).json({ error: "sessione_non_valida", scollega: true });
    }

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

app.get("/resolve-table/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: "token mancante" });

    const snap = await demasDb.collection("qrLookup").doc(token).get();
    if (!snap.exists) return res.status(404).json({ error: "QR non valido o scaduto" });

    const data = snap.data();
    const ora = Date.now();

    if (data.scadeAt != null && data.scadeAt < ora) {
      return res.status(410).json({ error: "QR scaduto" });
    }

    res.json({
      localeId: data.localeId,
      tableId: data.tableId,
      sessionToken: data.sessionToken,
      scadeAt: data.scadeAt ?? null,
      creataAt: data.creataAt ?? ora,
      tableNome: data.tableNome,
    });
  } catch (err) {
    console.error("❌ resolve-table error:", err);
    res.status(500).json({ error: "Errore risoluzione QR" });
  }
});
/* =========================
   BILLING — HELPER
========================= */
async function applyPlanToBar(barId, planId, source, ciclo = "mensile") {
  const planSnap = await demasDb.collection("plans").doc(planId).get();
  if (!planSnap.exists) throw new Error(`Piano "${planId}" non trovato in /plans`);
  const plan = planSnap.data();

  const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
  const infoSnap = await infoRef.get();
  if (!infoSnap.exists) throw new Error(`Locale "${barId}" non trovato`);
 const info = infoSnap.data();

  const employees = Array.isArray(info.employees) ? info.employees : [];
  const permissions = {};
  employees.forEach((emp) => {
    if (emp?.id) permissions[emp.id] = { ...plan.permissionsDefault };
  });

await infoRef.update({
    piano: {
      tipo: planId,
      ciclo,
      personalizzato: false,
      aggiornatoDa: source,
      aggiornatoIl: admin.firestore.FieldValue.serverTimestamp(),
    },
    zoneConfig: {
      limits: plan.limits,
      permissions,
    },
  });

  console.log(`✅ Piano di ${barId} aggiornato a "${planId}" (${ciclo}, ${source})`);
}

// Cerca un piano per price id, sia mensile che annuale, e restituisce anche il ciclo trovato
async function findPlanByStripePriceId(priceId) {
  const snapMensile = await demasDb.collection("plans").where("stripePriceIdMensile", "==", priceId).limit(1).get();
  if (!snapMensile.empty) return { planId: snapMensile.docs[0].id, ciclo: "mensile" };

  const snapAnnuale = await demasDb.collection("plans").where("stripePriceIdAnnuale", "==", priceId).limit(1).get();
  if (!snapAnnuale.empty) return { planId: snapAnnuale.docs[0].id, ciclo: "annuale" };

  return null;
}
// Nelle API Stripe recenti current_period_end è sui subscription items,
// non più sulla subscription stessa — proviamo entrambi i posti.
function getCurrentPeriodEnd(subscription) {
  if (subscription.current_period_end) return subscription.current_period_end;
  return subscription.items?.data?.[0]?.current_period_end ?? null;
}
/* =========================
   BILLING — CREA SESSIONE CHECKOUT
   POST /billing/create-checkout-session
   Body: { token, barId, planId }
========================= */
// 1. MODIFICA LA CREAZIONE DEL CHECKOUT (Blocca pagamenti multipli se attivo)
app.post("/billing/create-checkout-session", async (req, res) => {
  try {
    const { token, barId, planId, ciclo } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });

    const cicloScelto = ciclo === "annuale" ? "annuale" : "mensile";
    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId || !planId) return res.status(400).json({ error: "barId o planId mancante" });

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) {
      return res.status(403).json({ error: "Non autorizzato su questo locale" });
    }

   // CONTROLLO ANTI-DOPPIO PAGAMENTO: Se ha già un abbonamento attivo, blocca!
    if (info.stripeSubscriptionId) {
      return res.status(400).json({
        error: "Hai già un abbonamento attivo. Usa il cambio piano invece di un nuovo checkout."
      });
    }

    const planSnap = await demasDb.collection("plans").doc(planId).get();
    if (!planSnap.exists) return res.status(404).json({ error: "Piano non trovato" });

    const plan = planSnap.data();
    const stripePriceId = cicloScelto === "annuale" ? plan.stripePriceIdAnnuale : plan.stripePriceIdMensile;
    if (!stripePriceId) {
      return res.status(400).json({ error: "Piano non acquistabile online per questo ciclo" });
    }

    let stripeCustomerId = info.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: info.email || undefined,
        name: info.companyName || undefined,
        metadata: { barId },
      });
      stripeCustomerId = customer.id;
      await infoRef.update({ stripeCustomerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${process.env.DEMAS_APP_BASE_URL}/piani?checkout=success`,
      cancel_url: `${process.env.DEMAS_APP_BASE_URL}/piani?checkout=cancel`,
      metadata: { barId, planId, ciclo: cicloScelto },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Errore create-checkout-session:", err);
    res.status(500).json({ error: "Errore creazione sessione di pagamento" });
  }
});


/* =========================
   BILLING — CAMBIA PIANO (abbonamento già attivo)
   POST /billing/change-plan
   Body: { token, barId, planId }
========================= */
app.post("/billing/change-plan", async (req, res) => {
  try {
    const { token, barId, planId, ciclo } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });

    const cicloScelto = ciclo === "annuale" ? "annuale" : "mensile";
    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId || !planId) return res.status(400).json({ error: "barId o planId mancante" });

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) {
      return res.status(403).json({ error: "Non autorizzato su questo locale" });
    }
    if (!info.stripeSubscriptionId) {
      return res.status(400).json({ error: "Nessun abbonamento attivo — usa create-checkout-session" });
    }

    const planSnap = await demasDb.collection("plans").doc(planId).get();
    if (!planSnap.exists) return res.status(404).json({ error: "Piano non trovato" });
    const plan = planSnap.data();
    const stripePriceId = cicloScelto === "annuale" ? plan.stripePriceIdAnnuale : plan.stripePriceIdMensile;
    if (!stripePriceId) return res.status(400).json({ error: "Piano non acquistabile online per questo ciclo" });

    const subscription = await stripe.subscriptions.retrieve(info.stripeSubscriptionId);
    const itemId = subscription.items.data[0].id;

    await stripe.subscriptions.update(info.stripeSubscriptionId, {
      items: [{ id: itemId, price: stripePriceId }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
      metadata: { barId, planId, ciclo: cicloScelto },
    });

    res.json({ success: true });
    // L'applicazione vera e propria (piano + zoneConfig) arriva dal webhook
    // customer.subscription.updated — non scriviamo Firestore qui per evitare
    // di bypassare il ricalcolo di zoneConfig fatto da applyPlanToBar.
  } catch (err) {
    console.error("❌ Errore change-plan:", err);
    res.status(500).json({ error: "Errore cambio piano" });
  }
});
/* =========================
   BILLING — ANNULLA ABBONAMENTO (torna a Free a fine periodo già pagato)
   POST /billing/cancel-subscription
========================= */
app.post("/billing/cancel-subscription", async (req, res) => {
  try {
    const { token, barId } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });

    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId) return res.status(400).json({ error: "barId mancante" });

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) return res.status(403).json({ error: "Non autorizzato su questo locale" });
    if (!info.stripeSubscriptionId) return res.status(400).json({ error: "Nessun abbonamento attivo" });

    const subscription = await stripe.subscriptions.update(info.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await infoRef.update({
      "piano.cancellazionePendente": true,
      "piano.cancellaIl": subscription.cancel_at
        ? admin.firestore.Timestamp.fromMillis(subscription.cancel_at * 1000)
        : null,
    });

    res.json({ success: true, cancelAt: subscription.cancel_at });
  } catch (err) {
    console.error("❌ Errore cancel-subscription:", err);
    res.status(500).json({ error: "Errore cancellazione abbonamento" });
  }
});

/* =========================
   BILLING — ANNULLA LA DISDETTA (resta sul piano attuale)
   POST /billing/resume-subscription
========================= */
app.post("/billing/resume-subscription", async (req, res) => {
  try {
    const { token, barId } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });

    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId) return res.status(400).json({ error: "barId mancante" });

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) return res.status(403).json({ error: "Non autorizzato su questo locale" });
    if (!info.stripeSubscriptionId) return res.status(400).json({ error: "Nessun abbonamento attivo" });

    await stripe.subscriptions.update(info.stripeSubscriptionId, { cancel_at_period_end: false });

    await infoRef.update({
      "piano.cancellazionePendente": false,
      "piano.cancellaIl": null,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Errore resume-subscription:", err);
    res.status(500).json({ error: "Errore riattivazione abbonamento" });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server avviato sulla porta ${PORT}`);
});