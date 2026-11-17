---
'@livekit/agents-plugin-liveavatar': patch
---

Pace `agent.speak` audio to the playback clock, so an interrupt stops the avatar soon after it lands on a long reply. The new `audioLeadMs` option on `AvatarSession` sets how far the audio may run ahead of playback (default 2000 ms). An interrupted reply now reports how long the avatar talked, capped at the audio sent.
