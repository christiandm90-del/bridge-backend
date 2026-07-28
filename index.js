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

  const mappaSnap = await demasDb.collection("stripeCustomerMap").doc(customerId).get();

  if (mappaSnap.exists) {
    const barId = mappaSnap.data().barId;
    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    const barData = infoSnap.data() || {};

    if (["incomplete_expired", "canceled"].includes(subscription.status)) {
      if (barData.stripeSubscriptionId === subscription.id) {
        await infoRef.update({
          stripeSubscriptionId: admin.firestore.FieldValue.delete(),
          "piano.pagamentoInSospeso": admin.firestore.FieldValue.delete(),
        });
      }
      break;
    }

    const periodEnd = getCurrentPeriodEnd(subscription);
    await infoRef.update({
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
      if (trovato) {
        await infoRef.update({
          stripeSubscriptionId: subscription.id,
          "piano.pagamentoInSospeso": admin.firestore.FieldValue.delete(),
        });
        await applyPlanToBar(barId, trovato.planId, "stripe-webhook", trovato.ciclo);
      }
    }
  }
  break;
}
   case "customer.tax_id.updated": {
  const taxId = event.data.object;
  if (taxId.verification?.status === "unverified") {
    const mappaSnap = await demasDb.collection("stripeCustomerMap").doc(taxId.customer).get();
    if (mappaSnap.exists) {
      const barId = mappaSnap.data().barId;
      await demasDb.collection("bars").doc(barId).collection("meta").doc("info").update({
        "billing.pivaVerificata": false,
        "billing.daVerificare": true,
      });
      console.warn(`⚠️ P.IVA non verificata (VIES) per locale ${barId}`);
    }
  }
  break;
}



 case "customer.subscription.deleted": {
  const subscription = event.data.object;
  const customerId = subscription.customer;

  const mappaSnap = await demasDb.collection("stripeCustomerMap").doc(customerId).get();
  if (mappaSnap.exists) {
    const barId = mappaSnap.data().barId;
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
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-05-27.dahlia" });

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



const geoip = require("geoip-lite");

// Estrae l'IP reale del client anche dietro proxy (Render ecc.)
function estraiIpReale(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || null;
}

// Converte coordinate GPS in Paese (ISO2) via Google Geocoding.
// Richiede GOOGLE_MAPS_API_KEY nelle env. Se manca la chiave o le coordinate, ritorna null senza errori.
async function paeseDaCoordinate(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=3`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "DEMAS-App/1.0 (billing-verification)" },
    });
    const data = await resp.json();
    return data.address?.country_code?.toUpperCase() || null; // es. "IT"
  } catch (err) {
    console.error("Errore reverse geocoding:", err.message);
    return null;
  }
}

// Confronta indirizzo dichiarato, IP e GPS. NON blocca mai l'attivazione:
// produce solo un report-prova da salvare (richiesto da normativa UE) e
// un flag per revisione manuale se le fonti sono in contraddizione.
function verificaCoerenzaGeografica({ paeseDichiarato, ip, gpsPaese }) {
  const record = ip ? geoip.lookup(ip) : null;
  const paeseIp = record?.country || null;

  const prove = [paeseDichiarato, paeseIp, gpsPaese].filter(Boolean);
  const concordi = prove.filter((p) => p === paeseDichiarato).length;

  return {
    paeseDichiarato: paeseDichiarato || null,
    paeseIp,
    paeseGps: gpsPaese || null,
    proveTotali: prove.length,
    proveConcordanti: concordi,
    anomaliaRilevata: prove.length >= 2 && concordi < prove.length,
    verificatoIl: Date.now(),
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
/* =========================
   BILLING — SINCRONIZZA PIANO (recovery/safety-net)
   POST /billing/sync-plan
   Rilegge lo stato reale della subscription da Stripe e applica il piano
   se risulta attiva — usalo sia come recovery manuale sia come chiamata
   automatica subito dopo un pagamento riuscito, senza dipendere solo dal webhook.
========================= */
app.post("/billing/sync-plan", async (req, res) => {
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
    if (!info.stripeSubscriptionId) return res.status(400).json({ error: "Nessun abbonamento da sincronizzare" });

    const subscription = await stripe.subscriptions.retrieve(info.stripeSubscriptionId);
    const priceId = subscription.items?.data?.[0]?.price?.id;

    if (subscription.status === "active" && priceId) {
      const trovato = await findPlanByStripePriceId(priceId);
      if (trovato) {
        await infoRef.update({ "piano.pagamentoInSospeso": admin.firestore.FieldValue.delete() });
        await applyPlanToBar(barId, trovato.planId, "manual-sync", trovato.ciclo);
        return res.json({ success: true, planId: trovato.planId, status: subscription.status });
      }
      return res.status(409).json({ error: "Piano Stripe non riconosciuto nel catalogo" });
    }

    res.json({ success: false, status: subscription.status });
  } catch (err) {
    console.error("❌ Errore sync-plan:", err);
    res.status(500).json({ error: "Errore sincronizzazione piano" });
  }
});

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



/**
 * Regole di transizione piano, per evitare downgrade e cambi
 * annuale→mensile che causano riprorazioni incrociate scorrette:
 * - stesso ciclo: consentito SOLO upgrade (livello target > livello attuale)
 * - mensile → annuale: sempre consentito, qualsiasi livello
 * - annuale → mensile: MAI consentito
 */
function transizioneConsentita(livelloAttuale, cicloAttuale, livelloTarget, cicloTarget) {
  if (cicloAttuale === "annuale" && cicloTarget === "mensile") {
    return { ok: false, motivo: "Non è possibile passare da un piano annuale a uno mensile. Disdici l'abbonamento annuale e attivane uno nuovo mensile a fine periodo." };
  }
  if (cicloAttuale === cicloTarget) {
    if (livelloTarget <= livelloAttuale) {
      return { ok: false, motivo: "Il cambio piano online supporta solo upgrade a un piano superiore. Per un downgrade, disdici e riattiva un nuovo piano." };
    }
    return { ok: true };
  }
  // mensile → annuale: sempre ok
  return { ok: true };
}


// Nelle API Stripe recenti current_period_end è sui subscription items,
// non più sulla subscription stessa — proviamo entrambi i posti.
function getCurrentPeriodEnd(subscription) {
  if (subscription.current_period_end) return subscription.current_period_end;
  return subscription.items?.data?.[0]?.current_period_end ?? null;
}

// Rileva se l'errore Stripe è dovuto a Stripe Tax senza indirizzo cliente,
// per distinguerlo da altri errori e permettere al frontend di reagire.
function isStripeTaxLocationError(err) {
  return (
    err?.code === "customer_tax_location_invalid" ||
    /tax location/i.test(err?.message || "") ||
    /customer.*address/i.test(err?.message || "")
  );
}
/* =========================
   BILLING — PAYMENT SHEET (primo acquisto, nativo Capacitor)
   POST /billing/create-payment-sheet
   Body: { token, barId, planId, ciclo, indirizzo? }
========================= */
app.post("/billing/create-payment-sheet", async (req, res) => {
  try {
    const { token, barId, planId, ciclo, indirizzo } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });

    const cicloScelto = ciclo === "annuale" ? "annuale" : "mensile";
    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId || !planId) return res.status(400).json({ error: "barId o planId mancante" });

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) return res.status(403).json({ error: "Non autorizzato su questo locale" });

    // Se esiste già un riferimento, verifichiamo lo STATO REALE su Stripe prima di
    // bloccare o duplicare: "incomplete" va ripreso, scaduta/cancellata va liberata,
    // solo una davvero attiva blocca il nuovo acquisto.
    if (info.stripeSubscriptionId) {
      const esistente = await stripe.subscriptions
        .retrieve(info.stripeSubscriptionId, {
          expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
        })
        .catch(() => null);

      if (esistente && ["active", "trialing", "past_due", "unpaid"].includes(esistente.status)) {
        return res.status(400).json({ error: "Hai già un abbonamento attivo. Usa il cambio piano." });
      }

      if (esistente && esistente.status === "incomplete") {
        const ephemeralKeyRetry = await stripe.ephemeralKeys.create(
          { customer: esistente.customer },
          { apiVersion: "2026-05-27.dahlia" }
        );
        const clientSecretRetry = esistente.pending_setup_intent
          ? esistente.pending_setup_intent.client_secret
          : esistente.latest_invoice.confirmation_secret.client_secret;

        return res.json({
          paymentIntentClientSecret: clientSecretRetry,
          ephemeralKey: ephemeralKeyRetry.secret,
          customerId: esistente.customer,
          subscriptionId: esistente.id,
        });
      }

      // canceled / incomplete_expired / non trovata su Stripe: liberiamo il riferimento
      await infoRef.update({ stripeSubscriptionId: admin.firestore.FieldValue.delete() });
    }

    const planSnap = await demasDb.collection("plans").doc(planId).get();
    if (!planSnap.exists) return res.status(404).json({ error: "Piano non trovato" });
    const plan = planSnap.data();
    const stripePriceId = cicloScelto === "annuale" ? plan.stripePriceIdAnnuale : plan.stripePriceIdMensile;
    if (!stripePriceId) return res.status(400).json({ error: "Piano non acquistabile online per questo ciclo" });

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
// Mappa diretta customerId → barId: elimina il bisogno di query collectionGroup
// (e quindi di indici) ovunque nel webhook.
await demasDb.collection("stripeCustomerMap").doc(stripeCustomerId).set({ barId }, { merge: true });

    if (indirizzo?.country && indirizzo?.postal_code) {
      await stripe.customers.update(stripeCustomerId, {
        address: {
          country: indirizzo.country,
          postal_code: indirizzo.postal_code,
          city: indirizzo.city || undefined,
          line1: indirizzo.line1 || undefined,
          state: indirizzo.state || undefined,
        },
      });
    }

    // Verifica che il customer Stripe abbia REALMENTE un indirizzo salvato prima di
    // procedere: se manca, alcune configurazioni di Stripe Tax calcolano IVA a 0
    // invece di dare errore — meglio bloccare qui in modo esplicito.
    const customerCorrente = await stripe.customers.retrieve(stripeCustomerId);
    if (!customerCorrente.address?.country || !customerCorrente.address?.postal_code) {
      return res.status(422).json({
        error: "indirizzo_richiesto",
        message: "Serve l'indirizzo di fatturazione per calcolare l'IVA prima di procedere.",
      });
    }

    if (indirizzo?.piva) {
      try {
        await stripe.customers.createTaxId(stripeCustomerId, { type: "eu_vat", value: indirizzo.piva });
      } catch (err) {
        console.error("⚠️ P.IVA non valida:", err.message);
      }
    }

    const ipCliente = estraiIpReale(req);
    const gpsPaese = await paeseDaCoordinate(req.body.gps?.lat, req.body.gps?.lng);
    const coerenza = verificaCoerenzaGeografica({
      paeseDichiarato: indirizzo?.country || customerCorrente.address.country,
      ip: ipCliente,
      gpsPaese,
    });

    await infoRef.update({
      "billing.provaLocalizzazione": coerenza,
      "billing.daVerificare": coerenza.anomaliaRilevata,
    });
    if (coerenza.anomaliaRilevata) console.warn(`⚠️ Anomalia geografica locale ${barId}:`, coerenza);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: "2026-05-27.dahlia" }
    );

    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: stripePriceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      automatic_tax: { enabled: true },
        billing_mode: { type: "flexible" },
      expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
      metadata: { barId, planId, ciclo: cicloScelto },
    });

    // Salvato SUBITO, prima che il pagamento sia confermato: chiude la finestra in
    // cui l'utente poteva pagare due volte lo stesso piano prima del webhook.
    // L'applicazione del piano resta comunque compito ESCLUSIVO del webhook
    // customer.subscription.updated quando lo stato diventa "active".
    await infoRef.update({
      stripeSubscriptionId: subscription.id,
      "piano.pagamentoInSospeso": true,
    });

    const invoiceCreata = subscription.latest_invoice;
    if (invoiceCreata && (!invoiceCreata.tax || invoiceCreata.tax === 0)) {
      console.warn(`⚠️ IVA a 0 su invoice ${invoiceCreata.id} — barId ${barId}, indirizzo cliente:`, customerCorrente.address);
    }

    const clientSecret = subscription.pending_setup_intent
      ? subscription.pending_setup_intent.client_secret
      : subscription.latest_invoice.confirmation_secret.client_secret;

    res.json({
      paymentIntentClientSecret: clientSecret,
      ephemeralKey: ephemeralKey.secret,
      customerId: stripeCustomerId,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    console.error("❌ Errore create-payment-sheet:", err);
    if (isStripeTaxLocationError(err)) {
      return res.status(422).json({
        error: "indirizzo_richiesto",
        message: "Serve l'indirizzo di fatturazione per calcolare l'IVA prima di procedere.",
      });
    }
    res.status(500).json({ error: "Errore creazione pagamento" });
  }
});

/* =========================
   BILLING — SALVA INDIRIZZO DI FATTURAZIONE
   POST /billing/update-billing-address
   Body: { token, barId, indirizzo: { country, postal_code, city?, line1?, state? } }
========================= */
app.post("/billing/update-billing-address", async (req, res) => {
  try {
    const { token, barId, indirizzo } = req.body;
    if (!token) return res.status(401).json({ error: "Utente non autenticato" });
    const decoded = await demasApp.auth().verifyIdToken(token);
    if (!barId) return res.status(400).json({ error: "barId mancante" });
    if (!indirizzo?.country || !indirizzo?.postal_code) {
      return res.status(400).json({ error: "Indirizzo incompleto (paese e CAP obbligatori)" });
    }

    const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
    const infoSnap = await infoRef.get();
    if (!infoSnap.exists) return res.status(404).json({ error: "Locale non trovato" });

    const info = infoSnap.data();
    if (info.uid !== decoded.uid) return res.status(403).json({ error: "Non autorizzato su questo locale" });
    if (!info.stripeCustomerId) return res.status(400).json({ error: "Cliente Stripe non ancora creato" });

    await stripe.customers.update(info.stripeCustomerId, {
      address: {
        country: indirizzo.country,
        postal_code: indirizzo.postal_code,
        city: indirizzo.city || undefined,
        line1: indirizzo.line1 || undefined,
        state: indirizzo.state || undefined,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Errore update-billing-address:", err);
    res.status(500).json({ error: "Errore salvataggio indirizzo" });
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

// Verifica coerenza subscription: se ha più di un item, qualcosa non va —
    // meglio bloccare con un errore chiaro che riprorazionare dati sporchi.
    const subscription = await stripe.subscriptions.retrieve(info.stripeSubscriptionId);
    if (subscription.items.data.length !== 1) {
      return res.status(409).json({
        error: "Abbonamento in stato inconsistente (più voci attive). Contatta l'assistenza prima di procedere.",
      });
    }
    const itemId = subscription.items.data[0].id;
    const priceAttualeId = subscription.items.data[0].price.id;

    const pianoAttualeTrovato = await findPlanByStripePriceId(priceAttualeId);
    if (!pianoAttualeTrovato) {
      return res.status(409).json({ error: "Piano attuale non riconosciuto nel catalogo." });
    }

    const planAttualeSnap = await demasDb.collection("plans").doc(pianoAttualeTrovato.planId).get();
    const livelloAttuale = planAttualeSnap.data()?.livello ?? 0;
    const livelloTarget = plan.livello ?? 0;

    const check = transizioneConsentita(livelloAttuale, pianoAttualeTrovato.ciclo, livelloTarget, cicloScelto);
    if (!check.ok) {
      return res.status(400).json({ error: check.motivo });
    }


    const stripePriceId = cicloScelto === "annuale" ? plan.stripePriceIdAnnuale : plan.stripePriceIdMensile;
    if (!stripePriceId) return res.status(400).json({ error: "Piano non acquistabile online per questo ciclo" });



await stripe.subscriptions.update(info.stripeSubscriptionId, {
      items: [{ id: itemId, price: stripePriceId }],
      proration_behavior: "always_invoice", // fattura subito il conguaglio pro-rata, invece di accodarlo al rinnovo naturale (che su un piano annuale può essere tra mesi)
  
      cancel_at_period_end: false,
      metadata: { barId, planId, ciclo: cicloScelto },
    });

    res.json({ success: true });
    // L'applicazione vera e propria (piano + zoneConfig) arriva dal webhook
    // customer.subscription.updated — non scriviamo Firestore qui per evitare
    // di bypassare il ricalcolo di zoneConfig fatto da applyPlanToBar.
} catch (err) {
    console.error("❌ Errore change-plan:", err);
    if (isStripeTaxLocationError(err)) {
      return res.status(422).json({
        error: "indirizzo_richiesto",
        message: "Serve l'indirizzo di fatturazione per calcolare l'IVA prima di procedere.",
      });
    }
    res.status(500).json({ error: "Errore cambio piano" });
  }
});

/* =========================
   BILLING — ANTEPRIMA COSTO CAMBIO PIANO (pro-rata)
   POST /billing/preview-plan-change
   Body: { token, barId, planId, ciclo }
   Non modifica nulla: sola lettura, mostra all'utente cosa pagherebbe oggi.
========================= */
app.post("/billing/preview-plan-change", async (req, res) => {
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
    if (info.uid !== decoded.uid) return res.status(403).json({ error: "Non autorizzato su questo locale" });
    if (!info.stripeSubscriptionId) return res.status(400).json({ error: "Nessun abbonamento attivo" });

    const planSnap = await demasDb.collection("plans").doc(planId).get();
    if (!planSnap.exists) return res.status(404).json({ error: "Piano non trovato" });
    const plan = planSnap.data();

    // Verifica coerenza subscription: se ha più di un item, qualcosa non va —
    // meglio bloccare con un errore chiaro che riprorazionare dati sporchi.
    const subscription = await stripe.subscriptions.retrieve(info.stripeSubscriptionId);
    if (subscription.items.data.length !== 1) {
      return res.status(409).json({
        error: "Abbonamento in stato inconsistente (più voci attive). Contatta l'assistenza prima di procedere.",
      });
    }
    const itemId = subscription.items.data[0].id;
    const priceAttualeId = subscription.items.data[0].price.id;

    const pianoAttualeTrovato = await findPlanByStripePriceId(priceAttualeId);
    if (!pianoAttualeTrovato) {
      return res.status(409).json({ error: "Piano attuale non riconosciuto nel catalogo." });
    }

    const planAttualeSnap = await demasDb.collection("plans").doc(pianoAttualeTrovato.planId).get();
    const livelloAttuale = planAttualeSnap.data()?.livello ?? 0;
    const livelloTarget = plan.livello ?? 0;

    const check = transizioneConsentita(livelloAttuale, pianoAttualeTrovato.ciclo, livelloTarget, cicloScelto);
    if (!check.ok) {
      return res.status(400).json({ error: check.motivo });
    }


    const stripePriceId = cicloScelto === "annuale" ? plan.stripePriceIdAnnuale : plan.stripePriceIdMensile;
    if (!stripePriceId) return res.status(400).json({ error: "Piano non acquistabile online per questo ciclo" });



    // sola anteprima: nessuna scrittura su Stripe né su Firestore
const preview = await stripe.invoices.createPreview({
      customer: info.stripeCustomerId,
      subscription: info.stripeSubscriptionId,
      subscription_details: {
        items: [{ id: itemId, price: stripePriceId }],
        proration_behavior: "always_invoice", 
       
      },
      automatic_tax: { enabled: true },
    });

// Mostriamo TUTTE le righe, non solo quelle di proration del cambio
    // corrente — se ci sono voci pendenti residue da un problema precedente,
    // l'utente deve vederle, non scoprire un totale più alto di quanto mostrato.
    const righeProrata = preview.lines.data.map((l) => ({
      descrizione: l.description,
      importo: l.amount / 100,
      èProrationDiQuestoCambio: l.parent?.subscription_item_details?.proration === true,
    }));

    const sommaRighe = righeProrata.reduce((s, r) => s + r.importo, 0);
    const sommaNonCollimante = Math.abs(sommaRighe - preview.subtotal / 100) > 0.01;

    res.json({
      dovutoOggi: preview.amount_due / 100,
      imponibile: preview.subtotal / 100,
      iva: (preview.total - preview.subtotal) / 100,
      totale: preview.total / 100,
      valuta: preview.currency,
      righeProrata,
      // Segnale per il frontend: se true, c'è qualcosa di residuo/anomalo
      // da investigare manualmente su Stripe prima di far confermare l'utente.
      anomaliaRilevata: sommaNonCollimante,
    });
} catch (err) {
    console.error("❌ Errore preview-plan-change:", err);
    if (isStripeTaxLocationError(err)) {
      return res.status(422).json({
        error: "indirizzo_richiesto",
        message: "Serve l'indirizzo di fatturazione per calcolare l'IVA prima di procedere.",
      });
    }
    res.status(500).json({ error: "Errore nel calcolo dell'anteprima" });
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