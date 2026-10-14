/* ============================================================================
   PATCH BACKEND — supporta piani da /plans E da /customPlans
   Sostituisci le funzioni applyPlanToBar e findPlanByStripePriceId
   in index.js con questo blocco, e usa getPlanDoc() negli endpoint
   create-payment-sheet / change-plan / preview-plan-change.
============================================================================ */

/**
 * Carica un piano da /plans oppure da /customPlans.
 * Per i custom verifica che il bar sia tra gli assegnati (se barId passato).
 * Ritorna { id, data, isCustom } oppure null.
 */
async function getPlanDoc(planId, barId = null) {
  // 1. Catalogo generale
  const publicSnap = await demasDb.collection("plans").doc(planId).get();
  if (publicSnap.exists) {
    return { id: publicSnap.id, data: publicSnap.data(), isCustom: false };
  }

  // 2. Piani personalizzati
  const customSnap = await demasDb.collection("customPlans").doc(planId).get();
  if (!customSnap.exists) return null;

  const data = customSnap.data();
  // Sicurezza: se conosciamo il bar, deve essere nell'elenco assegnati
  if (barId) {
    const assigned = Array.isArray(data.assignedBarIds) ? data.assignedBarIds : [];
    if (!assigned.includes(barId)) {
      const err = new Error("Questo piano personalizzato non è assegnato a questo locale");
      err.status = 403;
      throw err;
    }
    // Scadenza visibilità (opzionale ma coerente con il frontend)
    const exp = data.expirationByBar?.[barId];
    if (exp) {
      const expMs = exp.toMillis ? exp.toMillis() : new Date(exp).getTime();
      if (expMs < Date.now()) {
        const err = new Error("Questo piano personalizzato è scaduto per il tuo locale");
        err.status = 410;
        throw err;
      }
    }
  }

  return { id: customSnap.id, data, isCustom: true };
}

/**
 * Applica i limiti e i permessi di un piano (generale o custom) al locale.
 */
async function applyPlanToBar(barId, planId, source, ciclo = "mensile", resetCancellazione = false) {
  const trovato = await getPlanDoc(planId, barId);
  if (!trovato) throw new Error(`Piano "${planId}" non trovato in /plans né in /customPlans`);
  const plan = trovato.data;

  const infoRef = demasDb.collection("bars").doc(barId).collection("meta").doc("info");
  const infoSnap = await infoRef.get();
  if (!infoSnap.exists) throw new Error(`Locale "${barId}" non trovato`);
  const info = infoSnap.data();

  const employees = Array.isArray(info.employees) ? info.employees : [];
  const permissions = {};
  employees.forEach((emp) => {
    if (emp?.id) permissions[emp.id] = { ...(plan.permissionsDefault || {}) };
  });

  const aggiornamento = {
    "piano.tipo": planId,
    "piano.ciclo": ciclo,
    "piano.personalizzato": !!trovato.isCustom,
    "piano.aggiornatoDa": source,
    "piano.aggiornatoIl": admin.firestore.FieldValue.serverTimestamp(),
    zoneConfig: {
      limits: plan.limits || {},
      permissions,
    },
  };

  if (resetCancellazione) {
    aggiornamento["piano.cancellazionePendente"] = false;
    aggiornamento["piano.cancellaIl"] = null;
  }

  await infoRef.update(aggiornamento);
  console.log(`✅ Piano di ${barId} aggiornato a "${planId}" (${ciclo}, custom=${trovato.isCustom}, ${source})`);
}

/**
 * Cerca un piano (generale o custom) a partire dallo Stripe Price ID.
 */
async function findPlanByStripePriceId(priceId) {
  // --- piani generali ---
  let snap = await demasDb.collection("plans").where("stripePriceIdMensile", "==", priceId).limit(1).get();
  if (!snap.empty) return { planId: snap.docs[0].id, ciclo: "mensile", isCustom: false };

  snap = await demasDb.collection("plans").where("stripePriceIdAnnuale", "==", priceId).limit(1).get();
  if (!snap.empty) return { planId: snap.docs[0].id, ciclo: "annuale", isCustom: false };

  // --- piani personalizzati ---
  snap = await demasDb.collection("customPlans").where("stripePriceIdMensile", "==", priceId).limit(1).get();
  if (!snap.empty) return { planId: snap.docs[0].id, ciclo: "mensile", isCustom: true };

  snap = await demasDb.collection("customPlans").where("stripePriceIdAnnuale", "==", priceId).limit(1).get();
  if (!snap.empty) return { planId: snap.docs[0].id, ciclo: "annuale", isCustom: true };

  return null;
}

/* ============================================================================
   SOSTITUZIONI NEGLI ENDPOINT
   Ovunque c'è:

     const planSnap = await demasDb.collection("plans").doc(planId).get();
     if (!planSnap.exists) return res.status(404).json({ error: "Piano non trovato" });
     const plan = planSnap.data();

   Sostituisci con:

     let planDoc;
     try {
       planDoc = await getPlanDoc(planId, barId);
     } catch (e) {
       return res.status(e.status || 500).json({ error: e.message });
     }
     if (!planDoc) return res.status(404).json({ error: "Piano non trovato" });
     const plan = planDoc.data;

   Endpoints da aggiornare (3 punti):
   - POST /billing/create-payment-sheet  (~riga 1656)
   - POST /billing/change-plan           (~riga 1842)
   - POST /billing/preview-plan-change   (~riga 1942)

   Per change-plan e preview, quando leggono il piano ATTUALE via
   pianoAttualeTrovato.planId, usa pure getPlanDoc:

     const planAttualeDoc = await getPlanDoc(pianoAttualeTrovato.planId);
     const livelloAttuale = planAttualeDoc?.data?.livello ?? 0;

   (non serve passare barId qui: il piano attuale è già applicato al bar)
============================================================================ */
