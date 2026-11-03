import { afterEach, expect, it, vi } from 'vitest';
import { BrowserProgrammeTime } from '../src/browser/programme-time';
afterEach(() => vi.restoreAllMocks());
it('continues the programme axis after refreshing a browser with a fresh performance origin', () => {
  const time = vi.spyOn(performance, 'now').mockReturnValue(0);
  const clock = new BrowserProgrammeTime();
  clock.synchronize(900000);
  time.mockReturnValue(1000);
  expect(clock.now()).toBe(901000);
  clock.synchronize(800000);
  time.mockReturnValue(2000);
  expect(clock.now()).toBe(902000);
});
