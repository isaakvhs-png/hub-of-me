export class BoundaryError extends Error {
  readonly code = "boundary";
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

export class BudgetError extends Error {
  readonly code = "budget";
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export class UsageMissingError extends Error {
  readonly code = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageMissingError";
  }
}

export class UnpricedModelError extends Error {
  readonly code = "unpriced";
  constructor(message: string) {
    super(message);
    this.name = "UnpricedModelError";
  }
}

export class ValidationError extends Error {
  readonly code = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
