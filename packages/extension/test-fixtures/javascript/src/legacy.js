const { add } = require('./math.js');

function total(value) {
  return add(value, 1);
}

module.exports = { total };
