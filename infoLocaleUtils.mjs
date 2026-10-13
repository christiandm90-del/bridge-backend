// ═══════════════════════════════════════════════════════════════════════════
// infoLocaleUtils.ts — FILE CONDIVISO
// Copia identica in DEMAS (components/) e in AppBase (components/).
// Solo TypeScript puro (nessuna dipendenza da React/DOM): può essere copiato
// tale e quale anche nel bridge backend, così client e server applicano
// ESATTAMENTE le stesse regole su orari e blocco ordini.
// Tutti i calcoli di data/ora usano il fuso Europe/Rome, non quello del dispositivo.
// ═══════════════════════════════════════════════════════════════════════════
export const MAX_TURNI = 2;
export const MAX_CHIUSURE_PERIODO = 3;
export const FUSO_ORARIO = "Europe/Rome";
export const giorni = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
export const giorniLabel = {
    lun: "Lunedì", mar: "Martedì", mer: "Mercoledì", gio: "Giovedì",
    ven: "Venerdì", sab: "Sabato", dom: "Domenica",
};
// ─── Testi di avviso (usati identici in DEMAS e in AppBase) ────────────────
export const AVVISI = {
    /** Mostrato ai clienti vicino a immagini/prodotti. */
    immagini: "Le immagini sono puramente illustrative e a scopo decorativo: il prodotto servito potrebbe differire da quello mostrato.",
    /** Mostrato ai clienti nei dettagli prodotto/offerta. */
    allergeni: "Componenti e allergeni sono indicati dal locale a titolo informativo. In caso di allergie o intolleranze chiedi sempre conferma al personale prima di ordinare.",
    /** Mostrato ai clienti in fondo al menu / nelle offerte. */
    prezzi: "Prezzi, disponibilità e offerte possono variare: fanno fede quelli confermati dal locale.",
    /** Mostrato al gestore in DEMAS. */
    gestore: [
        "Le immagini dei prodotti servono solo a identificare il prodotto venduto e vengono mostrate ai clienti come puramente illustrative.",
        "Sei responsabile della corretta corrispondenza tra immagine e prodotto offerto.",
        "Sei responsabile dei diritti sulle immagini che carichi o scegli (copyright e proprietà intellettuale).",
        "Componenti e allergeni devono essere accurati e aggiornati: vengono mostrati ai clienti come informazione fornita dal locale.",
        "Dopo aver applicato le modifiche ricorda di Pubblicare: senza pubblicazione non arrivano al menù online.",
    ],
};
export const MSG_ORDINI_CHIUSI = "Al momento il locale non accetta ordini online.";
const GIORNI_EN = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
export function adessoRoma(d = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: FUSO_ORARIO,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
        weekday: "short",
        hourCycle: "h23",
    }).formatToParts(d);
    const v = (t) => parts.find((p) => p.type === t)?.value ?? "";
    return {
        iso: `${v("year")}-${v("month")}-${v("day")}`,
        giornoIdx: GIORNI_EN[v("weekday").slice(0, 3).toLowerCase()] ?? 0,
        minuti: (Number(v("hour")) || 0) * 60 + (Number(v("minute")) || 0),
    };
}
export function chiaveGiornoOggi() {
    return giorni[adessoRoma().giornoIdx];
}
/** Data di oggi (YYYY-MM-DD) nel fuso del locale — niente più sfasamento UTC di notte. */
export function oggiISO() {
    return adessoRoma().iso;
}
export function minutiDaOrario(hhmm) {
    const [h, m] = (hhmm || "").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}
