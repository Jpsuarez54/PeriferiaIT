# SOLUCIÓN — Agente de Registro de Contratos Vigentes

## 1. Problema en una frase

El maestro de contratos está congelado desde el 2026-05-30 y solo llegan los contratos con póliza, así que la analista administrativa y la gerencia no saben qué contratos están vigentes, cuáles vencen ni qué pólizas faltan.

## 2. Arquitectura

```
┌───────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/ (chat)   │ ────────────────▶ │ src/server.ts  (Bun.serve)                   │
│ historial     │ ◀──────────────── │   └ src/agent/loop.ts   ciclo del agente     │
│ tool calls    │  reply, toolCalls │        ├ src/llm/adapter.ts  interfaz LLM    │
│ confirmación  │  needsConfirmation│        │   └ src/llm/gemini.ts implementación│
└───────────────┘                   │        └ src/tools/contratos.ts (zod)        │
                                    │              └ src/lib/*  extracción, reglas │
                                    └───────────┬───────────────────┬──────────────┘
                                                │                   │
                                  fixtures/ (solo lectura)   out/ (escritura)
                                                             ├ sharepoint/maestro-contratos.csv
                                                             ├ sharepoint/Contratos/<año>/<cliente>/<id>.txt
                                                             ├ sharepoint/historial.jsonl
                                                             ├ procesados.json, log.jsonl, alertas.md
                                                             └ sessions/<id>.json
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Reglas de conducta del agente, orden de trabajo y formato de respuesta. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Reglas de negocio RN1–RN6, confianza, pólizas, alertas. Se concatena al prompt al arrancar. |
| Ejecución | `src/tools/contratos.ts` + `src/lib/` | Las 6 herramientas tipadas con zod y toda la lógica determinista. Importables desde `demo.ts` sin servidor. |

Cambiar una regla de negocio toca `src/lib/` y `src/knowledge/`, nunca `src/server.ts`.

## 3. Ciclo del agente

`src/agent/loop.ts`, función `correrTurno`:

1. Agrega el mensaje del usuario al historial de la sesión.
2. Llama al modelo con el system prompt, el historial y la declaración de herramientas (JSON Schema generado desde los esquemas zod en `src/llm/schema.ts`).
3. Si el modelo pide herramientas, valida los argumentos con zod (`safeParse`); si no cumplen, devuelve el error al modelo en vez de ejecutar. Ejecuta, registra el resumen para el front y en `out/log.jsonl`, y vuelve al paso 2.
4. Si el modelo responde texto sin pedir herramientas, termina el turno.

**Topes (costo):** `MAX_ITERATIONS` (25) llamadas al modelo por turno y `MAX_TOKENS_PER_SESSION` (400 000) por sesión. Al llegar a cualquiera, el agente responde qué hizo y que falta continuar. El servidor además limita el mensaje a 4 000 caracteres y permite un solo turno a la vez por sesión.

**Confirmación humana (CA3), aplicada en el código y no solo en el prompt:**
- `contratos_registrar` sin `confirmado=true` rechaza cualquier contrato con campos de confianza < 0.8 y devuelve `requiere revisión: valor, fecha_fin`.
- El ciclo guarda ese `mensaje_id` como *pendiente* de la sesión y marca la respuesta con `needsConfirmation=true`; el front la resalta en amarillo.
- En el **mismo turno**, el ciclo rechaza cualquier `confirmado=true`: solo se acepta para un `mensaje_id` que quedó pendiente en un turno **anterior**. Así el modelo no puede autoconfirmarse aunque desobedezca el prompt.
- Si el usuario da un valor distinto al extraído, el modelo lo pasa en `correcciones` (validado con zod: fechas ISO reales, moneda del catálogo, valor no negativo).

**CA2 (el modelo no inventa valores):** el modelo nunca transporta el contrato. `contratos_validar` y `contratos_registrar` reciben solo `mensaje_id` y releen el documento. El campo `contrato` existe en el esquema para `demo.ts`, pero no se le declara al modelo.

**CA5 (errores):** un error del proveedor se convierte en un mensaje claro en el chat, se descarta el turno incompleto del historial y la sesión sigue viva.

## 4. Elección del modelo

- **Proveedor:** Google Gemini, API `generateContent`. Elegido porque tiene capa gratuita con *function calling*, sin tarjeta de crédito.
- **Modelo:** `gemini-3.5-flash`, con respaldo automático a `gemini-3.5-flash-lite` y `gemini-3.1-flash-lite`. Durante las pruebas `gemini-3.8-flash` no respondió en 40–90 s, devolvió 503 por alta demanda y 429 por la cuota gratuita de 20 peticiones; por eso el adaptador cambia de modelo ante 429, 503, 404 o timeout.
- **Por qué un modelo "flash":** el trabajo pesado (extraer, validar, registrar) es determinista. El modelo solo orquesta herramientas y redacta la respuesta, así que no necesita el modelo más caro.
- **Costo por caso (medido):** en la prueba de punta a punta con el prompt de ejemplo del PRD, el lote de 6 mensajes usó 4 llamadas al modelo y 18 066 tokens; la confirmación de msg-006 usó 14 548 tokens más. Total: 32 614 tokens, unos **5 400 tokens por mensaje procesado**. Lo bajo se logra porque el agente llama cada herramienta en paralelo para todos los mensajes en una sola respuesta.
- **Costo en dinero:** en la capa gratuita, USD 0. En la capa de pago, costo ≈ tokens de entrada × precio de entrada + tokens de salida × precio de salida, con los precios vigentes de Google AI. La mayor parte son tokens de entrada, porque el historial y la declaración de herramientas se reenvían en cada llamada.
- **Límite práctico:** la capa gratuita tiene cuotas diarias bajas por modelo (en las pruebas, 20 peticiones para `gemini-3.8-flash`). Cada procesamiento completo usa unas 6 peticiones.

Cambiar de proveedor = escribir otra clase que implemente `LLMAdapter` (`enviar(system, mensajes, herramientas)`) y crearla en `crearLLM()` de `src/server.ts`. El ciclo no cambia.

## 5. Estrategia de extracción

Todo es determinista (`src/lib/extract.ts`); el modelo no extrae.

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| `id_contrato` | Primer código `XX-AAAA-N` del documento. | 0.95 |
| `cliente` | Primera razón social después de "Entre (los suscritos,)". | 0.92 |
| `nit_cliente` | Número tras `NIT`/`RUC`, sin puntos ni dígito de verificación. | 0.95 |
| `pais` | Longitud del identificador: 13 EC, 14 HN, 11 PE, 9 CO (PA si hay balboas o Panamá). | 0.85–0.9 |
| `objeto` | Cuerpo de la cláusula OBJETO, máx. 200 caracteres. | 0.85 |
| `valor`, `moneda` | Cláusula VALOR: `COP $265.000.000`, `USD 120,000.00`. Si dice "no tiene un valor determinado": `valor=0`, `valor_indeterminado=true`. | 0.95 explícito · **0.5 por demanda** |
| `fecha_inicio`, `fecha_fin` | Cláusula PLAZO: fechas "(1) de agosto de 2026". En otrosí, la única fecha es la nueva `fecha_fin`. Si el plazo es "N meses desde la firma", se suma a la fecha de firma; si la firma no tiene día ("en el mes de agosto de 2026") se usa el último día del mes. | 0.95 explícitas · 0.85 derivada · **0.6 derivada de firma sin día** |
| Póliza | Cláusula GARANTÍAS / póliza. En un contrato marco, la póliza condicionada a órdenes de servicio futuras no obliga hoy (`requiere_poliza=false`). | 0.85–0.95 |

Las confianzas son reglas fijas por *cómo* se obtuvo el valor (explícito, derivado o inferido), no probabilidades. Cualquier campo < 0.8 entra en `requiere_revision`. Con esto msg-006 queda en revisión exactamente en `valor` y `fecha_fin`, como pide el PRD.

**Clasificación** (`src/lib/validate.ts`), en este orden: sin adjunto de contrato → `rechazado`; sin partes ni objeto → `rechazado`; otrosí → `actualizacion` del contrato referenciado; mismo `id_contrato` con iguales valor y fechas → `duplicado`; mismo `id_contrato` con diferencias → `actualizacion`; mismo NIT con objeto de similitud de Jaccard ≥ 0.9 → `actualizacion`; si no, `nuevo`. Un NIT repetido con otro id y otro objeto es contrato nuevo (pasa en msg-001, msg-002 y msg-006).

## 6. Regla de gobierno (propuesta)

**Dueña del proceso:** la Analista Administrativa es la dueña del maestro de contratos. La Gerencia Administrativa es su respaldo y la instancia de escalamiento. No hay área legal, así que nadie revisa cláusulas; la regla solo asegura que todo contrato quede registrado.

1. **Canal único.** Todo contrato se envía a `contratos@periferia-ficticia.com`. Lo administra la Analista Administrativa y el agente lo procesa. Los contratos que lleguen a correos personales no cuentan como entregados.
2. **Obligación del comercial.** El comercial dueño de la cuenta envía, **dentro de los 3 días hábiles siguientes a la firma**:
   - el PDF firmado por ambas partes (tenga o no póliza);
   - todo otrosí, acta de inicio, prórroga y acta de terminación o liquidación.
   Formato de asunto: `[CONTRATO|OTROSI|TERMINACION] <id_contrato> - <cliente>`, por ejemplo `[OTROSI] CT-2026-011 - Minera Los Andes`.
3. **Acuse automático.** En menos de 1 hora hábil el agente responde al remitente con: clasificación (nuevo, actualización, duplicado o rechazado), `id_contrato`, ruta de archivo y, si aplica, los campos que la analista debe confirmar o el motivo del rechazo.
4. **Excepciones y escalamiento.**
   - Sin firma, sin valor o con plazo ambiguo: queda en revisión. La analista pide la aclaración al comercial; si no responde en 5 días hábiles, escala a su jefe comercial.
   - Remitente no inscrito (como el practicante de msg-006): se registra igual, se avisa al jefe comercial y se pide inscribir al remitente.
   - Contrato con póliza: la analista gestiona la póliza con el corredor dentro de los 5 días hábiles siguientes al registro. Una póliza vencida o pendiente a 30 días del inicio se escala a la Gerencia.
5. **Cierre del gap (junio–agosto de 2026).** Una campaña de dos semanas: contabilidad entrega la lista de clientes facturados entre el 2026-05-30 y el 2026-08-31; cada comercial reenvía al buzón todos los contratos de esa lista en la primera semana; en la segunda, la analista concilia la lista contra el maestro y escala a la Gerencia los contratos que siguen faltando.
6. **Indicador mensual.** *Cobertura del maestro* = contratos con facturación en el mes que existen en el maestro ÷ contratos con facturación en el mes. Meta ≥ 98 %. Indicador secundario: días promedio entre la firma y el registro (meta ≤ 3).

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción 100 % determinista con regex. | Que el modelo extraiga los campos. | El PRD exige que lo registrado pase por la herramienta, y un modelo puede redondear un valor o inferir una fecha. Las regex son reproducibles en `demo.ts` y explicables línea a línea. Costo: con formatos de contrato muy distintos habrá más campos en revisión. |
| El modelo solo pasa `mensaje_id`; las herramientas releen el documento. | Que el modelo pase el contrato extraído de una herramienta a otra. | Elimina la posibilidad de que el modelo altere un valor entre llamadas (CA2). Costo: se relee y re-extrae el texto, que es trivial. |
| La regla "no confirmar en el mismo turno" se aplica en el ciclo. | Confiar solo en el prompt. | Un prompt se puede desobedecer; el código no. |
| CSV y JSON propios, sin base de datos ni librería CSV. | Una librería de CSV o SQLite. | El PRD pide un CSV y sin base de datos. El parser propio maneja comillas y comas y evita una dependencia más. |
| Adaptador Gemini con respaldo automático de modelo. | Un solo modelo fijo. | La capa gratuita mostró saturación (503), cuotas bajas (429) y timeouts en las pruebas. Con respaldo la demo sigue funcionando. |
| Front en HTML y JavaScript sin framework, servido por el mismo proceso. | React o Vite. | Un solo comando y un solo contenedor, sin paso de compilación. El front es una sola pantalla. |

## 8. Supuestos

- Un adjunto cuyo nombre contiene "contrato" u "otrosí" es un contrato; cualquier otro (por ejemplo `cotizacion.txt`) significa que el mensaje no trae contrato.
- El primer firmante después de "Entre" es el cliente; Periferia siempre es el contratista.
- Un otrosí que amplía el plazo obliga a ampliar las pólizas, por eso `estado_poliza` de CT-2026-011 pasa de `vigente` a `pendiente` (el otrosí dice "deberán ampliarse en vigencia conforme al nuevo plazo").
- En un contrato marco sin valor, la póliza "para cada orden de servicio cuyo valor supere…" no obliga al firmar: `requiere_poliza=false`.
- Plazo en meses desde una firma sin día: inicio = último día del mes de firma (2026-08-31), fin = inicio + 12 meses (2027-08-31). Por eso requiere confirmación.
- Los contratos se archivan como `.txt` porque el fixture trae el texto ya extraído; con PDF reales se conservaría la extensión del adjunto.
- `fecha_registro` es la fecha real de ejecución. La fecha `hoy` del usuario solo se usa para las alertas.
- El comercial de un remitente no inscrito se registra como `No registrado (<correo>)`.

## 9. Cobertura

| Historia | Estado | Nota |
|---|---|---|
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon` omite los ya procesados. |
| HU-2 Extraer | Hecho | Confianza por campo, ausentes `null` con 0. Texto vacío → `{ok:false}`. |
| HU-3 Validar y clasificar | Hecho | RN1–RN4 y similitud ≥ 0.9; remitente desconocido reportado sin bloquear. |
| HU-4 Registrar y archivar | Hecho | Maestro en `out/`, archivo copiado, historial, procesados. |
| HU-5 Alertas | Hecho | Tres secciones, fecha `hoy` como argumento. |
| HU-6 Errores | Hecho | Herramientas nunca lanzan; un error de mensaje o del modelo no detiene el lote ni la sesión. |
| Front, API, adaptador, topes | Hecho | |
| `contratos_leer_pdf` (P1) | Parcial | Lee texto plano archivado; no extrae texto de PDF binarios. |
| Bonus `modulo/` | Hecho | `tools/contratos.ts` reexporta las herramientas de la app; `agent.md` y `SKILL.md` se generan desde `agent/prompt.md` y `src/knowledge/` con `bun run modulo`, y `bun run modulo --check` verifica que no divergen. |

