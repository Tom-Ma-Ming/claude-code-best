import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { buildCliLaunch } from '../../utils/cliLaunch.js'

export function registerDingtalkBuiltinPlugin(): void {
  const launch = buildCliLaunch(['dingtalk', 'serve'])

  registerBuiltinPlugin({
    name: 'dingtalk',
    description:
      'DingTalk channel integration. Enables inbound DingTalk messages via Stream mode and provides a reply MCP tool. Configure with `ccb dingtalk login` and enable for a session with `--channels plugin:dingtalk@builtin`.',
    version: MACRO.VERSION,
    defaultEnabled: true,
    mcpServers: {
      dingtalk: {
        type: 'stdio',
        command: launch.execPath,
        args: launch.args,
      },
    },
  })
}
