/** Memory budget for stored snapshots (UTF-16 code units). */
export const HISTORY_MAX_CHARS = 48_000_000;

/**
 * Snapshot undo/redo for JSON-serialisable state.
 *
 * Every committed state is stored as a JSON string, so snapshots can never be mutated by accident and
 * identical states are never recorded twice. `begin()`/`commit()` collapse a burst of changes (a slider
 * drag, a shape being moved) into a single undo step.
 */
export class History<T> {
  private past: string[] = [];
  private future: string[] = [];
  private presentJson: string;
  private presentValue: T;
  private txnBase: string | null = null;

  constructor(
    initial: T,
    /** Maximum number of undo steps kept. */
    readonly limit = 200,
  ) {
    this.presentJson = JSON.stringify(initial);
    this.presentValue = JSON.parse(this.presentJson) as T;
  }

  /** The current state. Treat it as immutable; produce a new object to change it. */
  get present(): T {
    return this.presentValue;
  }

  get inTransaction(): boolean {
    return this.txnBase !== null;
  }

  get undoDepth(): number {
    return this.past.length;
  }

  get redoDepth(): number {
    return this.future.length;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Records `next` as the new present state. Inside a transaction the state is replaced without creating
   * an undo step. Returns false when nothing changed.
   */
  push(next: T): boolean {
    const json = JSON.stringify(next);
    if (json === this.presentJson) return false;
    if (this.txnBase === null) {
      this.past.push(this.presentJson);
      this.trim();
      this.future = [];
    }
    this.presentJson = json;
    this.presentValue = JSON.parse(json) as T;
    return true;
  }

  /**
   * Replaces the present state without recording a new undo step, i.e. amends the step the last `push`
   * created (used to fold a held arrow key into one step). Returns false when nothing changed or there is
   * no step to amend.
   */
  amend(next: T): boolean {
    if (this.past.length === 0 && this.txnBase === null) return false;
    const json = JSON.stringify(next);
    if (json === this.presentJson) return false;
    this.presentJson = json;
    this.presentValue = JSON.parse(json) as T;
    return true;
  }

  /** Drops the oldest steps beyond the step limit or the memory budget (in characters of JSON). */
  private trim(): void {
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    let total = 0;
    for (const s of this.past) total += s.length;
    while (total > HISTORY_MAX_CHARS && this.past.length > 1) total -= this.past.shift()!.length;
  }

  /** Starts a transaction. Nested calls are ignored. */
  begin(): void {
    if (this.txnBase === null) this.txnBase = this.presentJson;
  }

  /** Ends the transaction; if anything changed, exactly one undo step is recorded. Returns true in that case. */
  commit(): boolean {
    if (this.txnBase === null) return false;
    const base = this.txnBase;
    this.txnBase = null;
    if (base === this.presentJson) return false;
    this.past.push(base);
    this.trim();
    this.future = [];
    return true;
  }

  /** Ends the transaction and restores the state it started from. */
  rollback(): boolean {
    if (this.txnBase === null) return false;
    const base = this.txnBase;
    this.txnBase = null;
    if (base === this.presentJson) return false;
    this.presentJson = base;
    this.presentValue = JSON.parse(base) as T;
    return true;
  }

  undo(): boolean {
    this.commit();
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.presentJson);
    this.presentJson = prev;
    this.presentValue = JSON.parse(prev) as T;
    return true;
  }

  redo(): boolean {
    this.commit();
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.presentJson);
    this.presentJson = next;
    this.presentValue = JSON.parse(next) as T;
    return true;
  }

  /** Replaces everything: new initial state, empty stacks. */
  reset(initial: T): void {
    this.past = [];
    this.future = [];
    this.txnBase = null;
    this.presentJson = JSON.stringify(initial);
    this.presentValue = JSON.parse(this.presentJson) as T;
  }
}
