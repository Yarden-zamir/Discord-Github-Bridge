let payload;
try {
  payload = require("./payload.json");
} catch {
  // No payload file - run in bot server mode
}

if (payload) {
  console.log("Payload found - running webhook processor");
  require("./payloadProcessor.js").process(payload);
} else {
  console.log("No payload - running bot server");
  require("./botServer.js").start();
}
