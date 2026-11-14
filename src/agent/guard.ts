// Guardia de alcance y comprobaciones de seguridad del agente.
// Todo es determinista: no llama al modelo, no gasta cuota y se puede probar (test/seguridad.test.ts).
import { findAllDates, fmt, fechaValida, normalizarNIT, parseAmount } from "../lib/util";

export const RECHAZO =
  "Solo puedo ayudarte con el registro de contratos vigentes: leer el buzón, validar y registrar contratos, y generar las alertas de vencimiento. ¿Qué quieres hacer con el buzón?";

// Quita caracteres de control e invisibles (cero ancho, marcas bidireccionales) que sirven para
// partir una palabra y esquivar los filtros, y unifica variantes Unicode (NFKC).
export function limpiarEntrada(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim();
}

const norm = (s: string): string =>
  limpiarEntrada(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

interface Regla { categoria: string; re: RegExp }

// Se evalúan sobre el texto sin acentos y en minúsculas. Son deliberadamente específicas: bloquean
// ataques y usos claramente ajenos, y dejan pasar cualquier pregunta legítima sobre contratos.
const REGLAS: Regla[] = [
  { categoria: "anular instrucciones", re: /\b(ignora\w*|olvida\w*|omite|omitir|descarta\w*|desobedece\w*|anula\w*|salta\w*|desactiva\w*|elimina\w*|quita\w*)\b.{0,50}\b(instrucciones|reglas|indicaciones|restricciones|prompt|directrices|limites|politicas|filtros|seguridad|guardrails)\b/s },
  { categoria: "anular instrucciones", re: /\b(ignore|disregard|forget|override|bypass|disable)\b.{0,50}\b(instructions|rules|prompt|guidelines|restrictions|safety|filters)\b/s },
  { categoria: "extraer el prompt", re: /\b(repite|repetir|muestra\w*|imprime|revela\w*|dime|escribe|copia|filtra|enumera|lista|traduce|resume|reproduce|recita|devuelve|dame|comparte|print|show|reveal|repeat|display|output|tell\s+me)\b.{0,60}\b(tus|tu|sus|your)\s+(instrucciones|reglas|indicaciones|directrices|configuracion|prompt|programacion|restricciones|instructions|rules|system)/s },
  { categoria: "extraer el prompt", re: /(system\s*prompt|prompt\s+del?\s+sistema|mensaje\s+del?\s+sistema|developer\s+message|instrucciones\s+(del\s+sistema|internas|iniciales|ocultas|originales|previas)|\btus?\s+(instrucciones|prompt|directrices|programacion)\b)/ },
  { categoria: "cambio de rol", re: /\b(actua|actues|comportate|finge|simula|pretende|hazte\s+pasar|haz\s+de)\s+(como|por)\b/ },
  { categoria: "cambio de rol", re: /\b(ahora\s+eres|ya\s+no\s+eres|dejas?\s+de\s+ser|eres\s+(ahora\s+)?un\s+(asistente|experto|hacker|programador|traductor|abogado|medico))\b/ },
  { categoria: "cambio de rol", re: /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you)|from\s+now\s+on\s+you)\b/ },
  { categoria: "jailbreak", re: /\b(jailbreak|modo\s+(desarrollador|dios|sin\s+restricciones|sin\s+filtros|developer)|developer\s+mode|do\s+anything\s+now|sin\s+restricciones|sin\s+filtros)\b/ },
  { categoria: "solicitud de secretos", re: /(api[\s_-]?key|apikey|clave\s+(de\s+)?(la\s+)?(api|modelo|gemini|google)|llave\s+de\s+(la\s+)?api|token\s+de\s+acceso|variables?\s+de\s+entorno|process\.env|\.env\b|credenciales|contrasena|password|\bsecretos?\b|x-goog)/ },
  { categoria: "ejecución de comandos", re: /\b(ejecuta\w*|corre|correr|lanza\w*|run|exec|eval)\b.{0,30}\b(comando|command|shell|bash|powershell|cmd|terminal|script|codigo)\b/s },
  { categoria: "ejecución de comandos", re: /(rm\s+-rf|\bsudo\b|\bcurl\s|\bwget\s|\/etc\/(passwd|shadow)|\/proc\/|cmd\.exe|powershell\s|<script|javascript:|union\s+select|drop\s+table)/ },
  { categoria: "ruta fuera de alcance", re: /(\.\.[\/\\]|file:\/\/|\b[a-z]:\\|~\/|\/root\b|\/home\/)/ },
  { categoria: "fuera de alcance", re: /\b(escrib\w*|redact\w*|genera\w*|cre[ae]\w*|haz\w*|dame|compon\w+|inventa\w*|cuent[ae]\w*)\b.{0,20}\b(un|una|unos|unas)\b.{0,12}\b(poema|poesia|cuento|cancion|chiste|ensayo|historia|receta|discurso|adivinanza|acrostico|haiku|carta)\b/s },
  { categoria: "fuera de alcance", re: /\b(escrib\w*|program\w*|genera\w*|cre[ae]\w*|desarroll\w*|dame|haz\w*)\b.{0,25}\b(codigo|script|funcion|programa|aplicacion|pagina\s+web|exploit|malware|virus|keylogger|ransomware|payload)\b/s },
  { categoria: "fuera de alcance", re: /\b(traduce|traducir|traduceme|translate)\b/ },
  { categoria: "fuera de alcance", re: /\b(chiste|horoscopo|receta\s+de|quien\s+gano|capital\s+de|clima\s+(en|de)|pronostico|cotizacion\s+del\s+dolar|noticias\s+de)\b/ },
];

