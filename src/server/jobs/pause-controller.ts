export class PauseController {
  private requested = false;
  requestPause() {
    this.requested = true;
  }
  get shouldPause() {
    return this.requested;
  }
  throwIfPaused() {
    if (this.requested) throw new Error("Job paused by user");
  }
}
