# @gp/protocol: P0 "Join with code" changes

Every change here is additive and backward compatible (PROTOCOL_VERSION stays 1).

| Schema                                                                              | Change                                                                                                   | Why                                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateRoomRequestSchema.seatCount`                                                 | Now optional.                                                                                            | The server defaults it to the mode's smallest allowed seat count (2 for every current game).                                            |
| `CreateRoomRequestSchema.options`                                                   | Now optional (zod 4 treats a bare `z.unknown()` key as required).                                        | Missing options mean `{}`; the game's `configSchema` fills its defaults.                                                                |
| `RoomSnapshotSchema.meta`                                                           | New, optional, nullable: `MatchMetaSchema` `{version, awaiting: {seats, deadlineAt}, paused, finished}`. | The engine's `EngineMeta` for `GameHost`/game screens, with `deadlineAt` in server wall time. `null` in a lobby before the first match. |
| `RoomSnapshotSchema.result`                                                         | New, optional, nullable: `MatchPlacementsSchema` `{placements: [{seat, place, score}], abandoned?}`.     | The finished match's placements for the result sheet; `null` while playing or in the lobby.                                             |
| `MatchMetaSchema`, `MatchPlacementsSchema` (+ types `MatchMeta`, `MatchPlacements`) | New exports.                                                                                             | Used by the two fields above.                                                                                                           |

## Semantics the server implements (no schema change)

- `room:state.version` (and the `room:join` ack's `snapshot.version`) is the **room version**:
  `epoch × 2³² + n`, strictly increasing over the room's whole life in a server process (lobby,
  matches, rematches). A server restart starts a higher epoch, so it still increases.
- `game:action.baseVersion` must be the `version` of the latest snapshot the client rendered. The
  server maps it to the engine version that snapshot showed, for the `STALE` check. `meta.version`
  is the engine's own counter and is informational only.
- `room:state` is sent after every change, including connection-dot and ready changes. Seats show
  `connection: 'away'` for a held lobby seat without a socket (or after `presence: away`), and
  `'disconnected'` in a match, with a `grace` deadline for that seat.
- `deadlines`: `turn` (awaited seats + wall-time deadline, omitted while paused), `grace` (60 s per
  disconnected seat in a match) and `rematch` (when a FINISHED room closes).
- `GET /rooms/:code` answers 404 `not_found` for an unknown code and 410 `room_closed` for a closed
  or expired room.
- The socket handshake requires `auth: { token: <access JWT> }`; without a valid token the connect
  fails with a `connect_error` whose message is `UNAUTHORIZED`.
- `hello` is recommended but not required before room events (the platform badge defaults to `web`).
