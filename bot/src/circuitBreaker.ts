export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker {
  public state: CircuitState = CircuitState.CLOSED;
  private consecutiveErrors = 0;
  private nextAttempt = 0;
  private readonly maxErrors: number;
  private readonly resetTimeout: number;

  constructor(maxErrors: number = 5, resetTimeout: number = 30000) {
    this.maxErrors = maxErrors;
    this.resetTimeout = resetTimeout;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() >= this.nextAttempt) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new CircuitOpenError('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onError();
      throw error;
    }
  }

  private onSuccess() {
    this.state = CircuitState.CLOSED;
    this.consecutiveErrors = 0;
  }

  private onError() {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.maxErrors) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.resetTimeout;
    } else if (this.state === CircuitState.HALF_OPEN) {
       this.state = CircuitState.OPEN;
       this.nextAttempt = Date.now() + this.resetTimeout;
    }
  }
}
