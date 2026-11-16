// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { AudioFrame, type Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveAvatarAPI } from './api.js';
import { AvatarSession } from './avatar.js';

type Listener = (...args: unknown[]) => void;

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

function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms),
    ),
  ]);
}

function sentTypes(socket: FakeSocket): unknown[] {
  return socket.sent.map((event) => event.type);
}

function count(socket: FakeSocket, type: string): number {
  return sentTypes(socket).filter((sent) => sent === type).length;
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
  await nextTick();
}

async function captureReply(
  audio: voice.QueueAudioOutput,
  frameCount: number,
  firstMarker: number,
): Promise<void> {
  for (let i = 0; i < frameCount; i++) {
    const samples = new Int16Array(FRAME_SAMPLES).fill(firstMarker + i);
    await audio.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SAMPLES));
  }
}

async function forwardReply(
  audio: voice.QueueAudioOutput,
  socket: FakeSocket,
  frameCount: number,
  firstMarker: number,
): Promise<void> {
  const segmentsEnded = count(socket, 'agent.speak_end');
  await captureReply(audio, frameCount, firstMarker);
  audio.flush();
  await vi.waitFor(() => expect(count(socket, 'agent.speak_end')).toBe(segmentsEnded + 1));
}

async function startAvatar(): Promise<{
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
  const avatar = new AvatarSession({ apiKey: 'liveavatar-key', avatarId: 'avatar-1' });
  await avatar.start(agentSession, fakeRoom(), {
    livekitUrl: 'wss://livekit.test',
    livekitApiKey: 'livekit-key',
    livekitApiSecret: 'livekit-secret',
  });

  expect(sockets).toHaveLength(1);
  const socket = sockets[0]!;
  await vi.waitFor(() => expect(socket.hasListener('message')).toBe(true));
  await receive(socket, { type: 'session.state_updated', state: 'connected' });

  return { avatar, audio: agentSession.output.audio as voice.QueueAudioOutput, socket };
}

describe('LiveAvatar interrupt through the audio queue', () => {
  let avatar: AvatarSession | undefined;

  afterEach(async () => {
    await avatar?.aclose();
    avatar = undefined;
    sockets.length = 0;
    vi.restoreAllMocks();
  });

  it('interrupts the avatar when the reply is cut off after all its audio was forwarded', async () => {
    const started = await startAvatar();
    avatar = started.avatar;
    const { audio, socket } = started;

    await forwardReply(audio, socket, 14, 1);
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    audio.clearBuffer();

    const playout = await withTimeout(audio.waitForPlayout());
    expect(playout.interrupted).toBe(true);
    expect(playout.playbackPosition).toBeCloseTo(1.4);
    await vi.waitFor(() => expect(count(socket, 'agent.interrupt')).toBe(1));
    expect(sentTypes(socket).lastIndexOf('agent.speak')).toBeLessThan(
      sentTypes(socket).indexOf('agent.interrupt'),
    );
  });

  it('interrupts the avatar after a forwarded reply when it reports agent.speak_started', async () => {
    const started = await startAvatar();
    avatar = started.avatar;
    const { audio, socket } = started;

    await forwardReply(audio, socket, 14, 1);
    await receive(socket, { type: 'agent.speak_started' });
    audio.clearBuffer();

    const playout = await withTimeout(audio.waitForPlayout());
    expect(playout.interrupted).toBe(true);
    await vi.waitFor(() => expect(count(socket, 'agent.interrupt')).toBe(1));
  });

  it('drops the unsent remainder when the interrupt lands before the segment end is read', async () => {
    const started = await startAvatar();
    avatar = started.avatar;
    const { audio, socket } = started;

    await captureReply(audio, 14, 1);
    await vi.waitFor(() => expect(count(socket, 'agent.speak')).toBe(1));
    await nextTick();
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    audio.flush();
    audio.clearBuffer();

    const playout = await withTimeout(audio.waitForPlayout());
    expect(playout).toEqual({ playbackPosition: 0.6, interrupted: true });
    await vi.waitFor(() => expect(count(socket, 'agent.speak_end')).toBe(1));
    expect(count(socket, 'agent.interrupt')).toBe(1);
    expect(count(socket, 'agent.speak')).toBe(1);
  });

  it('reports an uninterrupted playout when the avatar finishes the reply', async () => {
    const started = await startAvatar();
    avatar = started.avatar;
    const { audio, socket } = started;

    await forwardReply(audio, socket, 14, 1);
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    await receive(socket, { type: 'agent.state_updated', new_state: 'listening' });

    const playout = await withTimeout(audio.waitForPlayout());
    expect(playout.interrupted).toBe(false);
    expect(playout.playbackPosition).toBeCloseTo(1.4);
    expect(count(socket, 'agent.interrupt')).toBe(0);
  });

  it('forwards the next reply in full after an interrupt', async () => {
    const started = await startAvatar();
    avatar = started.avatar;
    const { audio, socket } = started;

    await forwardReply(audio, socket, 14, 1);
    await receive(socket, { type: 'agent.state_updated', new_state: 'talking' });
    audio.clearBuffer();
    await vi.waitFor(() => expect(count(socket, 'agent.interrupt')).toBe(1));
    await receive(socket, { type: 'agent.audio_buffer_cleared' });
    await receive(socket, { type: 'agent.state_updated', new_state: 'listening' });

    const nextReplyFrom = socket.sent.length;
    await forwardReply(audio, socket, 7, 101);

    const chunks = speakSamples(socket, nextReplyFrom);
    expect(chunks.map((chunk) => chunk.length)).toEqual([6 * FRAME_SAMPLES, FRAME_SAMPLES]);
    expect(chunks[0]![0]).toBe(101);
    expect(chunks[1]![0]).toBe(107);
  });
});
