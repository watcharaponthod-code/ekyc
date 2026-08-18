// Monorepo Metro config (see apps/example) plus `.tflite` as an asset so the
// MobileFaceNet model can be `require()`d by react-native-fast-tflite.
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
config.resolver.assetExts = [...config.resolver.assetExts, 'tflite']

module.exports = config
