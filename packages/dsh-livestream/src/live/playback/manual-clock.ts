/**
 * 进程内节目时钟。计划 §7.1。
 * 测试和没有浏览器 ProgrammeClock 的进程用它推进 showTime。
 * 不是播放器 adapter：不 seek，不改人声速率。漂移样本的容限保持 pending-p2。
 * TODO(P2)：接浏览器 ProgrammeClock 与真实 adapter 之后，删掉这条进程内替代的使用点。
 */

import type { DriftSample, ProgrammeClockPort, SceneLocalTime } from '../domain/ports';

interface SceneClock {
  originShowTime: number;
  rate: number;
  hold: boolean;
  frozenLocalMs: number | null;
}

export class ManualProgrammeClock implements ProgrammeClockPort {
  showTime = 0;
  running = true;
  readonly drift: DriftSample[] = [];
  private scenes: Record<string, SceneClock> = {};

  now(): number {
    return this.showTime;
  }

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('节目时钟不能倒退');
    if (!this.running || ms === 0) return;
    this.showTime += ms;
  }

  register(sceneInstanceId: string): void {
    this.scenes[sceneInstanceId] = { originShowTime: this.showTime, rate: 1, hold: false, frozenLocalMs: null };
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
    this.drift.push({ ...sample, tolerance: 'pending-p2' });
  }

  private localMs(scene: SceneClock, showTime: number): number {
    if (scene.hold) return scene.frozenLocalMs ?? 0;
    return (showTime - scene.originShowTime) * scene.rate;
  }
}
