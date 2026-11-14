# Agente conversacional — Registro de Contratos Vigentes (Reto 02)

Agente en TypeScript y Bun que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos con nivel de confianza, detecta duplicados y otrosíes, registra en un maestro tipo SharePoint, archiva el documento y genera alertas de vencimiento. Pide confirmación humana antes de registrar cualquier campo dudoso.

- Especificación: [`PRD.md`](./PRD.md)
- Arquitectura, decisiones y regla de gobierno: [`SOLUCION.md`](./SOLUCION.md)
- **Link de prueba:** https://agente-contratos-gxtv.onrender.com (público, sin clave de acceso)

## Requisitos

- [Bun](https://bun.sh) 1.2 o superior.
- Una API key gratuita de Google Gemini (solo para el chat; la demo no la necesita). Se obtiene en https://aistudio.google.com con "Get API key".

## Demo sin modelo

Procesa los 6 mensajes del buzón llamando directamente a las herramientas. No necesita clave.

```bash
bun install && bun run demo.ts
```

Borra `out/` al inicio, así que da el mismo resultado en cada ejecución.

## Levantar el chat en local

```bash
cp .env.example .env      # y pon tu GEMINI_API_KEY
bun install && bun run dev
```

Abre http://localhost:3000. El botón "Reiniciar datos" borra `out/` para repetir la prueba desde el maestro original.

Prompt de ejemplo:

> Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.

Y después: `Confirmo el valor 0 y la fecha fin 2027-08-31`.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `GEMINI_API_KEY` | Sí, para el chat | — | Clave del modelo. Solo vive en el backend. |
| `MODEL` | No | `gemini-3.5-flash` | Modelo principal. |
| `MODEL_FALLBACKS` | No | `gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Respaldos si el principal está saturado. |
| `MAX_ITERATIONS` | No | `25` | Llamadas al modelo por turno. |
| `MAX_TOKENS_PER_SESSION` | No | `400000` | Tope de tokens por sesión. |
| `LLM_TIMEOUT_MS` | No | `45000` | Tiempo máximo por llamada al modelo. |
| `PORT` | No | `3000` | Puerto HTTP. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokens }` |
| `GET` | `/api/sessions/:id` | `{ id, historial[], tokens, pendientes[] }` |
| `GET` | `/api/health` | `{ ok, provider, model }`, sin la clave |
| `POST` | `/api/reset` | Borra `out/` y las sesiones. |

`toolCalls[]` trae `{ name, args, ok, resumen }` por cada herramienta llamada en el turno.

## Desplegar en Render (gratis)

1. Sube el repo a GitHub.
2. En https://render.com: **New → Blueprint**, elige el repo. Render lee `render.yaml` y construye con el `Dockerfile`.
3. Cuando lo pida, pega tu `GEMINI_API_KEY`.
4. La URL queda como `https://agente-contratos-XXXX.onrender.com`.

En el plan gratuito, el servicio se duerme tras 15 minutos sin uso y tarda unos 30–60 s en despertar. Ábrelo un par de minutos antes de la defensa. `out/` no es persistente en ese plan: se pierde al reiniciar, lo que equivale a "Reiniciar datos".

## Otros comandos

```bash
bun run typecheck        # tsc --noEmit en modo estricto
bun run modulo           # regenera modulo/agent.md y SKILL.md desde agent/ y src/knowledge/
bun run modulo --check   # falla si modulo/ no coincide con la app
```

## Estructura

```
agent/prompt.md                      comportamiento (system prompt)
src/knowledge/registro-contratos.md  conocimiento del proceso
src/tools/contratos.ts               herramientas zod (contratos_<export>)
src/lib/                             extracción, validación, registro, alertas, CSV
src/agent/                           ciclo del agente y sesiones
src/llm/                             interfaz del proveedor + Gemini
src/server.ts                        API HTTP y archivos del front
web/                                 chat (HTML + JS sin framework)
demo.ts                              verificación sin modelo
modulo/                              bonus: agente empaquetado y reutilizable
fixtures/reto-02/                    insumos (solo lectura)
out/                                 generado en ejecución (no se versiona)
```
