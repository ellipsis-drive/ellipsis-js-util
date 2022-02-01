const path = require('path');

module.exports = {
  entry: './src/lib/index.js',
  output: {
    publicPath: '',
    path: path.resolve(__dirname, 'build'),
    library: {
      type: 'umd',
      name: 'EllipsisUtil'
    },
    filename: 'ellipsis-js-util.js',
  },
  mode: 'production'
};