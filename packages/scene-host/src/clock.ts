/**
 * 协议测试用的内存节目钟。计划 §7.1。
 * 不是浏览器里的 ProgrammeClock，也不是墙钟。advance 只供测试推进，不是逐帧 seek。
 * 没有 setRate，不能用它给人声加速。
 */

import type { DriftSample, ProgrammeClockPort, SceneLocalTime } from '../../dsh-livestream/src/live/domain/ports';

interface SceneClock {
  originShowTime: number;
  rate: number;
  hold: boolean;
  frozenLocalMs: number | null;
}

export class InMemoryProgrammeClock implements ProgrammeClockPort {
  showTime = 0;
  running = true;
  pauseCount = 0;
  private scenes: Record<string, SceneClock> = {};
  readonly drift: DriftSample[] = [];

  now(): number {
    return this.showTime;
  }

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.pauseCount += 1;
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  /** 暂停时不推进。倒退直接拒绝。 */
  advance(ms: number): void {
    if (ms < 0) throw new Error('节目时钟不能倒退');
    if (!this.running || ms === 0) return;
    this.showTime += ms;
  }

  register(sceneInstanceId: string): void {
    this.scenes[sceneInstanceId] = { originShowTime: this.showTime, rate: 1, hold: false, frozenLocalMs: null };
  }

  drop(sceneInstanceId: string): void {
    delete this.scenes[sceneInstanceId];
  }

  holdScene(sceneInstanceId: string): void {
    const scene = this.scenes[sceneInstanceId];
    if (!scene || scene.hold) return;
    scene.frozenLocalMs = this.localMs(scene, this.showTime);
    scene.hold = true;
  }

  resumeScene(sceneInstanceId: string): void {
    const scene = this.scenes[sceneInstanceId];
    if (!scene || !scene.hold) return;
    const frozen = scene.frozenLocalMs ?? 0;
    scene.originShowTime = this.showTime - frozen / scene.rate;
    scene.hold = false;
    scene.frozenLocalMs = null;
  }

  mapScene(sceneInstanceId: string, showTime = this.showTime): SceneLocalTime {
    const scene = this.scenes[sceneInstanceId];
    if (!scene) return { sceneInstanceId, showTime, localMs: 0, rate: 1, hold: false };
    return { sceneInstanceId, showTime, localMs: this.localMs(scene, showTime), rate: scene.rate, hold: scene.hold };
  }

  observeDrift(sample: DriftSample): void {
    this.drift.push({
      sceneInstanceId: sample.sceneInstanceId,
      programmeShowTime: sample.programmeShowTime,
      adapterReportedTime: sample.adapterReportedTime,
      tolerance: 'pending-p2',
    });
  }

  private localMs(scene: SceneClock, showTime: number): number {
    if (scene.hold) return scene.frozenLocalMs ?? 0;
    return (showTime - scene.originShowTime) * scene.rate;
  }
}
