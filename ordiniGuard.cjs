var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../../../../home/claude/out/ordiniGuard.ts
var ordiniGuard_exports = {};
__export(ordiniGuard_exports, {
  creaOrdiniGuard: () => creaOrdiniGuard
});
module.exports = __toCommonJS(ordiniGuard_exports);

// ../../../../../home/claude/out/infoLocaleUtils.ts
var MAX_TURNI = 2;
var FUSO_ORARIO = "Europe/Rome";
var giorni = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
var giorniLabel = {
  lun: "Luned\xEC",
  mar: "Marted\xEC",
  mer: "Mercoled\xEC",
  gio: "Gioved\xEC",
  ven: "Venerd\xEC",
  sab: "Sabato",
  dom: "Domenica"
};
var MSG_ORDINI_CHIUSI = "Al momento il locale non accetta ordini online.";
var GIORNI_EN = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
function adessoRoma(d = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: FUSO_ORARIO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(d);
  const v = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    iso: `${v("year")}-${v("month")}-${v("day")}`,
    giornoIdx: GIORNI_EN[v("weekday").slice(0, 3).toLowerCase()] ?? 0,
    minuti: (Number(v("hour")) || 0) * 60 + (Number(v("minute")) || 0)
  };
}
function minutiDaOrario(hhmm) {
  const [h, m] = (hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function oraRoma(ms) {
  return new Date(ms).toLocaleTimeString("it-IT", { timeZone: FUSO_ORARIO, hour: "2-digit", minute: "2-digit" });
}
var RE_ORA = /^\d{1,2}:\d{2}$/;
var turnoValido = (t) => !!t && RE_ORA.test(t.open || "") && RE_ORA.test(t.close || "");
function turniDi(cfg) {
  if (!cfg) return [];
  const da = (cfg.turni ?? []).filter(turnoValido);
  if (da.length) return da.slice(0, MAX_TURNI);
  const legacy = { open: cfg.open, close: cfg.close };
  return turnoValido(legacy) ? [legacy] : [];
}
function getTurni(cfg) {
  return !cfg || cfg.closed ? [] : turniDi(cfg);
}
function copreOggi(t, now) {
  const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
  if (c > o) return now >= o && now < c;
  if (c === o) return true;
  return now >= o;
}
function copreDaIeri(t, now) {
  const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
  return c < o && now < c;
}
function isApertoOra(orari, adesso = adessoRoma()) {
  if (!orari || Object.keys(orari).length === 0) return true;
  const oggi = orari[giorni[adesso.giornoIdx]];
  const ieri = orari[giorni[(adesso.giornoIdx + 6) % 7]];
  return getTurni(oggi).some((t) => copreOggi(t, adesso.minuti)) || getTurni(ieri).some((t) => copreDaIeri(t, adesso.minuti));
}
function minutiAllaChiusura(orari, adesso = adessoRoma()) {
  if (!orari) return null;
  const now = adesso.minuti;
  const candidati = [];
  for (const t of getTurni(orari[giorni[adesso.giornoIdx]])) {
    const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
    if (c > o && now >= o && now < c) candidati.push(c - now);
    else if (c < o && now >= o) candidati.push(1440 - now + c);
  }
  for (const t of getTurni(orari[giorni[(adesso.giornoIdx + 6) % 7]])) {
    const o = minutiDaOrario(t.open), c = minutiDaOrario(t.close);
    if (c < o && now < c) candidati.push(c - now);
  }
  return candidati.length ? Math.min(...candidati) : null;
}
function descriviProssimaApertura(orari, adesso = adessoRoma()) {
  if (!orari) return null;
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
function orariRisolti(data, quali) {
  const locale = data.orari;
  const dalSet = (s) => s?.modo === "personalizzati" && s.orari ? s.orari : locale;
  switch (quali) {
    case "apertura":
      return locale;
    case "menu":
      return dalSet(data.orariMenu);
    case "consegne":
      return dalSet(data.orariConsegne);
    case "ordini": {
      const o = data.ordini;
      if (!o) return locale;
      if (o.modo === "personalizzati" && o.orari) return o.orari;
      if (o.modo === "come_menu") return dalSet(data.orariMenu);
      return locale;
    }
  }
}
function getChiusureDate(data) {
  if (data.chiusureDate) return data.chiusureDate;
  return (data.chiusure || []).filter(Boolean).map((d, i) => ({ id: `legacy-${i}`, data: d, etichetta: "", attiva: true, mostraEtichetta: false }));
}
function getChiusurePeriodi(data) {
  if (data.chiusurePeriodi) return data.chiusurePeriodi;
  const p = data.chiusurePeriodo;
  return p?.dal && p?.al ? [{ id: "legacy-0", etichetta: "", dal: p.dal, al: p.al, attiva: true, mostraEtichetta: false }] : [];
}
var etichettaPubblica = (it) => it.mostraEtichetta && it.etichetta?.trim() ? it.etichetta.trim() : void 0;
function getChiusuraOggi(data, adesso = adessoRoma()) {
  const oggi = adesso.iso;
  const s = getChiusureDate(data).find((c) => c.attiva !== false && c.data === oggi);
  if (s) return { tipo: "singola", data: oggi, etichetta: etichettaPubblica(s) };
  const p = getChiusurePeriodi(data).find(
    (x) => x.attiva !== false && x.dal && x.al && oggi >= x.dal && oggi <= x.al
  );
  if (p) return { tipo: "periodo", dal: p.dal, al: p.al, etichetta: etichettaPubblica(p) };
  return null;
}
function getStatoOrdini(data, adesso = adessoRoma(), ora = Date.now()) {
  const o = data.ordini;
  if (!o || !o.attivo) return { stato: "nascosto", motivo: "disattivati" };
  if (data.menuPubblicoAttivo === false) return { stato: "nascosto", motivo: "menu_non_attivo" };
  const p = o.pausa;
  if (p?.attiva && (!p.finoA || ora < p.finoA)) {
    return {
      stato: "chiuso",
      motivo: "pausa",
      messaggio: p.messaggio?.trim() || MSG_ORDINI_CHIUSI,
      riapertura: p.finoA ? `alle ${oraRoma(p.finoA)}` : null
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
        riapertura: descriviProssimaApertura(orari, adesso)
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
          riapertura: descriviProssimaApertura(orari, adesso)
        };
      }
    }
  }
  return { stato: "aperto" };
}

// ../../../../../home/claude/out/ordiniGuard.ts
var TTL = { pubblicato: 15e3, piano: 6e4, catalogoPiani: 6e5, bloccati: 6e4 };
var MAX_ENTRIES = 500;
function cached(map, key, ttl, load) {
  const now = Date.now();
  const e = map.get(key);
  if (e && now - e.t < ttl) return e.p;
  const ne = { t: now, p: load() };
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, ne);
  ne.p.catch(() => {
    if (map.get(key) === ne) map.delete(key);
  });
  return ne.p;
}
var str = (v, max) => String(v ?? "").trim().slice(0, max);
function creaOrdiniGuard({ demasDb, appbaseDb }) {
  const cPub = /* @__PURE__ */ new Map();
  const cTipo = /* @__PURE__ */ new Map();
  const cPiani = /* @__PURE__ */ new Map();
  const cBloccati = /* @__PURE__ */ new Map();
  async function pianoConsenteOrdini(localeId) {
    const tipo = await cached(cTipo, localeId, TTL.piano, async () => {
      const s = await demasDb.doc(`bars/${localeId}/meta/info`).get();
      return s.data()?.piano?.tipo ?? null;
    });
    if (!tipo) return false;
    return cached(cPiani, tipo, TTL.catalogoPiani, async () => {
      const s = await demasDb.doc(`plans/${tipo}`).get();
      return s.data()?.features?.ordiniOnline === true;
    });
  }
  async function verificaOrdiniConsentiti(localeId, email, opts = {}) {
    if (opts.giaPagato) return { ok: true };
    const [pianoOk, data, bloccati] = await Promise.all([
      pianoConsenteOrdini(localeId),
      cached(cPub, localeId, TTL.pubblicato, async () => (await appbaseDb.doc(`publicMenus/${localeId}`).get()).data() || {}),
      cached(cBloccati, localeId, TTL.bloccati, async () => {
        const s = await demasDb.doc(`bars/${localeId}/meta/ordiniBloccati`).get();
        return new Set((s.data()?.emails || []).map((e2) => String(e2).toLowerCase()));
      })
    ]);
    if (!pianoOk) return { ok: false, status: 403, error: "ordini_non_disponibili" };
    const stato = getStatoOrdini(data);
    if (stato.stato === "nascosto") return { ok: false, status: 403, error: "ordini_non_disponibili" };
    if (stato.stato === "chiuso") return { ok: false, status: 403, error: "ordini_chiusi" };
    const e = String(email || "").trim().toLowerCase();
    if (e && bloccati.has(e)) return { ok: false, status: 403, error: "cliente_bloccato" };
    return { ok: true };
  }
  function invalida(localeId) {
    cPub.delete(localeId);
    cTipo.delete(localeId);
  }
  function campiPubbliciDaSync(pm, ordiniConsentiti) {
    const pubEtichetta = (it) => it?.mostraEtichetta === true ? str(it.etichetta, 80) : "";
    const chiusureDate = (Array.isArray(pm.chiusureDate) ? pm.chiusureDate : []).slice(0, 200).map((c) => ({
      id: str(c.id, 40),
      data: str(c.data, 10),
      attiva: c.attiva !== false,
      mostraEtichetta: c.mostraEtichetta === true,
      etichetta: pubEtichetta(c)
    }));
    const chiusurePeriodi = (Array.isArray(pm.chiusurePeriodi) ? pm.chiusurePeriodi : []).slice(0, 3).map((p) => ({
      id: str(p.id, 40),
      dal: str(p.dal, 10),
      al: str(p.al, 10),
      attiva: p.attiva !== false,
      mostraEtichetta: p.mostraEtichetta === true,
      etichetta: pubEtichetta(p)
    }));
    const set = (s) => s ? { modo: s.modo === "personalizzati" ? "personalizzati" : "come_locale", orari: s.modo === "personalizzati" ? s.orari ?? null : null } : { modo: "come_locale", orari: null };
    const o = pm.ordini;
    const ordini = {
      attivo: ordiniConsentiti && o?.attivo === true,
      modo: ["sempre", "come_locale", "come_menu", "personalizzati"].includes(o?.modo) ? o.modo : "come_locale",
      orari: o?.modo === "personalizzati" ? o.orari ?? null : null,
      stopPrimaChiusuraMin: Math.max(0, Math.min(240, Number(o?.stopPrimaChiusuraMin) || 0)),
      pausa: {
        attiva: o?.pausa?.attiva === true,
        finoA: typeof o?.pausa?.finoA === "number" ? o.pausa.finoA : null,
        messaggio: str(o?.pausa?.messaggio, 200)
      }
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
      ordini
    };
  }
  return { verificaOrdiniConsentiti, pianoConsenteOrdini, campiPubbliciDaSync, invalida };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  creaOrdiniGuard
});