export type Veredicto = { permitido: true } | { permitido: false; categoria: string };

export function revisarMensaje(texto: string): Veredicto {
  if (/\bDAN\b/.test(limpiarEntrada(texto))) return { permitido: false, categoria: "jailbreak" };
  const t = norm(texto);
  for (const r of REGLAS) if (r.re.test(t)) return { permitido: false, categoria: r.categoria };
  return { permitido: true };
}

// ── Filtro de salida ─────────────────────────────────────────────────────────

// Fragmentos del prompt de comportamiento que no deberían aparecer literalmente en una respuesta.
export function lineasSensibles(prompt: string): string[] {
  return prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim().slice(0, 70))
    .filter((l) => l.length >= 60 && !RECHAZO.includes(l));
}

// true si la respuesta contiene la marca secreta o líneas literales del prompt.
export function fugaDePrompt(respuesta: string, canario: string, lineas: string[]): boolean {
  if (respuesta.includes(canario)) return true;
  const r = respuesta.replace(/\s+/g, " ");
  return lineas.some((l) => r.includes(l));
}

// ── Correcciones respaldadas ─────────────────────────────────────────────────

const MONEDA_PALABRAS: Record<string, RegExp> = {
  COP: /\bcop\b|\bpesos?\b/, USD: /\busd\b|\bdolar(es)?\b/, PEN: /\bpen\b|\bsoles?\b/,
  PAB: /\bpab\b|\bbalboas?\b/, HNL: /\bhnl\b|\blempiras?\b/,
};
const PAIS_PALABRAS: Record<string, RegExp> = {
  CO: /\bco\b|colombia/, EC: /\bec\b|ecuador/, PE: /\bpe\b|peru/, PA: /\bpa\b|panama/, HN: /\bhn\b|honduras/,
};

// Fechas que el usuario escribió, en formato ISO: "2027-08-31", "31 de agosto de 2027" o "31/08/2027".
function fechasDe(texto: string): Set<string> {
  const out = new Set<string>(texto.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []);
  try {
    for (const f of findAllDates(texto)) out.add(fmt(f.y, f.m, f.d));
  } catch { /* una fecha inexistente no respalda nada */ }
  for (const m of texto.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)) {
    const [d, mes, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (fechaValida(y, mes, d)) out.add(fmt(y, mes, d));
  }
  return out;
}

// ¿El usuario escribió este valor en su mensaje? Una corrección solo es válida si viene del
// documento (la propuesta) o del usuario: así un modelo manipulado no puede inventar cifras.
export function valorEnMensaje(campo: string, valor: unknown, texto: string): boolean {
  const t = norm(texto);
  if (typeof valor === "number") {
    return (t.match(/\d[\d.,]*/g) ?? []).some((tok) => parseAmount(tok.replace(/[.,]+$/, "")) === valor);
  }
  if (typeof valor !== "string") return false;
  if (campo === "fecha_inicio" || campo === "fecha_fin") return fechasDe(limpiarEntrada(texto)).has(valor);
  if (campo === "moneda") return (MONEDA_PALABRAS[valor] ?? /$^/).test(t);
  if (campo === "pais") return (PAIS_PALABRAS[valor] ?? /$^/).test(t);
  if (campo === "nit_cliente") {
    return (t.match(/\d[\d.\-]*/g) ?? []).some((tok) => normalizarNIT(tok) === valor || tok.replace(/\D/g, "") === valor);
  }
  return t.includes(norm(valor));
}