export function oraRoma(ms) {
    return new Date(ms).toLocaleTimeString("it-IT", { timeZone: FUSO_ORARIO, hour: "2-digit", minute: "2-digit" });
}
// ─── Orari a turni ─────────────────────────────────────────────────────────
const RE_ORA = /^\d{1,2}:\d{2}$/;
const turnoValido = (t) => !!t && RE_ORA.test(t.open || "") && RE_ORA.test(t.close || "");
/** Turni del giorno anche se il giorno è chiuso (serve all'editor per non perderli). Legge anche il formato legacy open/close. */
export function turniDi(cfg) {
    if (!cfg)
        return [];
    const da = (cfg.turni ?? []).filter(turnoValido);
    if (da.length)
        return da.slice(0, MAX_TURNI);
    const legacy = { open: cfg.open, close: cfg.close };
    return turnoValido(legacy) ? [legacy] : [];
}
/** Turni effettivi: vuoti se il giorno è chiuso. */
export function getTurni(cfg) {
    return !cfg || cfg.closed ? [] : turniDi(cfg);
}
export function testoTurni(cfg) {
    return getTurni(cfg).map((t) => `${t.open}–${t.close}`).join(" · ");
}
// Turno che inizia oggi. open === close = aperto tutto il giorno; close < open = scavalca la mezzanotte.
function copreOggi(t, now) {
    const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
    if (c > o)
        return now >= o && now < c;
    if (c === o)
        return true;
    return now >= o;
}
// Turno iniziato ieri che scavalca la mezzanotte e arriva fino a stamattina.
function copreDaIeri(t, now) {
    const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
    return c < o && now < c;
}
/** Se non c'è nessuna configurazione orari, non blocchiamo per prudenza (default: aperto). */
export function isApertoOra(orari, adesso = adessoRoma()) {
    if (!orari || Object.keys(orari).length === 0)
        return true;
    const oggi = orari[giorni[adesso.giornoIdx]];
    const ieri = orari[giorni[(adesso.giornoIdx + 6) % 7]];
    return (getTurni(oggi).some((t) => copreOggi(t, adesso.minuti)) ||
        getTurni(ieri).some((t) => copreDaIeri(t, adesso.minuti)));
}
/** Minuti mancanti alla fine del turno in corso (null se chiuso o aperto h24). */
export function minutiAllaChiusura(orari, adesso = adessoRoma()) {
    if (!orari)
        return null;
    const now = adesso.minuti;
    const candidati = [];
    for (const t of getTurni(orari[giorni[adesso.giornoIdx]])) {
        const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
        if (c > o && now >= o && now < c)
            candidati.push(c - now);
        else if (c < o && now >= o)
            candidati.push(1440 - now + c);
    }
    for (const t of getTurni(orari[giorni[(adesso.giornoIdx + 6) % 7]])) {
        const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
        if (c < o && now < c)
            candidati.push(c - now);
    }
    return candidati.length ? Math.min(...candidati) : null;
}
/** "oggi alle 18:00", "domani alle 08:00", "giovedì alle 08:00" — null se non si riapre mai. */
export function descriviProssimaApertura(orari, adesso = adessoRoma()) {
    if (!orari)
        return null;
    for (let d = 0; d <= 7; d++) {
        const key = giorni[(adesso.giornoIdx + d) % 7];
        const turni = [...getTurni(orari[key])].sort((a, b) => minutiDaOrario(a.open) - minutiDaOrario(b.open));
        const t = turni.find((x) => d > 0 || minutiDaOrario(x.open) > adesso.minuti);
        if (t) {
            const quando = d === 0 ? "oggi" : d === 1 ? "domani" : giorniLabel[key].toLowerCase();
            return `${quando} alle ${t.open}`;
        }
    }
    return null;
}
/** Risolve il set di orari effettivo (gestisce "come il locale"). Per ordini con modo "sempre" il chiamante non applica vincoli orari. */
export function orariRisolti(data, quali) {
    const locale = data.orari;
    const dalSet = (s) => (s?.modo === "personalizzati" && s.orari ? s.orari : locale);
    switch (quali) {
        case "apertura": return locale;
        case "menu": return dalSet(data.orariMenu);
        case "consegne": return dalSet(data.orariConsegne);
        case "ordini": {
            const o = data.ordini;
            if (!o)
                return locale;
            if (o.modo === "personalizzati" && o.orari)
                return o.orari;
            if (o.modo === "come_menu")
                return dalSet(data.orariMenu);
            return locale;
        }
    }
}
// ─── Chiusure straordinarie (con retrocompatibilità) ───────────────────────
export function getChiusureDate(data) {
    if (data.chiusureDate)
        return data.chiusureDate;
    return (data.chiusure || [])
        .filter(Boolean)
        .map((d, i) => ({ id: `legacy-${i}`, data: d, etichetta: "", attiva: true, mostraEtichetta: false }));
}
export function getChiusurePeriodi(data) {
    if (data.chiusurePeriodi)
        return data.chiusurePeriodi;
    const p = data.chiusurePeriodo;
    return p?.dal && p?.al
        ? [{ id: "legacy-0", etichetta: "", dal: p.dal, al: p.al, attiva: true, mostraEtichetta: false }]
        : [];
}
// L'etichetta esce solo se il gestore ha scelto di condividerla con i clienti.
const etichettaPubblica = (it) => it.mostraEtichetta && it.etichetta?.trim() ? it.etichetta.trim() : undefined;
export function getChiusuraOggi(data, adesso = adessoRoma()) {
    const oggi = adesso.iso;
    const s = getChiusureDate(data).find((c) => c.attiva !== false && c.data === oggi);
    if (s)
        return { tipo: "singola", data: oggi, etichetta: etichettaPubblica(s) };
    const p = getChiusurePeriodi(data).find((x) => x.attiva !== false && x.dal && x.al && oggi >= x.dal && oggi <= x.al);
    if (p)
        return { tipo: "periodo", dal: p.dal, al: p.al, etichetta: etichettaPubblica(p) };
    return null;
}
/** Chiusure programmate che iniziano dopo oggi, in ordine cronologico. */
export function getChiusureFuture(data, adesso = adessoRoma()) {
    const oggi = adesso.iso;
    const out = [];
    for (const c of getChiusureDate(data)) {
        if (c.attiva !== false && c.data && c.data > oggi)
            out.push({ inizio: c.data, info: { tipo: "singola", data: c.data, etichetta: etichettaPubblica(c) } });
    }
    for (const p of getChiusurePeriodi(data)) {
        if (p.attiva !== false && p.dal && p.al && p.dal > oggi)
            out.push({ inizio: p.dal, info: { tipo: "periodo", dal: p.dal, al: p.al, etichetta: etichettaPubblica(p) } });
    }
    return out.sort((a, b) => a.inizio.localeCompare(b.inizio)).map((x) => x.info);
}
export function formattaDataIt(iso) {
    try {
        const [y, m, d] = iso.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("it-IT", {
            day: "2-digit", month: "long", year: "numeric", timeZone: "UTC",
        });
    }
    catch {
        return iso;
    }
}
/** Quando il menu si può aprire (usa gli orari del "menu online", che di default coincidono con quelli del locale). */
export function getStatoMenu(data, adesso = adessoRoma()) {
    if (data.menuPubblicoAttivo === false)
        return { stato: "disattivato" };
    const chiusura = getChiusuraOggi(data, adesso);
    if (chiusura)
        return { stato: "chiusura", chiusura };
    if (!isApertoOra(orariRisolti(data, "menu"), adesso))
        return { stato: "orari" };
    return { stato: "ok" };
}
/**
 * Regole sugli ordini lato orari/pause/chiusure. NON include il vincolo di piano
 * né i clienti bloccati: quelli sono verificati dal bridge al momento dell'ordine.
 */
