/** Maps a fresh browser monotonic clock into the persistent programme axis. */
export class BrowserProgrammeTime {
  private readonly startedAt = performance.now();
  private offset = 0;
  now() {
    return performance.now() - this.startedAt + this.offset;
  }
  synchronize(showTime: number) {
    if (!Number.isFinite(showTime) || showTime < 0) throw Error('Invalid programme clock anchor');
    this.offset += Math.max(0, showTime - this.now());
  }
}
