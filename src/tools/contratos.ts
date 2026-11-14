// Herramientas del agente. Cada export es { description, args, execute } y el modelo la ve
// como "contratos_<export>". `args` es un objeto de esquemas zod con .describe() por campo.
// execute(args, ctx) valida los argumentos y devuelve JSON {ok,data} | {ok,error}. Nunca lanza.
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Ctx, ContratoExtraido, Campo } from "../lib/types";
import * as Ext from "../lib/extract";
import * as Val from "../lib/validate";
import * as Reg from "../lib/register";
import * as Ale from "../lib/alertas";
import { resumenBuzon, appendLog, leerTexto } from "../lib/io";
import { nowIso, esFechaISO } from "../lib/util";

type Shape = Record<string, z.ZodTypeAny>;

function mensajeDe(raw: unknown): string | null {
  const v = raw && typeof raw === "object" ? (raw as { mensaje_id?: unknown }).mensaje_id : undefined;
  return typeof v === "string" ? v : null;
}

function resumenDe(data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.clasificacion === "string") return d.clasificacion;
    if (typeof d.accion === "string") return d.accion;
    if (Array.isArray(d.mensajes)) return `${d.mensajes.length} mensajes`;
    if (Array.isArray(d.vencen)) return "alertas";
  }
  return "ok";
}

// Valida los argumentos, ejecuta y registra en out/log.jsonl (RN7). Convierte todo error en {ok:false}.
async function run<S extends Shape>(
  ctx: Ctx, herramienta: string, shape: S, raw: unknown, fn: (a: z.infer<z.ZodObject<S>>) => unknown,
): Promise<string> {
  const mensaje_id = mensajeDe(raw);
  const log = (ok: boolean, resumen: string) => appendLog(ctx, { ts: nowIso(), herramienta, mensaje_id, ok, resumen });
  const p = z.object(shape).safeParse(raw ?? {});
  if (!p.success) {
    const error = `argumentos inválidos: ${p.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`;
    log(false, error);
    return JSON.stringify({ ok: false, error });
  }
  try {
    const data = await fn(p.data);
    log(true, resumenDe(data));
    return JSON.stringify({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(false, error);
    return JSON.stringify({ ok: false, error });
  }
}

const mensajeId = z.string().regex(/^msg-[A-Za-z0-9_-]+$/, "use un id de mensaje, p.ej. msg-001").describe("Id del mensaje del buzón, p.ej. msg-001");
const fechaISO = z.string().refine(esFechaISO, "fecha inválida, use YYYY-MM-DD con una fecha que exista");

// `contrato` es opcional y no se declara al modelo: si no viene, la herramienta re-extrae del
// documento. Así el modelo nunca transporta valores del contrato (CA2). demo.ts sí lo usa.
const contrato = z.record(z.string(), z.unknown()).optional().describe("Contrato extraído (salida de contratos_extraer). Si se omite, se re-extrae del documento.");

const correccionesShape = {
  cliente: z.string().min(2).max(200).optional().describe("Razón social del cliente"),
  nit_cliente: z.string().regex(/^\d{6,15}$/, "solo dígitos, sin puntos ni dígito de verificación").optional().describe("NIT o RUC sin puntos ni dígito de verificación"),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).optional().describe("País del cliente"),
  objeto: z.string().min(3).max(200).optional().describe("Objeto del contrato"),
  valor: z.number().nonnegative().optional().describe("Valor confirmado, sin separadores; 0 si es por demanda"),
  moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]).optional().describe("Moneda confirmada"),
  fecha_inicio: fechaISO.optional().describe("Fecha de inicio confirmada, YYYY-MM-DD"),
  fecha_fin: fechaISO.optional().describe("Fecha de fin confirmada, YYYY-MM-DD"),
};
const correcciones = z.object(correccionesShape).optional().describe("Valores que el usuario dio explícitamente al confirmar. Solo con confirmado=true.");
type Correcciones = z.infer<typeof correcciones>;

async function contratoDe(ctx: Ctx, mensaje_id: string, raw: Record<string, unknown> | undefined): Promise<ContratoExtraido> {
  return (raw as ContratoExtraido | undefined) ?? Ext.extraerContrato(ctx, mensaje_id);
}

