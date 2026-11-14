// Extracción determinista (regex y heurísticas) del contrato a partir del texto del documento.
// Cada campo lleva una confianza que depende de cómo se obtuvo: explícito, calculado o supuesto.
import type { Ctx, ContratoExtraido, Campo, Pais, Moneda, EstadoPoliza } from "./types";
import { readCorreo, leerAdjunto, readComerciales } from "./io";
import { findAllDates, parseSigningDate, normalizarNIT, parseAmount, lastDayOfMonth, addMonths, fmt, razonSocial } from "./util";

const MONEDAS = new Set(["COP", "USD", "PEN", "PAB", "HNL"]);
const nulo = <T>(): Campo<T | null> => ({ valor: null, confianza: 0 });

// ── Estructura del documento ─────────────────────────────────────────────────

// Divide el texto en cláusulas por su ordinal (PRIMERA, SEGUNDA, ...).
function clausulas(texto: string): string[] {
  const re = /\b(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA)\.\s/g;
  const marcas: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) marcas.push(m.index);
  return marcas.map((inicio, k) => texto.slice(inicio, marcas[k + 1] ?? texto.length));
}

// Busca la cláusula por su TÍTULO ("SEGUNDA. VALOR."), no por una palabra suelta: así un texto con la
// palabra "valor" metido en otra cláusula no puede hacerse pasar por ella. Si dos cláusulas tienen el
// mismo título es ambiguo y no se elige ninguna (el campo queda en revisión). Un otrosí no lleva
// títulos (dice "Modificar la cláusula SEGUNDA (VALOR)"), así que ahí se busca la palabra.
function clausula(lista: string[], palabra: string, esOtrosi: boolean): string | null {
  const titulo = new RegExp(`^[A-ZÁÉÍÓÚ]+\\.\\s+(?:${palabra})`, "i");
  const porTitulo = lista.filter((c) => titulo.test(c));
  if (porTitulo.length === 1) return porTitulo[0] ?? null;
  if (porTitulo.length > 1 || !esOtrosi) return null;
  const libre = new RegExp(palabra, "i");
  return lista.find((c) => libre.test(c)) ?? null;
}

// ── Partes ───────────────────────────────────────────────────────────────────

function idContrato(texto: string): Campo<string | null> {
  const m = texto.match(/[A-Z]{2}-\d{4}-\d+/);
  return m ? { valor: m[0], confianza: 0.95 } : nulo();
}

// El cliente es la primera razón social después de "Entre (los suscritos,)".
function cliente(texto: string): Campo<string | null> {
  const nombre = texto.match(/Entre\s+(?:los suscritos,\s+)?([A-ZÁÉÍÓÚÑ][^,\n]+?),/)?.[1]?.trim();
  return nombre ? { valor: razonSocial(nombre), confianza: 0.92 } : nulo();
}

function nitCliente(texto: string): Campo<string | null> {
  const nit = normalizarNIT(texto.match(/(?:NIT|RUC)\s+([0-9][0-9.,]*)(?:-(\d))?/)?.[1] ?? "");
  return nit ? { valor: nit, confianza: 0.95 } : nulo();
}

// El país sale de la longitud del identificador tributario; sin identificador no se adivina.
function pais(nit: string, moneda: Moneda | null, texto: string): Campo<Pais | null> {
  const porLongitud: Record<number, Pais> = { 13: "EC", 14: "HN", 11: "PE" };
  const directo = porLongitud[nit.length];
  if (directo) return { valor: directo, confianza: 0.9 };
  if (nit.length !== 9) return nulo();
  const panama = moneda === "PAB" || /panam[aá]/i.test(texto);
  return { valor: panama ? "PA" : "CO", confianza: 0.85 };
}

function objeto(lista: string[], esOtrosi: boolean): Campo<string | null> {
  const c = clausula(lista, "OBJETO", esOtrosi);
  const cuerpo = c?.replace(/^.*?OBJETO\.\s*/s, "").trim();
  return cuerpo ? { valor: cuerpo.slice(0, 200), confianza: 0.85 } : nulo();
}

// ── Valor y moneda ───────────────────────────────────────────────────────────

function monedaEnTexto(texto: string): Moneda | null {
  if (/\bCOP\b|\bpesos\b/i.test(texto)) return "COP";
  if (/\bUSD\b|\bd[oó]lares\b/i.test(texto)) return "USD";
  if (/\bPEN\b|\bsoles\b/i.test(texto)) return "PEN";
  if (/\bPAB\b|\bbalboas\b/i.test(texto)) return "PAB";
  if (/\bHNL\b|\blempiras\b/i.test(texto)) return "HNL";
  return null;
}