export function getStatoOrdini(data, adesso = adessoRoma(), ora = Date.now()) {
    const o = data.ordini;
    if (!o || !o.attivo)
        return { stato: "nascosto", motivo: "disattivati" };
    if (data.menuPubblicoAttivo === false)
        return { stato: "nascosto", motivo: "menu_non_attivo" };
    const p = o.pausa;
    if (p?.attiva && (!p.finoA || ora < p.finoA)) {
        return {
            stato: "chiuso",
            motivo: "pausa",
            messaggio: p.messaggio?.trim() || MSG_ORDINI_CHIUSI,
            riapertura: p.finoA ? `alle ${oraRoma(p.finoA)}` : null,
        };
    }
    if (getChiusuraOggi(data, adesso)) {
        return { stato: "chiuso", motivo: "chiusura_straordinaria", messaggio: MSG_ORDINI_CHIUSI };
    }
    if (o.modo !== "sempre") {
        const orari = orariRisolti(data, "ordini");
        if (!isApertoOra(orari, adesso)) {
            return {
                stato: "chiuso",
                motivo: "fuori_orario",
                messaggio: MSG_ORDINI_CHIUSI,
                riapertura: descriviProssimaApertura(orari, adesso),
            };
        }
        const stop = o.stopPrimaChiusuraMin ?? 0;
        if (stop > 0) {
            const m = minutiAllaChiusura(orari, adesso);
            if (m !== null && m <= stop) {
                return {
                    stato: "chiuso",
                    motivo: "stop_pre_chiusura",
                    messaggio: MSG_ORDINI_CHIUSI,
                    riapertura: descriviProssimaApertura(orari, adesso),
                };
            }
        }
    }
    return { stato: "aperto" };
}
// ─── Salvataggio: mirror per compatibilità con le versioni vecchie ─────────
function sincronizzaGiorno(cfg) {
    const t = turniDi(cfg);
    const turni = t.length ? t : [{ open: cfg.open || "08:00", close: cfg.close || "23:00" }];
    return { ...cfg, turni, open: turni[0].open, close: turni[0].close };
}
function sincronizzaOrari(o) {
    return Object.fromEntries(Object.entries(o).map(([g, c]) => [g, sincronizzaGiorno(c)]));
}
/**
 * Da chiamare a ogni modifica di publicMenus in DEMAS. Mantiene coerenti i campi "nuovi"
 * (turni, chiusureDate, chiusurePeriodi) e i mirror "vecchi" (open/close, chiusure, chiusurePeriodo)
 * letti dalle versioni di AppBase non ancora aggiornate. Non produce mai valori undefined (Firestore li rifiuta).
 */
