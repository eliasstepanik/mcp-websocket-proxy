/**
 * Fake MCP server used by the integration tests.
 *
 * A plain ESM stdio MCP server built on the SDK's low-level `Server`, deliberately
 * written in the style the real servers on the work PC will use: it owns its own
 * tool/resource/prompt lists and its own state, and it exposes that state through a
 * resource so tests can observe things the wire cannot show (the observed
 * `logging/setLevel` level, the last `notifications/cancelled` it saw).
 *
 * Tools: echo, slow, progress, mutate, crash.
 * Resource: fixture://state
 * Prompt:   greet
 */

import { writeFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const STATE_URI = 'fixture://state';

/** Mutable state observable through the `fixture://state` resource. */
const state = {
  /** Last `logging/setLevel` level received from the client. */
  loggingLevel: null,
  /** Last `notifications/cancelled` observed (as seen by the SDK's abort signal). */
  lastCancellation: null,
  /** Number of tool calls handled by this process instance. */
  calls: 0,
  /** Extra tools added through the `mutate` tool. */
  extraTools: [],
};

const log = (message) => {
  process.stderr.write(`fixture: ${message}\n`);
};

const baseTools = () => [
  {
    name: 'echo',
    description: 'Echoes its argument. Pass text "__error__" to make the server fail with a custom JSON-RPC code.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'slow',
    description: 'Resolves after `ms` milliseconds. Cancellable.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
    },
  },
  {
    name: 'progress',
    description: 'Emits `steps` progress notifications, then resolves.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'number' } },
    },
  },
  {
    name: 'mutate',
    description: 'Adds a tool to the tool list and emits notifications/tools/list_changed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'Answers, then kills the process so the supervisor has to restart it.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const allTools = () => [
  ...baseTools(),
  ...state.extraTools.map((name) => ({
    name,
    description: 'Added at runtime by `mutate`.',
    inputSchema: { type: 'object', properties: {} },
  })),
];

const server = new Server(
  { name: 'fake-mcp-server', version: '1.2.3' },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
      logging: {},
    },
    instructions: 'Fixture server used by mcp-websocket-proxy tests.',
  },
);

// ------------------------------------------------------------------ tools

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  state.calls += 1;

  switch (name) {
    case 'echo': {
      if (args.text === '__error__') {
        // A deliberately application-specific code, to prove the proxy relays
        // upstream error codes unchanged.
        throw new McpError(-32100, 'fixture refuses to echo', { fixture: true });
      }
      return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] };
    }

    case 'slow': {
      const ms = Number(args.ms ?? 5000);
      // The SDK turns an incoming `notifications/cancelled` for this request into an
      // abort of `extra.signal`, so this is where the fixture "observes" it.
      extra.signal.addEventListener('abort', () => {
        state.lastCancellation = {
          requestId: extra.requestId,
          reason: String(extra.signal.reason),
        };
        log(`cancelled requestId=${extra.requestId} reason=${String(extra.signal.reason)}`);
      });
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (extra.signal.aborted) return { content: [{ type: 'text', text: 'slow:cancelled' }] };
      return { content: [{ type: 'text', text: `slow:done:${ms}` }] };
    }

    case 'progress': {
      const steps = Number(args.steps ?? 3);
      const progressToken = request.params?._meta?.progressToken;
      for (let i = 1; i <= steps; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (progressToken === undefined) continue;
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: i, total: steps, message: `step ${i}/${steps}` },
        });
      }
      return { content: [{ type: 'text', text: `progress:done:${steps}` }] };
    }

    case 'mutate': {
      const toolName = `extra_${state.extraTools.length + 1}`;
      state.extraTools.push(toolName);
      await server.sendToolListChanged();
      return { content: [{ type: 'text', text: `mutate:added:${toolName}` }] };
    }

    case 'crash': {
      // Let the response flush before dying, so the caller sees a clean answer.
      setTimeout(() => process.exit(1), 25);
      return { content: [{ type: 'text', text: 'crash:bye' }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${name}`);
  }
});

// -------------------------------------------------------------- resources

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: STATE_URI, name: 'fixture state', mimeType: 'application/json', description: 'Observed server state.' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== STATE_URI) {
    throw new McpError(ErrorCode.InvalidParams, `unknown resource ${request.params.uri}`);
  }
  return {
    contents: [{ uri: STATE_URI, mimeType: 'application/json', text: JSON.stringify(state) }],
  };
});

// ---------------------------------------------------------------- prompts

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'greet',
      description: 'Greets someone.',
      arguments: [{ name: 'name', required: true, description: 'Who to greet' }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== 'greet') {
    throw new McpError(ErrorCode.InvalidParams, `unknown prompt ${request.params.name}`);
  }
  const name = String(request.params.arguments?.name ?? 'world');
  return {
    description: 'Greets someone.',
    messages: [{ role: 'user', content: { type: 'text', text: `hello ${name}` } }],
  };
});

// --------------------------------------------------- observed client traffic

// `logging/setLevel` is a request. Owning the handler here (instead of letting the
// SDK answer it) is what lets the test prove the call actually reached the fixture.
server.setRequestHandler(SetLevelRequestSchema, async (request) => {
  state.loggingLevel = request.params.level;
  log(`logging/setLevel -> ${request.params.level}`);
  return {};
});

log(`started (pid=${process.pid})`);

// Append one line per process start so tests can count restarts from the outside.
if (process.env.FIXTURE_START_LOG) {
  writeFileSync(process.env.FIXTURE_START_LOG, `${process.pid}\n`, { flag: 'a' });
}

await server.connect(new StdioServerTransport());
