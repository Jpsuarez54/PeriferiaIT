# Asistente de Registro de Contratos Vigentes

Agente conversacional que actúa como punto único de recepción de contratos de Periferia IT Group. Lee un buzón de correos, extrae los datos de cada contrato con un nivel de confianza por campo, decide si es nuevo, una actualización, un duplicado o un rechazo, lo registra en un maestro tipo SharePoint, archiva el documento y genera alertas de vencimiento. Antes de registrar un dato dudoso, le pregunta a la analista.

**Link de prueba:** https://agente-contratos-gxtv.onrender.com · **Diseño completo y decisiones:** [`SOLUCION.md`](./SOLUCION.md) · **Especificación:** [`PRD.md`](./PRD.md)

## Cómo está hecho

Los contratos pueden llegar como texto o como PDF con capa de texto. Procesar el buzón completo cuesta unos USD 0,012 por contrato con Gemini 3.5 Flash; el cálculo está en `SOLUCION.md`.

El sistema separa tres cosas que suelen mezclarse en un agente:

| Capa | Archivo | Qué decide |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo conversa el agente, en qué orden usa las herramientas y qué nunca debe hacer. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Las reglas del proceso: cuándo algo es duplicado, qué pasa con las pólizas, qué entra en revisión. |
| Ejecución | `src/tools/contratos.ts` y `src/lib/` | Todo el trabajo real: leer, extraer, validar, registrar y alertar. Es código determinista. |

El modelo de lenguaje (Google Gemini) solo **orquesta**: decide qué herramienta llamar y redacta la respuesta. No extrae datos, no decide la clasificación y no escribe en el maestro. Por eso un error del modelo puede afectar cómo se explica algo en el chat, pero no lo que queda registrado.

```
Chat (web/)  →  Servidor (src/server.ts)  →  Ciclo del agente (src/agent/loop.ts)
                                                 ├─ Modelo: src/llm/gemini.ts, detrás de la interfaz src/llm/adapter.ts
                                                 └─ Herramientas: src/tools/contratos.ts → src/lib/*
                                                         ├─ lee:      fixtures/reto-02/   (buzón, maestro original, comerciales)
                                                         └─ escribe:  out/                (maestro, documentos, historial, logs, alertas)
```

### El ciclo del agente

En cada mensaje del usuario, el ciclo envía al modelo la conversación y la lista de herramientas. Si el modelo pide herramientas, el ciclo valida los argumentos con zod, las ejecuta y le devuelve el resultado. Se repite hasta que el modelo responde con texto, con un máximo de 25 vueltas. Si llega al tope, responde con lo que alcanzó a hacer y lo que falta. Cada llamada queda visible en el chat, con su nombre, argumentos y resultado, y en `out/log.jsonl`.

El agente procesa los seis correos del buzón en unas cinco llamadas al modelo, porque pide cada herramienta para todos los mensajes a la vez.

### Las herramientas

| Herramienta | Qué hace |
|---|---|
| `contratos_leer_buzon` | Lista los correos pendientes y si traen contrato. |
| `contratos_extraer` | Saca del texto del contrato id, cliente, NIT, país, objeto, valor, moneda, fechas y póliza, cada uno con su confianza. |
| `contratos_validar` | Clasifica (nuevo, actualización, duplicado, rechazado) y dice qué campos necesitan revisión y por qué. |
| `contratos_registrar` | Escribe en el maestro y archiva el documento. Si hay campos en revisión, se niega hasta recibir la confirmación. |
| `contratos_alertas` | Genera el reporte de vencimientos a 60 días, pólizas pendientes y registros desde el corte. |
| `contratos_leer_pdf` | Lee el texto de un documento archivado (PDF o texto), solo dentro de las carpetas permitidas. |

Cada herramienta es un objeto `{ description, args, execute }`. Sus argumentos se declaran con zod, y de esos mismos esquemas se genera la declaración que recibe el modelo. Las herramientas nunca lanzan errores: devuelven `{ ok: false, error }` con un motivo legible, así que un correo malo no detiene el lote.

### Extracción y confianza

La extracción usa expresiones regulares sobre las cláusulas del contrato (OBJETO, VALOR, PLAZO, GARANTÍAS). La confianza depende de **cómo** se obtuvo cada dato:

- Un dato escrito explícitamente tiene 0.95.
- Un dato calculado, como una fecha de fin a partir de un plazo en meses, tiene 0.85.
- Un dato inferido con un supuesto, como una firma "en agosto de 2026" sin día, baja a 0.6.

