// Clasificación (nuevo/actualizacion/duplicado/rechazado) y revisión humana.
import type { Ctx, ContratoExtraido, ResultadoValidacion, Campo, CampoRevision, FilaMaestro, Cambio, Clasificacion } from "./types";
import { readMaestro } from "./io";
import { similitud } from "./util";

const REVISABLE: (keyof ContratoExtraido)[] = [
  "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
];

// Campos sin los cuales una fila nueva del maestro quedaría incompleta.
export const OBLIGATORIOS_NUEVO: (keyof ContratoExtraido)[] = [
  "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
];

type Notas = Record<string, string>;

// Campos a revisar: con valor y confianza < 0.8, y (si es nuevo) los obligatorios ausentes.
// Los ausentes nunca se rellenan con un valor por defecto: los da el humano al confirmar.
function revision(c: ContratoExtraido, clasificacion: Clasificacion, conflictos: Notas): { campos: string[]; notas: Notas } {
  const notas: Notas = { ...conflictos };
  for (const k of REVISABLE) {
    const campo = c[k] as Campo<unknown>;
    if (campo.valor != null && campo.valor !== "" && campo.confianza < 0.8) notas[k] ??= campo.nota ?? "confianza baja en la extracción";
  }
  if (clasificacion === "nuevo") {
    for (const k of OBLIGATORIOS_NUEVO) {
      const campo = c[k] as Campo<unknown>;
      if (campo.valor == null || campo.valor === "") notas[k] ??= "no se encontró en el documento; indica el valor al confirmar";
    }
  }
  return { campos: Object.keys(notas), notas };
}

// Conflictos con la fila existente: el documento dice otra cosa sobre la identidad del contrato.
function conflictosCon(exist: FilaMaestro, c: ContratoExtraido): Notas {
  const n: Notas = {};
  if (c.nit_cliente.valor && c.nit_cliente.valor !== exist.nit_cliente) {
    n.nit_cliente = `conflicto con el maestro: el documento trae NIT ${c.nit_cliente.valor} y el maestro tiene ${exist.nit_cliente} para ${exist.id_contrato}`;
  }
  if (c.moneda.valor && c.moneda.valor !== exist.moneda) {
    n.moneda = `conflicto con el maestro: el documento está en ${c.moneda.valor} y el maestro en ${exist.moneda}`;
  }
  return n;
}

// Diferencias para una actualización (campos que el nuevo trae y cambian respecto al existente).
function diferencias(exist: FilaMaestro, c: ContratoExtraido): Record<string, Cambio> {
  const d: Record<string, Cambio> = {};
  const set = (k: string, antes: string, despues: string | null | undefined) => {
    if (despues != null && String(despues) !== String(antes)) d[k] = { antes: String(antes), despues: String(despues) };
  };
  set("fecha_fin", exist.fecha_fin, c.fecha_fin.valor);
  set("valor", String(exist.valor), c.valor.valor != null ? String(c.valor.valor) : null);
  set("moneda", exist.moneda, c.moneda.valor);
  set("estado_poliza", exist.estado_poliza, c.estado_poliza.valor);
  set("fecha_inicio", exist.fecha_inicio, c.fecha_inicio.valor);
  return d;
}

// Resultado completo: además de la clasificación, los datos que el agente necesita citar
// (id, cliente y detalle de cada campo en revisión), para que nunca tenga que suponerlos (CA2).
export function validar(ctx: Ctx, mensaje_id: string, c: ContratoExtraido): ResultadoValidacion {
  const { base, conflictos } = clasificar(ctx, c);
  const { campos, notas } = base.clasificacion === "rechazado" || base.clasificacion === "duplicado"
    ? { campos: [], notas: {} }
    : revision(c, base.clasificacion, conflictos);
  const campos_revision: CampoRevision[] = campos.map((k) => {
    const campo = c[k as keyof ContratoExtraido] as Campo<CampoRevision["valor"]>;
    return { campo: k, valor: campo.valor ?? null, confianza: campo.confianza, nota: notas[k] ?? "" };
  });
  return { ...base, requiere_revision: campos, id_contrato: c.id_contrato.valor, cliente: c.cliente.valor, campos_revision, mensaje_id };
}

function clasificar(ctx: Ctx, c: ContratoExtraido): { base: ResultadoValidacion; conflictos: Notas } {
  const meta = {
    requiere_revision: [] as string[],
    remitente_registrado: c.remitente_registrado,
    remitente_email: c.remitente_email,
    comercial_resuelto: c.comercial_resuelto,
    es_otrosi: c.es_otrosi,
  };
  const sin = (base: ResultadoValidacion) => ({ base, conflictos: {} });

  if (!c.tiene_contrato) return sin({ clasificacion: "rechazado", motivo_rechazo: "sin adjunto de contrato", ...meta });

  // RN4: texto sin partes ni objeto identificables.
  if (!c.es_otrosi && !c.cliente.valor && !c.objeto.valor) {
    return sin({ clasificacion: "rechazado", motivo_rechazo: "texto sin partes ni objeto identificables", ...meta });
  }

  const maestro = readMaestro(ctx);
  const porId = maestro.find((r) => r.id_contrato === c.id_contrato.valor);

  // Otrosí: actualización del contrato referenciado.
  if (c.es_otrosi) {
    if (!porId) return sin({ clasificacion: "rechazado", motivo_rechazo: "otrosí sin contrato referenciado en el maestro", ...meta });
    return {
      base: { clasificacion: "actualizacion", id_contrato_existente: porId.id_contrato, diferencias: diferencias(porId, c), ...meta },
      conflictos: conflictosCon(porId, c),
    };
  }

  if (porId) {
    const mismo =
      Number(porId.valor) === Number(c.valor.valor ?? porId.valor) &&
      porId.fecha_inicio === (c.fecha_inicio.valor ?? porId.fecha_inicio) &&
      porId.fecha_fin === (c.fecha_fin.valor ?? porId.fecha_fin);
    const conflictos = conflictosCon(porId, c);
    // RN1 solo si no hay conflicto: un mismo id con otro NIT no es un reenvío, hay que revisarlo.
    if (mismo && Object.keys(conflictos).length === 0) {
      return sin({ clasificacion: "duplicado", id_contrato_existente: porId.id_contrato, ...meta });
    }
    return {
      base: { clasificacion: "actualizacion", id_contrato_existente: porId.id_contrato, diferencias: diferencias(porId, c), ...meta },
      conflictos,
    };
  }

  // RN2 por NIT + objeto (similitud >= 0.9).
  const nit = c.nit_cliente.valor ?? "";
  const obj = c.objeto.valor ?? "";
  const similar = nit && obj ? maestro.find((r) => r.nit_cliente === nit && similitud(r.objeto, obj) >= 0.9) : undefined;
  if (similar) {
    return sin({ clasificacion: "actualizacion", id_contrato_existente: similar.id_contrato, diferencias: diferencias(similar, c), ...meta });
  }

  return sin({ clasificacion: "nuevo", ...meta });
}
