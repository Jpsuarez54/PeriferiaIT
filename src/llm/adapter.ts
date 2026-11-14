// Interfaz del proveedor LLM. El ciclo del agente solo conoce estos tipos;
// cambiar de proveedor = escribir otra implementación de LLMAdapter.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // Datos opacos que algunos proveedores exigen devolver (p.ej. firma de razonamiento de Gemini).
  meta?: Record<string, string>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string; // JSON serializado {ok,data}|{ok,error}
}

export type Mensaje =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

// Esquema JSON (subconjunto) para declarar herramientas al modelo.
export interface JsonSchema {
  type: "object" | "string" | "number" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Respuesta {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(system: string, mensajes: Mensaje[], herramientas: ToolSpec[]): Promise<Respuesta>;
}

export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LLMError";
  }
}
