/**
 * 帧请求背压。计划 §6.2：只保留最新请求，不积累过时帧。
 * 不是 Three、GSAP、Canvas 或 DOM 渲染器，不产出像素。
 */

export interface FrameRequest {
  requestId: number;
  showTime: number;
}

export class LatestFrameMailbox {
  submitted = 0;
  dropped = 0;
  private nextId = 0;
  private pending: FrameRequest | null = null;

  submit(showTime: number): FrameRequest {
    this.submitted += 1;
    if (this.pending) this.dropped += 1;
    const request: FrameRequest = { requestId: this.nextId + 1, showTime };
    this.nextId = request.requestId;
    this.pending = request;
    return request;
  }

  /** 取走当前最新请求。没有绘制。 */
  poll(): FrameRequest | null {
    const found = this.pending;
    this.pending = null;
    return found;
  }
}
