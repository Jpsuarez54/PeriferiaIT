# Agente conversacional — Registro de Contratos Vigentes (Reto 02)

Agente conversacional en **TypeScript/Bun** que actúa como punto único de recepción de contratos: clasifica correos, extrae datos estructurados con niveles de confianza, detecta duplicados/actualizaciones, registra en un maestro simulado de SharePoint, archiva documentos y genera alertas de vencimiento.

> Especificación completa en [`PRD.md`](./PRD.md). Decisiones y arquitectura en [`SOLUCION.md`](./SOLUCION.md).

## Requisitos

- [Bun](https://bun.sh) 1.4+ (o Node 20+)

## Instalar

```bash
bun install
```

## Demo determinista (sin modelo, sin clave)

Procesa los 6 mensajes del buzón llamando directamente a las herramientas:

```bash
bun run demo
```

## Levantar la app (chat con el agente)

1. Copia `.env.example` a `.env` y pon tu clave de modelo.
2. Arranca:

```bash
bun run dev
```

Abre http://localhost:3000 — historial del chat, llamadas a herramientas visibles y resaltado de confirmación humana.

## Estructura

```
agent/prompt.md            # system prompt (comportamiento)
src/tools/contratos.ts     # herramientas tipadas con zod (ejecución)
src/server.ts              # API HTTP + ciclo del agente
src/llm/                   # adaptador de proveedor (intercambiable)
src/knowledge/             # conocimiento del proceso
web/                       # front de chat
demo.ts                    # verificación sin modelo
fixtures/reto-02/          # insumos (solo lectura)
out/                       # generado en ejecución
```