function aplicarCorrecciones(c: ContratoExtraido, k: Correcciones): ContratoExtraido {
  if (!k) return c;
  const out: ContratoExtraido = { ...c };
  const fijar = <T>(valor: T): Campo<T> => ({ valor, confianza: 1, nota: "confirmado por el usuario" });
  if (k.cliente !== undefined) out.cliente = fijar(k.cliente);
  if (k.nit_cliente !== undefined) out.nit_cliente = fijar(k.nit_cliente);
  if (k.pais !== undefined) out.pais = fijar(k.pais);
  if (k.objeto !== undefined) out.objeto = fijar(k.objeto);
  if (k.valor !== undefined) out.valor = fijar(k.valor);
  if (k.moneda !== undefined) out.moneda = fijar(k.moneda);
  if (k.fecha_inicio !== undefined) out.fecha_inicio = fijar(k.fecha_inicio);
  if (k.fecha_fin !== undefined) out.fecha_fin = fijar(k.fecha_fin);
  return out;
}

// Carpetas que contratos_leer_pdf puede leer. Fuera de ellas no hay nada que el agente necesite.
const LECTURA_PERMITIDA = ["out/sharepoint", "fixtures/reto-02/buzon"];

function rutaSegura(ctx: Ctx, ruta: string): string {
  if (path.isAbsolute(ruta) || /^[a-zA-Z]:/.test(ruta)) throw new Error("ruta absoluta no permitida; use una ruta relativa al proyecto");
  const abs = path.resolve(ctx.directory, ruta);
  const permitida = LECTURA_PERMITIDA.some((d) => {
    const base = path.resolve(ctx.directory, d);
    return abs === base || abs.startsWith(base + path.sep);
  });
  if (!permitida) throw new Error(`solo se pueden leer archivos dentro de ${LECTURA_PERMITIDA.join(" o ")}`);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no existe el archivo ${ruta}`);
  return abs;
}

const leerBuzonArgs = {};
export const leer_buzon = {
  description: "Lista los mensajes del buzón pendientes de procesar, con id, remitente, asunto, fecha, adjuntos y si trae contrato.",
  args: leerBuzonArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_leer_buzon", leerBuzonArgs, args, () => ({ mensajes: resumenBuzon(ctx) }));
  },
};

const extraerArgs = { mensaje_id: mensajeId };
export const extraer = {
  description: "Extrae los datos estructurados del contrato de un mensaje, con nivel de confianza por campo en [0,1].",
  args: extraerArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_extraer", extraerArgs, args, (a) => Ext.extraerContrato(ctx, a.mensaje_id));
  },
};

const validarArgs = { mensaje_id: mensajeId, contrato };
export const validar = {
  description: "Clasifica el contrato de un mensaje en nuevo, actualizacion, duplicado o rechazado, con su id, cliente y los campos que requieren revisión humana.",
  args: validarArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_validar", validarArgs, args, async (a) => Val.validar(ctx, a.mensaje_id, await contratoDe(ctx, a.mensaje_id, a.contrato)));
  },
};

const registrarArgs = {
  mensaje_id: mensajeId,
  contrato,
  confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión de este mensaje"),
  correcciones,
};
export const registrar = {
  description: "Registra el contrato de un mensaje en el maestro y archiva el documento; sin confirmado=true rechaza los que tienen campos en revisión.",
  args: registrarArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_registrar", registrarArgs, args, async (a) => {
      if (a.correcciones && Object.keys(a.correcciones).length > 0 && a.confirmado !== true) {
        throw new Error("las correcciones requieren confirmado=true");
      }
      const c = aplicarCorrecciones(await contratoDe(ctx, a.mensaje_id, a.contrato), a.correcciones);
      const res = Reg.registrar(ctx, a.mensaje_id, c, a.confirmado === true);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    });
  },
};

const alertasArgs = { hoy: fechaISO.describe("Fecha de referencia del reporte, YYYY-MM-DD") };
export const alertas = {
  description: "Genera out/alertas.md con los contratos que vencen en 60 días o menos, las pólizas pendientes y los registrados desde el corte del 2026-05-30.",
  args: alertasArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_alertas", alertasArgs, args, (a) => Ale.alertas(ctx, a.hoy));
  },
};

const leerPdfArgs = { ruta: z.string().min(1).describe("Ruta relativa dentro de out/sharepoint o fixtures/reto-02/buzon, p.ej. out/sharepoint/Contratos/2026/industrias-delta/CT-2026-015.txt") };
export const leer_pdf = {
  description: "Lee el texto de un contrato archivado o de un adjunto del buzón, en PDF con texto o texto plano (solo rutas relativas dentro de out/sharepoint o del buzón).",
  args: leerPdfArgs,
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_leer_pdf", leerPdfArgs, args, async (a) => ({ ruta: a.ruta, texto: await leerTexto(rutaSegura(ctx, a.ruta)) }));
  },
};