export function normalizzaPerSalvataggio(d) {
    const date = getChiusureDate(d);
    const periodi = getChiusurePeriodi(d);
    const primoPeriodo = periodi.find((p) => p.attiva !== false && p.dal && p.al);
    const extra = {
        chiusureDate: date,
        chiusurePeriodi: periodi,
        chiusure: date.filter((c) => c.attiva !== false && c.data).map((c) => c.data),
        chiusurePeriodo: primoPeriodo ? { dal: primoPeriodo.dal, al: primoPeriodo.al } : null,
    };
    if (d.orari)
        extra.orari = sincronizzaOrari(d.orari);
    if (d.orariMenu) {
        extra.orariMenu = { ...d.orariMenu, ...(d.orariMenu.orari ? { orari: sincronizzaOrari(d.orariMenu.orari) } : {}) };
    }
    if (d.orariConsegne) {
        extra.orariConsegne = { ...d.orariConsegne, ...(d.orariConsegne.orari ? { orari: sincronizzaOrari(d.orariConsegne.orari) } : {}) };
    }
    if (d.ordini) {
        extra.ordini = { ...d.ordini, ...(d.ordini.orari ? { orari: sincronizzaOrari(d.ordini.orari) } : {}) };
    }
    return { ...d, ...extra };
}
// ─── Offerte ───────────────────────────────────────────────────────────────
/** Un'offerta è visibile solo se: marcata attiva, il giorno corrente è tra i suoi giorni (se specificati), ed è nella finestra oraria start-end. */
export function isOffertaAttivaOra(offerta) {
    if (!offerta.active)
        return false;
    const adesso = adessoRoma();
    if (offerta.giorni && offerta.giorni.length > 0) {
        if (!offerta.giorni.includes(giorni[adesso.giornoIdx]))
            return false;
    }
    if (!offerta.start || !offerta.end)
        return true;
    const startMin = minutiDaOrario(offerta.start);
    const endMin = minutiDaOrario(offerta.end);
    if (endMin > startMin)
        return adesso.minuti >= startMin && adesso.minuti < endMin;
    return adesso.minuti >= startMin || adesso.minuti < endMin;
}
