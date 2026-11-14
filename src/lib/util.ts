// Utilidades de texto y fechas. Sin dependencias externas.

export const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export const MES_RE =
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";

export function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseISO(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// días de `a` a `b` (b - a), o null si no se puede calcular
export function daysBetween(a: string, b: string): number | null {
  const da = parseISO(a), db = parseISO(b);
  if (!da || !db) return null;
  const ta = Date.UTC(da.y, da.m - 1, da.d);
  const tb = Date.UTC(db.y, db.m - 1, db.d);
  return Math.round((tb - ta) / 86400000);
}

export function lastDayOfMonth(y: number, m1: number): number {
  return new Date(y, m1, 0).getDate(); // m1 base-1: new Date(y, m1, 0) = último día del mes m1
}

// Suma n meses a una fecha (base-1 para m). Recorta el día si excede el último día del mes destino.
export function addMonths(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = lastDayOfMonth(ny, nm);
  return { y: ny, m: nm, d: Math.min(d, last) };
}

// Encuentra todas las fechas completas "primero (1) de agosto de 2026" del texto.
export function findAllDates(text: string): { y: number; m: number; d: number }[] {
  const re = new RegExp(String.raw`\(?(\d{1,2})\)?\s+de\s+(${MES_RE})\s+de\s+(\d{4})`, "gi");
  const out: { y: number; m: number; d: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const mes = MESES[(m[2] ?? "").toLowerCase()];
    if (!mes) continue;
    const f = { y: Number(m[3]), m: mes, d: Number(m[1]) };
    if (!fechaValida(f.y, f.m, f.d)) throw new Error(`fecha inválida en el documento: "${m[0].trim()}"`);
    out.push(f);
  }
  return out;
}

// Fecha de firma del documento. Devuelve d=null si el día no está explícito.
export function parseSigningDate(text: string): { y: number; m: number; d: number | null } | null {
  const re1 = new RegExp(
    String.raw`a\s+los\s+(?:[\wáéíóú]+\s+)?\((\d{1,2})\)\s+d[ií]as\s+del\s+mes\s+de\s+(${MES_RE})\s+de\s+(\d{4})`,
    "i"
  );
  const m1 = text.match(re1);
  const mes1 = m1 ? MESES[(m1[2] ?? "").toLowerCase()] : undefined;
  if (m1 && mes1) {
    const f = { y: Number(m1[3]), m: mes1, d: Number(m1[1]) };
    if (!fechaValida(f.y, f.m, f.d)) throw new Error(`fecha de firma inválida en el documento: "${m1[0].trim()}"`);
    return f;
  }
  const re2 = new RegExp(String.raw`mes\s+de\s+(${MES_RE})\s+de\s+(\d{4})`, "i");
  const m2 = text.match(re2);
  const mes2 = m2 ? MESES[(m2[1] ?? "").toLowerCase()] : undefined;
  if (m2 && mes2) return { y: Number(m2[2]), m: mes2, d: null };
  return null;
}

// "890.900.111-4" | "1790012345001" -> "890900111" | "1790012345001" (sin dígito de verificación ni puntos)
export function normalizarNIT(raw: string): string {
  let s = raw.trim();
  const hy = s.indexOf("-");
  if (hy >= 0) s = s.slice(0, hy);
  return s.replace(/[.,\s]/g, "");
}

// "265.000.000" | "120,000.00" -> 265000000 | 120000
export function parseAmount(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  const dec = t.match(/[.,](\d{1,2})$/); // parte decimal (1-2 dígitos al final)
  if (dec) t = t.slice(0, dec.index);
  const digits = t.replace(/[.,\s]/g, "");
  if (!digits) return null;
  return Number(digits);
}

export function slugify(s: string): string {
  const t = s
    .replace(/\bS\.?\s*A\.?\s*S\.?\b/gi, " ")
    .replace(/\bS\.?\s*A\.?\s*C\.?\b/gi, " ")
    .replace(/\bS\.?\s*de\s*R\.?\s*L\.?\b/gi, " ")
    .replace(/\bS\.?\s*A\.?\b/gi, " ")
    .replace(/\bLtda\.?\b/gi, " ");
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Similitud de Jaccard sobre tokens (>=0.9 = mismo objeto). Stopwords en español.
export function similitud(a: string, b: string): number {
  const stop = new Set([
    "de", "la", "el", "los", "las", "y", "o", "del", "al", "en", "para", "por", "con",
    "a", "que", "se", "su", "sus", "un", "una", "unos", "unas", "es", "ser",
  ]);
  const tok = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !stop.has(w));
  const A = new Set(tok(a)), B = new Set(tok(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// "INDUSTRIAS DELTA S.A.S." -> "Industrias Delta S.A.S." (solo si viene todo en mayúsculas),
// para que coincida con el formato del maestro. Las siglas con punto se conservan.
export function razonSocial(s: string): string {
  if (s !== s.toLocaleUpperCase("es")) return s;
  const menores = new Set(["de", "del", "y", "e"]); // "Los Andes", "La Sabana": artículos de nombre propio se capitalizan
  return s
    .split(/\s+/)
    .map((w, i) => {
      if (w.includes(".")) return w.toLocaleUpperCase("es");
      const l = w.toLocaleLowerCase("es");
      if (i > 0 && menores.has(l)) return l;
      return l.charAt(0).toLocaleUpperCase("es") + l.slice(1);
    })
    .join(" ");
}

// true si la fecha existe en el calendario (rechaza 31 de febrero, mes 13, etc.).
export function fechaValida(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && m >= 1 && m <= 12 && d >= 1 && d <= lastDayOfMonth(y, m);
}

export function esFechaISO(s: string): boolean {
  const p = parseISO(s);
  return p !== null && /^\d{4}-\d{2}-\d{2}$/.test(s) && fechaValida(p.y, p.m, p.d);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}
