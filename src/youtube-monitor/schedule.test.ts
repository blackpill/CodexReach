import { describe, expect, it } from 'vitest';
import { canCheckNow, nextCheckAt, normalizeCheckAt } from './schedule.js';
const ms = (time: string) => Date.parse(`2026-11-07T${time}+08:00`);
describe('Beijing hourly schedule', () => {
  it.each([
    ['06:59:59', '07:00:00'], ['07:00:00', '08:00:00'], ['07:35:00', '08:00:00'],
    ['21:59:59', '22:00:00'],
  ])('schedules %s to the next allowed hour %s', (now, next) => { expect(nextCheckAt(ms(now))).toBe(ms(next)); });
  it.each(['22:00:00', '22:30:00', '23:59:59'])('schedules %s to 7am tomorrow', now => {
    expect(nextCheckAt(ms(now))).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
  });
  it('includes the 22:00 slot with a one-minute scheduler grace but not later night catch-up', () => {
    for (const time of ['07:00:00','13:35:00','22:00:00','22:00:59']) expect(canCheckNow(ms(time))).toBe(true);
    for (const time of ['00:00:00','06:59:59','22:01:00','23:00:00']) expect(canCheckNow(ms(time))).toBe(false);
  });
  it('aligns persisted legacy 30-minute due times without resetting the comment cursor', () => {
    expect(normalizeCheckAt(ms('06:59:45'))).toBe(ms('07:00:00'));
    expect(normalizeCheckAt(ms('08:30:00'))).toBe(ms('09:00:00'));
    expect(normalizeCheckAt(ms('22:30:00'))).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
    expect(normalizeCheckAt(ms('22:00:00'))).toBe(ms('22:00:00'));
  });
  it('has exactly 16 daily slots and handles month/year rollover', () => {
    const slots: string[] = []; let now = ms('06:00:00');
    for (let i=0;i<16;i++) { now=nextCheckAt(now); slots.push(new Date(now+8*3_600_000).toISOString().slice(11,16)); }
    expect(slots).toEqual(Array.from({length:16},(_,i)=>`${String(i+7).padStart(2,'0')}:00`));
    expect(nextCheckAt(Date.parse('2026-12-31T22:00:00+08:00'))).toBe(Date.parse('2027-01-01T07:00:00+08:00'));
  });
});
