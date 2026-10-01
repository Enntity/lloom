// One window per gateway, shared by every model and alias. Runtime owns the
// presence lifecycle; this gate only interrupts and admits inference requests.
export class InteractivePriorityError extends Error {
  constructor(retryAfterSeconds) {
    super('background inference paused for an interactive conversation');
    this.name = 'InteractivePriorityError';
    this.code = 'INTERACTIVE_PRIORITY';
    this.statusCode = 409;
    this.type = 'runtime_admission_error';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ForegroundPriority {
  constructor({ idleMs = () => 60_000, now = Date.now } = {}) {
    this.idleMs = idleMs;
    this.now = now;
    this.foreground = 0;
    this.until = 0;
    this.background = new Set();
  }

  retryAfterSeconds() {
    return Math.max(1, Math.ceil((this.foreground ? this.duration() : this.until - this.now()) / 1000));
  }

  duration() {
    const value = Number(this.idleMs());
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 3_600_000) : 60_000;
  }

  begin(requestClass) {
    const controller = new AbortController();
    if (requestClass === 'foreground') {
      this.foreground++;
      this.until = this.now() + this.duration();
      for (const background of this.background) {
        background.abort(new InteractivePriorityError(this.retryAfterSeconds()));
      }
    } else {
      if (this.foreground || this.now() < this.until) {
        throw new InteractivePriorityError(this.retryAfterSeconds());
      }
      this.background.add(controller);
    }
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.background.delete(controller);
        if (requestClass === 'foreground') {
          this.foreground--;
          this.until = this.now() + this.duration();
        }
      }
    };
  }
}
