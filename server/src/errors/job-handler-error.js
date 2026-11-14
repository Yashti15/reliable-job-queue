export class JobHandlerError extends Error {
  constructor(message, { name = 'JobHandlerError' } = {}) {
    super(message)
    this.name = name
  }
}
