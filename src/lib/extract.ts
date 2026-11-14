// Extracción determinista (regex/heurísticas) del contrato a partir del texto.
import type { Ctx, ContratoExtraido, Campo, Pais, Moneda, EstadoPoliza } from "./types";
import { readCorreo, readAdjunto, readComerciales } from "./io";
import { findAllDates, parseSigningDate, normalizarNIT, parseAmount, lastDayOfMonth, addMonths, fmt, razonSocial } from "./util";

const ORD = ["PRIMERA", "SEGUNDA", "TERCERA", "CUARTA", "QUINTA", "SEXTA", "SEPTIMA", "OCTAVA", "NOVENA", "DECIMA"];

// Divide el texto en cláusulas por su ordinal (PRIMERA, SEGUNDA, ...).
function splitClauses(text: string): string[] {
  const re = /\b(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA)\.\s/g;
  const marks: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push(m.index);
  return marks.map((start, k) => text.slice(start, marks[k + 1] ?? text.length));
}

function clauseWith(clauses: string[], keyword: string): string | null {
  const re = new RegExp(keyword, "i");
  for (const c of clauses) if (re.test(c)) return c;
  return null;
}

function inferirPais(nit: string, moneda: Moneda | null, texto: string): Campo<Pais | null> {
  const len = nit.length;
  if (len === 13) return { valor: "EC", confianza: 0.9 };
  if (len === 14) return { valor: "HN", confianza: 0.9 };
  if (len === 11) return { valor: "PE", confianza: 0.9 };
  if (len === 9) {
    if (moneda === "PAB" || /panam[aá]/i.test(texto)) return { valor: "PA", confianza: 0.85 };
    return { valor: "CO", confianza: 0.85 };
  }
  return { valor: "CO", confianza: 0.5 };
}

function monedaDeTexto(texto: string): Moneda | null {
  if (/\bCOP\b|\bpesos\b/i.test(texto)) return "COP";
  if (/\bUSD\b|\bd[oó]lares\b/i.test(texto)) return "USD";
  if (/\bPEN\b|\bsoles\b/i.test(texto)) return "PEN";
  if (/\bPAB\b|\bbalboas\b/i.test(texto)) return "PAB";
  if (/\bHNL\b|\blempiras\b/i.test(texto)) return "HNL";
  return null;
}

