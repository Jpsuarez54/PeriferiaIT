// Front del chat, sin dependencias. Muestra cada llamada a herramienta y resalta las confirmaciones.
const $ = (s) => document.querySelector(s);
const chat = $("#chat"), scroll = $("#scroll"), form = $("#form"), entrada = $("#entrada"), enviar = $("#enviar");

const ICONOS = {
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  alerta: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  pasos: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" class="chevron"><path d="m6 9 6 6 6-6"/></svg>',
};

const NOMBRES = {
  contratos_leer_buzon: "Leer buzón", contratos_extraer: "Extraer datos", contratos_validar: "Validar",
  contratos_registrar: "Registrar", contratos_alertas: "Generar alertas", contratos_leer_pdf: "Leer documento",
};

const SUGERENCIAS = [
  { titulo: "Procesar el buzón", texto: "Clasifica, registra lo limpio y pregunta lo dudoso.",
    mensaje: "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme." },
  { titulo: "Ver pendientes", texto: "Qué mensajes hay sin procesar y qué trae cada uno.",
    mensaje: "¿Qué mensajes hay pendientes en el buzón y qué trae cada uno?" },
  { titulo: "Reporte de alertas", texto: "Vencimientos a 60 días y pólizas pendientes.",
    mensaje: "Genera el reporte de alertas con fecha de hoy 2026-09-03." },
];

// El id es la única credencial para leer una conversación: aleatorio y largo (UUID).
function nuevoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
const ID_OK = /^[A-Za-z0-9_-]{16,64}$/;
// ?s=<id> abre una conversación concreta (útil para compartirla durante la revisión).
const idUrl = new URLSearchParams(location.search).get("s");
const idGuardado = localStorage.getItem("sessionId");
let sessionId = (ID_OK.test(idUrl ?? "") ? idUrl : null) || (ID_OK.test(idGuardado ?? "") ? idGuardado : null) || nuevoId();
localStorage.setItem("sessionId", sessionId);
let ocupado = false;

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Markdown mínimo y seguro: el texto se escapa antes de dar formato.
// El modelo a veces escribe símbolos en LaTeX ($\le$); se muestran como texto normal.
const LATEX = { "\\le": "≤", "\\leq": "≤", "\\ge": "≥", "\\geq": "≥", "\\times": "×", "\\to": "→", "\\rightarrow": "→" };
function sinLatex(s) { return String(s ?? "").replace(/\$(\\[a-z]+)\$/g, (m, c) => LATEX[c] ?? m); }

function inline(s) {
  return esc(sinLatex(s))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}
