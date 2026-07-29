function add(a, b) {
  return a + b;
}

if (require.main === module) {
  const result = add(5, 7);
  console.log(result);
  console.log(result);
  console.log(result);
  console.log(result);
  console.log(result);
}

module.exports = { add };
