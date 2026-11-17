// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { AudioFrame, type Room } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveAvatarAPI } from './api.js';
import { AvatarSession, type AvatarSessionOptions } from './avatar.js';

type Listener = (...args: unknown[]) => void;

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./log.js', () => ({ log: () => logger }));

const sockets = vi.hoisted(() => {
  class FakeWebSocket {
    sent: Record<string, unknown>[] = [];
    private listeners = new Map<string, { listener: Listener; once: boolean }[]>();

    constructor(readonly url: string) {
      sockets.push(this);
      setImmediate(() => this.emit('open'));
    }

    on(event: string, listener: Listener): this {
      return this.add(event, listener, false);
    }

    once(event: string, listener: Listener): this {
      return this.add(event, listener, true);
    }

    send(data: string): void {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close(): void {
      this.emit('close');
    }

    hasListener(event: string): boolean {
      return (this.listeners.get(event) ?? []).length > 0;
    }

    emit(event: string, ...args: unknown[]): void {
      const entries = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        entries.filter((entry) => !entry.once),
      );
      for (const entry of entries) {
        entry.listener(...args);
      }
    }

    private add(event: string, listener: Listener, once: boolean): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { listener, once }]);
      return this;
    }
  }

  const sockets: FakeWebSocket[] = [];
  return Object.assign(sockets, { FakeWebSocket });
});

vi.mock('ws', () => ({ WebSocket: sockets.FakeWebSocket }));

type FakeSocket = (typeof sockets)[number];

const SAMPLE_RATE = 24000;
const FRAME_SAMPLES = 2400;

function fakeRoom(): Room {
  return {
    name: 'test-room',
    isConnected: true,
    localParticipant: { identity: 'local-agent' },
  } as unknown as Room;
}

function fakeAgentSession(): voice.AgentSession {
  return {
    output: { audio: null as voice.AudioOutput | null },
    on: vi.fn(),
  } as unknown as voice.AgentSession;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await nextTick();
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await drain();
}

function count(socket: FakeSocket, type: string, fromIndex = 0): number {
  return socket.sent.slice(fromIndex).filter((event) => event.type === type).length;
}

function speakSamples(socket: FakeSocket, fromIndex = 0): Int16Array[] {
  return socket.sent
    .slice(fromIndex)
    .filter((event) => event.type === 'agent.speak')
    .map((event) => {
      const bytes = Buffer.from(event.audio as string, 'base64');
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    });
}

async function receive(socket: FakeSocket, event: Record<string, unknown>): Promise<void> {
  socket.emit('message', Buffer.from(JSON.stringify(event)));
  await drain();
}

async function ack(socket: FakeSocket, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await receive(socket, { type: 'agent.audio_buffer_appended' });
  }
}

// Frames are 100 ms, so a reply is cut into chunks of 6, 10, 10, ... frames.
async function capture(
  audio: voice.QueueAudioOutput,
  frameCount: number,
  firstMarker = 1,
): Promise<void> {
  for (let i = 0; i < frameCount; i++) {
    const samples = new Int16Array(FRAME_SAMPLES).fill(firstMarker + i);
    await audio.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SAMPLES));
  }
  await drain();
}

async function startAvatar(options: AvatarSessionOptions = {}): Promise<{
  avatar: AvatarSession;
  audio: voice.QueueAudioOutput;
  socket: FakeSocket;
}> {
  vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
  vi.spyOn(LiveAvatarAPI.prototype, 'createStreamingSession').mockResolvedValue({
    code: 100,
    data: { session_id: 'session-1', session_token: 'session-token' },
  });
  vi.spyOn(LiveAvatarAPI.prototype, 'startStreamingSession').mockResolvedValue({
    code: 100,
    data: { ws_url: 'wss://liveavatar.test/ws' },
  });
  vi.spyOn(LiveAvatarAPI.prototype, 'stopStreamingSession').mockResolvedValue({
    code: 100,
    data: {},
  });

  const agentSession = fakeAgentSession();
  const avatar = new AvatarSession({ apiKey: 'liveavatar-key', avatarId: 'avatar-1', ...options });
  await avatar.start(agentSession, fakeRoom(), {
    livekitUrl: 'wss://livekit.test',
    livekitApiKey: 'livekit-key',
    livekitApiSecret: 'livekit-secret',
  });

  expect(sockets).toHaveLength(1);
  const socket = sockets[0]!;
  await drain();
  expect(socket.hasListener('message')).toBe(true);
  await receive(socket, { type: 'session.state_updated', state: 'connected' });

  return { avatar, audio: agentSession.output.audio as voice.QueueAudioOutput, socket };
}

