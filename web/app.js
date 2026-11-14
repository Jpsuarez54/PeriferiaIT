// Front del chat: sin dependencias. Muestra llamadas a herramientas y resalta confirmaciones.
const $ = (s) => document.querySelector(s);
const chat = $("#chat"), form = $("#form"), entrada = $("#entrada"), enviar = $("#enviar"), pensando = $("#pensando");

function nuevoId() { return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
let sessionId = localStorage.getItem("sessionId") || nuevoId();
localStorage.setItem("sessionId", sessionId);

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Markdown mínimo: tablas, encabezados, listas, negrita, código. El texto se escapa antes.
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function celdas(linea) { return linea.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()); }
function markdown(texto) {
  const lineas = String(texto || "").split(/\r?\n/);
  let html = "", i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (/^\s*\|/.test(l) && i + 1 < lineas.length && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1])) {
      const cab = celdas(l); i += 2;
      let filas = "";
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) { filas += "<tr>" + celdas(lineas[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
      html += `<table><thead><tr>${cab.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${filas}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      let items = "";
      while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) { items += `<li>${inline(lineas[i].replace(/^\s*[-*]\s+/, ""))}</li>`; i++; }
      html += `<ul>${items}</ul>`; continue;
    }
    const h = l.match(/^(#{1,3})\s+(.*)/);
    if (h) html += `<h3>${inline(h[2])}</h3>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}

function vistaTool(t) {
  const args = JSON.stringify(t.args ?? {}, null, 1);
  return `<details class="tool ${t.ok ? "" : "falla"}"><summary>${t.ok ? "✔" : "✖"} <span class="nombre">${esc(t.name)}</span>(${esc(Object.values(t.args ?? {}).filter((v) => typeof v !== "object").join(", "))}) → ${esc(t.resumen)}</summary><pre>argumentos: ${esc(args)}</pre></details>`;
}

function agregar(e) {
  const div = document.createElement("div");
  div.className = `msg ${e.role}${e.needsConfirmation ? " confirmar" : ""}${e.error ? " error" : ""}`;
  let html = "";
  if (e.needsConfirmation) html += `<div class="badge">⚠ Requiere tu confirmación</div>`;
  if (e.toolCalls?.length) html += `<div class="herramientas">${e.toolCalls.map(vistaTool).join("")}</div>`;
  html += `<div class="contenido">${e.role === "user" ? `<p>${esc(e.text)}</p>` : markdown(e.text)}</div>`;
  div.innerHTML = html;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function cargarHistorial() {
  chat.innerHTML = "";
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (r.ok) (await r.json()).historial.forEach(agregar);
  else agregar({ role: "assistant", text: "Hola. Puedo procesar el buzón de contratos, pedirte confirmación de lo dudoso y generar el reporte de alertas. Prueba con la sugerencia de abajo.", toolCalls: [] });
}

async function salud() {
  try {
    const h = await (await fetch("/api/health")).json();
    $("#estado").textContent = h.model ? `Modelo: ${h.model} · sesión ${sessionId}` : "Sin clave de modelo configurada en el servidor";
  } catch { $("#estado").textContent = "Servidor no disponible"; }
}

async function mandar(texto) {
  agregar({ role: "user", text: texto });
  enviar.disabled = true; pensando.hidden = false;
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: texto }) });
    const d = await r.json();
    agregar(r.ok ? { role: "assistant", ...d, text: d.reply } : { role: "assistant", text: `Error: ${d.error}`, error: true });
  } catch {
    agregar({ role: "assistant", text: "No pude contactar al servidor. Revisa tu conexión y reintenta.", error: true });
  } finally { enviar.disabled = false; pensando.hidden = true; entrada.focus(); }
}

form.addEventListener("submit", (ev) => { ev.preventDefault(); const t = entrada.value.trim(); if (!t || enviar.disabled) return; entrada.value = ""; mandar(t); });
entrada.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
document.querySelectorAll(".sug").forEach((b) => b.addEventListener("click", () => { entrada.value = b.textContent; entrada.focus(); }));
$("#nueva").addEventListener("click", () => { sessionId = nuevoId(); localStorage.setItem("sessionId", sessionId); cargarHistorial(); salud(); });
$("#reset").addEventListener("click", async () => {
  if (!confirm("¿Borrar los datos generados (out/) y empezar con el maestro original?")) return;
  const r = await fetch("/api/reset", { method: "POST" });
  if (r.ok) { sessionId = nuevoId(); localStorage.setItem("sessionId", sessionId); await cargarHistorial(); salud(); }
  else alert("No se pudo reiniciar: " + (await r.json()).error);
});

salud(); cargarHistorial();
