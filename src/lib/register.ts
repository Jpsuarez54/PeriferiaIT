// Registro/archivado en el maestro simulado de SharePoint.
import path from "node:path";
import type { Ctx, ContratoExtraido, ResultadoRegistro, FilaMaestro, Clasificacion, Cambio, EstadoPoliza } from "./types";
import { readMaestro, writeMaestro, appendHistorial, markProcesado, copyAttachment, outPath } from "./io";
import { validar } from "./validate";
import { slugify, todayISO, nowIso } from "./util";

function autoId(maestro: FilaMaestro[], año: string): string {
  let seq = 1;
  for (const r of maestro) if (r.id_contrato.startsWith(`AUTO-${año}-`)) seq = Math.max(seq, Number(r.id_contrato.split("-")[2] ?? "0") + 1);
  return `AUTO-${año}-${String(seq).padStart(3, "0")}`;
}

function comercialFinal(c: ContratoExtraido): string {
  return c.comercial.valor ?? `No registrado (${c.remitente_email})`;
}

export function registrar(
  ctx: Ctx, mensaje_id: string, c: ContratoExtraido, confirmado: boolean
): { ok: true; data: ResultadoRegistro } | { ok: false; error: string } {
  const v = validar(ctx, mensaje_id, c);

  if (v.clasificacion === "rechazado") {
    const motivo = v.motivo_rechazo ?? "motivo no especificado";
    markProcesado(ctx, mensaje_id, "rechazado", nowIso());
    return { ok: true, data: { id_contrato: "", accion: "rechazado", ruta_archivo: "", motivo } };
  }
  if (v.clasificacion === "duplicado") {
    markProcesado(ctx, mensaje_id, "duplicado", nowIso());
    appendHistorial(ctx, { ts: nowIso(), id_contrato: v.id_contrato_existente, accion: "duplicado", cambios: null, mensaje_id });
    return { ok: true, data: { id_contrato: v.id_contrato_existente ?? c.id_contrato.valor ?? "", accion: "duplicado", ruta_archivo: "" } };
  }

  if (v.requiere_revision.length > 0 && !confirmado) {
    return { ok: false, error: `requiere revisión: ${v.requiere_revision.join(", ")}` };
  }

  const maestro = readMaestro(ctx);

  if (v.clasificacion === "actualizacion") {
    const idx = maestro.findIndex((r) => r.id_contrato === v.id_contrato_existente);
    const fila = maestro[idx];
    if (!fila) return { ok: false, error: "contrato a actualizar no encontrado en el maestro" };
    const antes = { ...fila };
    if (c.fecha_fin.valor) fila.fecha_fin = c.fecha_fin.valor;
    if (c.fecha_inicio.valor) fila.fecha_inicio = c.fecha_inicio.valor;
    if (c.valor.valor != null) fila.valor = c.valor.valor;
    if (c.moneda.valor) fila.moneda = c.moneda.valor;
    if (c.estado_poliza.valor) fila.estado_poliza = c.estado_poliza.valor;
    const cambios: Record<string, Cambio> = {};
    for (const k of ["fecha_inicio", "fecha_fin", "valor", "moneda", "estado_poliza"] as (keyof FilaMaestro)[]) {
      const a = String(antes[k]); const b = String(fila[k]);
      if (a !== b) cambios[k] = { antes: a, despues: b };
    }
    writeMaestro(ctx, maestro);
    appendHistorial(ctx, { ts: nowIso(), id_contrato: fila.id_contrato, accion: "actualizacion", cambios, mensaje_id });
    markProcesado(ctx, mensaje_id, "actualizacion", nowIso());
    return { ok: true, data: { id_contrato: fila.id_contrato, accion: "actualizacion", ruta_archivo: fila.ruta_sharepoint, cambios } };
  }

  // nuevo
  const año = (c.fecha_inicio.valor ?? "").slice(0, 4) || String(new Date().getFullYear());
  const id = c.id_contrato.valor || autoId(maestro, año);
  const slug = slugify(c.cliente.valor ?? "cliente");
  const ext = c.adjunto.split(".").pop() ?? "txt";
  const ruta = `Contratos/${año}/${slug}/${id}.${ext}`;
  const estado: EstadoPoliza = c.estado_poliza.valor ?? (c.requiere_poliza.valor ? "pendiente" : "no_aplica");

  const fila: FilaMaestro = {
    id_contrato: id,
    cliente: c.cliente.valor ?? "",
    nit_cliente: c.nit_cliente.valor ?? "",
    pais: c.pais.valor ?? "CO",
    objeto: (c.objeto.valor ?? "").slice(0, 200),
    valor: c.valor.valor ?? 0,
    moneda: c.moneda.valor ?? "COP",
    fecha_inicio: c.fecha_inicio.valor ?? "",
    fecha_fin: c.fecha_fin.valor ?? "",
    requiere_poliza: c.requiere_poliza.valor,
    tipo_poliza: c.tipo_poliza.valor ?? "",
    estado_poliza: estado,
    comercial: comercialFinal(c),
    ruta_sharepoint: ruta,
    fecha_registro: todayISO(),
    fuente: "buzon",
  };

  copyAttachment(ctx, mensaje_id, c.adjunto, outPath(ctx, `sharepoint/${ruta}`));
  maestro.push(fila);
  writeMaestro(ctx, maestro);
  appendHistorial(ctx, { ts: nowIso(), id_contrato: id, accion: "nuevo", cambios: null, mensaje_id });
  markProcesado(ctx, mensaje_id, "nuevo", nowIso());
  return { ok: true, data: { id_contrato: id, accion: "nuevo", ruta_archivo: ruta } };
}

export type { Clasificacion };
