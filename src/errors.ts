export class BoundaryError extends Error {
  readonly code = "boundary";
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

export class UsageMissingError extends Error {
  readonly code = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageMissingError";
  }
}

export class ValidationError extends Error {
  readonly code = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Something asked for by id that is not there: a 404, not a 500 (14 Nov stress test: undo on an unknown agenda item). */
export class NotFoundError extends Error {
  readonly code = "not_found";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