export function extraerContrato(ctx: Ctx, mensaje_id: string): ContratoExtraido {
  const correo = readCorreo(ctx, mensaje_id);
  const comerciales = readComerciales(ctx);
  const comercialHit = comerciales.find((c) => c.email.toLowerCase() === (correo.de ?? "").toLowerCase());

  const adjuntos = correo.adjuntos ?? [];
  const adjContrato = adjuntos.find((a) => /contrato|otros[ií]/i.test(a)) ?? null;

  // Metadatos base
  const base = {
    mensaje_id,
    remitente_email: correo.de ?? "",
    remitente_registrado: !!comercialHit,
    comercial_resuelto: comercialHit?.nombre ?? null,
    adjunto: adjContrato ?? adjuntos[0] ?? "",
    tiene_contrato: !!adjContrato,
    es_otrosi: false,
  };

  const nuloStr = (): Campo<string | null> => ({ valor: null, confianza: 0 });
  if (!adjContrato) {
    return {
      id_contrato: nuloStr(), cliente: nuloStr(), nit_cliente: nuloStr(), pais: { valor: null, confianza: 0 },
      objeto: nuloStr(), valor: { valor: null, confianza: 0 }, moneda: { valor: null, confianza: 0 },
      fecha_inicio: nuloStr(), fecha_fin: nuloStr(), requiere_poliza: { valor: false, confianza: 0 },
      tipo_poliza: { valor: "", confianza: 0 }, estado_poliza: { valor: null, confianza: 0 },
      comercial: { valor: comercialHit?.nombre ?? null, confianza: comercialHit ? 0.95 : 0.3 },
      valor_indeterminado: { valor: false, confianza: 0 }, ...base,
    };
  }

  const texto = readAdjunto(ctx, mensaje_id, adjContrato);
  if (texto.trim() === "") throw new Error(`el adjunto ${adjContrato} de ${mensaje_id} está vacío`);
  const es_otrosi = /otros[ií]/i.test(adjContrato) || /^\s*OTROS[IÍ]/i.test(texto);
  const clauses = splitClauses(texto);

  // id_contrato: primer código tipo CT-2026-015 / CM-2026-03
  const idMatch = texto.match(/[A-Z]{2}-\d{4}-\d+/);
  const id_contrato: Campo<string | null> = idMatch
    ? { valor: idMatch[0], confianza: 0.95 }
    : nuloStr();

  // cliente: primera entidad nombrada tras "Entre"
  const cliMatch = texto.match(/Entre\s+(?:los suscritos,\s+)?([A-ZÁÉÍÓÚÑ][^,\n]+?),/);
  const cliCrudo = cliMatch?.[1]?.trim();
  const cliNombre = cliCrudo ? razonSocial(cliCrudo) : undefined;
  const cliente: Campo<string | null> = cliNombre ? { valor: cliNombre, confianza: 0.92 } : nuloStr();

  // nit/ruc
  const nitMatch = texto.match(/(?:NIT|RUC)\s+([0-9][0-9.,]*)(?:-(\d))?/);
  const nitRaw = normalizarNIT(nitMatch?.[1] ?? "");
  const nit_cliente: Campo<string | null> = nitRaw ? { valor: nitRaw, confianza: 0.95 } : nuloStr();

  // objeto: cláusula con OBJETO (nula en otrosíes)
  const objClause = clauseWith(clauses, "OBJETO");
  let objeto: Campo<string | null> = nuloStr();
  if (objClause) {
    const body = objClause.replace(/^.*?OBJETO\.\s*/s, "").trim();
    objeto = body ? { valor: body.slice(0, 200), confianza: 0.85 } : nuloStr();
  }

  // valor + moneda: cláusula con VALOR
  const valClause = clauseWith(clauses, "VALOR") ?? "";
  let valor: Campo<number | null> = { valor: null, confianza: 0 };
  let moneda: Campo<Moneda | null> = { valor: null, confianza: 0 };
  let valor_indeterminado: Campo<boolean> = { valor: false, confianza: 0 };
  if (/no tiene un?\s+valor determinado|sin\s+valor determinado|valor indeterminado/i.test(valClause)) {
    valor_indeterminado = { valor: true, confianza: 0.9 };
    valor = { valor: 0, confianza: 0.5, nota: "el contrato no fija un valor (contrato marco por demanda); se registra 0" };
    const m = monedaDeTexto(valClause) ?? monedaDeTexto(texto);
    moneda = m ? { valor: m, confianza: 0.85 } : { valor: null, confianza: 0 };
  } else {
    const vMatch = valClause.match(/(COP|USD|PEN|PAB|HNL)\s*\$?([\d.,]+)/);
    if (vMatch) {
      const n = parseAmount(vMatch[2] ?? "");
      if (n != null) {
        valor = { valor: n, confianza: 0.95 };
        moneda = { valor: vMatch[1] as Moneda, confianza: 0.95 };
      }
    } else {
      const numMatch = valClause.match(/\$([\d.,]+)/);
      if (numMatch) {
        const n = parseAmount(numMatch[1] ?? "");
        if (n != null) {
          valor = { valor: n, confianza: 0.85 };
          const m = monedaDeTexto(valClause) ?? monedaDeTexto(texto);
          moneda = m ? { valor: m, confianza: 0.8 } : { valor: null, confianza: 0 };
        }
      }
    }
  }

  const pais = inferirPais(nitRaw, moneda.valor, texto);

  // plazo: cláusula con PLAZO (en otrosíes queda en la cláusula que modifica el plazo)
  const plazoClause = clauseWith(clauses, "PLAZO") ?? "";
  const fechas = findAllDates(plazoClause);
  let fecha_inicio: Campo<string | null> = nuloStr();
  let fecha_fin: Campo<string | null> = nuloStr();
  const primera = fechas[0];
  const ultima = fechas[fechas.length - 1];
  if (primera && ultima && fechas.length >= 2) {
    fecha_inicio = { valor: fmt(primera.y, primera.m, primera.d), confianza: 0.95 };
    fecha_fin = { valor: fmt(ultima.y, ultima.m, ultima.d), confianza: 0.95 };
  } else if (primera) {
    // otrosí: "se extiende hasta <fecha>"
    fecha_inicio = nuloStr();
    fecha_fin = { valor: fmt(primera.y, primera.m, primera.d), confianza: 0.95 };
  } else {
    const nm = plazoClause.match(/(\d+)\s*\)?\s*meses/i);
    if (nm) {
      const n = Number(nm[1]);
      const signing = parseSigningDate(texto);
      if (signing) {
        let d = signing.d;
        let confIni = 0.9, confFin = 0.85;
        let nota = `calculada: firma + ${n} meses`;
        if (d === null) {
          d = lastDayOfMonth(signing.y, signing.m);
          confIni = 0.8; confFin = 0.6;
          nota = `calculada: el plazo es de ${n} meses desde la firma, pero la firma no indica el día; se tomó el último día del mes (${fmt(signing.y, signing.m, d)})`;
        }
        fecha_inicio = { valor: fmt(signing.y, signing.m, d), confianza: confIni };
        const f = addMonths(signing.y, signing.m, d, n);
        fecha_fin = { valor: fmt(f.y, f.m, f.d), confianza: confFin, nota };
      }
    }
  }

  // garantías: cláusula con GARANT o póliza
  const garClause = clauseWith(clauses, "GARANT|P[OÓ]LIZA|POLIZA");
  let requiere_poliza: Campo<boolean> = { valor: false, confianza: 0.9 };
  let tipo_poliza: Campo<string> = { valor: "", confianza: 0.9 };
  let estado_poliza: Campo<EstadoPoliza | null> = { valor: "no_aplica", confianza: 0.9 };
  if (garClause) {
    const condicional = valor_indeterminado.valor &&
      /orden\s+de\s+servicio|cuyo\s+valor\s+supere|para\s+cada\s+orden/i.test(garClause);
    if (condicional) {
      requiere_poliza = { valor: false, confianza: 0.85 };
      tipo_poliza = { valor: "", confianza: 0.8 };
      estado_poliza = { valor: "no_aplica", confianza: 0.85 };
    } else {
      requiere_poliza = { valor: true, confianza: 0.95 };
      const tipos = [...garClause.matchAll(/p[oó]liza\s+de\s+([a-záéíóú ]+?)(?=\s+por|\s+del|\s+y|,|$)/gi)].map((m) => (m[1] ?? "").trim()).filter((t) => t !== "");
      tipo_poliza = tipos.length
        ? { valor: tipos.map((t) => t.replace(/\s+/g, "_")).join(";"), confianza: 0.9 }
        : { valor: es_otrosi ? "" : "cumplimiento", confianza: 0.7, nota: "el contrato exige garantías pero no nombra el tipo de póliza; se asumió cumplimiento" };
      estado_poliza = { valor: "pendiente", confianza: 0.85 };
    }
  }

  // comercial
  const comercial: Campo<string | null> = comercialHit
    ? { valor: comercialHit.nombre, confianza: 0.95 }
    : { valor: null, confianza: 0.3 };

  return {
    id_contrato, cliente, nit_cliente, pais, objeto, valor, moneda,
    fecha_inicio, fecha_fin, requiere_poliza, tipo_poliza, estado_poliza,
    comercial, valor_indeterminado,
    ...base, es_otrosi,
  };
}
