import type { JobEvent, JobStatus } from '@actionow/contracts';
import { JOB_EVENTS } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { isTerminal, transition } from '../src/state-machine.js';

describe('job state machine', () => {
  it('queued -> running on start', () => {
    expect(transition('queued', 'start')).toBe('running');
  });
  it('running -> succeeded on succeed', () => {
    expect(transition('running', 'succeed')).toBe('succeeded');
  });
  it('queued can fail or cancel directly', () => {
    expect(transition('queued', 'fail')).toBe('failed');
    expect(transition('queued', 'cancel')).toBe('canceled');
  });
  it('rejects illegal transition from terminal', () => {
    expect(() => transition('succeeded', 'start')).toThrow(/invalid_transition/);
  });
  it('isTerminal identifies terminal states', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('job state machine — exhaustive', () => {
  it('covers every legal transition exactly per §5', () => {
    expect(transition('queued', 'start')).toBe('running');
    expect(transition('queued', 'succeed')).toBe('succeeded');
    expect(transition('queued', 'fail')).toBe('failed');
    expect(transition('queued', 'cancel')).toBe('canceled');
    expect(transition('running', 'succeed')).toBe('succeeded');
    expect(transition('running', 'fail')).toBe('failed');
    expect(transition('running', 'cancel')).toBe('canceled');
  });

  it('running cannot start again', () => {
    expect(() => transition('running', 'start')).toThrow(/invalid_transition/);
  });

  it('rejects every event from each terminal state', () => {
    const terminals: JobStatus[] = ['succeeded', 'failed', 'canceled'];
    for (const from of terminals) {
      for (const event of JOB_EVENTS) {
        expect(() => transition(from, event)).toThrow(/invalid_transition/);
      }
    }
  });

  it('isTerminal is true for all terminal states and false otherwise', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
  });

  it('the thrown error carries the from/event detail', () => {
    let caught: unknown;
    try {
      transition('failed', 'start');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const event: JobEvent = 'start';
    expect((caught as Error).message).toMatch(event);
    expect((caught as Error).message).toMatch('failed');
  });
});
