/**
 * The WebSocket wire protocol between the proxy server (Warren side) and the
 * Windows client (work PC).
 *
 * Frames are JSON **text** messages. Every frame is one of the discriminated
 * messages below, keyed on `type`. Messages travelling client -> server are
 * {@link ClientToServer}; those travelling server -> client are
 * {@link ServerToClient}.
 *
 * Size limits are enforced by the transport (the `ws` layer), not here: this
 * module is pure — no I/O, no timers, no state.
 */

import { z } from 'zod';

/** Protocol version negotiated in `hello`/`welcome`. */
export const PROTOCOL_VERSION = 1;

/**
 * Allowed shape of a proxied server name: lowercase alphanumeric first char,
 * then up to 62 of `a-z0-9_-` (63 chars max total).
 */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A JSON-RPC-ish request id: numbers and strings are both accepted. */
export const MessageIdSchema = z.union([z.number(), z.string()]);

/** A proxied server name, validated against {@link SERVER_NAME_RE}. */
export const ServerNameSchema = z.string().regex(SERVER_NAME_RE, {
  message: 'server name must match ^[a-z0-9][a-z0-9_-]{0,62}$',
});

/** A JSON-RPC error object, relayed verbatim from upstream when possible. */
export const RpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * The cached `initialize` result of an upstream MCP server, relayed verbatim.
 * `capabilities`/`serverInfo` are loose so unknown MCP fields survive the tunnel.
 */
export const ServerInfoSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.looseObject({}),
  serverInfo: z.looseObject({}),
  instructions: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  clientId: z.string().min(1),
  clientVersion: z.string().optional(),
});

export const ServerUpSchema = z.object({
  type: z.literal('server_up'),
  server: ServerNameSchema,
  info: ServerInfoSchema,
});

export const ServerDownSchema = z.object({
  type: z.literal('server_down'),
  server: ServerNameSchema,
  reason: z.string(),
});

export const ResponseSchema = z
  .object({
    type: z.literal('response'),
    id: MessageIdSchema,
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .refine((msg) => (msg.result === undefined) !== (msg.error === undefined), {
    message: 'response must carry exactly one of `result` or `error`',
  });

export const ProgressSchema = z.object({
  type: z.literal('progress'),
  id: MessageIdSchema,
  params: z.object({
    progress: z.number(),
    total: z.number().optional(),
    message: z.string().optional(),
  }),
});

export const NotificationSchema = z.object({
  type: z.literal('notification'),
  server: ServerNameSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const WelcomeSchema = z.object({
  type: z.literal('welcome'),
  protocol: z.literal(PROTOCOL_VERSION),
  serverVersion: z.string().optional(),
  heartbeatIntervalMs: z.number().int().positive(),
});

export const ServerAckSchema = z.object({
  type: z.literal('server_ack'),
  server: ServerNameSchema,
  ok: z.boolean(),
  error: z.enum(['name_conflict', 'invalid_name']).optional(),
});

export const RequestSchema = z.object({
  type: z.literal('request'),
  id: MessageIdSchema,
  server: ServerNameSchema,
  session: z.string().optional(),
  method: z.string(),
  params: z.unknown().optional(),
  wantProgress: z.boolean().optional(),
});

export const CancelSchema = z.object({
  type: z.literal('cancel'),
  id: MessageIdSchema,
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/** Everything the client may send to the server. */
export const ClientToServerSchema = z.discriminatedUnion('type', [
  HelloSchema,
  ServerUpSchema,
  ServerDownSchema,
  ResponseSchema,
  ProgressSchema,
  NotificationSchema,
]);

/** Everything the server may send to the client. */
export const ServerToClientSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  ServerAckSchema,
  RequestSchema,
  CancelSchema,
]);

/** Either direction. */
export const TunnelMessageSchema = z.union([ClientToServerSchema, ServerToClientSchema]);

export type Hello = z.infer<typeof HelloSchema>;
export type ServerUp = z.infer<typeof ServerUpSchema>;
export type ServerDown = z.infer<typeof ServerDownSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type Welcome = z.infer<typeof WelcomeSchema>;
export type ServerAck = z.infer<typeof ServerAckSchema>;
export type Request = z.infer<typeof RequestSchema>;
export type Cancel = z.infer<typeof CancelSchema>;

export type ClientToServer = z.infer<typeof ClientToServerSchema>;
export type ServerToClient = z.infer<typeof ServerToClientSchema>;
export type TunnelMessage = ClientToServer | ServerToClient;

/** Which end of the tunnel a frame is travelling *towards*. */
export type TunnelDirection = 'in' | 'out';

/**
 * Raised by {@link parseTunnelMessage} for a frame that is not valid protocol
 * traffic: invalid JSON, an unknown `type`, a wrong protocol version, a bad
 * server name, a `response` without exactly one of `result`/`error`, ...
 */
export class TunnelProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TunnelProtocolError';
  }
}

function describeError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Parse one wire frame.
 *
 * @param raw       the raw JSON text of a single WebSocket text frame
 * @param direction `in` for frames the server reads from a client,
 *                  `out` for frames the client reads from the server
 * @throws {TunnelProtocolError} when `raw` is not valid JSON or does not
 *         validate as a message of that direction.
 */
export function parseTunnelMessage(raw: string, direction: TunnelDirection): TunnelMessage {
  const schema = direction === 'in' ? ClientToServerSchema : ServerToClientSchema;
  const label = direction === 'in' ? 'client -> server' : 'server -> client';

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new TunnelProtocolError(`tunnel frame (${label}) is not valid JSON: ${reason}`, { cause });
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new TunnelProtocolError(
      `invalid tunnel frame (${label}): ${describeError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
