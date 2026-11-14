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

async function main(): Promise<void> {
  clearOut(ctx);
  const ids = listBuzon(ctx);
  console.log("=== DEMO — Procesamiento del buzón (fecha de referencia 2026-09-03) ===\n");
  console.log("--- Pasada 1: sin confirmar ---\n");
  const pendientes: { id: string; contrato: ContratoExtraido }[] = [];

  for (const id of ids) {
    const ex = await call(T.extraer, { mensaje_id: id });
    if (!ex.ok || !ex.data) { console.log(`${id} | ERROR extracción: ${ex.error}`); continue; }
    const contrato = (ex.data as { contrato: ContratoExtraido }).contrato;

    const val = await call(T.validar, { mensaje_id: id, contrato });
    const v = (val.data ?? {}) as ResultadoValidacion;
    const rev = v.requiere_revision ?? [];
    let accion: string;
    if (v.clasificacion === "rechazado") {
      const reg = await call(T.registrar, { mensaje_id: id, contrato });
      accion = reg.ok ? `rechazado (${v.motivo_rechazo ?? ""}), marcado como procesado` : `error: ${reg.error}`;
    } else if (rev.length > 0) {
      accion = `PENDIENTE revisión: ${rev.join(", ")}`;
      pendientes.push({ id, contrato });
    } else {
      const reg = await call(T.registrar, { mensaje_id: id, contrato, confirmado: false });
      accion = reg.ok
        ? `${(reg.data as ResultadoRegistro).accion} -> ${(reg.data as ResultadoRegistro).ruta_archivo || "sin escritura"}`
        : `no registrado: ${reg.error}`;
    }
    const rem = v.remitente_registrado ? "registrado" : "NO registrado";
    console.log(`${id} | ${v.clasificacion} | remitente ${rem} | revisión: [${rev.join(", ")}] | acción: ${accion}`);
  }

  if (pendientes.length) {
    const p = pendientes.find((x) => x.id === "msg-006") ?? pendientes[0]!;
    console.log(`\n--- Pasada 2: confirmando ${p.id} (confirmado=true) ---\n`);
    const reg = await call(T.registrar, { mensaje_id: p.id, contrato: p.contrato, confirmado: true });
    console.log(`${p.id} | ${reg.ok
      ? `${(reg.data as ResultadoRegistro).accion} -> ${(reg.data as ResultadoRegistro).ruta_archivo}`
      : `error: ${reg.error}`}`);
  }

  const al = await call(T.alertasTool, { hoy: "2026-09-03" });
  console.log("\n--- Alertas (out/alertas.md) ---");
  if (al.ok && al.data) {
    const a = al.data as ResultadoAlertas;
    console.log(`Vencen <=60d: ${a.vencen.map((x) => x.id_contrato).join(", ") || "ninguno"}`);
    console.log(`Pólizas pendientes: ${a.polizas_pendientes.map((x) => x.id_contrato).join(", ") || "ninguna"}`);
    console.log(`Registrados desde 2026-05-30: ${a.registrados_desde_corte.map((x) => x.id_contrato).join(", ") || "ninguno"}`);
  } else {
    console.log(`error: ${al.error}`);
  }
}

main().catch((e) => { console.error("demo falló:", e); process.exit(1); });
