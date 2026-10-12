const express = require('express');
const app = express();

app.use("/api", (req, res, next) => {
  console.log("baseUrl", req.baseUrl);
  console.log("path", req.path);
  console.log("url", req.url);
  console.log("originalUrl", req.originalUrl);
  res.send({ path: req.path });
});

app.listen(3001, () => {
  console.log("Test server running");
});
