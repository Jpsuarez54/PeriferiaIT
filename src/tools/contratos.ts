// Herramientas tipadas con zod. Cada export -> nombre "contratos_<export>".
// execute(args, ctx) devuelve JSON serializado {ok,data} | {ok,error}. Nunca lanza.
import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Ctx, ContratoExtraido, MensajeBuzon, ResultadoAlertas, ResultadoRegistro, ResultadoValidacion } from "../lib/types";
import * as Ext from "../lib/extract";
import * as Val from "../lib/validate";
import * as Reg from "../lib/register";
import * as Ale from "../lib/alertas";
import { resumenBuzon, appendLog } from "../lib/io";
import { nowIso } from "../lib/util";

async function run<T>(ctx: Ctx, herramienta: string, mensaje_id: string | undefined, fn: () => T | Promise<T>): Promise<string> {
  try {
    const data = await fn();
    appendLog(ctx, { ts: nowIso(), herramienta, mensaje_id: mensaje_id ?? null, ok: true, resumen: resumenDe(data) });
    return JSON.stringify({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    appendLog(ctx, { ts: nowIso(), herramienta, mensaje_id: mensaje_id ?? null, ok: false, resumen: error });
    return JSON.stringify({ ok: false, error });
  }
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

// `contrato` es opcional: si no viene, la herramienta re-extrae del documento.
// Así el modelo nunca transporta valores (CA2): solo pasa mensaje_id.
const contratoSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Contrato extraído (salida de contratos_extraer). Si se omite, se re-extrae del documento.");

const fechaISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha inválida, use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, "fecha inválida");

const correccionesSchema = z
  .object({
    valor: z.number().nonnegative().optional().describe("Valor confirmado por el humano, sin separadores"),
    moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]).optional().describe("Moneda confirmada"),
    fecha_inicio: fechaISO.optional().describe("Fecha de inicio confirmada YYYY-MM-DD"),
    fecha_fin: fechaISO.optional().describe("Fecha de fin confirmada YYYY-MM-DD"),
  })
  .optional()
  .describe("Valores que el humano dio explícitamente al confirmar. Solo con confirmado=true.");

function contratoDe(ctx: Ctx, mensaje_id: string, raw: unknown): ContratoExtraido {
  return (raw as ContratoExtraido | undefined) ?? Ext.extraerContrato(ctx, mensaje_id);
}

type Correcciones = z.infer<typeof correccionesSchema>;
function aplicarCorrecciones(c: ContratoExtraido, k: Correcciones): ContratoExtraido {
  if (!k) return c;
  const out = { ...c };
  if (k.valor !== undefined) out.valor = { valor: k.valor, confianza: 1 };
  if (k.moneda !== undefined) out.moneda = { valor: k.moneda, confianza: 1 };
  if (k.fecha_inicio !== undefined) out.fecha_inicio = { valor: k.fecha_inicio, confianza: 1 };
  if (k.fecha_fin !== undefined) out.fecha_fin = { valor: k.fecha_fin, confianza: 1 };
  return out;
}

export const leer_buzon = {
  description: "Lista los mensajes del buzón pendientes de procesar, con id, remitente, asunto, fecha, adjuntos y si trae contrato.",
  args: z.object({}).describe("Sin argumentos."),
  async execute(_args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    return run(ctx, "contratos_leer_buzon", undefined, async () => {
      const mensajes: MensajeBuzon[] = resumenBuzon(ctx);
      return { mensajes };
    });
  },
} as const;

export const extraer = {
  description: "Extrae los datos estructurados del contrato de un mensaje, con nivel de confianza por campo en [0,1].",
  args: z.object({ mensaje_id: z.string().describe("Id del mensaje, p.ej. msg-001") }),
  async execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    const mensaje_id = String(args.mensaje_id ?? "");
    return run(ctx, "contratos_extraer", mensaje_id, async () => {
      const contrato: ContratoExtraido = Ext.extraerContrato(ctx, mensaje_id);
      return { contrato };
    });
  },
} as const;

export const validar = {
  description: "Clasifica el contrato en nuevo/actualizacion/duplicado/rechazado y lista los campos que requieren revisión humana.",
  args: z.object({ mensaje_id: z.string().describe("Id del mensaje"), contrato: contratoSchema }),
  async execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    const mensaje_id = String(args.mensaje_id ?? "");
    return run(ctx, "contratos_validar", mensaje_id, async () => {
      const contrato = contratoDe(ctx, mensaje_id, args.contrato);
      const res: ResultadoValidacion = Val.validar(ctx, mensaje_id, contrato);
      return res;
    });
  },
} as const;

export const registrar = {
  description: "Registra el contrato en el maestro simulado y archiva el documento. Exige confirmado=true si hay campos en revisión.",
  args: z.object({
    mensaje_id: z.string().describe("Id del mensaje"),
    contrato: contratoSchema,
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión"),
    correcciones: correccionesSchema,
  }),
  async execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    const mensaje_id = String(args.mensaje_id ?? "");
    const confirmado = args.confirmado === true;
    return run(ctx, "contratos_registrar", mensaje_id, async () => {
      const k = correccionesSchema.parse(args.correcciones);
      if (k && Object.keys(k).length > 0 && !confirmado) throw new Error("las correcciones requieren confirmado=true");
      const contrato = aplicarCorrecciones(contratoDe(ctx, mensaje_id, args.contrato), k);
      const res = Reg.registrar(ctx, mensaje_id, contrato, confirmado);
      if (!res.ok) throw new Error(res.error);
      const data: ResultadoRegistro = res.data;
      return data;
    });
  },
} as const;

export const alertasTool = {
  description: "Genera el reporte de alertas: contratos que vencen en ≤60 días, pólizas pendientes y contratos registrados desde el corte.",
  args: z.object({ hoy: z.string().describe("Fecha de referencia en YYYY-MM-DD") }),
  async execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    const hoy = String(args.hoy ?? "");
    return run(ctx, "contratos_alertas", undefined, async () => {
      const res: ResultadoAlertas = Ale.alertas(ctx, hoy);
      return res;
    });
  },
} as const;

export const leer_pdf = {
  description: "Lee el texto de un contrato archivado (P1). Ruta relativa al proyecto o absoluta.",
  args: z.object({ ruta: z.string().describe("Ruta al archivo del contrato") }),
  async execute(args: Record<string, unknown>, ctx: Ctx): Promise<string> {
    const ruta = String(args.ruta ?? "");
    return run(ctx, "contratos_leer_pdf", undefined, async () => {
      const abs = path.isAbsolute(ruta) ? ruta : path.join(ctx.directory, ruta);
      const texto = readFileSync(abs, "utf-8");
      return { texto, ruta };
    });
  },
} as const;

// Registro para el ciclo del agente (servidor): nombre -> herramienta.
export const TOOLS = {
  contratos_leer_buzon: leer_buzon,
  contratos_extraer: extraer,
  contratos_validar: validar,
  contratos_registrar: registrar,
  contratos_alertas: alertasTool,
  contratos_leer_pdf: leer_pdf,
} as const;
