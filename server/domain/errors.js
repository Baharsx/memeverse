export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