// HU-6: un importe con un código de moneda fuera del catálogo es un error, no un COP supuesto.
function validarMoneda(clausulaValor: string): void {
  for (const m of clausulaValor.matchAll(/\b([A-Z]{3})\s*\$?\s*\d/g)) {
    const codigo = m[1] ?? "";
    if (!MONEDAS.has(codigo)) throw new Error(`moneda desconocida en el contrato: ${codigo} (se aceptan ${[...MONEDAS].join(", ")})`);
  }
}

interface ValorExtraido {
  valor: Campo<number | null>;
  moneda: Campo<Moneda | null>;
  valor_indeterminado: Campo<boolean>;
}

function valorYMoneda(lista: string[], texto: string, esOtrosi: boolean): ValorExtraido {
  const c = clausula(lista, "VALOR", esOtrosi) ?? "";
  validarMoneda(c);
  const sinValor: ValorExtraido = { valor: nulo(), moneda: nulo(), valor_indeterminado: { valor: false, confianza: 0 } };

  if (/no tiene un?\s+valor determinado|sin\s+valor determinado|valor indeterminado/i.test(c)) {
    const m = monedaEnTexto(c) ?? monedaEnTexto(texto);
    return {
      valor: { valor: 0, confianza: 0.5, nota: "el contrato no fija un valor (contrato marco por demanda); se registra 0" },
      moneda: m ? { valor: m, confianza: 0.85 } : nulo(),
      valor_indeterminado: { valor: true, confianza: 0.9 },
    };
  }
  const conCodigo = c.match(/(COP|USD|PEN|PAB|HNL)\s*\$?([\d.,]+)/);
  if (conCodigo) {
    const n = parseAmount(conCodigo[2] ?? "");
    return n == null ? sinValor : { ...sinValor, valor: { valor: n, confianza: 0.95 }, moneda: { valor: conCodigo[1] as Moneda, confianza: 0.95 } };
  }
  const soloSigno = c.match(/\$([\d.,]+)/);
  const n = soloSigno ? parseAmount(soloSigno[1] ?? "") : null;
  if (n == null) return sinValor;
  const m = monedaEnTexto(c) ?? monedaEnTexto(texto);
  return { ...sinValor, valor: { valor: n, confianza: 0.85 }, moneda: m ? { valor: m, confianza: 0.8 } : nulo() };
}

// ── Plazo ────────────────────────────────────────────────────────────────────

interface Plazo { fecha_inicio: Campo<string | null>; fecha_fin: Campo<string | null> }

// Plazo en meses contado desde la firma. Si la firma no dice el día, se toma el último del mes.
function plazoEnMeses(clausulaPlazo: string, texto: string): Plazo {
  const meses = Number(clausulaPlazo.match(/(\d+)\s*\)?\s*meses/i)?.[1] ?? NaN);
  const firma = Number.isNaN(meses) ? null : parseSigningDate(texto);
  if (!firma) return { fecha_inicio: nulo(), fecha_fin: nulo() };
  const sinDia = firma.d === null;
  const dia = firma.d ?? lastDayOfMonth(firma.y, firma.m);
  const inicio = fmt(firma.y, firma.m, dia);
  const f = addMonths(firma.y, firma.m, dia, meses);
  const nota = sinDia
    ? `calculada: el plazo es de ${meses} meses desde la firma, pero la firma no indica el día; se tomó el último día del mes (${inicio})`
    : `calculada: firma + ${meses} meses`;
  return {
    fecha_inicio: { valor: inicio, confianza: sinDia ? 0.8 : 0.9 },
    fecha_fin: { valor: fmt(f.y, f.m, f.d), confianza: sinDia ? 0.6 : 0.85, nota },
  };
}

function plazo(lista: string[], texto: string, esOtrosi: boolean): Plazo {
  const c = clausula(lista, "PLAZO", esOtrosi) ?? "";
  const fechas = findAllDates(c);
  const primera = fechas[0];
  const ultima = fechas[fechas.length - 1];
  if (primera && ultima && fechas.length >= 2) {
    return { fecha_inicio: { valor: fmt(primera.y, primera.m, primera.d), confianza: 0.95 }, fecha_fin: { valor: fmt(ultima.y, ultima.m, ultima.d), confianza: 0.95 } };
  }
  // Una sola fecha: típico de un otrosí ("se extiende hasta <fecha>").
  if (primera) return { fecha_inicio: nulo(), fecha_fin: { valor: fmt(primera.y, primera.m, primera.d), confianza: 0.95 } };
  return plazoEnMeses(c, texto);
}

// ── Póliza ───────────────────────────────────────────────────────────────────

interface Poliza { requiere_poliza: Campo<boolean>; tipo_poliza: Campo<string>; estado_poliza: Campo<EstadoPoliza | null> }

