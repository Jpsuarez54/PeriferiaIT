// Tipos del dominio de contratos. Sin `any`.

export type Pais = "CO" | "EC" | "PE" | "PA" | "HN";
export type Moneda = "COP" | "USD" | "PEN" | "PAB" | "HNL";
export type EstadoPoliza = "vigente" | "pendiente" | "vencida" | "no_aplica";
export type Fuente = "buzon" | "manual" | "migracion";
export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado";

export interface Ctx {
  directory: string;
  sessionId: string;
}

// Un campo extraído con su nivel de confianza en [0,1].
export interface Campo<T> {
  valor: T;
  confianza: number;
  nota?: string; // por qué la confianza es baja, en lenguaje claro
}

export interface CampoRevision {
  campo: string;
  valor: string | number | boolean | null;
  confianza: number;
  nota: string;
}

// Contrato extraído: cada campo lleva confianza. Los ausentes son null con confianza 0.
export interface ContratoExtraido {
  id_contrato: Campo<string | null>;
  cliente: Campo<string | null>;
  nit_cliente: Campo<string | null>;
  pais: Campo<Pais | null>;
  objeto: Campo<string | null>;
  valor: Campo<number | null>;
  moneda: Campo<Moneda | null>;
  fecha_inicio: Campo<string | null>;
  fecha_fin: Campo<string | null>;
  requiere_poliza: Campo<boolean>;
  tipo_poliza: Campo<string>;
  estado_poliza: Campo<EstadoPoliza | null>;
  comercial: Campo<string | null>;
  valor_indeterminado: Campo<boolean>;
  // metadatos del mensaje
  mensaje_id: string;
  remitente_email: string;
  remitente_registrado: boolean;
  comercial_resuelto: string | null;
  es_otrosi: boolean;
  adjunto: string;
  tiene_contrato: boolean;
}

// Fila del maestro (valores planos, sin confianza).
export interface FilaMaestro {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: Pais;
  objeto: string;
  valor: number;
  moneda: Moneda;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: boolean;
  tipo_poliza: string;
  estado_poliza: EstadoPoliza;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: Fuente;
}

export interface Cambio {
  antes: string;
  despues: string;
}

export interface ResultadoValidacion {
  clasificacion: Clasificacion;
  // Datos para que el agente cite sin inventar: salen del documento, null si no hay contrato.
  id_contrato?: string | null;
  cliente?: string | null;
  campos_revision?: CampoRevision[];
  id_contrato_existente?: string;
  requiere_revision: string[];
  diferencias?: Record<string, Cambio>;
  motivo_rechazo?: string;
  remitente_registrado: boolean;
  remitente_email: string;
  comercial_resuelto: string | null;
  es_otrosi: boolean;
  mensaje_id?: string;
}

export interface ResultadoRegistro {
  id_contrato: string;
  accion: Clasificacion;
  ruta_archivo: string;
  cambios?: Record<string, Cambio>;
  motivo?: string;
}

export interface ResumenFila {
  id_contrato: string;
  cliente: string;
  fecha_fin: string;
  requiere_poliza: boolean;
  estado_poliza: EstadoPoliza;
  fecha_registro: string;
}

export interface ResultadoAlertas {
  ruta: string;
  vencen: ResumenFila[];
  polizas_pendientes: ResumenFila[];
  registrados_desde_corte: ResumenFila[];
}

export interface MensajeBuzon {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: string[];
  tiene_contrato: boolean;
}
