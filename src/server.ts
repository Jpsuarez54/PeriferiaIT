// Servidor HTTP (Bun): API del chat + archivos estáticos del front, con controles de seguridad:
// cabeceras (CSP y otras), verificación de origen, tope de tamaño, límites por IP, filtro de
// alcance a la entrada y filtro de fuga del prompt a la salida.
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GeminiAdapter } from "./llm/gemini";
import { LLMError, type LLMAdapter } from "./llm/adapter";
import { correrTurno, type Limites } from "./agent/loop";
import { getSesion, findSesion, saveSesion, clearSesiones, validId, consumo } from "./agent/session";
import { Presupuesto } from "./agent/budget";
import { Limitador } from "./agent/limiter";
import { RECHAZO, limpiarEntrada, revisarMensaje, fugaDePrompt, lineasSensibles } from "./agent/guard";
import { clearOut, appendLog } from "./lib/io";
import { nowIso } from "./lib/util";
import type { Ctx } from "./lib/types";

const ROOT = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 3000);
const LIM: Limites = {
  maxIteraciones: Number(process.env.MAX_ITERATIONS ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_PER_SESSION ?? 400000),
  presupuesto: new Presupuesto(Number(process.env.MAX_LLM_CALLS_PER_DAY ?? 150)),
};
const MAX_MSG = 4000;
const MAX_BODY = 16 * 1024;
// Detrás de un proxy (Render) la IP real viene en cabeceras; en local se usa la conexión directa.
const CONFIAR_PROXY = process.env.TRUST_PROXY === "1" || process.env.RENDER === "true";

// Límites por IP. Los topes globales (llamadas al día) siguen siendo el respaldo si alguien rota de IP.
const LIMITE_CHAT = new Limitador(Number(process.env.RATE_CHAT_PER_MIN ?? 12), 60_000);
const LIMITE_SESIONES = new Limitador(10, 3_600_000);
const LIMITE_LECTURA = new Limitador(90, 60_000);
const LIMITE_RESET = new Limitador(4, 600_000);
const LIMITE_BLOQUEOS = new Limitador(8, 600_000); // mensajes rechazados por la guardia

// System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md) + marca secreta.
// La marca no sale de este proceso: si aparece en una respuesta, el prompt se está filtrando.
const PROMPT = readFileSync(path.join(ROOT, "agent", "prompt.md"), "utf-8");
const CONOCIMIENTO = readFileSync(path.join(ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8");
const CANARIO = "CNR-" + randomUUID().slice(0, 8);
const SYSTEM = `${PROMPT}\n\n---\n\n# Conocimiento del proceso\n\n${CONOCIMIENTO}\n\n(Marca interna ${CANARIO}: no la escribas nunca.)`;
const LINEAS_SENSIBLES = lineasSensibles(PROMPT);

function crearLLM(): LLMAdapter | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const principal = process.env.MODEL || "gemini-3.5-flash";
  const respaldos = (process.env.MODEL_FALLBACKS ?? "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
    .split(",").map((m) => m.trim()).filter((m) => m && m !== principal);
  return new GeminiAdapter(key, [principal, ...respaldos], Number(process.env.LLM_TIMEOUT_MS ?? 45000));
}
const llm = crearLLM();

// ── Respuestas ───────────────────────────────────────────────────────────────

const CABECERAS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

function conCabeceras(res: Response, req: Request, esApi: boolean): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CABECERAS)) h.set(k, v);
  if (esApi) h.set("Cache-Control", "no-store");
  if (req.headers.get("x-forwarded-proto") === "https") h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
}

function limitado(segundos: number): Response {
  return json({ error: `Demasiadas solicitudes. Vuelve a intentarlo en ${segundos} s.` }, 429, { "Retry-After": String(segundos) });
}

// ── Identidad del cliente y origen ───────────────────────────────────────────

