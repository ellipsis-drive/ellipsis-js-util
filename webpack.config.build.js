const path = require('path');

module.exports = {
  entry: './src/lib/index.js',
  output: {
    publicPath: '',
    path: path.resolve(__dirname, 'build'),
    library: {
      name: 'ellipsis',
      type: 'umd'
    },
    filename: 'ellipsis-js-util.js',
  },
  mode: 'production',
  externals: {
    'unique-names-generator': 'unique-names-generator'
  }
};