// Limitador de tasa por clave (IP) con ventana deslizante, en memoria.
// Protege los endpoints que cuestan dinero o modifican datos de un cliente que los llame en ráfaga.
export class Limitador {
  private golpes = new Map<string, number[]>();

  constructor(readonly max: number, readonly ventanaMs: number) {}

  private vigentes(clave: string, ahora: number): number[] {
    const l = (this.golpes.get(clave) ?? []).filter((t) => t > ahora - this.ventanaMs);
    if (l.length) this.golpes.set(clave, l);
    else this.golpes.delete(clave);
    return l;
  }

  // Registra un uso y devuelve false si ya se superó el máximo en la ventana.
  permitir(clave: string, ahora = Date.now()): boolean {
    const l = this.vigentes(clave, ahora);
    if (l.length >= this.max) return false;
    l.push(ahora);
    this.golpes.set(clave, l);
    if (this.golpes.size > 5000) this.limpiar(ahora);
    return true;
  }

  // Sin registrar un uso: ¿ya está en el máximo?
  excedido(clave: string, ahora = Date.now()): boolean {
    return this.vigentes(clave, ahora).length >= this.max;
  }

  // Segundos hasta que se libere un cupo.
  esperaSeg(clave: string, ahora = Date.now()): number {
    const l = this.vigentes(clave, ahora);
    const primero = l[0];
    return primero === undefined ? 1 : Math.max(1, Math.ceil((primero + this.ventanaMs - ahora) / 1000));
  }

  private limpiar(ahora: number): void {
    for (const k of this.golpes.keys()) this.vigentes(k, ahora);
    // Si aun así crece (ataque con muchas IP), se descartan las más antiguas.
    while (this.golpes.size > 5000) {
      const primera = this.golpes.keys().next().value;
      if (primera === undefined) break;
      this.golpes.delete(primera);
    }
  }
}
