//@ts-check
'use strict';

const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const packageJson = require('./package.json');

/**
 * Webpack configuration for the FreeOCD VS Code extension.
 *
 * Produces two bundles:
 *   1. `extension.js` — Main extension entry point (CommonJS, externals:
 *      `vscode` and `node-hid`).
 *   2. `mcp-server.js` — Standalone MCP server (CommonJS, no externals).
 *      Launched as a child process by the IDE's MCP client via stdio.
 *
 * Static assets (DAPjs UMD bundle, icons, target definitions, walkthrough
 * markdown) are copied to the output directory via CopyWebpackPlugin.
 */

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    'node-hid': 'commonjs node-hid'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      EXTENSION_VERSION: JSON.stringify(packageJson.version)
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'vendor/dapjs/dist/dap.umd.js', to: 'dap.umd.js', noErrorOnMissing: true },
        { from: 'resources/icons', to: 'icons' },
        { from: 'resources/targets', to: 'targets' },
        { from: 'resources/walkthrough', to: 'walkthrough' },
        { from: 'resources/tool-sets', to: 'tool-sets' }
      ]
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

/** @type {import('webpack').Configuration} */
const mcpServerConfig = {
  target: 'node',
  mode: 'none',

  entry: './src/mcp/mcp-server.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'mcp-server.js',
    libraryTarget: 'commonjs2'
  },
  externals: {},
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      EXTENSION_VERSION: JSON.stringify(packageJson.version)
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

module.exports = [extensionConfig, mcpServerConfig];
