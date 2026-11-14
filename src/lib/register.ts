// Registro y archivado en el maestro simulado de SharePoint.
import { existsSync } from "node:fs";
import type { Ctx, ContratoExtraido, ResultadoRegistro, FilaMaestro, Cambio, EstadoPoliza, Pais, Moneda } from "./types";
import { readMaestro, writeMaestro, appendHistorial, markProcesado, copyAttachment, outPath } from "./io";
import { validar, OBLIGATORIOS_NUEVO } from "./validate";
import { slugify, todayISO, nowIso } from "./util";

type Resultado = { ok: true; data: ResultadoRegistro } | { ok: false; error: string };

function autoId(maestro: FilaMaestro[], año: string): string {
  let seq = 1;
  for (const r of maestro) if (r.id_contrato.startsWith(`AUTO-${año}-`)) seq = Math.max(seq, Number(r.id_contrato.split("-")[2] ?? "0") + 1);
  return `AUTO-${año}-${String(seq).padStart(3, "0")}`;
}

function extension(adjunto: string): string {
  return adjunto.includes(".") ? (adjunto.split(".").pop() ?? "txt") : "txt";
}

// Ruta libre para archivar un otrosí junto al contrato: <id>-otrosi-<n>.<ext>
function rutaOtrosi(ctx: Ctx, fila: FilaMaestro, ext: string): string {
  const año = fila.fecha_inicio.slice(0, 4) || "sin-fecha";
  const dir = `Contratos/${año}/${slugify(fila.cliente)}`;
  for (let n = 1; ; n++) {
    const ruta = `${dir}/${fila.id_contrato}-otrosi-${n}.${ext}`;
    if (!existsSync(outPath(ctx, `sharepoint/${ruta}`))) return ruta;
  }
}

export function registrar(ctx: Ctx, mensaje_id: string, c: ContratoExtraido, confirmado: boolean): Resultado {
  const v = validar(ctx, mensaje_id, c);

  if (v.clasificacion === "rechazado") {
    markProcesado(ctx, mensaje_id, "rechazado", nowIso());
    return { ok: true, data: { id_contrato: "", accion: "rechazado", ruta_archivo: "", motivo: v.motivo_rechazo ?? "motivo no especificado" } };
  }
  // RN1: no se escribe nada en el maestro ni en el historial; solo se marca el mensaje como leído.
  if (v.clasificacion === "duplicado") {
    markProcesado(ctx, mensaje_id, "duplicado", nowIso());
    return { ok: true, data: { id_contrato: v.id_contrato_existente ?? "", accion: "duplicado", ruta_archivo: "" } };
  }
  if (v.requiere_revision.length > 0 && !confirmado) {
    return { ok: false, error: `requiere revisión: ${v.requiere_revision.join(", ")}` };
  }
  return v.clasificacion === "actualizacion"
    ? actualizar(ctx, mensaje_id, c, v.id_contrato_existente ?? "")
    : insertar(ctx, mensaje_id, c);
}

function actualizar(ctx: Ctx, mensaje_id: string, c: ContratoExtraido, id: string): Resultado {
  const maestro = readMaestro(ctx);
  const fila = maestro.find((r) => r.id_contrato === id);
  if (!fila) return { ok: false, error: `el contrato ${id} no está en el maestro` };
  const antes = { ...fila };
  if (c.fecha_fin.valor) fila.fecha_fin = c.fecha_fin.valor;
  if (c.fecha_inicio.valor) fila.fecha_inicio = c.fecha_inicio.valor;
  if (c.valor.valor != null) fila.valor = c.valor.valor;
  if (c.moneda.valor) fila.moneda = c.moneda.valor;
  if (c.estado_poliza.valor) fila.estado_poliza = c.estado_poliza.valor;
  const cambios: Record<string, Cambio> = {};
  for (const k of ["fecha_inicio", "fecha_fin", "valor", "moneda", "estado_poliza"] as const) {
    if (String(antes[k]) !== String(fila[k])) cambios[k] = { antes: String(antes[k]), despues: String(fila[k]) };
  }
  // El documento que trae el cambio (otrosí) se archiva junto al contrato; la fila conserva
  // la ruta del contrato original y el historial guarda la del otrosí.
  const documento = rutaOtrosi(ctx, fila, extension(c.adjunto));
  copyAttachment(ctx, mensaje_id, c.adjunto, outPath(ctx, `sharepoint/${documento}`));
  writeMaestro(ctx, maestro);
  appendHistorial(ctx, { ts: nowIso(), id_contrato: fila.id_contrato, accion: "actualizacion", cambios, mensaje_id, documento });
  markProcesado(ctx, mensaje_id, "actualizacion", nowIso());
  return { ok: true, data: { id_contrato: fila.id_contrato, accion: "actualizacion", ruta_archivo: documento, cambios } };
}

function insertar(ctx: Ctx, mensaje_id: string, c: ContratoExtraido): Resultado {
  // Aun confirmado, no se inventan datos: lo que falte debe llegar en `correcciones`.
  const faltan = OBLIGATORIOS_NUEVO.filter((k) => {
    const valor = (c[k] as { valor: unknown }).valor;
    return valor == null || valor === "";
  });
  if (faltan.length) return { ok: false, error: `faltan datos obligatorios: ${faltan.join(", ")}; envíalos en correcciones` };

  const maestro = readMaestro(ctx);
  const fecha_inicio = c.fecha_inicio.valor as string;
  const año = fecha_inicio.slice(0, 4);
  const id = c.id_contrato.valor || autoId(maestro, año);
  const cliente = c.cliente.valor as string;
  const ruta = `Contratos/${año}/${slugify(cliente)}/${id}.${extension(c.adjunto)}`;
  const estado: EstadoPoliza = c.estado_poliza.valor ?? (c.requiere_poliza.valor ? "pendiente" : "no_aplica");

  const fila: FilaMaestro = {
    id_contrato: id,
    cliente,
    nit_cliente: c.nit_cliente.valor as string,
    pais: c.pais.valor as Pais,
    objeto: (c.objeto.valor as string).slice(0, 200),
    valor: c.valor.valor as number,
    moneda: c.moneda.valor as Moneda,
    fecha_inicio,
    fecha_fin: c.fecha_fin.valor as string,
    requiere_poliza: c.requiere_poliza.valor,
    tipo_poliza: c.requiere_poliza.valor ? c.tipo_poliza.valor : "",
    estado_poliza: estado,
    comercial: c.comercial.valor ?? `No registrado (${c.remitente_email})`,
    ruta_sharepoint: ruta,
    fecha_registro: todayISO(),
    fuente: "buzon",
  };

  copyAttachment(ctx, mensaje_id, c.adjunto, outPath(ctx, `sharepoint/${ruta}`));
  maestro.push(fila);
  writeMaestro(ctx, maestro);
  appendHistorial(ctx, { ts: nowIso(), id_contrato: id, accion: "nuevo", cambios: null, mensaje_id, documento: ruta });
  markProcesado(ctx, mensaje_id, "nuevo", nowIso());
  return { ok: true, data: { id_contrato: id, accion: "nuevo", ruta_archivo: ruta } };
}