function celdas(l) { return l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()); }
function markdown(texto) {
  const L = String(texto || "").split(/\r?\n/);
  let html = "", i = 0;
  while (i < L.length) {
    const l = L[i];
    if (/^\s*\|/.test(l) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      const cab = celdas(l); i += 2; let filas = "";
      while (i < L.length && /^\s*\|/.test(L[i])) { filas += "<tr>" + celdas(L[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
      html += `<div class="tabla"><table><thead><tr>${cab.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${filas}</tbody></table></div>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      let it = "";
      while (i < L.length && /^\s*[-*]\s+/.test(L[i])) { it += `<li>${inline(L[i].replace(/^\s*[-*]\s+/, ""))}</li>`; i++; }
      html += `<ul>${it}</ul>`; continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      let it = "";
      while (i < L.length && /^\s*\d+[.)]\s+/.test(L[i])) { it += `<li>${inline(L[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`; i++; }
      html += `<ol>${it}</ol>`; continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) html += "<hr>";
    else if (/^#{1,6}\s+/.test(l)) html += `<h3>${inline(l.replace(/^#{1,6}\s+/, ""))}</h3>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}

// Argumentos completos de la llamada: "mensaje_id: msg-006 · confirmado: true · correcciones: {...}".
function argsTexto(args) {
  const partes = Object.entries(args ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return partes.length ? partes.join(" · ") : "sin argumentos";
}

function vistaPasos(calls) {
  if (!calls?.length) return "";
  const fallas = calls.filter((c) => !c.ok).length;
  const filas = calls.map((c) => `<li class="paso ${c.ok ? "ok" : "falla"}">${c.ok ? ICONOS.check : ICONOS.alerta}
      <div class="paso-txt">
        <div class="paso-cab"><span class="herr">${esc(NOMBRES[c.name] ?? c.name)}</span><code class="tecnico">${esc(c.name)}</code></div>
        <div class="paso-args">${esc(argsTexto(c.args))}</div>
      </div>
      <span class="res">${esc(c.resumen)}</span></li>`).join("");
  const nota = fallas ? ` · <span class="nota-paso">${fallas} con observación</span>` : "";
  return `<details class="pasos"><summary>${ICONOS.pasos}<span>${calls.length} ${calls.length === 1 ? "acción ejecutada" : "acciones ejecutadas"}${nota}</span>${ICONOS.chevron}</summary><ul class="lista-pasos">${filas}</ul></details>`;
}

function bajar() { scroll.scrollTop = scroll.scrollHeight; }

function agregar(e, { interactivo = false } = {}) {
  chat.querySelector(".bienvenida")?.remove();
  const fila = document.createElement("div");
  if (e.role === "user") {
    fila.className = "fila usuario";
    fila.innerHTML = `<div class="burbuja">${esc(e.text)}</div>`;
  } else {
    fila.className = "fila";
    let html = `<img src="/logo.svg" alt="" class="avatar"><div class="cuerpo"><div class="autor">Asistente</div>${vistaPasos(e.toolCalls)}`;
    if (e.error) {
      html += `<div class="tarjeta error-msg">${ICONOS.error}<div><h4>No pude completar la respuesta</h4><p>${esc(e.text)}</p></div></div>`;
    } else {
      html += `<div class="md">${markdown(e.text)}</div>`;
    }
    if (e.needsConfirmation) {
      html += `<div class="tarjeta confirmar">${ICONOS.alerta}<div><h4>Se necesita tu confirmación</h4>
        <p>Hay contratos con campos dudosos que no se registrarán hasta que los confirmes o corrijas.</p>
        ${interactivo ? `<div class="botones"><button type="button" class="btn primario" data-accion="confirmar">Confirmar valores propuestos</button>
        <button type="button" class="btn" data-accion="corregir">Corregir un valor</button></div>` : ""}</div></div>`;
    }
    fila.innerHTML = html + "</div>";
    fila.querySelector('[data-accion="confirmar"]')?.addEventListener("click", (ev) => {
      desactivarBotones(ev.target.closest(".botones"));
      mandar("Confirmo los valores propuestos para los contratos en revisión.");
    });
    fila.querySelector('[data-accion="corregir"]')?.addEventListener("click", () => {
      entrada.value = "Corrijo: ";
      ajustar(); entrada.focus();
    });
  }
  chat.appendChild(fila);
  bajar();
  return fila;
}

function desactivarBotones(cont) { cont?.querySelectorAll("button").forEach((b) => { b.disabled = true; }); }

function bienvenida() {
  chat.innerHTML = `<section class="bienvenida">
    <img src="/logo.svg" alt="" class="logo-grande">
    <h2>¿En qué te ayudo hoy?</h2>
    <p>Leo el buzón de contratos, extraigo los datos, detecto duplicados y otrosíes, registro en el maestro y te aviso qué vence. Antes de registrar algo dudoso, te pregunto.</p>
    <div class="sugerencias">${SUGERENCIAS.map((s, i) => `<button type="button" class="sugerencia" data-i="${i}"><strong>${esc(s.titulo)}</strong><span>${esc(s.texto)}</span></button>`).join("")}</div>
  </section>`;
  chat.querySelectorAll(".sugerencia").forEach((b) => b.addEventListener("click", () => mandar(SUGERENCIAS[Number(b.dataset.i)].mensaje)));
}

async function cargarHistorial() {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!r.ok) return bienvenida();
    const { historial } = await r.json();
    if (!historial.length) return bienvenida();
    chat.innerHTML = "";
    historial.forEach((e, i) => agregar(e, { interactivo: i === historial.length - 1 }));
    // ?abrir=1 despliega los paneles de acciones (útil para revisar o capturar la conversación).
    if (new URLSearchParams(location.search).get("abrir") === "1") chat.querySelectorAll(".pasos").forEach((d) => { d.open = true; });
  } catch { bienvenida(); }
}

async function salud() {
  const estado = $("#estado"), texto = $("#estado-texto");
  try {
    const h = await (await fetch("/api/health")).json();
    estado.className = "estado " + (h.model ? "en-linea" : "caido");
    texto.textContent = h.model ? `En línea · ${h.model}` : "Sin modelo configurado";
  } catch { estado.className = "estado caido"; texto.textContent = "Sin conexión"; }
}

function escribiendo() {
  const fila = document.createElement("div");
  fila.className = "fila";
  fila.innerHTML = `<img src="/logo.svg" alt="" class="avatar"><div class="cuerpo"><div class="autor">Asistente</div>
    <div class="escribiendo"><span class="puntos"><i></i><i></i><i></i></span><span>Trabajando en tu solicitud… puede tardar hasta un minuto</span></div></div>`;
  chat.appendChild(fila); bajar();
  return fila;
}

async function mandar(texto) {
  if (ocupado || !texto.trim()) return;
  ocupado = true; enviar.disabled = true;
  chat.querySelectorAll(".botones").forEach(desactivarBotones);
  agregar({ role: "user", text: texto });
  const espera = escribiendo();
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: texto }) });
    const d = await r.json();
    espera.remove();
    agregar(r.ok ? { role: "assistant", ...d, text: d.reply } : { role: "assistant", text: d.error, error: true }, { interactivo: true });
  } catch {
    espera.remove();
    agregar({ role: "assistant", text: "No pude contactar al servidor. Revisa tu conexión y vuelve a intentarlo.", error: true });
  } finally {
    ocupado = false; actualizarBoton(); entrada.focus();
  }
}

function ajustar() { entrada.style.height = "auto"; entrada.style.height = Math.min(entrada.scrollHeight, 200) + "px"; actualizarBoton(); }
function actualizarBoton() { enviar.disabled = ocupado || !entrada.value.trim(); }

form.addEventListener("submit", (ev) => { ev.preventDefault(); const t = entrada.value.trim(); if (!t) return; entrada.value = ""; ajustar(); mandar(t); });
entrada.addEventListener("input", ajustar);
entrada.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
$("#nueva").addEventListener("click", () => { if (ocupado) return; sessionId = nuevoId(); localStorage.setItem("sessionId", sessionId); bienvenida(); entrada.focus(); });
$("#reset").addEventListener("click", async () => {
  if (ocupado || !confirm("¿Reiniciar los datos? Se borran los registros de esta prueba y el maestro vuelve a su estado original.")) return;
  const r = await fetch("/api/reset", { method: "POST" });
  if (!r.ok) return alert("No se pudo reiniciar: " + (await r.json()).error);
  sessionId = nuevoId(); localStorage.setItem("sessionId", sessionId); bienvenida();
});

actualizarBoton(); salud(); cargarHistorial();
