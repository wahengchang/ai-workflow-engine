export class AweError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AweError';
    this.code = code;
  }
}

export function assertAwe(condition, code, message) {
  if (!condition) throw new AweError(code, message);
}
