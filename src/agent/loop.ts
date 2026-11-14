// Ciclo del agente: prompt -> modelo -> herramientas -> modelo ... -> respuesta.
import { z } from "zod";
import type { LLMAdapter, Mensaje, ToolResult, ToolSpec } from "../llm/adapter";
import { toJsonSchema } from "../llm/schema";
import { TOOLS } from "../tools/contratos";
import type { Ctx } from "../lib/types";
import type { Sesion, ToolCallVista } from "./session";

export interface Limites {
  maxIteraciones: number;
  maxTokensSesion: number;
}

export interface Turno {
  reply: string;
  toolCalls: ToolCallVista[];
  needsConfirmation: boolean;
}

type NombreTool = keyof typeof TOOLS;
function esTool(n: string): n is NombreTool {
  return Object.prototype.hasOwnProperty.call(TOOLS, n);
}

export function toolSpecs(): ToolSpec[] {
  return (Object.keys(TOOLS) as NombreTool[]).map((name) => ({
    name,
    description: TOOLS[name].description,
    parameters: toJsonSchema(TOOLS[name].args) ?? { type: "object", properties: {} },
  }));
}

function resumir(content: string): { ok: boolean; resumen: string } {
  const r = JSON.parse(content) as { ok: boolean; data?: unknown; error?: string };
  if (!r.ok) return { ok: false, resumen: r.error ?? "error" };
  const d = (r.data ?? {}) as Record<string, unknown>;
  if (Array.isArray(d.mensajes)) return { ok: true, resumen: `${d.mensajes.length} mensajes pendientes` };
  if (d.contrato && typeof d.contrato === "object") {
    const c = d.contrato as Record<string, { valor?: unknown }>;
    return { ok: true, resumen: `contrato ${String(c.id_contrato?.valor ?? "sin id")} de ${String(c.cliente?.valor ?? "?")}` };
  }
  if (typeof d.clasificacion === "string") {
    const rev = Array.isArray(d.requiere_revision) && d.requiere_revision.length ? `, revisión: ${d.requiere_revision.join(", ")}` : "";
    return { ok: true, resumen: `${d.clasificacion}${rev}` };
  }
  if (typeof d.accion === "string") return { ok: true, resumen: `${d.accion}${d.id_contrato ? ` ${String(d.id_contrato)}` : ""}` };
  if (Array.isArray(d.vencen)) return { ok: true, resumen: `reporte en ${String(d.ruta)}` };
  return { ok: true, resumen: "ok" };
}

// Ejecuta una llamada: valida args con zod y aplica la regla de confirmación (CA3).
async function ejecutar(name: string, args: Record<string, unknown>, ctx: Ctx, confirmables: Set<string>): Promise<string> {
  if (!esTool(name)) return JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` });
  const tool = TOOLS[name];
  const parsed = (tool.args as z.ZodTypeAny).safeParse(args);
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
  return tool.execute(parsed.data as Record<string, unknown>, ctx);
}

export async function correrTurno(llm: LLMAdapter, system: string, s: Sesion, texto: string, ctx: Ctx, lim: Limites): Promise<Turno> {
  const vistas: ToolCallVista[] = [];
  if (s.tokens >= lim.maxTokensSesion) {
    return { reply: `Esta sesión alcanzó el tope de ${lim.maxTokensSesion} tokens. Abre una sesión nueva para continuar.`, toolCalls: [], needsConfirmation: false };
  }
  // Solo se puede confirmar lo que quedó pendiente en un turno anterior.
  const confirmables = new Set(s.pendientes);
  const pendientes = new Set(s.pendientes);
  s.mensajes.push({ role: "user", text: texto });
  const specs = toolSpecs();

  for (let i = 0; i < lim.maxIteraciones; i++) {
    const t0 = Date.now();
    const r = await llm.enviar(system, s.mensajes, specs);
    s.tokens += r.usage.inputTokens + r.usage.outputTokens;
    console.log(`[${s.id}] iteración ${i + 1}: ${r.toolCalls.map((t) => t.name).join(", ") || "respuesta final"} (${Date.now() - t0} ms, ${s.tokens} tokens)`);
    s.mensajes.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls });
    if (r.toolCalls.length === 0) {
      s.pendientes = [...pendientes];
      return { reply: r.text, toolCalls: vistas, needsConfirmation: pendientes.size > 0 };
    }
    const results: ToolResult[] = [];
    for (const tc of r.toolCalls) {
      const content = await ejecutar(tc.name, tc.args, ctx, confirmables);
      const { ok, resumen } = resumir(content);
      vistas.push({ name: tc.name, args: tc.args, ok, resumen });
      results.push({ id: tc.id, name: tc.name, content });
      if (tc.name === "contratos_registrar") {
        const id = String(tc.args.mensaje_id ?? "");
        if (ok) pendientes.delete(id);
        else if (resumen.startsWith("requiere revisión")) pendientes.add(id);
      }
    }
    s.mensajes.push({ role: "tool", results });
    if (s.tokens >= lim.maxTokensSesion) break;
  }
  s.pendientes = [...pendientes];
  const reply = `Detuve el procesamiento al llegar al tope (${lim.maxIteraciones} iteraciones o ${lim.maxTokensSesion} tokens). Llamadas hechas en este turno: ${vistas.length}. Pídeme que continúe para terminar lo que falta.`;
  // El historial debe terminar en un mensaje del modelo para el siguiente turno.
  s.mensajes.push({ role: "assistant", text: reply, toolCalls: [] } satisfies Mensaje);
  return { reply, toolCalls: vistas, needsConfirmation: pendientes.size > 0 };
}
