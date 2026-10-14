#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NAME, VERSION, loadConfig } from './config.js';
import { Tally } from './tally.js';
import { Store } from './store.js';
import { createApp } from './app.js';

// stdout carries the protocol; anything a library prints must go to stderr.
console.log = console.error;

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`${NAME}: ${e.message}`);
  process.exit(1);
}

const app = createApp({ config, tally: new Tally(config), store: new Store(config.dataDir) });
const server = new Server({ name: 'mini-tallo', version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: app.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => app.callTool(req.params.name, req.params.arguments ?? {}));
await server.connect(new StdioServerTransport());
console.error(`${NAME} ${VERSION} ready. TallyPrime gateway: ${config.host}:${config.port}. Posting: ${config.posting ? 'on' : 'off'}.`);
