// Sesiones del chat. Se guardan en memoria y en out/sessions/<id>.json para sobrevivir reinicios.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Mensaje } from "../llm/adapter";

export interface ToolCallVista {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  resumen: string;
}

export interface EntradaVista {
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallVista[];
  needsConfirmation: boolean;
  ts: string;
}

export interface Sesion {
  id: string;
  mensajes: Mensaje[];      // historial para el modelo
  vista: EntradaVista[];    // historial para el front
  tokens: number;           // tokens consumidos (entrada + salida)
  tokensEntrada?: number;   // desglose para calcular el costo
  tokensSalida?: number;
  llamadas?: number;        // llamadas al modelo en la conversación
  pendientes: string[];     // mensaje_id a la espera de confirmación humana
}

// Precio de pago de Gemini 3.5 Flash en USD por millón de tokens (Google AI, 2026).
// Configurable por si cambia el modelo o la tarifa.
const PRECIO_ENTRADA = Number(process.env.PRICE_INPUT_PER_M ?? 1.5);
const PRECIO_SALIDA = Number(process.env.PRICE_OUTPUT_PER_M ?? 9);

export function costoUSD(s: Sesion): number {
  return ((s.tokensEntrada ?? 0) * PRECIO_ENTRADA + (s.tokensSalida ?? 0) * PRECIO_SALIDA) / 1_000_000;
}

export function consumo(s: Sesion): { tokens: number; entrada: number; salida: number; llamadas: number; costo_usd: number } {
  return {
    tokens: s.tokens, entrada: s.tokensEntrada ?? 0, salida: s.tokensSalida ?? 0,
    llamadas: s.llamadas ?? 0, costo_usd: Number(costoUSD(s).toFixed(5)),
  };
}

const cache = new Map<string, Sesion>();

function file(dir: string, id: string): string {
  return path.join(dir, "out", "sessions", `${id}.json`);
}

export function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function getSesion(dir: string, id: string): Sesion {
  const hit = cache.get(id);
  if (hit) return hit;
  const f = file(dir, id);
  let s: Sesion = { id, mensajes: [], vista: [], tokens: 0, pendientes: [] };
  if (existsSync(f)) {
    try {
      // Quita un BOM eventual; un archivo dañado no debe romper la conversación.
      s = JSON.parse(readFileSync(f, "utf-8").replace(/^\uFEFF/, "")) as Sesion;
    } catch {
      console.error(`[sesion] archivo dañado, se reinicia: ${id}`);
    }
  }
  cache.set(id, s);
  return s;
}

export function findSesion(dir: string, id: string): Sesion | null {
  return cache.get(id) ?? (existsSync(file(dir, id)) ? getSesion(dir, id) : null);
}

export function saveSesion(dir: string, s: Sesion): void {
  const f = file(dir, s.id);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s), "utf-8");
}

export function clearSesiones(): void {
  cache.clear();
}