Prueba de punta a punta con Gemini (`gemini-3.5-flash`), prompt de ejemplo del PRD: la tabla del agente coincide con la de la demo, `msg-006` queda en revisión con la pregunta de confirmación y `needsConfirmation=true`. Tras "Confirmo el valor 0 y la fecha fin 2027-08-31", el agente llama `contratos_registrar` con `confirmado=true` y `correcciones {valor: 0, fecha_fin: 2027-08-31}`, y CM-2026-03 queda registrado.

Resultado de `bun run demo` (fecha 2026-09-03):

| Mensaje | Clasificación | Acción |
|---|---|---|
| msg-001 | nuevo | Registrado CT-2026-015, `estado_poliza=pendiente`. |
| msg-002 | nuevo | Registrado CT-2026-016, `no_aplica`. |
| msg-003 | actualizacion | CT-2026-011: `fecha_fin` 2027-05-01→2027-11-01, `valor` 350000→520000, en `historial.jsonl`. |
| msg-004 | duplicado | Sin escritura. |
| msg-005 | rechazado | Sin adjunto de contrato. |
| msg-006 | nuevo, revisión `valor, fecha_fin` | No se registra en la primera pasada; con `confirmado=true`, CM-2026-03. |

**Qué falta para producción:** OCR y lectura de PDF reales; conexión real a Exchange (Graph API) y a SharePoint; autenticación de la analista; bloqueo de escritura concurrente del maestro; envío real del acuse al comercial; pruebas con contratos de otros formatos para calibrar las regex.

