// Monorepo Metro config: watch the workspace root so the local package is
// picked up, and resolve modules from both the app and the root.
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
// One copy of each native module, or Nitro hybrid objects register twice.
config.resolver.disableHierarchicalLookup = true

module.exports = config
