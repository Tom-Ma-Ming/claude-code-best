import { describe, expect, test } from 'bun:test'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createDingtalkMcpServer } from '../server.js'

/**
 * Regression guard for the deferred-tool trap.
 *
 * ccb's isDeferredTool() defers every MCP tool that is not in CORE_TOOLS, so a
 * channel's reply tool ships without a schema: the model sees the name, cannot
 * see the parameters, and every call fails validation. In practice that means
 * inbound messages arrive and can never be answered — and the model retries
 * forever, which is what made a session impossible to exit.
 *
 * The opt-out is `_meta['anthropic/alwaysLoad']`, read in
 * src/services/mcp/client.ts.
 */
async function listTools() {
  const server = createDingtalkMcpServer('test')
  // @ts-expect-error — reaching into the SDK's handler registry for the test
  const handler = server._requestHandlers.get(
    ListToolsRequestSchema.shape.method.value,
  )
  return (await handler({ method: 'tools/list', params: {} }, {})) as {
    tools: Array<{
      name: string
      _meta?: Record<string, unknown>
      inputSchema: { required?: string[]; properties: Record<string, unknown> }
    }>
  }
}

describe('dingtalk MCP tool declarations', () => {
  test('reply is marked alwaysLoad so it is never deferred', async () => {
    const { tools } = await listTools()
    const reply = tools.find(t => t.name === 'reply')
    expect(reply).toBeDefined()
    expect(reply?._meta?.['anthropic/alwaysLoad']).toBe(true)
  })

  test('every exposed tool is alwaysLoad', async () => {
    const { tools } = await listTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool._meta?.['anthropic/alwaysLoad']).toBe(true)
    }
  })

  test('reply declares the parameters the model needs', async () => {
    const { tools } = await listTools()
    const reply = tools.find(t => t.name === 'reply')!
    expect(reply.inputSchema.required).toEqual(['chat_id', 'text'])
    expect(Object.keys(reply.inputSchema.properties)).toEqual(
      expect.arrayContaining(['chat_id', 'text', 'markdown', 'title', 'files']),
    )
  })
})