Todo campo con confianza menor a 0.8 entra en revisión con una nota que explica el motivo. Un campo que no aparece en el documento queda vacío y también entra en revisión: el sistema nunca lo rellena con un valor por defecto.

### Confirmación humana

La regla "no registrar nada dudoso sin preguntar" está en el código, no solo en el prompt:

1. `contratos_registrar` rechaza un contrato con campos en revisión si no recibe `confirmado=true`.
2. El ciclo solo acepta `confirmado=true` en un turno **posterior** al que mostró los campos dudosos. Así, el modelo no puede confirmarse a sí mismo.
3. Los valores que el usuario corrige viajan en `correcciones` y se validan con zod (fechas reales, monedas del catálogo).

En el chat, la confirmación aparece como una tarjeta con botones para confirmar o corregir.

### Lo que no puede inventar el modelo

El modelo nunca transporta los datos de un contrato de una herramienta a otra: solo pasa el id del mensaje, y cada herramienta vuelve a leer el documento. Además, `contratos_validar` le entrega el cliente, el número de contrato y el motivo de cada campo dudoso, para que los copie en vez de suponerlos.

### Límites de costo y seguridad

- Hay topes de 25 vueltas por mensaje, 400 000 tokens por conversación y 150 llamadas al modelo por día para todo el servidor.
- La clave del modelo solo existe como variable de entorno del servidor. No está en el repositorio, en el front, en los logs ni en las respuestas de la API.
- Ninguna herramienta ejecuta comandos, y la única que lee archivos está limitada a dos carpetas.
- Si Gemini está saturado o no responde, el adaptador pasa solo a un modelo de respaldo. Si todos fallan, el chat muestra el error y la conversación sigue viva.

### Front

El front es HTML, CSS y JavaScript sin framework, servido por el mismo proceso. Tiene la conversación, un panel plegable con las acciones ejecutadas en cada respuesta, la tarjeta de confirmación y sugerencias para empezar.

### Módulo reutilizable (`modulo/`)

Es el mismo agente empaquetado para otras plataformas de agentes:

- `agent.md` contiene el prompt.
- `skill/registro-contratos/SKILL.md` contiene el conocimiento del proceso.
- `tools/contratos.ts` reexporta las mismas herramientas de la aplicación.

`agent.md` y `SKILL.md` se generan desde los archivos de la app con `bun run modulo`, así que no pueden quedar desactualizados.

## Estructura

```
agent/prompt.md                      comportamiento del agente
src/knowledge/registro-contratos.md  reglas del proceso
src/tools/contratos.ts               herramientas (contratos_<export>)
src/lib/                             extracción, validación, registro, alertas, CSV
src/agent/                           ciclo del agente, conversaciones y tope diario
src/llm/                             interfaz del proveedor e implementación Gemini
src/server.ts                        API HTTP y archivos del front
web/                                 chat
demo.ts                              recorrido completo sin modelo
modulo/                              agente empaquetado y reutilizable
fixtures/reto-02/                    datos de entrada del reto (solo lectura)
```

## Ejecutar

Se necesita [Bun](https://bun.sh) 1.2 o superior.

```bash
bun install && bun run demo.ts   # recorrido completo con las herramientas, sin modelo ni clave
bun run dev                      # chat en http://localhost:3000; requiere GEMINI_API_KEY en .env
```

Variables de entorno (ver `.env.example`):

| Variable | Obligatoria | Por defecto |
|---|---|---|
| `GEMINI_API_KEY` | Sí, para el chat | — |
| `MODEL` | No | `gemini-3.5-flash` |
| `MODEL_FALLBACKS` | No | `gemini-3.5-flash-lite,gemini-3.1-flash-lite` |
| `MAX_ITERATIONS` | No | `25` |
| `MAX_TOKENS_PER_SESSION` | No | `400000` |
| `MAX_LLM_CALLS_PER_DAY` | No | `150` |
| `LLM_TIMEOUT_MS` | No | `45000` |
| `PRICE_INPUT_PER_M` / `PRICE_OUTPUT_PER_M` | No | `1.5` / `9` (USD por millón de tokens, para el costo informado) |

API: `POST /api/chat` `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokens, consumo }` · `GET /api/sessions/:id` · `GET /api/health` · `POST /api/reset`. El link público no tiene clave de acceso.
