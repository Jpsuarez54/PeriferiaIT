// Clasificación (nuevo/actualizacion/duplicado/rechazado) y revisión humana.
import type { Ctx, ContratoExtraido, ResultadoValidacion, Campo, FilaMaestro, Cambio } from "./types";
import { readMaestro } from "./io";
import { similitud } from "./util";

const REVISABLE: (keyof ContratoExtraido)[] = [
  "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
];

// Campos que requieren revisión: con valor presente y confianza < 0.8 (excluye comercial y sistema).
export function requiereRevision(c: ContratoExtraido): string[] {
  const out: string[] = [];
  for (const k of REVISABLE) {
    const campo = c[k] as Campo<unknown>;
    if (campo && campo.valor != null && campo.valor !== "" && campo.confianza < 0.8) out.push(k);
  }
  return out;
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

export function validar(ctx: Ctx, mensaje_id: string, c: ContratoExtraido): ResultadoValidacion {
  const meta = {
    remitente_registrado: c.remitente_registrado,
    remitente_email: c.remitente_email,
    comercial_resuelto: c.comercial_resuelto,
    es_otrosi: c.es_otrosi,
  };

  if (!c.tiene_contrato) {
    return { clasificacion: "rechazado", requiere_revision: [], motivo_rechazo: "sin adjunto de contrato", ...meta };
  }

  // RN4: texto sin partes ni objeto identificables.
  if (!c.es_otrosi && !c.cliente.valor && !c.objeto.valor) {
    return { clasificacion: "rechazado", requiere_revision: [], motivo_rechazo: "texto sin partes ni objeto identificables", ...meta };
  }

  const maestro = readMaestro(ctx);

  // Otrosí: actualización del contrato referenciado.
  if (c.es_otrosi) {
    const exist = maestro.find((r) => r.id_contrato === c.id_contrato.valor);
    if (exist) {
      return {
        clasificacion: "actualizacion", id_contrato_existente: exist.id_contrato,
        requiere_revision: requiereRevision(c), diferencias: diferencias(exist, c), ...meta,
      };
    }
    return {
      clasificacion: "rechazado", requiere_revision: [],
      motivo_rechazo: "otrosí sin contrato referenciado en el maestro", ...meta,
    };
  }

  // Por id_contrato
  const exist = maestro.find((r) => r.id_contrato === c.id_contrato.valor);
  if (exist) {
    const mismo =
      Number(exist.valor) === Number(c.valor.valor ?? exist.valor) &&
      exist.fecha_inicio === (c.fecha_inicio.valor ?? exist.fecha_inicio) &&
      exist.fecha_fin === (c.fecha_fin.valor ?? exist.fecha_fin);
    if (mismo) {
      return { clasificacion: "duplicado", id_contrato_existente: exist.id_contrato, requiere_revision: [], ...meta };
    }
    return {
      clasificacion: "actualizacion", id_contrato_existente: exist.id_contrato,
      requiere_revision: requiereRevision(c), diferencias: diferencias(exist, c), ...meta,
    };
  }

  // Por nit + objeto (similitud >= 0.9) -> actualización
  const nit = c.nit_cliente.valor ?? "";
  const obj = c.objeto.valor ?? "";
  if (nit && obj) {
    for (const r of maestro) {
      if (r.nit_cliente === nit && similitud(r.objeto, obj) >= 0.9) {
        return {
          clasificacion: "actualizacion", id_contrato_existente: r.id_contrato,
          requiere_revision: requiereRevision(c), diferencias: diferencias(r, c), ...meta,
        };
      }
    }
  }

  return { clasificacion: "nuevo", requiere_revision: requiereRevision(c), ...meta };
}
