// Servidor HTTP (Bun): API del chat + archivos estáticos del front.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GeminiAdapter } from "./llm/gemini";
import { LLMError, type LLMAdapter } from "./llm/adapter";
import { correrTurno, type Limites } from "./agent/loop";
import { getSesion, findSesion, saveSesion, clearSesiones, validId } from "./agent/session";
import { clearOut, appendLog } from "./lib/io";
import { nowIso } from "./lib/util";
import type { Ctx } from "./lib/types";

const ROOT = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 3000);
const LIM: Limites = {
  maxIteraciones: Number(process.env.MAX_ITERATIONS ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_PER_SESSION ?? 400000),
};
const MAX_MSG = 4000;

// System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md).
function cargarSystem(): string {
  const prompt = readFileSync(path.join(ROOT, "agent", "prompt.md"), "utf-8");
  const conocimiento = readFileSync(path.join(ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8");
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`;
}
const SYSTEM = cargarSystem();

function crearLLM(): LLMAdapter | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const principal = process.env.MODEL || "gemini-3.5-flash";
  const respaldos = (process.env.MODEL_FALLBACKS ?? "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
    .split(",").map((m) => m.trim()).filter((m) => m && m !== principal);
  return new GeminiAdapter(key, [principal, ...respaldos], Number(process.env.LLM_TIMEOUT_MS ?? 45000));
}
const llm = crearLLM();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// Un turno a la vez por sesión: evita carreras sobre el mismo historial.
const ocupadas = new Set<string>();

async function chat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { sessionId?: unknown; message?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!validId(sessionId)) return json({ error: "sessionId inválido" }, 400);
  if (!message) return json({ error: "message vacío" }, 400);
  if (message.length > MAX_MSG) return json({ error: `message supera ${MAX_MSG} caracteres` }, 400);
  if (!llm) return json({ reply: "El servidor no tiene configurada la clave del modelo (GEMINI_API_KEY).", toolCalls: [], needsConfirmation: false, error: true });
  if (ocupadas.has(sessionId)) return json({ error: "ya hay un turno en curso en esta sesión" }, 409);

  ocupadas.add(sessionId);
  const s = getSesion(ROOT, sessionId);
  const ctx: Ctx = { directory: ROOT, sessionId };
  const n = s.mensajes.length;
  try {
    s.vista.push({ role: "user", text: message, toolCalls: [], needsConfirmation: false, ts: nowIso() });
    const t = await correrTurno(llm, SYSTEM, s, message, ctx, LIM);
    s.vista.push({ role: "assistant", text: t.reply, toolCalls: t.toolCalls, needsConfirmation: t.needsConfirmation, ts: nowIso() });
    return json({ ...t, tokens: s.tokens });
  } catch (e) {
    s.mensajes.length = n; // descarta el turno incompleto; la sesión sigue viva (CA5)
    const detalle = e instanceof LLMError ? e.message : "error interno del agente";
    if (!(e instanceof LLMError)) console.error(e);
    appendLog(ctx, { ts: nowIso(), herramienta: "llm", mensaje_id: null, ok: false, resumen: detalle });
    const reply = `No pude completar la respuesta: ${detalle}. Puedes reintentar el mismo mensaje.`;
    s.vista.push({ role: "assistant", text: reply, toolCalls: [], needsConfirmation: false, ts: nowIso() });
    return json({ reply, toolCalls: [], needsConfirmation: false, error: true });
  } finally {
    saveSesion(ROOT, s);
    ocupadas.delete(sessionId);
  }
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function estatico(pathname: string): Response {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const abs = path.resolve(ROOT, "web", rel);
  if (!abs.startsWith(path.resolve(ROOT, "web")) || !existsSync(abs)) return new Response("No encontrado", { status: 404 });
  return new Response(Bun.file(abs), { headers: { "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream" } });
}

Bun.serve({
  port: PORT,
  idleTimeout: 255, // un turno largo puede tardar más de los 10 s por defecto
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, provider: llm?.provider ?? "sin-configurar", model: llm?.model ?? null });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") return chat(req);
    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") {
      const id = decodeURIComponent(m[1] ?? "");
      const s = validId(id) ? findSesion(ROOT, id) : null;
      return s ? json({ id: s.id, historial: s.vista, tokens: s.tokens, pendientes: s.pendientes }) : json({ error: "sesión no encontrada" }, 404);
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      if (ocupadas.size > 0) return json({ error: "hay un turno en curso" }, 409);
      clearOut({ directory: ROOT, sessionId: "reset" });
      clearSesiones();
      return json({ ok: true });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "ruta no encontrada" }, 404);
    return estatico(url.pathname);
  },
});

console.log(`Agente de contratos en http://localhost:${PORT} (proveedor: ${llm?.provider ?? "sin clave"}, modelo: ${llm?.model ?? "-"})`);