describe('LiveAvatar audio pacing', () => {
  let avatar: AvatarSession | undefined;

  async function start(options: AvatarSessionOptions = {}) {
    const started = await startAvatar(options);
    avatar = started.avatar;
    return started;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  });

  afterEach(async () => {
    await avatar?.aclose();
    avatar = undefined;
    sockets.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the first two chunks of a reply at once', async () => {
    const { audio, socket } = await start();

    await capture(audio, 16);

    expect(speakSamples(socket).map((chunk) => chunk.length)).toEqual([
      6 * FRAME_SAMPLES,
      10 * FRAME_SAMPLES,
    ]);
  });

  it('holds the third chunk until the playback clock is within the lead', async () => {
    const { audio, socket } = await start();

    await capture(audio, 26);
    expect(count(socket, 'agent.speak')).toBe(2);

    await advance(599);
    expect(count(socket, 'agent.speak')).toBe(2);

    await advance(1);
    expect(count(socket, 'agent.speak')).toBe(3);
  });

  it('holds chunks to the lead set by audioLeadMs', async () => {
    const { audio, socket } = await start({ audioLeadMs: 1000 });

    await capture(audio, 16);
    expect(count(socket, 'agent.speak')).toBe(1);

    await advance(599);
    expect(count(socket, 'agent.speak')).toBe(1);

    await advance(1);
    expect(count(socket, 'agent.speak')).toBe(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the default lead when audioLeadMs is %s',
    async (audioLeadMs) => {
      const { audio, socket } = await start({ audioLeadMs });

      await capture(audio, 26);
      expect(count(socket, 'agent.speak')).toBe(2);

      await advance(599);
      expect(count(socket, 'agent.speak')).toBe(2);

      await advance(1);
      expect(count(socket, 'agent.speak')).toBe(3);
    },
  );

  it('holds a chunk while three are unacknowledged and releases one per ack', async () => {
    const { audio, socket } = await start();

    await capture(audio, 46);
    await advance(1600);
    expect(count(socket, 'agent.speak')).toBe(3);

    await ack(socket);
    expect(count(socket, 'agent.speak')).toBe(4);

    await advance(1000);
    expect(count(socket, 'agent.speak')).toBe(4);

    await ack(socket);
    expect(count(socket, 'agent.speak')).toBe(5);
  });

  it('resets the unacknowledged count when LiveAvatar reports the buffer cleared', async () => {
    const { audio, socket } = await start();

    await capture(audio, 46);
    await advance(1600);
    expect(count(socket, 'agent.speak')).toBe(3);

    await receive(socket, { type: 'agent.audio_buffer_cleared' });
    expect(count(socket, 'agent.speak')).toBe(4);
  });

  it('resets the unacknowledged count on an interrupt', async () => {
    const { audio, socket } = await start();

    await capture(audio, 46);
    await advance(1600);
    expect(count(socket, 'agent.speak')).toBe(3);
    audio.clearBuffer();
    await drain();

    const nextReplyFrom = socket.sent.length;
    await capture(audio, 16, 101);

    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(2);
  });

  it('keeps the cap after an interrupt when late acks arrive', async () => {
    const { audio, socket } = await start();

    await capture(audio, 26);
    await advance(600);
    audio.clearBuffer();
    await drain();
    await ack(socket, 3);

    const nextReplyFrom = socket.sent.length;
    await capture(audio, 46, 101);
    await advance(1600);

    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(3);
  });

  it('stops waiting for acks for the rest of a segment after one ack wait times out, warning once', async () => {
    const { audio, socket } = await start();

    await capture(audio, 66);
    await advance(1600);
    expect(count(socket, 'agent.speak')).toBe(3);

    await advance(1999);
    expect(count(socket, 'agent.speak')).toBe(3);
    expect(logger.warn).not.toHaveBeenCalled();

    await advance(1);
    expect(count(socket, 'agent.speak')).toBe(6);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(count(socket, 'agent.speak')).toBe(6);

    await advance(1);
    expect(count(socket, 'agent.speak')).toBe(7);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    audio.flush();
    await drain();
    await capture(audio, 16, 101);
    expect(count(socket, 'agent.speak')).toBe(8);

    await advance(1999);
    expect(count(socket, 'agent.speak')).toBe(8);

    await advance(1);
    expect(count(socket, 'agent.speak')).toBe(9);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('sends the interrupt at once and never sends the held chunk when interrupted mid-segment', async () => {
    const { audio, socket } = await start();

    await capture(audio, 26);
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    expect(count(socket, 'agent.speak')).toBe(2);

    await advance(300);
    audio.clearBuffer();
    await drain();
    expect(count(socket, 'agent.interrupt')).toBe(1);

    const playout = await audio.waitForPlayout();
    expect(playout.interrupted).toBe(true);

    await advance(1000);
    expect(count(socket, 'agent.speak')).toBe(2);
  });

  it('drops the held leftover but ends the segment when interrupted at the segment end', async () => {
    const { audio, socket } = await start();

    await capture(audio, 30);
    audio.flush();
    await drain();
    expect(count(socket, 'agent.speak')).toBe(2);

    await advance(600);
    expect(count(socket, 'agent.speak')).toBe(3);
    expect(count(socket, 'agent.speak_end')).toBe(0);

    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    await advance(100);
    audio.clearBuffer();
    await drain();

    expect(count(socket, 'agent.interrupt')).toBe(1);
    expect(count(socket, 'agent.speak_end')).toBe(1);
    expect(count(socket, 'agent.speak')).toBe(3);
    expect((await audio.waitForPlayout()).interrupted).toBe(true);

    const nextReplyFrom = socket.sent.length;
    await capture(audio, 7, 101);
    audio.flush();
    await drain();

    const chunks = speakSamples(socket, nextReplyFrom);
    expect(chunks.map((chunk) => chunk.length)).toEqual([6 * FRAME_SAMPLES, FRAME_SAMPLES]);
    expect(chunks[0]![0]).toBe(101);
    expect(chunks[1]![0]).toBe(107);
  });

  async function interruptAfterRelease(
    audio: voice.QueueAudioOutput,
    socket: FakeSocket,
    releaseMs: number,
    microtasks: number,
  ): Promise<void> {
    vi.advanceTimersByTime(releaseMs);
    for (let i = 0; i < microtasks; i++) {
      await Promise.resolve();
    }
    audio.clearBuffer();
    audio.flush();
    await drain();

    const types = socket.sent.map((event) => event.type);
    expect(types.indexOf('agent.interrupt')).toBeGreaterThan(-1);
    expect(types.lastIndexOf('agent.speak')).toBeLessThan(types.indexOf('agent.interrupt'));

    await receive(socket, { type: 'agent.audio_buffer_cleared' });
    await receive(socket, { type: 'agent.state_updated', new_state: 'listening' });
    await capture(audio, 7, 101);
    audio.flush();
    await drain();
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    await receive(socket, { type: 'agent.state_updated', new_state: 'listening' });

    expect((await audio.waitForPlayout()).playbackPosition).toBeCloseTo(0.7);
  }

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'never sends a mid-segment chunk the clock released when the interrupt lands %i microtasks later',
    async (microtasks) => {
      const { audio, socket } = await start();

      await capture(audio, 26);
      await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });

      await interruptAfterRelease(audio, socket, 600, microtasks);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'never sends a leftover the clock released at the segment end when the interrupt lands %i microtasks later',
    async (microtasks) => {
      const { audio, socket } = await start();

      await capture(audio, 30);
      audio.flush();
      await drain();
      await ack(socket, 2);
      await advance(600);
      await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });

      await interruptAfterRelease(audio, socket, 400, microtasks);
    },
  );

  it('reports the time the avatar talked as the position of an interrupted reply', async () => {
    const { audio, socket } = await start();

    await capture(audio, 26);
    audio.flush();
    await advance(1000);
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    await advance(2500);
    audio.clearBuffer();

    const playout = await audio.waitForPlayout();
    expect(playout.interrupted).toBe(true);
    expect(playout.playbackPosition).toBeCloseTo(2.5);
  });

  it('caps the reported position of an interrupted reply at the audio sent', async () => {
    const { audio, socket } = await start();

    await capture(audio, 16);
    audio.flush();
    await drain();
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    await advance(3000);
    audio.clearBuffer();

    const playout = await audio.waitForPlayout();
    expect(playout.interrupted).toBe(true);
    expect(playout.playbackPosition).toBeCloseTo(1.6);
  });

  it('reports position zero when interrupted before the avatar talked', async () => {
    const { audio } = await start();

    await capture(audio, 16);
    audio.clearBuffer();

    expect(await audio.waitForPlayout()).toEqual({ playbackPosition: 0, interrupted: true });
  });

  it('restarts the playback clock for each reply', async () => {
    const { audio, socket } = await start();

    await capture(audio, 16);
    audio.flush();
    await drain();
    await ack(socket, 2);
    await advance(5000);

    const nextReplyFrom = socket.sent.length;
    await capture(audio, 26, 101);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(2);

    await advance(599);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(2);

    await advance(1);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(3);
  });

  it('restarts the playback clock after an interrupt', async () => {
    const { audio, socket } = await start();

    await capture(audio, 26);
    await advance(300);
    audio.clearBuffer();
    await advance(5000);

    const nextReplyFrom = socket.sent.length;
    await capture(audio, 26, 101);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(2);

    await advance(599);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(2);

    await advance(1);
    expect(count(socket, 'agent.speak', nextReplyFrom)).toBe(3);
  });

  it('ends a held wait on aclose and leaves no timer behind', async () => {
    const started = await start();
    const { audio, socket } = started;

    await capture(audio, 26);
    expect(count(socket, 'agent.speak')).toBe(2);

    await started.avatar.aclose();
    avatar = undefined;

    expect(vi.getTimerCount()).toBe(0);
    expect(count(socket, 'agent.speak')).toBe(2);
  });
});