## 10. Uso de IA

- **Kiro (asistente de IA en el IDE):** se usó para leer el PRD y los fixtures, proponer la arquitectura, escribir el código, la demo y este documento, instalar Bun y depurar. Todo el código fue revisado y ejecutado: la demo y la verificación de tipos (`tsc --noEmit` en modo estricto) pasan.
- **Lo que se corrigió o descartó de lo propuesto:**
  - Un primer diseño donde el modelo pasaba el contrato completo entre herramientas: se descartó por el riesgo de que el modelo alterara valores (CA2).
  - Confiar la confirmación humana solo al prompt: se reemplazó por una regla en el ciclo.
  - El modelo `gemini-2.5-flash`, que ya no está disponible para cuentas nuevas, y `gemini-3.8-flash`, que no respondía en las pruebas: se cambió a `gemini-3.5-flash` con respaldo.
  - Errores encontrados al ejecutar: imports que chocaban con nombres de herramientas, el desempaquetado del resultado de `contratos_extraer` en la demo, y `tipo_poliza` vacío marcado como dudoso en el otrosí.
- **Gemini** se usa solo en tiempo de ejecución como modelo del agente, no para construir.

## 11. Riesgos en producción

| Riesgo | Mitigación |
|---|---|
| Contratos con formatos distintos hacen fallar las regex. | Todo campo no encontrado queda `null` con confianza 0 y entra en revisión; nada se registra mal en silencio. Calibrar con un lote real y medir el % de campos en revisión. |
| Falsos duplicados por variaciones del nombre del cliente. | La deduplicación es por `id_contrato` y NIT, nunca por nombre. |
| El modelo inventa o redondea un valor en su respuesta. | Los valores registrados salen solo de las herramientas; el modelo no los transporta. La tabla del chat puede citarlos mal, pero el maestro no. |
| Saturación o cuota agotada del proveedor. | Respaldo automático de modelo, timeouts y mensaje claro. En producción, una capa de pago con cuota garantizada. |
| La clave del modelo se filtra. | Solo en variable de entorno del backend; `/api/health` no la expone; `.env` está en `.gitignore`. |
| Alguien abusa del link público y gasta la cuota. | Topes de iteraciones, tokens por sesión y tamaño de mensaje. En producción, autenticación y límite por IP. |
| Dos procesos escriben el maestro a la vez. | Hoy un solo turno por sesión. En producción, una cola única de procesamiento o el bloqueo de SharePoint. |
| El proceso vuelve a depender de una persona. | La regla de gobierno define dueña, respaldo, plazos e indicador mensual. |
