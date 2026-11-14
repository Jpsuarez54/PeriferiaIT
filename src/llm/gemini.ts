// Implementación de LLMAdapter para Google Gemini (REST generateContent).
import type { JsonSchema, LLMAdapter, Mensaje, Respuesta, ToolCall, ToolSpec } from "./adapter";
import { LLMError } from "./adapter";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface Content { role: "user" | "model"; parts: Part[] }
interface GeminiResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (s.required?.length) out.required = s.required;
  return out;
}

function toContents(mensajes: Mensaje[]): Content[] {
  return mensajes.map((m): Content => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls) {
        const p: Part = { functionCall: { name: tc.name, args: tc.args } };
        if (tc.meta?.thoughtSignature) p.thoughtSignature = tc.meta.thoughtSignature;
        parts.push(p);
      }
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: JSON.parse(r.content) as Record<string, unknown> } })),
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GeminiAdapter implements LLMAdapter {
  readonly provider = "google-gemini";
  private readonly modelos: string[];
  private activo: string;
  private cambioEn = 0;

  // modelos[0] es el principal; el resto son respaldos ante saturación.
  constructor(private readonly apiKey: string, modelos: string[], private readonly timeoutMs = 45000) {
    this.modelos = modelos.length ? modelos : ["gemini-3.5-flash"];
    this.activo = this.modelos[0] ?? "gemini-3.5-flash";
  }

  get model(): string {
    return this.activo;
  }

  async enviar(system: string, mensajes: Mensaje[], herramientas: ToolSpec[]): Promise<Respuesta> {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toContents(mensajes),
      tools: [{ functionDeclarations: herramientas.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }],
      generationConfig: { temperature: 0 },
    };
    const data = await this.post(body);
    const cand = data.candidates?.[0];
    if (!cand?.content?.parts) {
      const motivo = data.promptFeedback?.blockReason ?? cand?.finishReason ?? "respuesta vacía";
      throw new LLMError(`el modelo no devolvió contenido (${motivo})`);
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    cand.content.parts.forEach((p, i) => {
      if (p.functionCall) {
        toolCalls.push({
          id: `${p.functionCall.name}-${Date.now()}-${i}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
          ...(p.thoughtSignature ? { meta: { thoughtSignature: p.thoughtSignature } } : {}),
        });
      } else if (p.text && !p.thought) text += p.text;
    });
    const u = data.usageMetadata ?? {};
    return {
      text,
      toolCalls,
      usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
    };
  }

  // Prueba el modelo activo y, si está saturado (429/503) o no responde, pasa al siguiente
  // de la lista de respaldo. El que responde queda como activo para las siguientes llamadas.
  private async post(body: unknown): Promise<GeminiResponse> {
    // Tras 5 minutos en un respaldo, se vuelve a intentar primero el modelo principal.
    const principal = this.modelos[0] ?? this.activo;
    if (this.activo !== principal && Date.now() - this.cambioEn > 5 * 60_000) this.activo = principal;
    const orden = [this.activo, ...this.modelos.filter((m) => m !== this.activo)];
    let ultimo = "sin intentos";
    for (const modelo of orden) {
      for (let intento = 0; intento < 2; intento++) {
        const r = await this.intentar(modelo, body);
        if (r.ok) {
          if (modelo !== this.activo) {
            console.log(`[llm] cambio de modelo: ${this.activo} -> ${modelo}`);
            this.cambioEn = Date.now();
          }
          this.activo = modelo;
          return r.data;
        }
        ultimo = `${modelo}: ${r.error}`;
        if (!r.reintentable) throw new LLMError(r.error, r.status);
        if (r.status !== undefined && intento === 0) await sleep(1500);
        else break; // timeout: no repetir el mismo modelo, pasar al siguiente
      }
    }
    throw new LLMError(`los modelos de Gemini están saturados o no responden (${ultimo}). Intenta de nuevo en un minuto`, 503);
  }

  private async intentar(
    modelo: string, body: unknown,
  ): Promise<{ ok: true; data: GeminiResponse } | { ok: false; error: string; status?: number; reintentable: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/${encodeURIComponent(modelo)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, error: timeout ? `no respondió en ${this.timeoutMs / 1000}s` : "no se pudo contactar al proveedor", reintentable: true };
    }
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (res.ok) return { ok: true, data };
    const detalle = data.error?.message ?? res.statusText;
    if (res.status === 429 || res.status === 503 || res.status === 500) {
      return { ok: false, error: `saturado (${res.status}): ${detalle}`, status: res.status, reintentable: true };
    }
    if (res.status === 404) return { ok: false, error: `modelo no disponible: ${detalle}`, status: 404, reintentable: true };
    return { ok: false, error: `el proveedor rechazó la solicitud (${res.status}): ${detalle}`, status: res.status, reintentable: false };
  }
}
