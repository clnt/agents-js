// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveAvatarAPI } from './api.js';
import { AvatarSession } from './avatar.js';

vi.mock('ws', () => ({
  WebSocket: class {
    once(event: string, listener: (error: Error) => void): this {
      if (event === 'error') {
        setImmediate(() => listener(new Error('websocket unavailable')));
      }
      return this;
    }

    close(): void {}
  },
}));

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

describe('LiveAvatar AvatarSession sessionId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is null before start', () => {
    const avatar = new AvatarSession({ apiKey: 'liveavatar-key', avatarId: 'avatar-1' });

    expect(avatar.sessionId).toBeNull();
  });

  it('returns the LiveAvatar session id after start', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    vi.spyOn(LiveAvatarAPI.prototype, 'createStreamingSession').mockResolvedValue({
      code: 100,
      data: { session_id: 'liveavatar-session-1', session_token: 'session-token' },
    });
    vi.spyOn(LiveAvatarAPI.prototype, 'startStreamingSession').mockResolvedValue({
      code: 100,
      data: { ws_url: 'wss://liveavatar.test/ws' },
    });
    vi.spyOn(LiveAvatarAPI.prototype, 'stopStreamingSession').mockResolvedValue({
      code: 100,
      data: {},
    });
    const avatar = new AvatarSession({ apiKey: 'liveavatar-key', avatarId: 'avatar-1' });

    await avatar.start(fakeAgentSession(), fakeRoom(), {
      livekitUrl: 'wss://livekit.test',
      livekitApiKey: 'livekit-key',
      livekitApiSecret: 'livekit-secret',
    });

    expect(avatar.sessionId).toBe('liveavatar-session-1');
    await avatar.aclose();
  });
});