const SIN_POLIZA: Poliza = {
  requiere_poliza: { valor: false, confianza: 0.9 },
  tipo_poliza: { valor: "", confianza: 0.9 },
  estado_poliza: { valor: "no_aplica", confianza: 0.9 },
};

function poliza(lista: string[], valorIndeterminado: boolean, esOtrosi: boolean): Poliza {
  const c = clausula(lista, "GARANT|P[OÓ]LIZA|POLIZA", esOtrosi);
  if (!c) return SIN_POLIZA;
  // En un contrato marco, la póliza atada a órdenes de servicio futuras no obliga al firmar.
  if (valorIndeterminado && /orden\s+de\s+servicio|cuyo\s+valor\s+supere|para\s+cada\s+orden/i.test(c)) {
    return { ...SIN_POLIZA, requiere_poliza: { valor: false, confianza: 0.85 }, estado_poliza: { valor: "no_aplica", confianza: 0.85 } };
  }
  const tipos = [...c.matchAll(/p[oó]liza\s+de\s+([a-záéíóú ]+?)(?=\s+por|\s+del|\s+y|,|$)/gi)]
    .map((m) => (m[1] ?? "").trim()).filter((t) => t !== "");
  const tipo: Campo<string> = tipos.length
    ? { valor: tipos.map((t) => t.replace(/\s+/g, "_")).join(";"), confianza: 0.9 }
    : { valor: esOtrosi ? "" : "cumplimiento", confianza: 0.7, nota: "el contrato exige garantías pero no nombra el tipo de póliza; se asumió cumplimiento" };
  return { requiere_poliza: { valor: true, confianza: 0.95 }, tipo_poliza: tipo, estado_poliza: { valor: "pendiente", confianza: 0.85 } };
}

// ── Ensamble ─────────────────────────────────────────────────────────────────

type Meta = Pick<ContratoExtraido, "mensaje_id" | "remitente_email" | "remitente_registrado" | "comercial_resuelto" | "adjunto" | "tiene_contrato" | "es_otrosi" | "comercial">;

function sinContrato(meta: Meta): ContratoExtraido {
  return {
    ...meta,
    id_contrato: nulo(), cliente: nulo(), nit_cliente: nulo(), pais: nulo(), objeto: nulo(),
    valor: nulo(), moneda: nulo(), fecha_inicio: nulo(), fecha_fin: nulo(),
    requiere_poliza: { valor: false, confianza: 0 }, tipo_poliza: { valor: "", confianza: 0 },
    estado_poliza: nulo(), valor_indeterminado: { valor: false, confianza: 0 },
  };
}

function metadatos(ctx: Ctx, mensaje_id: string): Meta {
  const correo = readCorreo(ctx, mensaje_id);
  const hit = readComerciales(ctx).find((c) => c.email.toLowerCase() === (correo.de ?? "").toLowerCase());
  const adjuntos = correo.adjuntos ?? [];
  const contrato = adjuntos.find((a) => /contrato|otros[ií]/i.test(a)) ?? null;
  return {
    mensaje_id,
    remitente_email: correo.de ?? "",
    remitente_registrado: !!hit,
    comercial_resuelto: hit?.nombre ?? null,
    comercial: hit ? { valor: hit.nombre, confianza: 0.95 } : { valor: null, confianza: 0.3 },
    adjunto: contrato ?? adjuntos[0] ?? "",
    tiene_contrato: !!contrato,
    es_otrosi: false,
  };
}

export async function extraerContrato(ctx: Ctx, mensaje_id: string): Promise<ContratoExtraido> {
  const meta = metadatos(ctx, mensaje_id);
  if (!meta.tiene_contrato) return sinContrato(meta);

  const texto = await leerAdjunto(ctx, mensaje_id, meta.adjunto);
  if (texto.trim() === "") throw new Error(`el adjunto ${meta.adjunto} de ${mensaje_id} está vacío o no tiene texto`);
  const es_otrosi = /otros[ií]/i.test(meta.adjunto) || /^\s*OTROS[IÍ]/i.test(texto);
  const lista = clausulas(texto);
  const nit = nitCliente(texto);
  const v = valorYMoneda(lista, texto, es_otrosi);

  return {
    ...meta,
    es_otrosi,
    id_contrato: idContrato(texto),
    cliente: cliente(texto),
    nit_cliente: nit,
    pais: pais(nit.valor ?? "", v.moneda.valor, texto),
    objeto: objeto(lista, es_otrosi),
    ...v,
    ...plazo(lista, texto, es_otrosi),
    ...poliza(lista, v.valor_indeterminado.valor, es_otrosi),
  };
}
