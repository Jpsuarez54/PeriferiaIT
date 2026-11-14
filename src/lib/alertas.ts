// Reporte de alertas: vencimientos ≤60d, pólizas pendientes, gap cubierto.
import type { Ctx, ResultadoAlertas, ResumenFila } from "./types";
import { readMaestro, writeText } from "./io";
import { daysBetween } from "./util";

const CORTE = "2026-05-30";

type Renglon = { id_contrato: string; cliente: string; fecha_fin: string; requiere_poliza: boolean; estado_poliza: string; fecha_registro: string };

function resumen(r: Renglon): ResumenFila {
  return {
    id_contrato: r.id_contrato, cliente: r.cliente, fecha_fin: r.fecha_fin,
    requiere_poliza: r.requiere_poliza, estado_poliza: r.estado_poliza as ResumenFila["estado_poliza"],
    fecha_registro: r.fecha_registro,
  };
}

function tabla(rows: ResumenFila[]): string {
  if (!rows.length) return "_Ninguno._\n";
  const head = "| id_contrato | cliente | fecha_fin | requiere_poliza | estado_poliza | fecha_registro |\n|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.id_contrato} | ${r.cliente} | ${r.fecha_fin} | ${r.requiere_poliza ? "sí" : "no"} | ${r.estado_poliza} | ${r.fecha_registro} |`).join("\n");
  return head + "\n" + body + "\n";
}

export function alertas(ctx: Ctx, hoy: string): ResultadoAlertas {
  const maestro = readMaestro(ctx);
  const vencen = maestro.filter((r) => {
    const d = daysBetween(hoy, r.fecha_fin);
    return d != null && d >= 0 && d <= 60;
  }).map(resumen);
  const polizas_pendientes = maestro
    .filter((r) => r.requiere_poliza && r.estado_poliza !== "vigente")
    .map(resumen);
  const registrados_desde_corte = maestro
    .filter((r) => (r.fecha_registro ?? "") >= CORTE)
    .map(resumen);

  const md = [
    `# Alertas de contratos — referencia ${hoy}`,
    "",
    `## 1. Vencen en ≤ 60 días (desde ${hoy})`,
    tabla(vencen),
    "## 2. Pólizas pendientes (requieren póliza y no están vigentes)",
    tabla(polizas_pendientes),
    `## 3. Registrados desde el corte (${CORTE}) — gap cubierto`,
    tabla(registrados_desde_corte),
  ].join("\n");

  writeText(ctx, "alertas.md", md);
  return { ruta: "out/alertas.md", vencen, polizas_pendientes, registrados_desde_corte };
}
