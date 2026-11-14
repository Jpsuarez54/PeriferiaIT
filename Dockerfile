# Imagen única: sirve el front (web/) y la API del agente con Bun.
FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY modulo ./modulo
COPY demo.ts tsconfig.json ./

# El proceso corre sin privilegios: solo puede escribir en out/ (datos de la ejecución).
RUN mkdir -p out && chown -R bun:bun /app
USER bun

ENV PORT=3000
EXPOSE 3000
# La clave del modelo (GEMINI_API_KEY) se configura en el panel del host, nunca en la imagen.
CMD ["bun", "run", "src/server.ts"]