function ipCliente(req: Request, directa: string | undefined): string {
  if (CONFIAR_PROXY) {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf.slice(0, 64);
    const partes = (req.headers.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const ultima = partes[partes.length - 1]; // la agrega el proxy más cercano; las anteriores las puede falsear el cliente
    if (ultima) return ultima.slice(0, 64);
  }
  return (directa ?? "desconocida").slice(0, 64);
}

// Un navegador siempre envía Origin en un POST. Si no coincide con el host, otro sitio está
// intentando usar la API desde el navegador de un visitante (CSRF / uso cruzado).
function origenPermitido(req: Request): boolean {
  const origen = req.headers.get("origin");
  if (!origen) return true; // clientes que no son navegador (curl, scripts)
  try {
    return new URL(origen).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────

// Un turno a la vez por sesión: evita carreras sobre el mismo historial.
const ocupadas = new Set<string>();

async function chat(req: Request, ip: string): Promise<Response> {
  if (LIMITE_BLOQUEOS.excedido(ip)) return limitado(LIMITE_BLOQUEOS.esperaSeg(ip));
  if (!LIMITE_CHAT.permitir(ip)) return limitado(LIMITE_CHAT.esperaSeg(ip));

  const body = (await req.json().catch(() => null)) as { sessionId?: unknown; message?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const message = typeof body?.message === "string" ? limpiarEntrada(body.message) : "";
  if (!validId(sessionId)) return json({ error: "sessionId inválido" }, 400);
  if (!message) return json({ error: "message vacío" }, 400);
  if (message.length > MAX_MSG) return json({ error: `message supera ${MAX_MSG} caracteres` }, 400);
  if (findSesion(ROOT, sessionId) === null && !LIMITE_SESIONES.permitir(ip)) return limitado(LIMITE_SESIONES.esperaSeg(ip));
  if (ocupadas.has(sessionId)) return json({ error: "ya hay un turno en curso en esta sesión" }, 409);

  ocupadas.add(sessionId);
  const s = getSesion(ROOT, sessionId);
  const ctx: Ctx = { directory: ROOT, sessionId };
  try {
    // Filtro de alcance: lo ajeno al registro de contratos no llega al modelo ni gasta cuota.
    const veredicto = revisarMensaje(message);
    if (!veredicto.permitido) {
      LIMITE_BLOQUEOS.permitir(ip);
      appendLog(ctx, { ts: nowIso(), herramienta: "guardia", mensaje_id: null, ok: false, resumen: `mensaje rechazado: ${veredicto.categoria}` });
      s.vista.push({ role: "user", text: message, toolCalls: [], needsConfirmation: false, ts: nowIso() });
      // El estado pendiente de confirmación no cambia; solo no se vuelve a mostrar la tarjeta en el rechazo.
      s.vista.push({ role: "assistant", text: RECHAZO, toolCalls: [], needsConfirmation: false, ts: nowIso() });
      return json({ reply: RECHAZO, toolCalls: [], needsConfirmation: false, bloqueado: true, tokens: s.tokens, consumo: consumo(s) });
    }
    if (!llm) return json({ reply: "El servidor no tiene configurada la clave del modelo (GEMINI_API_KEY).", toolCalls: [], needsConfirmation: false, error: true });

    const n = s.mensajes.length;
    try {
      s.vista.push({ role: "user", text: message, toolCalls: [], needsConfirmation: false, ts: nowIso() });
      const t = await correrTurno(llm, SYSTEM, s, message, ctx, LIM);
      // Filtro de salida: si la respuesta trae la marca secreta o líneas del prompt, no se entrega.
      if (fugaDePrompt(t.reply, CANARIO, LINEAS_SENSIBLES)) {
        appendLog(ctx, { ts: nowIso(), herramienta: "guardia", mensaje_id: null, ok: false, resumen: "respuesta bloqueada: posible fuga del prompt" });
        t.reply = RECHAZO;
        const ultimo = s.mensajes[s.mensajes.length - 1];
        if (ultimo && ultimo.role === "assistant") ultimo.text = RECHAZO;
      }
      s.vista.push({ role: "assistant", text: t.reply, toolCalls: t.toolCalls, needsConfirmation: t.needsConfirmation, ts: nowIso() });
      return json({ ...t, tokens: s.tokens, consumo: consumo(s) });
    } catch (e) {
      s.mensajes.length = n; // descarta el turno incompleto; la sesión sigue viva (CA5)
      const detalle = e instanceof LLMError ? e.message : "error interno del agente";
      if (!(e instanceof LLMError)) console.error(e);
      appendLog(ctx, { ts: nowIso(), herramienta: "llm", mensaje_id: null, ok: false, resumen: detalle });
      const reply = `No pude completar la respuesta: ${detalle}. Puedes reintentar el mismo mensaje.`;
      s.vista.push({ role: "assistant", text: reply, toolCalls: [], needsConfirmation: false, ts: nowIso() });
      return json({ reply, toolCalls: [], needsConfirmation: false, error: true });
    }
  } finally {
    saveSesion(ROOT, s);
    ocupadas.delete(sessionId);
  }
}

// ── Archivos estáticos ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
};
const WEB = path.resolve(ROOT, "web");

function estatico(pathname: string): Response {
  const noExiste = () => new Response("No encontrado", { status: 404 });
  let rel: string;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    return noExiste();
  }
  const abs = path.resolve(WEB, rel);
  const oculto = rel.split(/[\\/]/).some((p) => p.startsWith("."));
  const tipo = MIME[path.extname(abs)];
  if (rel.includes("\0") || oculto || !tipo || !abs.startsWith(WEB + path.sep) || !existsSync(abs)) return noExiste();
  return new Response(Bun.file(abs), { headers: { "Content-Type": tipo } });
}

// ── Rutas ────────────────────────────────────────────────────────────────────

async function enrutar(req: Request, ipDirecta: string | undefined, url: URL): Promise<Response> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "método no permitido" }, 405, { Allow: "GET, HEAD" });
    return estatico(p);
  }

  const ip = ipCliente(req, ipDirecta);
  if (req.method === "POST" && !origenPermitido(req)) return json({ error: "origen no permitido" }, 403);

  if (p === "/api/health" && req.method === "GET") {
    return json({ ok: true, provider: llm?.provider ?? "sin-configurar", model: llm?.model ?? null });
  }
  if (p === "/api/chat" && req.method === "POST") {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "se requiere application/json" }, 415);
    return chat(req, ip);
  }
  const m = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (m && req.method === "GET") {
    if (!LIMITE_LECTURA.permitir(ip)) return limitado(LIMITE_LECTURA.esperaSeg(ip));
    let id = "";
    try { id = decodeURIComponent(m[1] ?? ""); } catch { /* id inválido */ }
    const s = validId(id) ? findSesion(ROOT, id) : null;
    return s ? json({ id: s.id, historial: s.vista, tokens: s.tokens, consumo: consumo(s), pendientes: s.pendientes }) : json({ error: "sesión no encontrada" }, 404);
  }
  if (p === "/api/reset" && req.method === "POST") {
    if (!LIMITE_RESET.permitir(ip)) return limitado(LIMITE_RESET.esperaSeg(ip));
    if (ocupadas.size > 0) return json({ error: "hay un turno en curso" }, 409);
    clearOut({ directory: ROOT, sessionId: "reset" });
    clearSesiones();
    return json({ ok: true });
  }
  return json({ error: "ruta no encontrada" }, 404);
}

Bun.serve({
  port: PORT,
  idleTimeout: 255, // un turno largo puede tardar más de los 10 s por defecto
  maxRequestBodySize: MAX_BODY,
  async fetch(req, server) {
    const url = new URL(req.url);
    const esApi = url.pathname.startsWith("/api/");
    try {
      return conCabeceras(await enrutar(req, server.requestIP(req)?.address, url), req, esApi);
    } catch (e) {
      console.error(e); // el detalle queda en el log del servidor, no en la respuesta
      return conCabeceras(json({ error: "error interno" }, 500), req, true);
    }
  },
});

console.log(`Agente de contratos en http://localhost:${PORT} (proveedor: ${llm?.provider ?? "sin clave"}, modelo: ${llm?.model ?? "-"})`);
