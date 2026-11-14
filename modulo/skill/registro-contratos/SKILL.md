---
name: registro-contratos
description: Reglas de negocio para registrar contratos vigentes (duplicados, actualizaciones por otrosí, confianza mínima 0.8, pólizas y alertas de vencimiento).
---

<!-- Generado por modulo/build.ts desde src/knowledge/registro-contratos.md. No editar a mano. -->

# Proceso de registro de contratos vigentes

## Contexto

- El maestro de contratos estuvo congelado desde el 2026-05-30. Todo lo registrado desde esa fecha cubre el gap.
- Antes solo llegaban los contratos con póliza. Ahora se registra todo contrato, tenga o no póliza.
- El maestro vive en `out/sharepoint/maestro-contratos.csv`. El fixture original nunca se modifica.
- Los documentos se archivan en `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`.

## Clasificación (reglas de negocio)

| Clasificación | Cuándo | Qué se hace |
|---|---|---|
| `duplicado` | Mismo `id_contrato` con los mismos valor, fecha de inicio y fecha de fin. | No se escribe en el maestro. Se reporta. |
| `actualizacion` | Es un otrosí, o mismo `id_contrato` con algún campo distinto, o mismo NIT con objeto casi igual (similitud ≥ 0.9). | Se modifica la fila y el cambio queda en `historial.jsonl`. |
| `nuevo` | No coincide con nada del maestro. | Se inserta. Con póliza queda `estado_poliza = pendiente`; sin póliza, `no_aplica`. |
| `rechazado` | Sin adjunto de contrato (cotización, pregunta), o texto sin partes ni objeto. | Se reporta con el motivo. |

Un mismo cliente puede tener varios contratos: un NIT repetido con otro `id_contrato` y otro objeto es un contrato nuevo, no un duplicado.

## Confianza y revisión humana

- Cada campo extraído trae una confianza entre 0 y 1. Los campos ausentes son `null` con confianza 0.
- Un campo con confianza < 0.8 va a `requiere_revision` y bloquea el registro hasta que el humano confirme.
- Casos típicos de baja confianza:
  - **Valor por demanda** (contrato marco): se registra `valor = 0` con `valor_indeterminado = true`, pero el humano debe confirmarlo.
  - **Plazo en meses contado desde una firma sin día**: se toma el último día del mes de firma como inicio y se suma el plazo. La fecha de fin es una inferencia y requiere confirmación.

## Remitentes

- El comercial se resuelve con el correo del remitente contra el catálogo de comerciales.
- Un remitente desconocido se reporta en la respuesta, pero no bloquea el registro. En el maestro queda como `No registrado (<correo>)`.

## Pólizas

- `requiere_poliza = true` cuando el contrato obliga a constituir garantías.
- En un contrato marco, una póliza condicionada a órdenes de servicio futuras no obliga hoy: `requiere_poliza = false`.
- Un otrosí que amplía el plazo obliga a ampliar las pólizas: el estado pasa a `pendiente` hasta que se renueven.

## Alertas

El reporte `out/alertas.md` tiene tres secciones, calculadas con la fecha `hoy` que da el usuario:
1. Contratos que vencen en 60 días o menos.
2. Contratos que requieren póliza y cuya póliza no está vigente.
3. Contratos registrados desde el 2026-05-30 (gap cubierto).
