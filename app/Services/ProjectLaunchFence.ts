// Keeps launches out of a project while it is being removed. Launches enter
// the fence for their whole start, and removal closes it, then waits for the
// launches already inside to finish, so none registers a process after
// removal has listed what to stop.
export class ProjectLaunchFence {
  private readonly closed = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private readonly drained = new Map<string, Array<() => void>>();

  async run<T>(projectId: string, launch: () => Promise<T>): Promise<T> {
    if (this.closed.has(projectId)) throw new Error('This project is being removed.');
    this.inFlight.set(projectId, (this.inFlight.get(projectId) ?? 0) + 1);
    try {
      return await launch();
    } finally {
      const left = (this.inFlight.get(projectId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(projectId, left);
      else {
        this.inFlight.delete(projectId);
        for (const resolve of this.drained.get(projectId) ?? []) resolve();
        this.drained.delete(projectId);
      }
    }
  }

  // Closes the fence and resolves once no launch is inside it.
  async close(projectId: string): Promise<void> {
    if (this.closed.has(projectId)) throw new Error('This project is already being removed.');
    this.closed.add(projectId);
    if (!this.inFlight.has(projectId)) return;
    await new Promise<void>((resolve) => this.drained.set(projectId, [...(this.drained.get(projectId) ?? []), resolve]));
  }

  open(projectId: string): void {
    this.closed.delete(projectId);
  }
}
