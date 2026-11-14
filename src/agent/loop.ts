// Ciclo del agente: prompt -> modelo -> herramientas -> modelo ... -> respuesta.
import { z } from "zod";
import type { LLMAdapter, Mensaje, ToolResult, ToolSpec } from "../llm/adapter";
import { toJsonSchema } from "../llm/schema";
import * as contratos from "../tools/contratos";
import type { Ctx } from "../lib/types";
import type { Sesion, ToolCallVista } from "./session";
import type { Presupuesto } from "./budget";
import { valorEnMensaje } from "./guard";

export interface Limites {
  maxIteraciones: number;
  maxTokensSesion: number;
  presupuesto: Presupuesto;
}

export interface Turno {
  reply: string;
  toolCalls: ToolCallVista[];
  needsConfirmation: boolean;
}

interface Herramienta {
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute(args: Record<string, unknown>, ctx: Ctx): Promise<string>;
}

function esHerramienta(v: unknown): v is Herramienta {
  return typeof v === "object" && v !== null && "execute" in v && "args" in v && "description" in v;
}

// El nombre que ve el modelo es <archivo>_<export>, derivado de los exports de src/tools/contratos.ts.
export const TOOLS: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(contratos).filter(([, v]) => esHerramienta(v)).map(([k, v]) => [`contratos_${k}`, v as Herramienta]),
);

export function toolSpecs(): ToolSpec[] {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: toJsonSchema(z.object(t.args)) ?? { type: "object", properties: {} },
  }));
}

function resumir(content: string): { ok: boolean; resumen: string } {
  const r = JSON.parse(content) as { ok: boolean; data?: unknown; error?: string };
  if (!r.ok) return { ok: false, resumen: r.error ?? "error" };
  const d = (r.data ?? {}) as Record<string, unknown>;
  if (Array.isArray(d.mensajes)) return { ok: true, resumen: `${d.mensajes.length} mensajes pendientes` };
  if (typeof d.clasificacion === "string") {
    const rev = Array.isArray(d.requiere_revision) && d.requiere_revision.length ? ` · revisión: ${d.requiere_revision.join(", ")}` : "";
    return { ok: true, resumen: `${d.clasificacion}${d.id_contrato ? ` ${String(d.id_contrato)}` : ""}${rev}` };
  }
  if (typeof d.accion === "string") return { ok: true, resumen: `${d.accion}${d.id_contrato ? ` ${String(d.id_contrato)}` : ""}` };
  if (Array.isArray(d.vencen)) return { ok: true, resumen: `reporte en ${String(d.ruta)}` };
  if (typeof d.texto === "string") return { ok: true, resumen: `${d.texto.length} caracteres leídos` };
  const id = (d.id_contrato as { valor?: unknown } | undefined)?.valor;
  if (id !== undefined) return { ok: true, resumen: `contrato ${String(id ?? "sin id")} extraído` };
  return { ok: true, resumen: "ok" };
}

// Una corrección solo vale si el valor viene del documento (la propuesta de la extracción) o lo
// escribió el usuario en su mensaje. Así un modelo manipulado, por ejemplo por texto malicioso dentro
// de un contrato, no puede registrar una cifra que nadie dio. Devuelve el error, o null si todo cuadra.
async function correccionesSinRespaldo(ctx: Ctx, mensajeId: string, correcciones: Record<string, unknown>, textoUsuario: string): Promise<string | null> {
  const ex = JSON.parse(await contratos.extraer.execute({ mensaje_id: mensajeId }, ctx)) as { ok: boolean; data?: Record<string, { valor?: unknown }> };
  const propuesta = ex.ok ? (ex.data ?? {}) : {};
  for (const [campo, valor] of Object.entries(correcciones)) {
    if (valor === undefined) continue;
    const propuesto = propuesta[campo]?.valor;
    if (propuesto !== undefined && propuesto !== null && String(propuesto) === String(valor)) continue;
    if (valorEnMensaje(campo, valor, textoUsuario)) continue;
    return `correcciones.${campo}: el valor ${JSON.stringify(valor)} no está en el documento ni en el mensaje del usuario; pídele al usuario que lo escriba`;
  }
  return null;
}

