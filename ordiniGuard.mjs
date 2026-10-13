/**
 * ordiniGuard.ts — BRIDGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Decide se un cliente può ordinare da un locale ADESSO, con cache in memoria per
 * non moltiplicare le letture Firestore (centinaia di clienti per locale).
 *
 * Costo a regime: per ogni locale, al massimo ~4 letture ogni 15-60 secondi e SOLO mentre arrivano ordini.
 * Nessuna scrittura. Nessun listener. Dopo il primo ordine di una finestra, gli altri costano 0 letture.
 *
 * Database:
 *   appbaseDb → publicMenus/{localeId}                (snapshot pubblicato: ordini, orari, chiusure)
 *   demasDb   → bars/{localeId}/meta/info             (piano.tipo)
 *               plans/{tipo}                          (features.ordiniOnline)   ← se /plans sta in un altro db, cambia qui
 *               bars/{localeId}/meta/ordiniBloccati   ({ emails: string[] }, privato)
 */
import { getStatoOrdini } from "./infoLocaleUtils.mjs";
const TTL = { pubblicato: 15000, piano: 60000, catalogoPiani: 600000, bloccati: 60000 };
const MAX_ENTRIES = 500;
function cached(map, key, ttl, load) {
    const now = Date.now();
    const e = map.get(key);
    if (e && now - e.t < ttl)
        return e.p; // include le richieste concorrenti: un solo load per chiave
    const ne = { t: now, p: load() };
    if (map.size >= MAX_ENTRIES)
        map.clear();
    map.set(key, ne);
    ne.p.catch(() => { if (map.get(key) === ne)
        map.delete(key); }); // gli errori non restano in cache
    return ne.p;
}
const str = (v, max) => String(v ?? "").trim().slice(0, max);
export function creaOrdiniGuard({ demasDb, appbaseDb }) {
    const cPub = new Map();
    const cTipo = new Map();
    const cPiani = new Map();
    const cBloccati = new Map();
    /** Il piano del locale include gli ordini online? (features.ordiniOnline === true) */
    async function pianoConsenteOrdini(localeId) {
        const tipo = await cached(cTipo, localeId, TTL.piano, async () => {
            const s = await demasDb.doc(`bars/${localeId}/meta/info`).get();
            return s.data()?.piano?.tipo ?? null;
        });
        if (!tipo)
            return false;
        return cached(cPiani, tipo, TTL.catalogoPiani, async () => {
            const s = await demasDb.doc(`plans/${tipo}`).get();
            return s.data()?.features?.ordiniOnline === true;
        });
    }
    /**
     * @param email  da verifyIdToken (decoded.email), mai dal body.
     * @param giaPagato  true per ordini con carta già incassati: il via libera è stato dato alla creazione del PaymentIntent,
     *                   rifiutarli ora significherebbe tenersi i soldi senza ordine (es. scatta la chiusura nel frattempo).
     */
    async function verificaOrdiniConsentiti(localeId, email, opts = {}) {
        if (opts.giaPagato)
            return { ok: true };
        const [pianoOk, data, bloccati] = await Promise.all([
            pianoConsenteOrdini(localeId),
            cached(cPub, localeId, TTL.pubblicato, async () => ((await appbaseDb.doc(`publicMenus/${localeId}`).get()).data() || {})),
            cached(cBloccati, localeId, TTL.bloccati, async () => {
                const s = await demasDb.doc(`bars/${localeId}/meta/ordiniBloccati`).get();
                return new Set((s.data()?.emails || []).map((e) => String(e).toLowerCase()));
            }),
        ]);
        if (!pianoOk)
            return { ok: false, status: 403, error: "ordini_non_disponibili" };
        const stato = getStatoOrdini(data); // usa l'orologio reale a ogni chiamata, anche con dati in cache
        if (stato.stato === "nascosto")
            return { ok: false, status: 403, error: "ordini_non_disponibili" };
        if (stato.stato === "chiuso")
            return { ok: false, status: 403, error: "ordini_chiusi" };
        const e = String(email || "").trim().toLowerCase();
        if (e && bloccati.has(e))
            return { ok: false, status: 403, error: "cliente_bloccato" };
        return { ok: true };
    }
    /** Da chiamare dopo /sync-menu: il prossimo ordine rilegge subito i dati del locale. */
    function invalida(localeId) { cPub.delete(localeId); cTipo.delete(localeId); }
    /**
     * Campi pubblici da scrivere in publicMenus/{localeId} partendo da quanto manda DEMAS.
     * - ordini.attivo forzato a false se il piano non li include (downgrade/scadenza inclusi)
     * - etichette delle chiusure rimosse se il gestore NON le condivide (il documento è leggibile da tutti i client)
     * - tutti i campi nuovi sono scritti sempre per intero, così il merge:true non lascia pause o orari vecchi
     * - lunghezze limitate (documento pubblico, anti-abuso)
     */
    function campiPubbliciDaSync(pm, ordiniConsentiti) {
        const pubEtichetta = (it) => (it?.mostraEtichetta === true ? str(it.etichetta, 80) : "");
        const chiusureDate = (Array.isArray(pm.chiusureDate) ? pm.chiusureDate : []).slice(0, 200).map((c) => ({
            id: str(c.id, 40), data: str(c.data, 10), attiva: c.attiva !== false,
            mostraEtichetta: c.mostraEtichetta === true, etichetta: pubEtichetta(c),
        }));
        const chiusurePeriodi = (Array.isArray(pm.chiusurePeriodi) ? pm.chiusurePeriodi : []).slice(0, 3).map((p) => ({
            id: str(p.id, 40), dal: str(p.dal, 10), al: str(p.al, 10), attiva: p.attiva !== false,
            mostraEtichetta: p.mostraEtichetta === true, etichetta: pubEtichetta(p),
        }));
        const set = (s) => (s ? { modo: s.modo === "personalizzati" ? "personalizzati" : "come_locale", orari: s.modo === "personalizzati" ? s.orari ?? null : null } : { modo: "come_locale", orari: null });
        const o = pm.ordini;
        const ordini = {
            attivo: ordiniConsentiti && o?.attivo === true,
            modo: ["sempre", "come_locale", "come_menu", "personalizzati"].includes(o?.modo) ? o.modo : "come_locale",
            orari: o?.modo === "personalizzati" ? o.orari ?? null : null,
            stopPrimaChiusuraMin: Math.max(0, Math.min(240, Number(o?.stopPrimaChiusuraMin) || 0)),
            pausa: {
                attiva: o?.pausa?.attiva === true,
                finoA: typeof o?.pausa?.finoA === "number" ? o.pausa.finoA : null,
                messaggio: str(o?.pausa?.messaggio, 200),
            },
        };
        return {
            orari: pm.orari || {},
            orariMenu: set(pm.orariMenu),
            orariConsegne: set(pm.orariConsegne),
            // mirror legacy, letti dalle versioni di AppBase non ancora aggiornate
            chiusure: pm.chiusure || [],
            chiusurePeriodo: pm.chiusurePeriodo || null,
            chiusureDate,
            chiusurePeriodi,
            offerte: pm.offerte || [],
            menuPubblicoAttivo: pm.menuPubblicoAttivo || false,
            pagamentoLocaleAttivo: pm.pagamentoLocaleAttivo !== false,
            ordini,
        };
    }
    return { verificaOrdiniConsentiti, pianoConsenteOrdini, campiPubbliciDaSync, invalida };
}
