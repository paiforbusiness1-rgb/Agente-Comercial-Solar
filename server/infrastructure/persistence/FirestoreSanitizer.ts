/**
 * FirestoreSanitizer.ts
 * Microservicio puro de sanitización recursiva para Google Cloud Firestore.
 * 
 * Reglas Persistentes:
 * - Regla 6 (SSD - ISO/IEC 27034-1): Elimina claves 'undefined', neutraliza 'NaN' a null y preserva 'Date' y 'Timestamp'.
 * - Regla 2 (HRU): Preservación estricta de null, false, 0, cadenas vacías y arrays vacíos. Cero hardcoding.
 * - Regla 3 (Anti-God-Object): Microservicio con responsabilidad única desacoplado de los repositorios.
 */

export function cleanFirestorePayload<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  // Defecto 3: Neutralizar NaN a null para evitar FirebaseError: Unsupported field value: NaN
  if (typeof input === 'number') {
    return (Number.isNaN(input) ? null : input) as unknown as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  // Defecto 4: Guardia inmutable de fechas y timestamps nativos de Firestore
  if (input instanceof Date || (input as any)?.constructor?.name === 'Timestamp') {
    return input;
  }

  // Sanitización de arrays
  if (Array.isArray(input)) {
    return input
      .map((item) => cleanFirestorePayload(item))
      .filter((item) => item !== undefined) as unknown as T;
  }

  // Sanitización de objetos planos
  const cleanObj: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    // Estricto: SOLO omitir si es exactamente undefined (preservando null, 0, false, "")
    if (value === undefined) {
      continue;
    }
    cleanObj[key] = cleanFirestorePayload(value);
  }

  return cleanObj as T;
}
