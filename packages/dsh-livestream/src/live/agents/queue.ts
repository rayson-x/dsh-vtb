/**
 * 制作任务队列。计划 §8.1、§8.3。
 * 按优先级、截止和入队顺序调度。泵之前不占用工人。
 * 这个队列不是现场读模型的前置条件。
 */

import type { ProductionJob, ProductionQueuePort } from './ports';

export class ProductionQueue implements ProductionQueuePort {
  private readonly jobs: ProductionJob[] = [];

  enqueue(job: ProductionJob): void {
    if (this.jobs.some((item) => item.taskId === job.taskId && item.state !== 'done' && item.state !== 'cancelled')) {
      throw new Error(`任务 ${job.taskId} 已在制作队列`);
    }
    this.jobs.push({ ...job, state: 'waiting' });
  }

  peekNext(): ProductionJob | undefined {
    return this.ranked().find((job) => job.state === 'waiting');
  }

  markRunning(taskId: string): void {
    const job = this.require(taskId);
    if (job.state !== 'waiting') throw new Error(`任务 ${taskId} 不在等待`);
    job.state = 'running';
  }

  complete(taskId: string): void {
    const job = this.require(taskId);
    if (job.state !== 'running') throw new Error(`任务 ${taskId} 不在执行`);
    job.state = 'done';
  }

  cancel(taskId: string): ProductionJob | undefined {
    const job = this.jobs.find((item) => item.taskId === taskId && (item.state === 'waiting' || item.state === 'running'));
    if (!job) return undefined;
    job.state = 'cancelled';
    return { ...job };
  }

  waitingCount(): number {
    return this.jobs.filter((job) => job.state === 'waiting').length;
  }

  runningCount(): number {
    return this.jobs.filter((job) => job.state === 'running').length;
  }

  snapshot(): readonly ProductionJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  private require(taskId: string): ProductionJob {
    const job = this.jobs.find((item) => item.taskId === taskId);
    if (!job) throw new Error(`制作队列没有 ${taskId}`);
    return job;
  }

  private ranked(): ProductionJob[] {
    return [...this.jobs].sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      const leftDeadline = left.deadlineShowTime ?? Number.POSITIVE_INFINITY;
      const rightDeadline = right.deadlineShowTime ?? Number.POSITIVE_INFINITY;
      if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
      return left.enqueuedAt - right.enqueuedAt;
    });
  }
}
