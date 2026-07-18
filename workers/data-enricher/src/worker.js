import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { gather } from './mcp.js';

/** @param {Env} env */
function serverUrls(env) {
  return (env.MCP_SERVERS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

export default {
  /**
   * @param {ScheduledController} _controller
   * @param {Env} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    console.log('hello world');
    for (const url of serverUrls(env)) {
      const target = new URL(url);
      const summary = await gather(new StreamableHTTPClientTransport(target));
      console.log(JSON.stringify({ event: 'mcp_gathered', server: target.host, tools: summary.tools }));
    }
  },
};
