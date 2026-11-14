// Tope global de llamadas al modelo por día (UTC), compartido por todas las sesiones.
// Evita que alguien gaste la clave abriendo sesiones nuevas sin fin.
export class Presupuesto {
  private dia = "";
  private usadas = 0;

  constructor(readonly maxPorDia: number) {}

  private alDia(): void {
    const hoy = new Date().toISOString().slice(0, 10);
    if (hoy !== this.dia) {
      this.dia = hoy;
      this.usadas = 0;
    }
  }

  // Reserva una llamada. Devuelve false si ya no quedan.
  consumir(): boolean {
    this.alDia();
    if (this.usadas >= this.maxPorDia) return false;
    this.usadas++;
    return true;
  }

  get restantes(): number {
    this.alDia();
    return Math.max(0, this.maxPorDia - this.usadas);
  }
}
