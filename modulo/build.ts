// Genera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md a partir de las
// fuentes que usa la aplicación (agent/prompt.md y src/knowledge/registro-contratos.md).
// Uso: bun run modulo   (bun run modulo --check  falla si los archivos están desactualizados)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const prompt = readFileSync(path.join(ROOT, "agent", "prompt.md"), "utf-8").trim();
const conocimiento = readFileSync(path.join(ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8").trim();

const agent = `---
description: Punto único de recepción de contratos. Lee el buzón, clasifica, registra en el maestro y genera alertas, pidiendo confirmación humana para los campos dudosos.
mode: primary
permission:
  edit: deny
  bash: deny
---

<!-- Generado por modulo/build.ts desde agent/prompt.md. No editar a mano. -->

${prompt}
`;

const skill = `---
name: registro-contratos
description: Reglas de negocio para registrar contratos vigentes (duplicados, actualizaciones por otrosí, confianza mínima 0.8, pólizas y alertas de vencimiento).
---

<!-- Generado por modulo/build.ts desde src/knowledge/registro-contratos.md. No editar a mano. -->

${conocimiento}
`;

const salidas: [string, string][] = [
  [path.join(ROOT, "modulo", "agent.md"), agent],
  [path.join(ROOT, "modulo", "skill", "registro-contratos", "SKILL.md"), skill],
];

if (process.argv.includes("--check")) {
  const viejos = salidas.filter(([f, c]) => !existsSync(f) || readFileSync(f, "utf-8") !== c);
  if (viejos.length) {
    console.error(`Desactualizado: ${viejos.map(([f]) => path.relative(ROOT, f)).join(", ")}. Corre: bun run modulo`);
    process.exit(1);
  }
  console.log("modulo/ coincide con agent/prompt.md y src/knowledge/");
} else {
  for (const [f, c] of salidas) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, c, "utf-8");
    console.log(`escrito ${path.relative(ROOT, f)}`);
  }
}
