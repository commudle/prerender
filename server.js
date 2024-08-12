let prerender = require('./lib');

let server = prerender({
  port: 8080,
  chromeFlags: [
    '--no-sandbox',
    '--headless',
    '--disable-gpu',
    '--remote-debugging-port=9222',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
  ],
  logRequests: true,
});

server.use(prerender.sendPrerenderHeader());
server.use(prerender.browserForceRestart());
// server.use(prerender.blockResources());
// server.use(prerender.removeScriptTags());
server.use(prerender.replaceIsBot());
server.use(prerender.addMetaTags());
server.use(prerender.httpHeaders());
server.use(require('prerender-memory-cache'));

server.start();