// Ejecuta una llamada: valida args con zod y aplica la regla de confirmación (CA3).
async function ejecutar(name: string, args: Record<string, unknown>, ctx: Ctx, confirmables: Set<string>, textoUsuario: string): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` });
  const parsed = z.object(tool.args).safeParse(args);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
    return JSON.stringify({ ok: false, error: `argumentos inválidos: ${error}` });
  }
  if (name === "contratos_registrar" && args.confirmado === true && !confirmables.has(String(args.mensaje_id))) {
    return JSON.stringify({
      ok: false,
      error: "confirmado=true no permitido: primero muestra los campos en revisión y espera la respuesta del usuario en el siguiente mensaje",
    });
  }
  if (name === "contratos_registrar") {
    const d = parsed.data as { mensaje_id: string; correcciones?: Record<string, unknown> };
    const error = d.correcciones ? await correccionesSinRespaldo(ctx, d.mensaje_id, d.correcciones, textoUsuario) : null;
    if (error) return JSON.stringify({ ok: false, error });
  }
  return tool.execute(parsed.data as Record<string, unknown>, ctx);
}

// CA1: al cortar por un tope, responde con lo que alcanzó a hacer y lo que falta.
function resumenParcial(motivo: string, vistas: ToolCallVista[], pendientes: Set<string>): string {
  const hechas = vistas.map((v) => {
    const arg = typeof v.args.mensaje_id === "string" ? ` ${v.args.mensaje_id}` : "";
    return `- ${v.name}${arg}: ${v.ok ? "" : "⚠ "}${v.resumen}`;
  });
  return [
    `Me detuve porque ${motivo}.`,
    "",
    hechas.length ? "**Lo que alcancé a hacer:**" : "No alcancé a ejecutar ninguna herramienta.",
    ...hechas,
    "",
    "**Lo que falta:** los mensajes del buzón que no aparecen arriba siguen pendientes, y el reporte de alertas no se generó si no está en la lista." +
      (pendientes.size ? ` Además, ${[...pendientes].join(", ")} espera tu confirmación.` : ""),
    "Escríbeme \"continúa\" para seguir desde aquí.",
  ].join("\n");
}

function cierre(s: Sesion, reply: string, vistas: ToolCallVista[], pendientes: Set<string>): Turno {
  s.pendientes = [...pendientes];
  // El historial debe terminar en un mensaje del modelo para el siguiente turno.
  s.mensajes.push({ role: "assistant", text: reply, toolCalls: [] } satisfies Mensaje);
  return { reply, toolCalls: vistas, needsConfirmation: pendientes.size > 0 };
}

export async function correrTurno(llm: LLMAdapter, system: string, s: Sesion, texto: string, ctx: Ctx, lim: Limites): Promise<Turno> {
  if (s.tokens >= lim.maxTokensSesion) {
    return { reply: `Esta conversación alcanzó el tope de ${lim.maxTokensSesion} tokens. Abre una conversación nueva para continuar.`, toolCalls: [], needsConfirmation: false };
  }
  if (lim.presupuesto.restantes === 0) {
    return { reply: `El servidor alcanzó su tope diario de ${lim.presupuesto.maxPorDia} llamadas al modelo. Vuelve a intentarlo mañana.`, toolCalls: [], needsConfirmation: false };
  }
  // Solo se puede confirmar lo que quedó pendiente en un turno anterior.
  const confirmables = new Set(s.pendientes);
  const pendientes = new Set(s.pendientes);
  const vistas: ToolCallVista[] = [];
  s.mensajes.push({ role: "user", text: texto });
  const specs = toolSpecs();

  for (let i = 0; i < lim.maxIteraciones; i++) {
    if (!lim.presupuesto.consumir()) {
      return cierre(s, resumenParcial(`el servidor alcanzó su tope diario de ${lim.presupuesto.maxPorDia} llamadas al modelo (se reinicia a medianoche UTC)`, vistas, pendientes), vistas, pendientes);
    }
    const t0 = Date.now();
    const r = await llm.enviar(system, s.mensajes, specs);
    s.tokens += r.usage.inputTokens + r.usage.outputTokens;
    s.tokensEntrada = (s.tokensEntrada ?? 0) + r.usage.inputTokens;
    s.tokensSalida = (s.tokensSalida ?? 0) + r.usage.outputTokens;
    s.llamadas = (s.llamadas ?? 0) + 1;
    console.log(`[${s.id}] iteración ${i + 1}: ${r.toolCalls.map((t) => t.name).join(", ") || "respuesta final"} (${Date.now() - t0} ms, ${s.tokens} tokens)`);
    s.mensajes.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls });
    if (r.toolCalls.length === 0) {
      s.pendientes = [...pendientes];
      return { reply: r.text, toolCalls: vistas, needsConfirmation: pendientes.size > 0 };
    }
    const results: ToolResult[] = [];
    for (const tc of r.toolCalls) {
      const content = await ejecutar(tc.name, tc.args, ctx, confirmables, texto);
      const { ok, resumen } = resumir(content);
      vistas.push({ name: tc.name, args: tc.args, ok, resumen });
      results.push({ id: tc.id, name: tc.name, content });
      if (tc.name === "contratos_registrar") {
        const id = String(tc.args.mensaje_id ?? "");
        if (ok) pendientes.delete(id);
        else if (resumen.startsWith("requiere revisión") || resumen.startsWith("faltan datos")) pendientes.add(id);
      }
    }
    s.mensajes.push({ role: "tool", results });
    if (s.tokens >= lim.maxTokensSesion) break;
  }
  const motivo = s.tokens >= lim.maxTokensSesion
    ? `la conversación llegó a su tope de ${lim.maxTokensSesion} tokens`
    : `llegué al tope de ${lim.maxIteraciones} llamadas al modelo en este mensaje`;
  return cierre(s, resumenParcial(motivo, vistas, pendientes), vistas, pendientes);
}
