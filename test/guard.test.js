// -----------------------------------------------------------------------------
// The index guard (src/guard.js), taken as is from gladys-p1-monitor where it
// was reviewed and approved: its own tests come with it, unchanged. Plus the
// /data store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexGuard, indexOfTariffs } from '../src/guard.js';
import { createFileStore, createMemoryStore } from '../src/store.js';

const MINUTE = 60_000;
test('index guard: never 0, a normal rise goes through', () => {
  const guard = new IndexGuard();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(new IndexGuard().accept(-1, 0), false);
  assert.equal(new IndexGuard().accept(NaN, 0), false);
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  const back = new IndexGuard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  back.acceptHeld();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = new IndexGuard({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 2.5,
    to: 12345.5,
    threshold: 12345,
    at: 200 * 60 * MINUTE,
  });
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is billed', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  // A drop to 10 kWh, for a week: held all along.
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  // Back to the real value: it goes through, the hold ends; the reference
  // never went down, so no rise of 50,000 kWh is ever billed.
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  guard.acceptHeld();
  // The core skips the negative delta: nothing billed.
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.01, at: 2 * MINUTE });
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  // Back to the old value after the acceptance: a jump, held.
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: an acceptance of a drop never takes a jump', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(10, MINUTE);
  guard.acceptHeld();
  assert.equal(guard.accept(90_000, 2 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
  assert.equal(guard.accept(90_000, 3 * MINUTE), false);
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  // 3 hours of the same value, read every minute.
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 }, 'the date of the value is kept');
  // +4 kWh after 3 hours: 1.3 kW on average, plausible.
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = new IndexGuard({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  // A newer value in Gladys than in /data wins; the same value keeps its oldest date.
  assert.deepEqual(new IndexGuard({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(new IndexGuard({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
  assert.deepEqual(
    new IndexGuard({ value: 1000, at: -50 }, { last: { value: 1000, at: 10 } }).last,
    { value: 1000, at: -50 },
  );
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  // 5000 is not what the user saw: held again, nothing taken, acceptance dropped.
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.accepted, undefined);
  assert.equal(guard.accept(5000.1, 3 * MINUTE), false, 'still held');
  // The value shown, plus what the home may draw meanwhile: taken.
  const fair = new IndexGuard({ value: 1000, at: 0 });
  fair.accept(1005, MINUTE);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 2 * MINUTE), true);
  // Below the value shown: not the jump accepted either.
  const below = new IndexGuard({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  // A drop: at most the value shown plus the margin.
  const drop = new IndexGuard({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  drop.accept(10, 3 * MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(10.2, 4 * MINUTE), true);
  assert.equal(new IndexGuard({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});
test('index guard: a value held read back from /data is dated at its loading', () => {
  const DAY = 24 * 60 * MINUTE;
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  // Loaded 5 days later: an acceptance covers 1005 plus the margin since the load only.
  const guard = new IndexGuard(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
  assert.equal(guard.held.to, 5000);
  const fair = new IndexGuard(undefined, saved, 5 * DAY);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 5 * DAY + MINUTE), true);
});
test('index guard: under a held jump, an old reference never lets a big rise through', () => {
  const DAY = 24 * 60 * MINUTE;
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(15_000, MINUTE), false);
  // Still held 10 days later: the reference is now old, its margin alone
  // would cover 24,000 kWh.
  assert.equal(guard.accept(15_000, 10 * DAY), false);
  assert.equal(guard.held.threshold, 15_000);
  // 14,000, under the jump, read a minute later: held in its turn, 0 kWh taken.
  assert.equal(guard.accept(14_000, 10 * DAY + MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 14_000);
  assert.equal(guard.held.from, 1000);
  // A value back near the reference still ends the hold.
  assert.equal(guard.accept(1000.2, 10 * DAY + 2 * MINUTE), true);
  assert.equal(guard.held, undefined);
});
test('index of the tariffs: both there; a register at 0 or dropping alone is no index', () => {
  assert.equal(indexOfTariffs(5000, 3000), 8000);
  assert.equal(indexOfTariffs(5000, 0), 5000, 'a single-tariff meter, no reference yet');
  for (const [low, high] of [
    [undefined, 3000],
    [5000, null],
    [NaN, 3000],
    [Infinity, 1],
    [-1, 3000],
    [0, 0],
  ]) {
    assert.equal(indexOfTariffs(low, high), undefined, `${low} ${high}`);
  }
  const ref = { low: 5000, high: 3000 };
  assert.equal(indexOfTariffs(5000.1, 3000, ref), 8000.1);
  assert.equal(indexOfTariffs(0, 3000.1, ref), undefined, 'a tariff above 0 falls to 0');
  assert.equal(indexOfTariffs(4000, 3000.1, ref), undefined, 'one tariff drops alone');
  assert.equal(indexOfTariffs(5000, 2999, ref), undefined, 'one tariff drops alone');
  assert.equal(indexOfTariffs(10, 5, ref), 15, 'both drop: a real drop, for the guard');
  assert.equal(indexOfTariffs(10, 0, ref), 10, 'both lower, one at 0: still a real drop');
  assert.equal(indexOfTariffs(5000.1, 0, { low: 5000, high: 0 }), 5000.1, 'single tariff');
});

// --- The /data store ----------------------------------------------------------------

test('the /data store: written through a temporary file, read back, empty when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugwise-'));
  try {
    const store = createFileStore(join(dir, 'state.json'));
    assert.deepEqual(store.load(), {});
    await store.save({ a: { last: { value: 1, at: 2 }, jump: null } });
    assert.deepEqual(store.load(), { a: { last: { value: 1, at: 2 }, jump: null } });
    assert.deepEqual(createFileStore(join(dir, 'missing', 'x.json')).load(), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the memory store gives copies', async () => {
  const store = createMemoryStore({ a: 1 });
  const data = store.load();
  data.a = 2;
  assert.deepEqual(store.load(), { a: 1 });
  await store.save({ b: 2 });
  assert.deepEqual(store.data, { b: 2 });
});

test('index guard: an accepted drop is the floor, a lower value later is held', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  assert.equal(guard.accept(5, 2 * MINUTE), false, 'never 5 kWh without a click');
  assert.equal(guard.held.to, 5);
  assert.equal(guard.last.value, 1000);
  // The value accepted comes back: it follows, from the floor accepted.
  assert.equal(guard.accept(12.1, 3 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: readings under an accepted floor for hours never widen the acceptance', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 }, undefined, 0);
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  let t = 2 * MINUTE;
  for (; t < 15 * 60 * MINUTE; t += MINUTE) assert.equal(guard.accept(5, t), false);
  assert.equal(guard.accept(212, t), false, '212 kWh after 15 h under the floor: held');
  assert.equal(guard.held.to, 212);
  // A value above the acceptance dropped it: 12.1 needs a new acceptance.
  assert.equal(guard.accept(12.1, t + MINUTE), false);
  assert.equal(guard.held.direction, 'down');
});
