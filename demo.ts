// demo.ts — verificación determinista SIN modelo. Procesa los 6 mensajes del buzón
// llamando directamente a las herramientas y muestra clasificación, revisión y acción.
import * as T from "./src/tools/contratos";
import { clearOut, listBuzon } from "./src/lib/io";
import type { Ctx, ContratoExtraido, ResultadoAlertas, ResultadoRegistro, ResultadoValidacion } from "./src/lib/types";

const ctx: Ctx = { directory: process.cwd(), sessionId: "demo" };

interface R { ok: boolean; data?: unknown; error?: string }
async function call(tool: { execute: (a: Record<string, unknown>, c: Ctx) => Promise<string> }, args: Record<string, unknown>): Promise<R> {
  return JSON.parse(await tool.execute(args, ctx)) as R;
}

function accionDe(reg: R): string {
  if (!reg.ok) return `no registrado: ${reg.error}`;
  const d = reg.data as ResultadoRegistro;
  return `${d.accion} -> ${d.ruta_archivo || "sin escritura"}`;
}

async function main(): Promise<void> {
  clearOut(ctx);
  console.log("=== DEMO — Procesamiento del buzón (fecha de referencia 2026-09-03) ===\n");
  console.log("--- Pasada 1: sin confirmar ---\n");
  const pendientes: { id: string; contrato: ContratoExtraido }[] = [];

  for (const id of listBuzon(ctx)) {
    const ex = await call(T.extraer, { mensaje_id: id });
    if (!ex.ok) { console.log(`${id} | ERROR extracción: ${ex.error}`); continue; }
    const contrato = ex.data as ContratoExtraido;

    const v = (await call(T.validar, { mensaje_id: id, contrato })).data as ResultadoValidacion;
    const rev = v.requiere_revision;
    const rem = v.remitente_registrado ? "registrado" : "NO registrado";
    let accion: string;
    if (rev.length > 0 && v.clasificacion !== "rechazado") {
      const reg = await call(T.registrar, { mensaje_id: id, contrato });
      accion = `${reg.ok ? "registrado (inesperado)" : "sin registrar"}: ${reg.error ?? ""}`;
      pendientes.push({ id, contrato });
    } else {
      accion = accionDe(await call(T.registrar, { mensaje_id: id, contrato }));
    }
    console.log(`${id} | ${v.clasificacion} | ${v.id_contrato ?? "—"} | remitente ${rem} | revisión: [${rev.join(", ")}] | acción: ${accion}`);
    for (const c of v.campos_revision ?? []) console.log(`         · ${c.campo} = ${String(c.valor)} (confianza ${c.confianza}): ${c.nota}`);
  }

  const p = pendientes.find((x) => x.id === "msg-006") ?? pendientes[0];
  if (p) {
    console.log(`\n--- Pasada 2: el usuario confirma ${p.id} ("confirmo el valor 0 y la fecha fin 2027-08-31") ---\n`);
    const reg = await call(T.registrar, { mensaje_id: p.id, contrato: p.contrato, confirmado: true, correcciones: { valor: 0, fecha_fin: "2027-08-31" } });
    console.log(`${p.id} | ${accionDe(reg)}`);
  }

  const al = await call(T.alertas, { hoy: "2026-09-03" });
  console.log("\n--- Alertas (out/alertas.md) ---");
  if (al.ok) {
    const a = al.data as ResultadoAlertas;
    console.log(`Vencen <=60d: ${a.vencen.map((x) => x.id_contrato).join(", ") || "ninguno"}`);
    console.log(`Pólizas pendientes: ${a.polizas_pendientes.map((x) => x.id_contrato).join(", ") || "ninguna"}`);
    console.log(`Registrados desde 2026-05-30: ${a.registrados_desde_corte.map((x) => x.id_contrato).join(", ") || "ninguno"}`);
  } else {
    console.log(`error: ${al.error}`);
  }

  // HU-6: entradas malas devuelven {ok:false, error} legible y no detienen nada.
  console.log("\n--- Manejo de errores (HU-6) ---");
  const casos: [string, { execute: (a: Record<string, unknown>, c: Ctx) => Promise<string> }, Record<string, unknown>][] = [
    ["fecha inexistente en alertas", T.alertas, { hoy: "2026-02-30" }],
    ["mensaje que no existe", T.validar, { mensaje_id: "msg-999" }],
    ["lectura fuera de las carpetas permitidas", T.leer_pdf, { ruta: "../.env" }],
    ["corrección sin confirmación humana", T.registrar, { mensaje_id: "msg-001", correcciones: { valor: 1 } }],
    ["moneda fuera del catálogo en una corrección", T.registrar, { mensaje_id: "msg-001", confirmado: true, correcciones: { moneda: "EUR" } }],
  ];
  for (const [nombre, tool, args] of casos) {
    const r = await call(tool, args);
    console.log(`${nombre}: ok=${r.ok}${r.ok ? "" : ` -> ${r.error}`}`);
  }
}

main().catch((e) => { console.error("demo falló:", e); process.exit(1); });
