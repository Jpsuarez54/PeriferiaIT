// Entrada/salida: fixtures (solo lectura) y out/ (escritura). CSV propio con quoting.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Ctx, FilaMaestro, MensajeBuzon, Pais, Moneda, EstadoPoliza, Fuente } from "./types";

const FIX = "fixtures/reto-02";
const OUT = "out";
const SP = "out/sharepoint";

export const MAESTRO_COLS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
  "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const;

export function fixPath(ctx: Ctx, rel: string): string {
  return path.join(ctx.directory, FIX, rel);
}
export function outPath(ctx: Ctx, rel: string): string {
  return path.join(ctx.directory, OUT, rel);
}

// ── Correo / adjuntos / comerciales ──────────────────────────────────────────
export function readCorreo(ctx: Ctx, id: string): { id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] } {
  const f = fixPath(ctx, `buzon/${id}/correo.json`);
  if (!existsSync(f)) throw new Error(`no existe el mensaje ${id} en el buzón`);
  try {
    return JSON.parse(readFileSync(f, "utf-8"));
  } catch {
    throw new Error(`el correo de ${id} no es un JSON válido`);
  }
}
export async function leerAdjunto(ctx: Ctx, id: string, name: string): Promise<string> {
  const f = fixPath(ctx, `buzon/${id}/${name}`);
  if (!existsSync(f)) throw new Error(`el adjunto ${name} de ${id} no está en el buzón`);
  return leerTexto(f);
}

// Texto de un documento: .pdf con capa de texto (P1) o texto plano. Los PDF escaneados
// no tienen texto y devuelven "", que la extracción reporta como error.
export async function leerTexto(abs: string): Promise<string> {
  if (!abs.toLowerCase().endsWith(".pdf")) return readFileSync(abs, "utf-8");
  const { getDocumentProxy, extractText } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(abs)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch (e) {
    throw new Error(`no se pudo leer el PDF ${path.basename(abs)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
export function readComerciales(ctx: Ctx): { email: string; nombre: string; region: string }[] {
  return JSON.parse(readFileSync(fixPath(ctx, "comerciales.json"), "utf-8"));
}
export function listBuzon(ctx: Ctx): string[] {
  const base = fixPath(ctx, "buzon");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("msg-"))
    .map((d) => d.name)
    .sort();
}

// ── Maestro (CSV) ────────────────────────────────────────────────────────────
export function fixtureMaestro(ctx: Ctx): string {
  return fixPath(ctx, "maestro-contratos.csv");
}
export function outMaestro(ctx: Ctx): string {
  return outPath(ctx, "sharepoint/maestro-contratos.csv");
}

// RN6: la primera ejecución copia el fixture a out/sharepoint/.
export function ensureMaestro(ctx: Ctx): string {
  const dest = outMaestro(ctx);
  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(fixtureMaestro(ctx), dest);
  }
  return dest;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      cur.push(field); field = "";
    } else if (c === "\n") {
      cur.push(field); rows.push(cur); cur = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// Una celda que empieza con = + - @ se ejecuta como fórmula al abrir el CSV en Excel (inyección de
// fórmulas): un cliente llamado "=HYPERLINK(...)" robaría datos. Se neutraliza con una comilla.
function neutralizar(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
function escCSV(crudo: string): string {
  const v = neutralizar(crudo);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
export function toCSV(rows: string[][]): string {
  return rows.map((r) => r.map(escCSV).join(",")).join("\r\n") + "\r\n";
}

export function filaToRow(f: FilaMaestro): string[] {
  return [
    f.id_contrato, f.cliente, f.nit_cliente, f.pais, f.objeto, String(f.valor), f.moneda,
    f.fecha_inicio, f.fecha_fin, f.requiere_poliza ? "true" : "false", f.tipo_poliza,
    f.estado_poliza, f.comercial, f.ruta_sharepoint, f.fecha_registro, f.fuente,
  ];
}
export function rowToFila(r: string[]): FilaMaestro {
  return {
    id_contrato: r[0] ?? "",
    cliente: r[1] ?? "",
    nit_cliente: r[2] ?? "",
    pais: (r[3] as Pais) ?? "CO",
    objeto: r[4] ?? "",
    valor: Number(r[5] ?? "0") || 0,
    moneda: (r[6] as Moneda) ?? "COP",
    fecha_inicio: r[7] ?? "",
    fecha_fin: r[8] ?? "",
    requiere_poliza: r[9] === "true",
    tipo_poliza: r[10] ?? "",
    estado_poliza: (r[11] as EstadoPoliza) ?? "no_aplica",
    comercial: r[12] ?? "",
    ruta_sharepoint: r[13] ?? "",
    fecha_registro: r[14] ?? "",
    fuente: (r[15] as Fuente) ?? "buzon",
  };
}

export function readMaestro(ctx: Ctx): FilaMaestro[] {
  ensureMaestro(ctx);
  const rows = parseCSV(readFileSync(outMaestro(ctx), "utf-8"));
  if (rows.length < 2) return [];
  const header = rows[0] ?? [];
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return rowToFila(MAESTRO_COLS.map((c) => obj[c] ?? ""));
  });
}
export function writeMaestro(ctx: Ctx, filas: FilaMaestro[]): void {
  const rows = [MAESTRO_COLS.slice() as unknown as string[], ...filas.map(filaToRow)];
  writeFileSync(outMaestro(ctx), toCSV(rows), "utf-8");
}

// ── Historial / procesados / log ─────────────────────────────────────────────
export function appendHistorial(ctx: Ctx, entry: Record<string, unknown>): void {
  const p = outPath(ctx, "sharepoint/historial.jsonl");
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}
export function readProcesados(ctx: Ctx): { id: string; estado: string; ts: string }[] {
  const p = outPath(ctx, "procesados.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}
export function markProcesado(ctx: Ctx, id: string, estado: string, ts: string): void {
  const p = outPath(ctx, "procesados.json");
  mkdirSync(path.dirname(p), { recursive: true });
  const list = readProcesados(ctx).filter((x) => x.id !== id);
  list.push({ id, estado, ts });
  writeFileSync(p, JSON.stringify(list, null, 2), "utf-8");
}
export function appendLog(ctx: Ctx, entry: Record<string, unknown>): void {
  const p = outPath(ctx, "log.jsonl");
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}

export function copyAttachment(ctx: Ctx, id: string, name: string, destAbs: string): void {
  mkdirSync(path.dirname(destAbs), { recursive: true });
  copyFileSync(fixPath(ctx, `buzon/${id}/${name}`), destAbs);
}

export function clearOut(ctx: Ctx): void {
  rmSync(outPath(ctx, ""), { recursive: true, force: true });
}

export function resumenBuzon(ctx: Ctx): MensajeBuzon[] {
  const procesados = new Set(readProcesados(ctx).map((x) => x.id));
  const out: MensajeBuzon[] = [];
  for (const id of listBuzon(ctx)) {
    if (procesados.has(id)) continue;
    const c = readCorreo(ctx, id);
    const tiene_contrato = (c.adjuntos ?? []).some((a) => /contrato|otros[ií]/i.test(a));
    out.push({ id: c.id, de: c.de, asunto: c.asunto, fecha: c.fecha, adjuntos: c.adjuntos ?? [], tiene_contrato });
  }
  return out;
}

export function writeText(ctx: Ctx, rel: string, content: string): void {
  const p = outPath(ctx, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf-8");
}
