// Monorepo Metro config: watch the workspace root so the local package is
// picked up, and resolve from both the app's and the root's node_modules.
//
// Note: `disableHierarchicalLookup` is deliberately NOT set. npm installs some
// of Expo's own dependencies nested (node_modules/expo/node_modules/…), and
// turning off hierarchical lookup makes Metro fail to resolve them.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

module.exports = config
